import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from swe import export_patch, snapshot, relocate_environment, validate_swe_report
from protocol import namespace_argv

class SweExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.base=self.root/'base';self.final=self.root/'final';self.base.mkdir();self.final.mkdir()
    def tearDown(self):self.tmp.cleanup()
    def test_patch_uses_actual_files_not_actor_git_and_captures_all_file_operations(self):
        (self.base/'edit.py').write_text('before\n');(self.final/'edit.py').write_text('after\n')
        (self.base/'deleted').write_text('old\n');(self.final/'added').write_text('new\n')
        (self.base/'binary').write_bytes(b'\x00old');(self.final/'binary').write_bytes(b'\x00new')
        (self.base/'exec').write_text('run\n');(self.final/'exec').write_text('run\n');(self.final/'exec').chmod(0o755)
        (self.final/'.git').mkdir();(self.final/'.git/config').write_text('[core]\n hooksPath = /tmp/bad\n')
        patch=export_patch(self.base,self.final)
        self.assertIn('GIT binary patch',patch);self.assertIn('new mode 100755',patch)
        self.assertIn('deleted file mode',patch);self.assertIn('new file mode',patch);self.assertNotIn('.git/config',patch)
        replay=self.root/'replay';shutil.copytree(self.base,replay)
        subprocess.run(['git','apply','--binary','-'],cwd=replay,input=patch.encode(),check=True)
        self.assertEqual((replay/'binary').read_bytes(),b'\x00new');self.assertFalse((replay/'deleted').exists())
        self.assertEqual((replay/'added').read_text(),'new\n')
    def test_external_symlink_becomes_link_blob_without_reading_target(self):
        (self.final/'link').symlink_to('/etc/passwd')
        patch=export_patch(self.base,self.final)
        self.assertIn('120000',patch);self.assertIn('+/etc/passwd',patch);self.assertNotIn('root:',patch)
    def test_special_files_and_symlink_repository_roots_rejected(self):
        os.mkfifo(self.final/'fifo')
        with self.assertRaisesRegex(ValueError,'Special'):export_patch(self.base,self.final)
        alias=self.root/'alias';alias.symlink_to(self.base)
        with self.assertRaisesRegex(ValueError,'root'):snapshot(alias,self.root/'out')
    def test_swe_namespace_has_testbed_and_attempt_local_python_without_hidden_tests(self):
        args=namespace_argv(['python','-V'],'/eval/project','/eval/home','/eval/logs','/run/control',workdir='/testbed',environment='/eval/swe-envs/task')
        self.assertNotIn('/tests',args);self.assertNotIn('/app',args)
        i=args.index('/eval/swe-envs/task');self.assertEqual(args[i+1],'/opt/hicode-swe/env')
        self.assertEqual(args[args.index('--chdir')+1],'/testbed')
    def test_report_requires_both_official_test_groups_and_consistent_resolution(self):
        item={'patch_is_None':False,'patch_exists':True,'patch_successfully_applied':True,'resolved':True,
              'tests_status':{'FAIL_TO_PASS':{'success':['fix'],'failure':[]},'PASS_TO_PASS':{'success':['regression'],'failure':[]}}}
        validate_swe_report({'task':item},'task','passed')
        item['tests_status']['PASS_TO_PASS']['failure']=['regression']
        with self.assertRaises(ValueError):validate_swe_report({'task':item},'task','passed')
        item['resolved']=False
        validate_swe_report({'task':item},'task','failed')
        with self.assertRaises(ValueError):validate_swe_report({'wrong':item},'task','failed')

    def test_environment_script_relocation_keeps_runtime_writable_in_task_namespace(self):
        env=self.root/'env';(env/'bin').mkdir(parents=True)
        script=env/'bin/pip';script.write_text('#!/cache/env/bin/python\nprint(1)\n');script.chmod(0o755)
        relocate_environment(env,'/cache/env')
        self.assertEqual(script.read_text(),'#!/opt/hicode-swe/env/bin/python\nprint(1)\n')
        self.assertTrue(script.stat().st_mode & 0o111)

if __name__=='__main__':unittest.main()
