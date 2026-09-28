import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from verifier import verify


class VerifierTest(unittest.TestCase):
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

    def test_wrapper_failure_without_pytest_report_is_not_a_wrong_answer(self):
        grade, text = self.run_check("import sys; print('sandbox failed'); sys.exit(1)", report=False)
        self.assertEqual(grade, 'unavailable')
        self.assertIn('No valid pytest report', text)
        self.assertEqual(self.run_check("import sys; sys.exit(1)")[0], 'unavailable')
