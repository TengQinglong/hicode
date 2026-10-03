import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from swe import project_environment,xarray_arm_reporting
from xarray_report import report_arm_passes


class XarrayEnvironmentTest(unittest.TestCase):
    def test_upstream_ancestry_version_is_separate_from_synthetic_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'.git').mkdir();metadata=root/'metadata';metadata.mkdir()
            receipt={'baseCommit':'a'*40,'describe':'v0.15.1-110-ga64cf2d5','version':'0.15.2.dev110+ga64cf2d5'}
            (root/'.git/hicode-source-version.json').write_text(json.dumps(receipt))
            self.assertEqual(receipt['version'],'0.15.2.dev110+ga64cf2d5')
            self.assertEqual(project_environment('pydata/xarray',root),{'SETUPTOOLS_SCM_PRETEND_VERSION':receipt['version']})
            receipt['version']='999\nPRIVATE_TOKEN=bad';(root/'.git/hicode-source-version.json').write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):project_environment('pydata/xarray',root)
        with self.assertRaises(ValueError):project_environment('pydata/xarray')

    def test_arm_policy_requires_original_marker_and_actual_passed_assertion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);p=root/'xarray/tests';p.mkdir(parents=True)
            (p/'__init__.py').write_text('arm_xfail=pytest.mark.xfail(platform.machine()=="aarch64" or "arm" in platform.machine(),reason="expected failure on ARM")')
            (p/'test_duck_array_ops.py').write_text('@arm_xfail\ndef test_datetime_mean(): pass\n')
            with patch('swe.platform.machine',return_value='aarch64'):self.assertTrue(xarray_arm_reporting(root))
            with patch('swe.platform.machine',return_value='x86_64'):self.assertFalse(xarray_arm_reporting(root))
            (p/'__init__.py').write_text('arm_xfail=pytest.mark.xfail(True,reason="other")')
            with patch('swe.platform.machine',return_value='aarch64'):self.assertFalse(xarray_arm_reporting(root))
        known='xarray/tests/test_duck_array_ops.py::test_datetime_mean[True]'
        valid=SimpleNamespace(nodeid=known,when='call',outcome='passed',wasxfail='expected failure on ARM')
        other=SimpleNamespace(nodeid='other',when='call',outcome='passed',wasxfail='expected failure on ARM')
        failed=SimpleNamespace(nodeid=known,when='call',outcome='failed',wasxfail='expected failure on ARM')
        lines=[];reporter=SimpleNamespace(stats={'xpassed':[valid,other,failed]},write_line=lines.append)
        with patch('xarray_report.platform.machine',return_value='aarch64'):report_arm_passes(reporter)
        self.assertEqual(lines,['PASSED '+known])
