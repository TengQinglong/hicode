import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from swe import project_environment,xarray_arm_reporting
from xarray_setup import dependency_pins,source_version,public_preflight
from xarray_report import report_arm_passes,PublicProof


class XarrayEnvironmentTest(unittest.TestCase):
    def test_missing_optional_dependencies_are_part_of_preparation_not_a_skip_policy(self):
        declaration='dependencies:\n'+''.join(' - '+name+'\n' for name in ('bottleneck','cftime','sparse','pint','numba','numexpr','numbagg','iris'))
        pins=dependency_pins(declaration)
        self.assertIn('pint==0.19.2',pins);self.assertIn('cftime==1.6.4',pins)
        self.assertNotIn('flox==0.6.10',pins)
        self.assertIn('flox==0.6.10',dependency_pins(declaration+' - flox\n'))
        with self.assertRaises(ValueError):dependency_pins('dependencies:\n - numpy\n')

    def test_upstream_ancestry_version_is_separate_from_synthetic_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'.git').mkdir();metadata=root/'metadata';metadata.mkdir()
            with patch('xarray_setup.subprocess.run',return_value=SimpleNamespace(returncode=0)),patch('xarray_setup.subprocess.check_output',side_effect=['v0.15.1-110-ga64cf2d5\n','2020-01-01T00:00:00+00:00\n','0.15.2.dev110+ga64cf2d5\n']):
                receipt=source_version(root,'a'*40,'/python',metadata)
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
        proof=PublicProof('/unused',True)
        with patch('xarray_report.platform.machine',return_value='aarch64'):
            for r in [valid,other,failed]:proof.pytest_runtest_logreport(r)
        self.assertEqual(proof.outcomes[known],'expected-or-unexpected-failure')
        self.assertEqual(proof.outcomes['other'],'expected-or-unexpected-failure')

    def test_public_preflight_rejects_missing_or_skipped_original_regressions(self):
        node='xarray/tests/test_example.py::test_regression'
        row={'PASS_TO_PASS':[node],'base_commit':'a'*40}
        for outcomes in [{},{node:'skipped'},{node:'passed'}]:
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)
                def execute(argv,**kwargs):
                    if '--collect-only' in argv:(root/'public-collection.json').write_text(json.dumps({'nodes':[node],'skipped':[]}))
                    else:(root/'public-regressions.json').write_text(json.dumps(outcomes))
                with patch('xarray_setup.__file__',str(root/'setup.py')):
                    (root/'xarray_report.py').write_text('# fixture')
                    if outcomes.get(node)=='passed':self.assertTrue(public_preflight(row,root,'/env',root,execute)['passed'])
                    else:
                        with self.assertRaisesRegex(ValueError,'Incomplete public'):public_preflight(row,root,'/env',root,execute)
