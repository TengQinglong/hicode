"""Offline real pytest/official parser regression; no dataset solutions or models."""
import os
import platform
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform=='linux' and platform.machine() in {'aarch64','arm64'} and os.environ.get('HICODE_XARRAY_SMOKE')=='1','Requires ARM Linux pytest and pinned official harness')
class XarrayParserTest(unittest.TestCase):
    def test_verified_arm_xpass_is_reported_last_but_unrelated_and_strict_failures_remain(self):
        python=os.environ['HICODE_XARRAY_TEST_PYTHON'];grader=os.environ['HICODE_XARRAY_GRADER_PYTHON']
        plugin=Path(__file__).resolve().parents[1]/'src/worker/xarray_report.py'
        with tempfile.TemporaryDirectory(prefix='xarray-report-') as tmp:
            root=Path(tmp);tests=root/'xarray/tests';tests.mkdir(parents=True)
            (root/'hicode_platform_report.py').write_bytes(plugin.read_bytes())
            (tests/'test_duck_array_ops.py').write_text('''import pytest
@pytest.mark.xfail(True,reason="expected failure on ARM")
@pytest.mark.parametrize("flag",[False,True])
def test_datetime_mean(flag):assert True
@pytest.mark.xfail(True,reason="expected failure on ARM")
def test_other():assert True
@pytest.mark.xfail(True,reason="expected failure on ARM",strict=True)
def test_strict():assert True
''')
            result=subprocess.run([python,'-m','pytest','-rA','-p','hicode_platform_report','xarray/tests/test_duck_array_ops.py'],cwd=root,
                                  env={**os.environ,'PYTHONPATH':str(root)},capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,1,result.stdout+result.stderr)
            output=root/'output.txt';output.write_text(result.stdout)
            known='xarray/tests/test_duck_array_ops.py::test_datetime_mean[True]'
            self.assertGreater(result.stdout.index('PASSED '+known),result.stdout.index('XPASS '+known))
            script='''import sys
from swebench.harness.log_parsers.python import parse_log_pytest
statuses=parse_log_pytest(open(sys.argv[1]).read(),None)
assert statuses['xarray/tests/test_duck_array_ops.py::test_datetime_mean[False]']=='PASSED'
assert statuses['xarray/tests/test_duck_array_ops.py::test_datetime_mean[True]']=='PASSED'
assert 'PASSED'!=statuses.get('xarray/tests/test_duck_array_ops.py::test_other')
assert statuses['xarray/tests/test_duck_array_ops.py::test_strict']=='FAILED'
print('ORIGINAL_PYTEST_AND_OFFICIAL_PARSER_OK')
'''
            parsed=subprocess.run([grader,'-c',script,str(output)],capture_output=True,text=True,timeout=30)
            self.assertEqual(parsed.returncode,0,parsed.stdout+parsed.stderr)
