import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from dataset_runtime import dataset_runtime
from eval_datasets.deep_swe import validate_result, supervise
from protocol import namespace_argv, assignment_prompt

class DeepSweTest(unittest.TestCase):
    def test_original_python_environment_is_bounded_and_shared_by_actor_and_verifier(self):
        handler=dataset_runtime({'dataset':'deep-swe'})
        environment={'PYTHONPATH':'/app/src','VIRTUAL_ENV':'/opt/venv'}
        result=handler.command_environment({'deep':{'runtimeEnvironment':environment}},'/home','/run')
        self.assertEqual(result['PYTHONPATH'],'/app/src')
        self.assertEqual(result['VIRTUAL_ENV'],'/opt/venv')
        self.assertTrue(result['PATH'].startswith('/opt/venv/bin:'))
        self.assertEqual(handler.command_environment({'deep':{'runtimeEnvironment':{}}},'/home','/run'),
                         {'PYTHONDONTWRITEBYTECODE':'1'})
        rust={'CARGO_HOME':'/opt/hicode-rust/cargo','RUSTUP_HOME':'/opt/hicode-rust/rustup','CARGO_NET_OFFLINE':'true'}
        self.assertEqual(handler.command_environment({'deep':{'runtimeEnvironment':rust}},'/home','/run')['CARGO_HOME'],rust['CARGO_HOME'])
        polars={'POLARS_FORCE_PKG':'compat'}
        self.assertEqual(handler.command_environment({'deep':{'runtimeEnvironment':polars}},'/home','/run')['POLARS_FORCE_PKG'],'compat')
        go={'GOMODCACHE':'/opt/hicode-go/pkg/mod','GOPROXY':'off'}
        self.assertEqual(handler.command_environment({'deep':{'runtimeEnvironment':go}},'/home','/run')['GOPATH'],'/home/go')
        for bad in [None,[],{'PATH':'/other/bin'},{'PYTHONPATH':'/tests'},{'VIRTUAL_ENV':'/other/home'},
                    {'POLARS_FORCE_PKG':'auto'},{'POLARS_FORCE_PKG':'../tests'},{'PYTHONPATH':{}},{'GOPATH':'/root/go'},{'GOMODCACHE':'/opt/hicode-go/pkg/mod'},
                    {'CARGO_HOME':'/root/.cargo'},{'CARGO_HOME':'/opt/hicode-rust/cargo'},
                    {'CARGO_HOME':'/opt/hicode-rust/cargo','RUSTUP_HOME':'/other'}]:
            with self.assertRaises(ValueError):handler.command_environment({'deep':{'runtimeEnvironment':bad}},'/home','/run')

    def setUp(self):
        self.original={'p2p_node_ids':['stable'],'f2p_node_ids':['new','new']}
        self.reward={'reward':0,'p2p_total':1,'p2p_passed':1,'f2p_total':1,'f2p_passed':0}
        self.ctrf={'results':{'summary':{'tests':2,'passed':1,'failed':1,'skipped':0,'pending':0,'other':0},'tests':[{'name':'[p2p] stable','status':'passed'},{'name':'[f2p] new','status':'failed'}]}}

    def test_original_whitelist_and_reward_must_agree(self):
        validate_result(self.reward,self.ctrf,self.original,'failed')
        bad=copy.deepcopy(self.ctrf);bad['results']['tests'][1]['status']='passed'
        with self.assertRaises(ValueError):validate_result(self.reward,bad,self.original,'failed')
        bad=copy.deepcopy(self.ctrf);bad['results']['tests'].pop()
        with self.assertRaises(ValueError):validate_result(self.reward,bad,self.original,'failed')
        with self.assertRaises(ValueError):validate_result({**self.reward,'reward':1},self.ctrf,self.original,'passed')
        self.reward.update(reward=1,f2p_passed=1);self.ctrf['results']['tests'][1]['status']='passed';self.ctrf['results']['summary'].update(passed=2,failed=0)
        validate_result(self.reward,self.ctrf,self.original,'passed')

    def test_patch_apply_failure_is_failed_not_infrastructure_or_passed(self):
        reward={**self.reward,'p2p_passed':0,'apply_failed':1}
        validate_result(reward,None,self.original,'failed')
        with self.assertRaises(ValueError):validate_result(reward,None,self.original,'passed')

    def test_verifier_network_is_isolated_and_uses_a_distinct_workspace(self):
        args=namespace_argv(['--ro-bind','/r/artifacts','/logs/artifacts','bash','/tests/test.sh'],
                            '/r/fresh','/r/fresh-home','/r/logs','/control','/r/tests',isolated_network=True)
        self.assertIn('--unshare-net',args)
        self.assertNotIn('/r/project',args)
        self.assertEqual(args[-2:],['bash','/tests/test.sh'])
        self.assertIn('180 分钟',assignment_prompt('question',10800,'isolated','/app',[]))

    def test_pristine_verifier_cannot_see_the_actor_home_or_uncommitted_files(self):
        with patch('protocol.actor_readonly_mounts',return_value=['--ro-bind','/usr','/usr']):
            args=namespace_argv(['bash','/tests/test.sh'],'/fresh-project','/fresh-home','/logs','/control','/tests',
                                isolated_network=True,verifier_release='/release')
        self.assertIn(['--tmpfs','/'],[args[i:i+2] for i in range(len(args)-1)])
        self.assertNotIn(['--ro-bind','/','/'],[args[i:i+3] for i in range(len(args)-2)])
        self.assertNotIn('/old-project',args)
        self.assertNotIn('/old-home',args)
        with self.assertRaises(ValueError):namespace_argv(['python'],'/p','/h','/l','/c',verifier_release='/release')

    def test_timeout_and_cancellation_stop_verifier_process_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls=iter([False,True]);cancel_after_start=lambda:next(calls,True)
            for cancelled in [lambda:False,cancel_after_start]:
                with self.assertRaises((TimeoutError,RuntimeError)):
                    supervise(['python3','-c','import time;time.sleep(60)'],timeout=.05,
                              output=Path(tmp)/'log',env=os.environ,demote=lambda:None,cancelled=cancelled)

    def test_recovery_checks_original_report_and_patch_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'tests').mkdir();(root/'logs/verifier').mkdir(parents=True);(root/'artifacts').mkdir()
            (root/'tests/config.json').write_text(json.dumps(self.original))
            (root/'logs/verifier/reward.json').write_text(json.dumps(self.reward))
            (root/'logs/verifier/ctrf.json').write_text(json.dumps(self.ctrf))
            (root/'artifacts/model.patch').write_bytes(b'committed diff')
            (root/'patch-manifest.json').write_text(json.dumps({'baseCommit':'a'*40,'bytes':14,'sha256':hashlib.sha256(b'committed diff').hexdigest()}))
            handler=dataset_runtime({'dataset':'deep-swe'});job={'deep':{'baseCommit':'a'*40}}
            proof=handler.recovery_evidence(root,job,'failed',lambda p,limit:p.read_bytes())
            self.assertIn('artifacts/model.patch',proof)
            (root/'artifacts/model.patch').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'patch changed'):handler.recovery_evidence(root,job,'failed',lambda p,limit:p.read_bytes())

