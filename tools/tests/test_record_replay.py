import ctypes
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))


def load_recorder():
    # Import the real module without querying Steam, loading input DLLs, or consulting Windows folder settings.
    registry = ModuleType('winreg')
    registry.HKEY_CURRENT_USER = 0
    registry.OpenKey = Mock(side_effect=OSError('no Steam in unit tests'))

    def documents(_guid, _flags, _token, out):
        out._obj.value = str(TOOLS)
        return 0

    dlls = SimpleNamespace(shell32=SimpleNamespace(SHGetKnownFolderPath=documents),
                           ole32=SimpleNamespace(CoTaskMemFree=lambda _out: None))
    spec = importlib.util.spec_from_file_location('record_replay_test_subject', TOOLS / 'record_replay.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'winreg': registry, 'aoe4input': ModuleType('aoe4input'),
                                  'runlock': ModuleType('runlock')}), \
            patch.object(ctypes, 'windll', dlls, create=True):
        spec.loader.exec_module(module)
    return module


class RecordReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.recorder = load_recorder()

    def test_complete_one_second_short(self):
        self.assertTrue(self.recorder.reached_end(99.0, 100.0))

    def test_incomplete_one_and_quarter_seconds_short(self):
        self.assertFalse(self.recorder.reached_end(98.75, 100.0))

    def test_exact_tolerance_boundary(self):
        self.assertTrue(self.recorder.reached_end(98.875, 100.0))
        self.assertFalse(self.recorder.reached_end(98.874, 100.0))

    def test_scarlog_rejects_shrink(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'scarlog.txt'
            path.write_bytes(b'first line\nsecond line\n')
            log = self.recorder.ScarLog(path)
            self.assertEqual(log.poll(), ['first line', 'second line'])
            path.write_bytes(b'short\n')
            with self.assertRaisesRegex(self.recorder.RecordError, 'scarlog rotated'):
                log.poll()

    def test_scarlog_rejects_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'scarlog.txt'
            path.write_bytes(b'first\n')
            log = self.recorder.ScarLog(path)
            log.poll()
            replacement = Path(temp) / 'replacement.txt'
            replacement.write_bytes(b'longer replacement\n')
            replacement.replace(path)
            with self.assertRaisesRegex(self.recorder.RecordError, 'scarlog rotated'):
                log.poll()

    def test_completion_rejects_interior_errors_and_gaps(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'test.rlog'
            current = f'HDR|{self.recorder.grammar.VERSION}|1|100|100|2\n'
            older = f'HDR|{self.recorder.grammar.VERSION - 1}|1|100|100|2\n'
            for header, records, expected in [
                (current, 'T|1\nT|1.5\nT|2\n', True),
                (current, 'T|1\nERR|sample|failure\nT|1.5\nT|2\n', False),
                (current, 'T|1\nT|2.5\n', False),
                (current, 'T|1\nT|2\n', True),
                (current, 'T|2\nT|1.5\nT|2\n', False),
                (older, 'T|1\nT|1.5\nT|2\n', False),
            ]:
                with self.subTest(header=header, records=records):
                    path.write_text(header + records, encoding='utf-8')
                    self.assertEqual(self.recorder.is_complete(path, 3), expected)

    def test_close_game_leaves_unknown_and_reused_pids_alone(self):
        process = Mock()
        process.create_time.return_value = 20
        with patch.object(self.recorder.psutil, 'Process', return_value=process) as factory:
            self.recorder.close_game(None)
            factory.assert_not_called()
            self.recorder.close_game((123, 10))
            process.kill.assert_not_called()
            self.recorder.close_game((123, 20))
            process.kill.assert_called_once()
            process.wait.assert_called_once_with(timeout=60)

    CONFIG = (b'configuration =  \r\n{\r\n\t[5] =  \r\n\t{\r\n\t\tsetting = "mouseclamp",\r\n\t\tvariantBool = true,\r\n\t},\r\n'
              b'\t[11] =  \r\n\t{\r\n\t\tsetting = "shadows",\r\n\t\tvariantUInt = 4,\r\n\t},\r\n'
              b'\t[12] =  \r\n\t{\r\n\t\tsetting = "resolution",\r\n\t\tvariantString = "1920:1080:0:0",\r\n\t},\r\n}\r\n')

    def test_recording_graphics_lower_only_listed_settings_and_restore_exactly(self):
        with tempfile.TemporaryDirectory() as temp:
            config, backup = Path(temp) / 'configuration_system.lua', Path(temp) / 'backup'
            config.write_bytes(self.CONFIG)
            with patch.multiple(self.recorder, GAME_CONFIG=config, CONFIG_BACKUP=backup):
                self.assertTrue(self.recorder.lower_graphics())
                low = config.read_bytes()
                self.assertIn(b'variantUInt = 0,\r\n', low)
                self.assertIn(b'variantString = "1280:720:0:0",\r\n', low)
                self.assertIn(b'variantBool = true,\r\n', low)  # mouseclamp is not a graphics setting
                self.assertEqual(low.count(b'\r\n'), self.CONFIG.count(b'\r\n'))
                self.recorder.restore_graphics()
            self.assertEqual(config.read_bytes(), self.CONFIG)
            self.assertFalse(backup.exists())

    def test_recording_after_a_crashed_run_keeps_the_players_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            config, backup = Path(temp) / 'configuration_system.lua', Path(temp) / 'backup'
            config.write_bytes(self.CONFIG)
            with patch.multiple(self.recorder, GAME_CONFIG=config, CONFIG_BACKUP=backup):
                self.recorder.lower_graphics()  # the run dies here: no restore
                self.recorder.lower_graphics()
                self.recorder.restore_graphics()
            self.assertEqual(config.read_bytes(), self.CONFIG)

    def test_no_game_configuration_launches_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            config, backup = Path(temp) / 'configuration_system.lua', Path(temp) / 'backup'
            with patch.multiple(self.recorder, GAME_CONFIG=config, CONFIG_BACKUP=backup):
                self.assertFalse(self.recorder.lower_graphics())
            self.assertFalse(config.exists() or backup.exists())

    def test_keep_open_after_a_crashed_run_launches_with_the_players_settings(self):
        launched = []

        def launch(_command):
            launched.append(config.read_bytes())
            raise RuntimeError('stop after launch')

        replay = SimpleNamespace(duration_seconds=60.0, version=1, players=[])
        with tempfile.TemporaryDirectory() as temp:
            config, backup = Path(temp) / 'configuration_system.lua', Path(temp) / 'backup'
            config.write_bytes(self.CONFIG)
            with patch.multiple(self.recorder, GAME_CONFIG=config, CONFIG_BACKUP=backup, STEAM_EXE=Path('steam.exe'),
                                stage_replay=Mock(return_value='replay.rec')), \
                    patch.object(self.recorder.ai, 'game_pid', Mock(return_value=None), create=True), \
                    patch.object(self.recorder.subprocess, 'Popen', side_effect=launch):
                self.recorder.lower_graphics()  # the lowered run dies here: no restore
                with self.assertRaisesRegex(RuntimeError, 'stop after launch'):
                    self.recorder.record(Path('replay.rec'), replay, 125.0, keep_open=True)
            self.assertEqual(launched, [self.CONFIG])
            self.assertFalse(backup.exists())


if __name__ == '__main__':
    unittest.main()
