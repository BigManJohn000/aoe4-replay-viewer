import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import runlock


class RunLockTests(unittest.TestCase):
    def test_competing_process_is_refused_and_nested_hold_works(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runlock, 'LOCK_DIR', Path(temp)):
            with runlock.hold('recording'):
                with runlock.hold('recording'):
                    self.assertEqual(runlock.active('recording'), [os.getpid()])
                code = (f'import sys;sys.path.insert(0,{str(TOOLS)!r});import runlock;from pathlib import Path;'
                        f'runlock.LOCK_DIR=Path({temp!r});\n'
                        'try:\n'
                        '    with runlock.hold("recording"): pass\n'
                        'except runlock.LockError as e:\n'
                        '    print(e);sys.exit(23)\n')
                child = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=15)
                self.assertEqual(child.returncode, 23, child.stderr)
                self.assertIn('Another live process holds the recording lock', child.stdout)
            self.assertEqual(runlock.active('recording'), [])
            with runlock.hold('recording'):
                self.assertEqual(runlock.active('recording'), [os.getpid()])


if __name__ == '__main__':
    unittest.main()
