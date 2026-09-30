import json
import unittest
from pathlib import Path
from unittest.mock import patch
from swe_machine import project_tool_pins

class DevelopmentToolsTest(unittest.TestCase):
    def test_pins_follow_project_versions_instead_of_latest_environment(self):
        document={'black':'22.10.0','isort':'v5.10.1','flake8':'5.0.4'}
        with patch('swe_machine.subprocess.check_output',return_value=json.dumps(document)):
            self.assertEqual(project_tool_pins(Path('/repo'),Path('/python')),['black==22.10.0','flake8==5.0.4','isort==5.10.1'])

    def test_missing_tools_and_non_version_revisions_fail_closed(self):
        for document in [{'black':'22.10.0'}, {'black':'main','isort':'5.10.1','flake8':'5.0.4'}, {'black':None,'isort':'5.10.1','flake8':'5.0.4'}]:
            with patch('swe_machine.subprocess.check_output',return_value=json.dumps(document)):
                with self.assertRaises(ValueError):project_tool_pins(Path('/repo'),Path('/python'))
