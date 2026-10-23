import ctypes
import importlib.util
import sys
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


if __name__ == '__main__':
    unittest.main()