class PreparedGoTest(unittest.TestCase):
    def test_fixed_tools_are_copied_to_the_private_gopath_without_actor_home(self):
        from eval_datasets.deep_swe import prepare_verifier_go
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();source=root/'fixed';source.mkdir();home=root/'verifier-home';home.mkdir()
            actor=root/'actor-home/go/bin';actor.mkdir(parents=True)
            (actor/'goyacc').write_text('untrusted Actor tool')
            for name in ['goyacc','go-ctrf-json-reporter']:
                tool=source/name;tool.write_text('fixed '+name);tool.chmod(0o755)
            with patch('eval_datasets.deep_swe.Path',return_value=source):tools=prepare_verifier_go(home)
            target=home/'go/bin'
            self.assertEqual(set(tools),{target/'goyacc',target/'go-ctrf-json-reporter'})
            self.assertEqual((target/'goyacc').read_text(),'fixed goyacc')
            self.assertEqual((target/'go-ctrf-json-reporter').read_text(),'fixed go-ctrf-json-reporter')
            self.assertEqual((target/'goyacc').stat().st_mode & 0o777,0o555)
            self.assertEqual(target.stat().st_mode & 0o777,0o755)
            (target/'anko_test.log').write_text('private test log')
            self.assertEqual((target/'anko_test.log').read_text(),'private test log')

    def test_fixed_tool_links_and_non_executables_are_rejected(self):
        from eval_datasets.deep_swe import prepare_verifier_go
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();source=root/'fixed';source.mkdir();home=root/'home';home.mkdir()
            outside=root/'outside';outside.write_text('not a tool');outside.chmod(0o755)
            tool=source/'goyacc';tool.symlink_to(outside)
            with patch('eval_datasets.deep_swe.Path',return_value=source),self.assertRaisesRegex(ValueError,'regular executable'):
                prepare_verifier_go(home)
            self.assertFalse((home/'go/bin').exists())
            tool.unlink();tool.write_text('not executable');tool.chmod(0o644)
            with patch('eval_datasets.deep_swe.Path',return_value=source),self.assertRaisesRegex(ValueError,'regular executable'):
                prepare_verifier_go(home)

    @unittest.skipUnless(sys.platform=='linux' and os.getuid()==0 and shutil.which('bwrap')
                         and os.environ.get('HICODE_EVAL_ACTOR_SMOKE')=='1',
                         'Requires the dedicated Linux namespace environment')
    def test_private_gopath_writes_do_not_make_fixed_tools_writable(self):
        from eval_datasets.deep_swe import prepare_verifier_go
        with tempfile.TemporaryDirectory(prefix='verifier-go-',dir='/eval') as tmp:
            root=Path(tmp).resolve();root.chmod(0o755)
            source=root/'fixed';source.mkdir()
            binary=source/'fixed-tool';binary.write_text('#!/bin/sh\nprintf FIXED_TOOL_OK');binary.chmod(0o755)
            project=root/'project';home=root/'home';logs=root/'logs';control=root/'control';tests=root/'tests'
            for path in [project,home,logs,control,tests]:path.mkdir()
            (logs/'verifier').mkdir()
            with patch('eval_datasets.deep_swe.Path',return_value=source):tools=prepare_verifier_go(home)
            subprocess.run(['chown','-hR','65534:65534',str(home),str(project)],check=True)
            def demote():os.setgroups([]);os.setgid(65534);os.setuid(65534)
            script='''import errno,os,subprocess
from pathlib import Path
home=Path(os.environ['HOME']);binary=home/'go/bin/fixed-tool'
log=home/'go/bin/anko_test.log';log.write_text('first');log.write_text('second')
assert log.read_text()=='second'
generated=home/'go/bin/generated';generated.write_text('test-owned');generated.unlink()
assert subprocess.check_output([str(binary)],text=True)=='FIXED_TOOL_OK'
for mutate in [lambda:binary.write_text('changed'),lambda:binary.chmod(0o777),
               lambda:binary.unlink(),lambda:binary.rename(binary.with_name('replaced'))]:
    try:mutate()
    except OSError as error:assert error.errno in {errno.EROFS,errno.EBUSY,errno.EPERM,errno.EACCES},error
    else:raise AssertionError('Fixed tool changed')
assert subprocess.check_output([str(binary)],text=True)=='FIXED_TOOL_OK'
assert not Path('/root/go/bin').exists()
print('PRIVATE_GOPATH_OK')
'''
            mounts=[arg for tool in tools for arg in ['--ro-bind',str(tool),str(tool)]]
            runtime=[arg for name in ['/usr','/bin','/sbin','/lib','/lib64'] if Path(name).exists()
                     for arg in ['--ro-bind',name,name]]
            with patch('protocol.actor_readonly_mounts',return_value=runtime):
                args=namespace_argv([*mounts,'python3','-c',script],project,home,logs,control,
                                    tests=tests,isolated_network=True,verifier_release='/release')
            result=subprocess.run(args,env={'PATH':os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8'},
                                  preexec_fn=demote,capture_output=True,text=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('PRIVATE_GOPATH_OK',result.stdout)


class PreparedPnpmTest(unittest.TestCase):
    def test_fixed_tools_are_staged_without_image_home_and_links_are_rebased(self):
        from eval_datasets.deep_swe import prepare_verifier_pnpm
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();source=root/'source';source.mkdir()
            version=source/'pnpm/10_tmp';version.mkdir(parents=True);(version/'bin').mkdir()
            binary=version/'bin/pnpm';binary.write_text('fixed tool');binary.chmod(0o755)
            (source/'pnpm/10').symlink_to(version)
            target=root/'staging'
            def paths(name):
                return source if name=='/root/.local/share/pnpm/.tools' else target
            with patch('eval_datasets.deep_swe.Path',side_effect=paths):prepare_verifier_pnpm()
            staged=target/'.tools/pnpm/10'
            self.assertEqual((staged/'bin/pnpm').read_text(),'fixed tool')
            self.assertTrue(staged.resolve().is_relative_to(target))
            self.assertFalse(Path(staged.readlink()).is_absolute())
            self.assertTrue((staged/'bin/pnpm').stat().st_mode & 0o111)
            (source/'escape').symlink_to(root)
            with patch('eval_datasets.deep_swe.Path',side_effect=paths),self.assertRaisesRegex(ValueError,'escapes tool cache'):
                prepare_verifier_pnpm()


class PreparedCorepackTest(unittest.TestCase):
    def test_only_fixed_pnpm_packages_are_visible_in_the_private_verifier(self):
        from eval_datasets.deep_swe import prepare_verifier_corepack
        from protocol import verifier_readonly_mounts
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();source=root/'fixed/v1/pnpm';binary=source/'10.24.0/bin/pnpm.cjs'
            binary.parent.mkdir(parents=True);binary.write_text('fixed pnpm')
            (source/'current').symlink_to(source/'10.24.0')
            (source.parent.parent/'lastKnownGood.json').write_text(json.dumps({'pnpm':'10.24.0+sha512.abc','npm':'not-copied'}))
            target=root/'staged'
            with patch('eval_datasets.deep_swe.Path',side_effect=lambda name:source if name=='/root/.cache/node/corepack/v1/pnpm' else target):
                prepare_verifier_corepack()
            self.assertEqual((target/'v1/pnpm/current/bin/pnpm.cjs').read_text(),'fixed pnpm')
            self.assertFalse((target/'v1/pnpm/current').readlink().is_absolute())
            self.assertEqual(json.loads((target/'lastKnownGood.json').read_text()),{'pnpm':'10.24.0+sha512.abc'})
            self.assertEqual((target/'lastKnownGood.json').stat().st_mode & 0o777,0o444)
            def mounted(name):
                return target if name=='/opt/hicode-verifier-corepack' else root/'absent'
            with patch('protocol.Path',side_effect=mounted):args=verifier_readonly_mounts()
            self.assertIn('COREPACK_HOME',args)
            self.assertIn(['--ro-bind',str(target),str(target)],[args[i:i+3] for i in range(len(args)-2)])
            self.assertIn('COREPACK_ENABLE_NETWORK',args)
            self.assertIn('COREPACK_DEFAULT_TO_LATEST',args)
            self.assertNotIn(str(source),args)
            self.assertNotIn('/root',args)
            (source/'escape').symlink_to(root)
            with patch('eval_datasets.deep_swe.Path',side_effect=lambda name:source if name=='/root/.cache/node/corepack/v1/pnpm' else root/'another'),self.assertRaisesRegex(ValueError,'escapes package cache'):
                prepare_verifier_corepack()


    def test_activation_rejects_untrusted_paths_versions_and_oversized_records(self):
        from eval_datasets.deep_swe import prepare_verifier_corepack
        cases=[json.dumps({'pnpm':'../outside'}),json.dumps({'pnpm':'https://example.test/pnpm.tgz'}),
               json.dumps({'pnpm':'99.0.0'}),json.dumps({'pnpm':None}),'[]','not-json',' '*16385,'symlink']
        for body in cases:
            with self.subTest(body=body[:80]),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp).resolve();source=root/'fixed/v1/pnpm';(source/'10.24.0').mkdir(parents=True)
                activation=source.parent.parent/'lastKnownGood.json'
                if body=='symlink':
                    external=root/'other.json';external.write_text('{"pnpm":"10.24.0"}');activation.symlink_to(external)
                else:activation.write_text(body)
                target=root/'staged'
                with patch('eval_datasets.deep_swe.Path',side_effect=lambda name:source if name=='/root/.cache/node/corepack/v1/pnpm' else target),self.assertRaises(ValueError):
                    prepare_verifier_corepack()
                self.assertFalse(target.exists())


class PreparedBrowserTest(unittest.TestCase):
    def test_fixed_cache_is_shared_readonly_without_home_or_external_links(self):
        from eval_datasets.deep_swe import prepare_browser_cache
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();source=root/'fixed';source.mkdir()
            target=root/'task/ms-playwright'
            binary=source/'chromium/chrome';binary.parent.mkdir();binary.write_text('fixed browser');binary.chmod(0o755)
            (source/'browser').symlink_to(binary)
            def paths(name):
                if name=='/root/.cache/ms-playwright':return source
                if name=='/opt/hicode-task/ms-playwright':return target
                return Path(name)
            with patch('eval_datasets.deep_swe.Path',side_effect=paths):
                prepare_browser_cache();prepare_browser_cache()
                handler=dataset_runtime({'dataset':'deep-swe'})
                for home in ['/actor-home','/verifier-home']:
                    env=handler.command_environment({'deep':{'runtimeEnvironment':{}}},home,None)
                    self.assertEqual(env['PLAYWRIGHT_BROWSERS_PATH'],str(target))
            self.assertEqual((target/'browser').read_text(),'fixed browser')
            self.assertTrue((target/'browser').resolve().is_relative_to(target))
            self.assertFalse(Path((target/'browser').readlink()).is_absolute())
            self.assertEqual((target/'chromium/chrome').stat().st_mode & 0o777,0o555)
            self.assertEqual(target.stat().st_mode & 0o777,0o555)

    def test_absent_browser_does_not_add_dependencies_and_escape_is_rejected(self):
        from eval_datasets.deep_swe import prepare_browser_cache
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();source=root/'fixed';target=root/'task/ms-playwright'
            def paths(name):return source if name=='/root/.cache/ms-playwright' else target
            with patch('eval_datasets.deep_swe.Path',side_effect=paths):prepare_browser_cache()
            self.assertFalse(target.exists())
            source.mkdir();outside=root/'secret';outside.write_text('outside cache')
            (source/'escape').symlink_to(outside)
            with patch('eval_datasets.deep_swe.Path',side_effect=paths),self.assertRaisesRegex(ValueError,'escapes fixed cache'):
                prepare_browser_cache()
            self.assertFalse(target.exists())
            (source/'escape').unlink();(source/'file').write_text('browser data')
            target.parent.mkdir();target.symlink_to(source)
            with patch('eval_datasets.deep_swe.Path',side_effect=paths),self.assertRaisesRegex(ValueError,'prepared browser'):
                prepare_browser_cache()

if __name__=='__main__':unittest.main()
