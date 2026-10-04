import io
import unittest
from swe import normalize_django_log, verification_validity
from types import SimpleNamespace

START = '>>>>> Start Test Output'
END = '>>>>> End Test Output'


class DjangoLogTest(unittest.TestCase):
    def test_body_exception_is_failure_but_setup_error_stays_unavailable(self):
        class Cases(unittest.TestCase):
            def setUp(self):
                if self._testMethodName == 'test_setup':
                    raise ImportError('environment missing')
            def test_body(self):
                """Descriptive target name."""
                raise AttributeError('missing application attribute')
            def test_setup(self):
                pass
            def test_teardown(self):
                pass
            def tearDown(self):
                if self._testMethodName == 'test_teardown':
                    raise RuntimeError('environment cleanup failed')
        stream=io.StringIO()
        suite=unittest.defaultTestLoader.loadTestsFromTestCase(Cases)
        names={test._testMethodName:str(test) for test in suite}
        unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
        body=stream.getvalue().replace(__file__,'/testbed/tests/test_report.py')
        expected=[*names.values(),'Descriptive target name.']
        results=self.canonical(body,expected)
        self.assertEqual(results[names['test_body']],'FAIL')
        self.assertEqual(results['Descriptive target name.'],'FAIL')
        self.assertEqual(results[names['test_setup']],'ERROR')
        self.assertEqual(results[names['test_teardown']],'ERROR')

    def canonical(self, body, expected):
        raw = START + '\n' + body + '\n' + END
        fixed = normalize_django_log(raw, expected)
        # Canonical records must lie inside the upstream parser's marker window.
        extra = fixed[len(START) + 1 + len(body):fixed.index(END)].strip()
        self.assertTrue(fixed.startswith(START + '\n' + body))
        return dict(line.rsplit(' ... ', 1) for line in extra.splitlines()) if extra else {}

    def test_real_subtest_failure_and_next_test_on_same_line(self):
        class Example(unittest.TestCase):
            def test_a(self):
                for value in [1, 2]:
                    with self.subTest(value=value):
                        self.assertEqual(value, 0)
            def test_b(self):
                pass
        stream = io.StringIO()
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(Example)
        expected = [str(test) for test in suite]
        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
        self.assertEqual(len(result.failures), 2)
        self.assertEqual(self.canonical(stream.getvalue(), expected),
                         {expected[0]: 'FAIL', expected[1]: 'ok'})

    def test_descriptive_id_and_following_pass_are_separate(self):
        body = ('test_year (app.First)\n'
                'Uses a BETWEEN filter ... test_after (app.First) ... ok\n'
                'test_year (app.Second)\nUses a BETWEEN filter ... ok\n'
                'FAIL: test_year (app.First) [iso_year]\nUses a BETWEEN filter\n'
                'AssertionError: expected BETWEEN\nRan 3 tests\nFAILED (failures=1)')
        self.assertEqual(self.canonical(body, ['Uses a BETWEEN filter', 'test_after (app.First)']),
                         {'Uses a BETWEEN filter': 'FAIL', 'test_after (app.First)': 'ok'})

    def test_failed_parent_does_not_hide_error_or_skipped_test(self):
        body = ('test_a (app.Tests) ... test_b (app.Tests) ... skipped "optional"\n'
                'FAIL: test_a (app.Tests) (value=1)\nAssertionError\n'
                'ERROR: test_a (app.Tests) (value=2)\nImportError')
        self.assertEqual(self.canonical(body, ['test_a (app.Tests)', 'test_b (app.Tests)']),
                         {'test_a (app.Tests)': 'ERROR', 'test_b (app.Tests)': 'skipped'})

    def test_unfinished_tests_are_not_invented_or_copied_from_setup_output(self):
        body = 'test_missing (app.Tests) ... test_after (app.Tests) ... ok\n'
        self.assertEqual(self.canonical(body, ['test_missing (app.Tests)', 'test_after (app.Tests)']),
                         {'test_after (app.Tests)': 'ok'})
        raw = 'test_missing (app.Tests) ... ok\n' + START + '\nImportError\n' + END
        self.assertEqual(normalize_django_log(raw, ['test_missing (app.Tests)']), raw)
        for raw in [body, START + body, END + body + START, START + body + END + END]:
            self.assertEqual(normalize_django_log(raw, ['test_missing (app.Tests)']), raw)
        spec = SimpleNamespace(FAIL_TO_PASS=['test_missing'], PASS_TO_PASS=['test_after'])
        self.assertFalse(verification_validity(spec, {'test_after': 'PASSED'}, True, 1)[0])

    def test_class_setup_error_does_not_overwrite_previous_completed_test(self):
        class Passing(unittest.TestCase):
            def test_ok(self):
                pass
        class Broken(unittest.TestCase):
            @classmethod
            def setUpClass(cls):
                raise TypeError('unsupported constructor argument')
            def test_not_run(self):
                pass
        stream = io.StringIO()
        passed = unittest.defaultTestLoader.loadTestsFromTestCase(Passing)
        broken = unittest.defaultTestLoader.loadTestsFromTestCase(Broken)
        expected = [str(test) for test in [*passed, *broken]]
        unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.TestSuite([passed, broken]))
        self.assertEqual(self.canonical(stream.getvalue(), expected), {expected[0]: 'ok'})
        self.assertEqual(self.canonical(f'{expected[0]} ... ok\nERROR\n'
                                       'ERROR: setUpClass (app.Other)\nTypeError', expected),
                         {expected[0]: 'ok'})


if __name__ == '__main__':
    unittest.main()
