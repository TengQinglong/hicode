import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from cleanup import finalize_task, stop_task_processes


class CleanupTest(unittest.TestCase):
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
