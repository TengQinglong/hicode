import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from swe import git,restore_official_test_paths,controlled_eval_script,verification_validity,project_environment,namespace_eval_commands,verifier_log_directory
from reviewed_test_deps import reviewed_test_dependencies

class OfficialTestReplay(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.repo=self.root/'repo';self.repo.mkdir()
        (self.repo/'tests').mkdir();(self.repo/'tests/old.py').write_text('original\n');(self.repo/'production.py').write_text('original\n')
        git(['init','--template='],self.repo);git(['add','-A'],self.repo);git(['commit','-qm','baseline'],self.repo)
        self.base=git(['rev-parse','HEAD'],self.repo).decode().strip()
    def tearDown(self):self.tmp.cleanup()
    def test_runner_precreated_verifier_directory_is_reused_without_overwriting_evidence(self):
        logs=self.root/'logs/verifier';logs.mkdir(parents=True)
        self.assertEqual(verifier_log_directory(self.root),logs)
        (logs/'output.txt').write_text('prior evidence')
        with self.assertRaisesRegex(ValueError,'already contains evidence'):
            verifier_log_directory(self.root)
        self.assertEqual((logs/'output.txt').read_text(),'prior evidence')
        (logs/'output.txt').unlink();logs.rmdir()
        logs.symlink_to(self.repo, target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'not a directory'):
            verifier_log_directory(self.root)
    def official_patch(self):
        (self.repo/'tests/old.py').write_text('official\n');(self.repo/'tests/new.py').write_text('official new\n')
        git(['add','-A'],self.repo)
        text=git(['diff','--cached','--binary','HEAD'],self.repo).decode()
        git(['reset','--hard','HEAD'],self.repo)
        return text
    def test_existing_and_new_conflicts_reset_without_touching_model_production_or_evidence(self):
        text=self.official_patch();(self.repo/'tests/old.py').write_text('model test\n');(self.repo/'tests/new.py').write_text('model new\n');(self.repo/'production.py').write_text('model production\n')
        before=text
        paths=restore_official_test_paths(self.repo,self.base,text)
        self.assertEqual(paths,['tests/new.py','tests/old.py']);self.assertEqual((self.repo/'tests/old.py').read_text(),'original\n');self.assertFalse((self.repo/'tests/new.py').exists())
        git(['apply','-'],self.repo,text.encode())
        self.assertEqual((self.repo/'tests/new.py').read_text(),'official new\n');self.assertEqual((self.repo/'production.py').read_text(),'model production\n');self.assertEqual(text,before)
    def test_symlink_parent_and_git_metadata_rejected_before_any_reset(self):
        text=self.official_patch();shutil.rmtree(self.repo/'tests');(self.repo/'tests').symlink_to(self.root)
        with self.assertRaisesRegex(ValueError,'safe directory'):restore_official_test_paths(self.repo,self.base,text)
        (self.repo/'tests').unlink();(self.repo/'tests').mkdir();(self.repo/'tests/old.py').write_text('unchanged\n')
        bad=text.replace('tests/new.py','.git/config')
        with self.assertRaisesRegex(ValueError,'boundaries'):restore_official_test_paths(self.repo,self.base,bad)
        self.assertEqual((self.repo/'tests/old.py').read_text(),'unchanged\n')
    def test_official_support_paths_replayed_without_resetting_unrelated_model_changes(self):
        (self.repo/'library').mkdir()
        (self.repo/'library/helper.py').write_text('baseline helper\n')
        git(['add','-A'],self.repo);git(['commit','-qm','support baseline'],self.repo)
        base=git(['rev-parse','HEAD'],self.repo).decode().strip()
        (self.repo/'library/helper.py').write_text('official helper\n')
        (self.repo/'root_fixture.py').write_text('official fixture\n')
        git(['add','-A'],self.repo)
        text=git(['diff','--cached','--binary',base],self.repo).decode()
        git(['reset','--hard',base],self.repo)
        (self.repo/'library/helper.py').write_text('model helper\n')
        (self.repo/'root_fixture.py').write_text('model fixture\n')
        (self.repo/'production.py').write_text('model fix\n')
        self.assertEqual(restore_official_test_paths(self.repo,base,text),
                         ['library/helper.py','root_fixture.py'])
        git(['apply','-'],self.repo,text.encode())
        self.assertEqual((self.repo/'library/helper.py').read_text(),'official helper\n')
        self.assertEqual((self.repo/'root_fixture.py').read_text(),'official fixture\n')
        self.assertEqual((self.repo/'production.py').read_text(),'model fix\n')
    def test_model_symlink_at_test_file_is_removed_without_reading_target(self):
        text=self.official_patch();(self.repo/'tests/new.py').symlink_to('/etc/passwd')
        restore_official_test_paths(self.repo,self.base,text);git(['apply','-'],self.repo,text.encode())
        self.assertEqual((self.repo/'tests/new.py').read_text(),'official new\n')
    def script(self,setup,test):
        text=self.official_patch()
        commands=[setup,f'git checkout {self.base} tests/old.py',f"git apply -v - <<'PATCH'\n{text}\nPATCH",": '>>>>> Start Test Output'",test,": '>>>>> End Test Output'",f'git checkout {self.base} tests/old.py']
        return controlled_eval_script(commands,self.base,text)
    def test_setup_failure_cannot_reach_tests_and_test_exit_is_preserved(self):
        marker=self.root/'executed'
        r=subprocess.run(['bash'],input=self.script('exit 7',f'touch {marker}'),text=True,capture_output=True)
        self.assertEqual(r.returncode,7);self.assertFalse(marker.exists())
        r=subprocess.run(['bash'],input=self.script('true','exit 1'),text=True,capture_output=True)
        self.assertEqual(r.returncode,1);self.assertIn('End Test Output',r.stderr)
    def test_unrecognized_patch_or_phase_structure_rejected(self):
        with self.assertRaises(ValueError):controlled_eval_script(['git apply malicious'],'a'*40,'official')
    def test_missing_or_error_target_is_unavailable_but_real_failed_assertion_is_valid(self):
        spec=SimpleNamespace(FAIL_TO_PASS=['target'],PASS_TO_PASS=['regression'])
        for status,parsed,code in [({},True,0),({'target':'PASSED','regression':'ERROR'},True,1),({'target':'PASSED','regression':'PASSED'},False,0),({'target':'PASSED','regression':'PASSED'},True,4)]:
            self.assertFalse(verification_validity(spec,status,parsed,code)[0])
        self.assertTrue(verification_validity(spec,{'target':'FAILED','regression':'PASSED'},True,1)[0])
        self.assertTrue(verification_validity(spec,{'target':'PASSED','regression':'PASSED'},True,0)[0])

    def test_recheck_proxy_preserves_local_test_servers_and_rejects_credentials(self):
        from swe import verifier_proxy_environment
        self.assertEqual(verifier_proxy_environment(None), {})
        env = verifier_proxy_environment('http://host.lima.internal:7890')
        self.assertEqual(env['HTTPS_PROXY'], 'http://host.lima.internal:7890')
        self.assertEqual(env['NO_PROXY'], 'localhost,127.0.0.1,::1')
        for value in ['socks5://host:7890', 'http://user:secret@host', 'http://host/path',
                      'http://host?key=secret', 'http://host\n', 1]:
            with self.assertRaises(ValueError):
                verifier_proxy_environment(value)
    def test_pytest_scm_uses_original_base_ancestry_for_install_and_grading(self):
        receipt={'baseCommit':'a'*40,'describe':'7.1.2-80-gaa55975','version':'7.1.3.dev80+gaa55975'}
        (self.repo/'.git/hicode-source-version.json').write_text(json.dumps(receipt))
        self.assertEqual(project_environment('pytest-dev/pytest',self.repo),{'SETUPTOOLS_SCM_PRETEND_VERSION':receipt['version']})
        self.assertEqual(namespace_eval_commands(['python -m pip install -e .'],'pytest-dev/pytest','7.2'),['python -m pip install --no-deps --no-build-isolation -e .'])
        from scm import read_source_version
        with self.assertRaises(ValueError):read_source_version(self.repo,'b'*40)
        with self.assertRaises(ValueError):project_environment('pytest-dev/pytest')
    def test_real_pytest_development_tags_are_accepted_without_replacing_their_version(self):
        receipt={'baseCommit':'aa55975c7'+'a'*31,'describe':'7.2.0.dev0-157-gaa55975c7','version':'7.2.0.dev157+gaa55975c7'}
        (self.repo/'.git/hicode-source-version.json').write_text(json.dumps(receipt))
        from scm import read_source_version
        receipt=read_source_version(self.repo,receipt['baseCommit'])
        self.assertEqual(receipt['describe'],'7.2.0.dev0-157-gaa55975c7')
        self.assertEqual(receipt['version'],'7.2.0.dev157+gaa55975c7')
    def test_invalid_frozen_scm_version_is_rejected(self):
        (self.repo/'.git/hicode-source-version.json').write_text(json.dumps({
            'baseCommit':'a'*40,'describe':'v7.1.2-80-gaa55975','version':'999\nBAD=1'}))
        with self.assertRaises(ValueError):project_environment('pytest-dev/pytest',self.repo)

    def test_reviewed_test_dependencies_come_from_frozen_public_declarations(self):
        (self.repo/'setup.py').write_text('install_requires=["wcwidth"]\n')
        (self.repo/'setup.cfg').write_text('install_requires =\n    iniconfig\n    toml\n')
        self.assertEqual(reviewed_test_dependencies('pytest-dev/pytest','5.4',self.repo),
                         ['wcwidth==0.2.13','iniconfig==2.0.0','toml==0.10.2'])
        (self.repo/'setup.py').write_text('install_requires=[]\n')
        self.assertEqual(reviewed_test_dependencies('pytest-dev/pytest','5.4',self.repo),
                         ['iniconfig==2.0.0','toml==0.10.2'])
        (self.repo/'setup.cfg').write_text('install_requires =\n')
        with self.assertRaises(ValueError):reviewed_test_dependencies('pytest-dev/pytest','5.4',self.repo)
        (self.repo/'setup.py').write_text("install_requires=['docutils>=0.12']\n")
        self.assertEqual(reviewed_test_dependencies('sphinx-doc/sphinx','3.4',self.repo),['docutils==0.16'])
        self.assertEqual(reviewed_test_dependencies('sphinx-doc/sphinx','3.5',self.repo),['docutils==0.16'])

if __name__=='__main__':unittest.main()
