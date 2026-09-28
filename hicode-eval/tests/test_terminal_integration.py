import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from terminal import capture, settle


@unittest.skipUnless(os.environ.get('HICODE_EVAL_TMUX_INTEGRATION') == '1' and shutil.which('tmux'),
                     'Requires opt-in local tmux integration')
class TerminalIntegrationTest(unittest.TestCase):
    def test_completion_before_final_pty_output(self):
        with tempfile.TemporaryDirectory(prefix='eval-terminal-') as directory:
            root = Path(directory)
            socket = str(root / 'tmux.sock')
            script = root / 'paint.py'
            ready = root / 'ready'
            script.write_text('import time\nfrom pathlib import Path\n'
                              'print("Generating response...",flush=True)\n'
                              f'Path({str(ready)!r}).touch()\n'
                              'time.sleep(.7)\n'
                              'print("\\x1b[2J\\x1b[HComplete final answer\\nWorked for 1s",flush=True)\n'
                              'time.sleep(15)\n')
            def tmux(*args, timeout=2):
                return subprocess.check_output(['tmux', '-S', socket, *args], text=True, timeout=timeout)
            try:
                tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'hicode', '-x', '140', '-y', '40',
                     'exec ' + shlex.join([sys.executable, str(script)]))
                deadline = time.monotonic() + 5
                while not ready.exists():
                    if time.monotonic() >= deadline: self.fail('PTY did not start')
                    time.sleep(.01)
                packets = []
                self.assertTrue(settle(tmux, lambda kind, **p: packets.append(p['screen']), lambda: False))
                self.assertIn('Complete final answer', packets[-1])
                self.assertIn('Worked for 1s', packets[-1])
                # Clear-screen may move the old frame into tmux scrollback; preserve that history.
                self.assertEqual([line for line in packets[-1].splitlines() if line][-2:],
                                 ['Complete final answer', 'Worked for 1s'])
                self.assertEqual(capture(tmux, lambda *a, **kw: None), packets[-1])
            finally:
                subprocess.run(['tmux', '-S', socket, 'kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
