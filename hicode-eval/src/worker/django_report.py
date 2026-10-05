"""Run the original Django test script without evaluating subtest parameters for display."""
from contextlib import contextmanager
from pathlib import Path
import runpy
import sys
import unittest


@contextmanager
def stable_subtest_descriptions():
    original = unittest.TextTestResult.getDescription

    def describe(result, test):
        if isinstance(test, unittest.case._SubTest):
            # QuerySets and other lazy parameters can perform work in __repr__.
            # Keep the parent test identity and original traceback; formatting
            # must not execute another query or hide the recorded failure.
            return original(result, test.test_case) + ' [subtest parameters omitted]'
        return original(result, test)

    unittest.TextTestResult.getDescription = describe
    try:
        yield
    finally:
        unittest.TextTestResult.getDescription = original


if __name__ == '__main__':
    sys.argv = sys.argv[1:]
    sys.path.insert(0, str(Path(sys.argv[0]).resolve().parent))
    with stable_subtest_descriptions():
        runpy.run_path(sys.argv[0], run_name='__main__')
