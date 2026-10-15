import json
import tempfile
import os
import signal
import subprocess
import sys
import shutil
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from protocol import hicode_command
from cleanup import finalize_task, stop_task_processes, open_task_cli, task_cli_exited, terminate_task_cli


class CleanupTest(unittest.TestCase):
    def test_liveness_uses_the_pinned_identity_and_rejects_an_invalid_fd(self):
        with patch('cleanup.select.select', return_value=([], [], [])) as poll:
            self.assertFalse(task_cli_exited(7))
            poll.assert_called_once_with([7], [], [], 0)
        with patch('cleanup.select.select', return_value=([7], [], [])):
            self.assertTrue(task_cli_exited(7))
        with patch('cleanup.select.select', side_effect=OSError('bad fd')):
            with self.assertRaises(OSError):task_cli_exited(7)

    def test_graceful_signal_drains_events_before_confirming_exit(self):
        reads = Mock(return_value=False)
        with patch('cleanup.signal.pidfd_send_signal', create=True) as send, patch('cleanup.select.select', side_effect=[([], [], []), ([7], [], [])]):
            self.assertTrue(terminate_task_cli(7, reads))
        send.assert_called_once_with(7, signal.SIGTERM)
        self.assertGreaterEqual(reads.call_count, 3)

    def test_grace_window_is_bounded_and_never_sends_sigkill(self):
        clock = iter([0, 0, 11])
        with patch('cleanup.signal.pidfd_send_signal', create=True) as send, patch('cleanup.select.select', return_value=([], [], [])), patch('cleanup.time.monotonic', side_effect=lambda: next(clock)):
            self.assertFalse(terminate_task_cli(7, lambda: False))
        send.assert_called_once_with(7, signal.SIGTERM)

    def test_cli_identity_matches_the_generated_command_including_bun_options(self):
        command = hicode_command('/release', '/logs/events.jsonl', 'full-access', {'source':'qwen','model':'offline-smoke'})
        cli = self.process()
        cli.joinpath.return_value.read_bytes.return_value = b'/usr/local/bin/bun\0' + b'\0'.join(os.fsencode(arg) for arg in command[1:]) + b'\0'
        with patch('cleanup.Path.iterdir', return_value=[cli]), patch('cleanup.os.pidfd_open', return_value=7, create=True), patch('cleanup.os.close') as close:
            self.assertEqual(open_task_cli(20001, command), 7)
            close.assert_not_called()
        for index, replacement in [(2, '/other/tsconfig.json'), (3, '/other/src/index.tsx'), (6, '/other/events.jsonl')]:
            wrong = command.copy(); wrong[index] = replacement
            with self.subTest(index=index), patch('cleanup.Path.iterdir', return_value=[cli]), patch('cleanup.os.pidfd_open', return_value=7, create=True), patch('cleanup.os.close') as close:
                with self.assertRaisesRegex(RuntimeError, 'uniquely identify'): open_task_cli(20001, wrong)
                close.assert_called_once_with(7)
        cli.stat.return_value = SimpleNamespace(st_uid=20002)
        with patch('cleanup.Path.iterdir', return_value=[cli]), patch('cleanup.os.pidfd_open', create=True) as pin:
            with self.assertRaisesRegex(RuntimeError, 'uniquely identify'): open_task_cli(20001, command)
            pin.assert_not_called()

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open') and shutil.which('bun') and os.getuid() == 0,
                         'Requires Linux evaluation machine for UID/pidfd smoke test')
    def test_real_task_cli_flushes_before_exit_or_is_bounded_if_it_ignores_term(self):
        for ignores in [False, True]:
            with self.subTest(ignores=ignores), tempfile.TemporaryDirectory(prefix='eval-stop-') as tmp:
                root = Path(tmp); os.chown(root, 65534, 65534); os.chmod(root, 0o700)
                (root/'src').mkdir(); (root/'tsconfig.json').write_text('{}'); script = root/'src/index.tsx'; events = root/'events.jsonl'
                script.write_text("process.on('SIGTERM', async () => {" + ("" if ignores else "await Bun.write(process.argv[process.argv.indexOf('--event-log') + 1], 'flushed'); process.exit(143);") + "}); console.log('READY'); setInterval(() => {}, 1000);")
                def demote(): os.setgroups([]); os.setgid(65534); os.setuid(65534)
                command = hicode_command(root, events, 'full-access', {'source':'qwen','model':'offline-smoke'})
                child = subprocess.Popen(command, preexec_fn=demote, stdout=subprocess.PIPE, text=True)
                fd = None
                try:
                    self.assertEqual(child.stdout.readline().strip(), 'READY')
                    fd = open_task_cli(65534, command)
                    self.assertFalse(task_cli_exited(fd))
                    self.assertEqual(terminate_task_cli(fd, lambda: False, grace_seconds=.3 if ignores else 3), not ignores)
                    if not ignores:
                        self.assertTrue(task_cli_exited(fd))
                        self.assertEqual(child.wait(timeout=3), 143)
                        self.assertEqual(events.read_text(), 'flushed')
                    else: self.assertIsNone(child.poll())
                finally:
                    if fd is not None: os.close(fd)
                    child.kill(); child.wait(); child.stdout.close()

    def process(self, uid=20001, state='S'):
        p = Mock()
        p.name = '1234'
        p.stat.return_value = SimpleNamespace(st_uid=uid)
        p.joinpath.return_value.read_text.return_value = '1234 (worker name) ' + state + ' 1 2'
        return p

    def test_process_disappearing_during_verification_is_already_stopped(self):
        p = self.process()
        p.joinpath.return_value.read_text.side_effect = ProcessLookupError(3, 'No such process')
        with patch('cleanup.Path.iterdir', return_value=[p]), patch('cleanup.os.kill') as kill:
            stop_task_processes(20001)
        kill.assert_called_once()

    def test_missing_proc_entry_and_exited_kill_are_tolerated(self):
        p = self.process()
        p.stat.side_effect = [SimpleNamespace(st_uid=20001), FileNotFoundError()]
        with patch('cleanup.Path.iterdir', return_value=[p]), patch('cleanup.os.kill', side_effect=ProcessLookupError()):
            stop_task_processes(20001)

    def test_other_users_are_untouched_and_zombies_do_not_block(self):
        other = self.process(20002)
        zombie = self.process(state='Z')
        with patch('cleanup.Path.iterdir', return_value=[other, zombie]), patch('cleanup.os.kill') as kill:
            stop_task_processes(20001)
        self.assertEqual(kill.call_count, 1)
        other.joinpath.assert_not_called()

    def test_permission_failures_and_live_survivors_are_not_ignored(self):
        p = self.process()
        with patch('cleanup.Path.iterdir', return_value=[p]), patch('cleanup.os.kill', side_effect=PermissionError()):
            with self.assertRaises(PermissionError): stop_task_processes(20001)
        with patch('cleanup.Path.iterdir', return_value=[p]), patch('cleanup.os.kill'), patch('cleanup.time.sleep'):
            with self.assertRaisesRegex(RuntimeError, 'could not be stopped'): stop_task_processes(20001)
        with self.assertRaises(ValueError): stop_task_processes(0)

    def test_outcome_survives_failed_cleanup_but_is_not_a_completion_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = {'execution': 'completed', 'grading': 'passed', 'uid': 20001}
            with patch('cleanup.stop_task_processes', side_effect=PermissionError('blocked')):
                with self.assertRaises(PermissionError): finalize_task(root, result)
            self.assertEqual(json.loads((root/'outcome.json').read_text()), result)
            self.assertFalse((root/'result.json').exists())
            with patch('cleanup.stop_task_processes'):
                finalize_task(root, result)
            self.assertEqual(json.loads((root/'result.json').read_text()), result)
