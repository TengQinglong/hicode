import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from verifier import verify, display_output, verifier_environment


class VerifierTest(unittest.TestCase):
    def test_verifier_keeps_its_pins_first_and_sees_task_installed_dependencies(self):
        env=verifier_environment({'packages':['x==1'],'verifierPackages':['x==2']},Path('/task/home'))
        self.assertEqual(env['PYTHONPATH'].split(os.pathsep),['/app/.eval-verifier-python','/app/.eval-python','/task/home/.local/lib/python3.13/site-packages'])
        self.assertEqual(env['PATH'].split(os.pathsep)[:4],['/opt/hicode-verifier/bin','/opt/python313/bin','/task/home/.local/bin','/task/home/bin'])
        self.assertEqual(verifier_environment({},Path('/task/home'))['PYTHONPATH'],'/task/home/.local/lib/python3.13/site-packages')
    def run_check(self, code, timeout=5, cancel=False, failed=False, report=True):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output.txt'
            counts = {'passed': 0 if failed else 1, 'failed': 1 if failed else 0, 'skipped': 0, 'pending': 0, 'other': 0, 'tests': 1}
            data = {'results': {'summary': counts, 'tests': [{'status': 'failed' if failed else 'passed'}]}}
            prefix = 'from pathlib import Path; Path("ctrf.json").write_text(' + repr(json.dumps(data)) + ');' if report else ''
            grade, text = verify([sys.executable, '-c', prefix + code], timeout=timeout,
                                 output_path=output, report_path=Path(directory) / 'ctrf.json', cwd=directory, env=os.environ.copy(),
                                 preexec_fn=None, cancelled=lambda: cancel)
            self.assertEqual(text, output.read_text())
            return grade, text

    def test_pass_and_assertion_failure(self):
        self.assertEqual(self.run_check("print('all checks passed')")[0], 'passed')
        grade, text = self.run_check("import sys; print('assertion failed'); sys.exit(1)", failed=True)
        self.assertEqual(grade, 'failed')
        self.assertIn('assertion failed', text)

    def test_internal_errors_and_no_tests_have_no_score(self):
        for code in [2, 3, 4, 5, 127]:
            with self.subTest(code=code):
                grade, text = self.run_check(f'import sys; sys.exit({code})')
                self.assertEqual(grade, 'unavailable')
                self.assertIn(f'exit {code}', text)

    def test_timeout_and_cancel_have_no_score(self):
        code = "import time; print('starting', flush=True); time.sleep(10)"
        grade, text = self.run_check(code, timeout=.3)
        self.assertEqual(grade, 'unavailable')
        self.assertIn('starting', text)
        self.assertIn('timed out', text)
        grade, text = self.run_check(code, cancel=True)
        self.assertEqual(grade, 'unavailable')
        self.assertIn('cancelled', text)

    def test_missing_executable_has_no_score(self):
        with tempfile.TemporaryDirectory() as directory:
            grade, text = verify([directory + '/missing'], timeout=1,
                                 output_path=Path(directory) / 'output.txt', report_path=Path(directory) / 'ctrf.json', cwd=directory,
                                 env={}, preexec_fn=None, cancelled=lambda: False)
            self.assertEqual(grade, 'unavailable')
            self.assertIn('could not start', text)

    def test_warning_display_preserves_failure_and_score_and_keeps_raw_log(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'output.txt'
            raw='E AssertionError: actual != expected\n=== warnings summary ===\n' + 'third party warning\n'*582 + '-- Docs: pytest\n=== 1 failed, 582 warnings ===\n'
            path.write_text(raw)
            visible=display_output(path)
            self.assertIn('AssertionError',visible)
            self.assertIn('Warnings: 582',visible)
            self.assertIn('1 failed',visible)
            self.assertNotIn('third party warning',visible)
            self.assertEqual(path.read_text(),raw)

    def test_wrapper_failure_without_pytest_report_is_not_a_wrong_answer(self):
        grade, text = self.run_check("import sys; print('sandbox failed'); sys.exit(1)", report=False)
        self.assertEqual(grade, 'unavailable')
        self.assertIn('No valid pytest report', text)
        self.assertEqual(self.run_check("import sys; sys.exit(1)")[0], 'unavailable')
