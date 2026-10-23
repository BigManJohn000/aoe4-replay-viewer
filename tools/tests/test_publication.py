import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import atomicio
import fetch_replays
import harvest


class PublicationTests(unittest.TestCase):
    def test_invalid_download_is_quarantined_not_published(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'game.rec'
            path.write_bytes(b'previous publication')
            with self.assertRaises(fetch_replays.InvalidReplay):
                fetch_replays.publish_replay(path, b'HTTP 200 error page')
            self.assertEqual(path.read_bytes(), b'previous publication')
            self.assertEqual(path.with_suffix('.rec.bad').read_bytes(), b'HTTP 200 error page')
            self.assertEqual(list(Path(temp).glob('*.tmp')), [])

    def test_valid_download_is_parsed_before_replacing(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'game.rec'
            path.write_bytes(b'old')
            def load(temporary):
                self.assertEqual(path.read_bytes(), b'old')
                self.assertNotEqual(temporary, path)
                self.assertEqual(temporary.read_bytes(), b'new')
                return SimpleNamespace(version=11308)
            with patch.object(fetch_replays.recfile, 'load', side_effect=load):
                replay = fetch_replays.publish_replay(path, b'new')
            self.assertEqual(replay.version, 11308)
            self.assertEqual(path.read_bytes(), b'new')

    def test_invalid_existing_replay_is_not_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'game.rec'
            path.write_bytes(b'error page')
            self.assertIsNone(fetch_replays.existing_replay(path))
            self.assertFalse(path.exists())
            self.assertTrue(path.with_suffix('.rec.bad').exists())

    def test_harvest_invalid_download_remains_retryable(self):
        with tempfile.TemporaryDirectory() as temp, sqlite3.connect(':memory:') as con:
            con.executescript(harvest.SCHEMA)
            root = Path(temp)
            with patch.object(harvest, 'ROOT', root), patch.object(harvest, 'REPLAYS', root / 'replays'), \
                    patch.object(harvest, 'get', return_value=b'not a replay'), patch.object(harvest, 'log'):
                self.assertEqual(harvest.download_replay(con, 123, 456, 0), -2)
            self.assertEqual(con.execute('select status,build from replays').fetchone(), (-2, None))
            self.assertEqual(con.execute('select game_id from replays where status not between 200 and 499').fetchall(),
                             [(123,)])
            self.assertTrue((root / 'replays' / 'aoe4_123.rec.bad').exists())

    def test_harvest_persists_validated_build(self):
        with tempfile.TemporaryDirectory() as temp, sqlite3.connect(':memory:') as con:
            con.executescript(harvest.SCHEMA)
            root = Path(temp)
            with patch.object(harvest, 'ROOT', root), patch.object(harvest, 'REPLAYS', root / 'replays'), \
                    patch.object(harvest, 'get', return_value=b'replay'), \
                    patch.object(fetch_replays.recfile, 'load', return_value=SimpleNamespace(version=11308)):
                self.assertEqual(harvest.download_replay(con, 123, 456, 0), 200)
            self.assertEqual(con.execute('select status,build from replays').fetchone(), (200, 11308))

    def test_atomic_failure_preserves_previous_output(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'output.json'
            path.write_text('{"old":true}', encoding='utf-8')
            with patch.object(atomicio.os, 'replace', side_effect=OSError('locked')):
                with self.assertRaises(OSError):
                    atomicio.atomic_write_text(path, '{"new":true}')
            self.assertEqual(json.loads(path.read_text()), {'old': True})
            self.assertEqual(list(Path(temp).glob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
