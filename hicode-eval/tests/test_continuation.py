import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from continuation import capture_checkpoint,restore_checkpoint,validate_members,restore_service,model_bridge_port


class ContinuationTest(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.base=Path(self.temporary.name);self.root=self.base/'aaaaaaaaaaaaaaaa'
        (self.root/'project').mkdir(parents=True);(self.root/'home').mkdir()
        (self.root/'project/answer.py').write_text('unfinished answer')
        (self.root/'home/session.txt').write_text('saved session')

    def test_restores_pre_verifier_files_home_and_training_checkpoint_without_hidden_inputs(self):
        (self.root/'project/weights.ckpt').write_bytes(b'saved training state')
        (self.root/'project/run.sh').write_text('run');(self.root/'project/run.sh').chmod(0o755)
        (self.root/'tests').mkdir();(self.root/'tests/hidden.py').write_text('private assertions')
        value=capture_checkpoint(self.root,'session-fixture','/eval/runs/aaaaaaaaaaaaaaaa/home',1800,None,49152)
        (self.root/'project/answer.py').write_text('verifier mutated workspace')
        (self.root/'home/session.txt').write_text('verifier mutated home')
        target=self.base/'bbbbbbbbbbbbbbbb';target.mkdir()
        (target/'continuation-input.tar.gz').write_bytes((self.root/'continuation.tar.gz').read_bytes())
        restore_checkpoint(target,value,None)
        self.assertEqual((target/'project/answer.py').read_text(),'unfinished answer')
        self.assertEqual((target/'home/session.txt').read_text(),'saved session')
        self.assertEqual((target/'project/weights.ckpt').read_bytes(),b'saved training state')
        self.assertEqual((target/'project/run.sh').stat().st_mode&0o777,0o755)
        self.assertFalse((target/'tests').exists());self.assertFalse((target/'continuation-input.tar.gz').exists())

    def test_archive_tampering_rejected_before_restoring_any_files(self):
        value=capture_checkpoint(self.root,'session-fixture','/eval/runs/aaaaaaaaaaaaaaaa/home',70,None,49152)
        (self.root/'continuation-input.tar.gz').write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError,'differs'):restore_checkpoint(self.root,value,None)
        self.assertEqual((self.root/'project/answer.py').read_text(),'unfinished answer')

    def test_model_bridge_identity_is_bounded_and_stays_on_localhost(self):
        path=self.root/'home/settings.json'
        path.write_text(json.dumps({'sources':{'fixture':{'baseUrl':'http://127.0.0.1:49152/v1'}}}))
        self.assertEqual(model_bridge_port(path,'fixture'),49152)
        for url in ['http://127.0.0.1:80/v1','http://other.example:49152/v1','http://127.0.0.1:49152/v1?key=value']:
            path.write_text(json.dumps({'sources':{'fixture':{'baseUrl':url}}}))
            with self.subTest(url=url),self.assertRaises(ValueError):model_bridge_port(path,'fixture')
        path.write_text('{}')
        with self.assertRaises(ValueError):model_bridge_port(path,'fixture')

    def test_rejects_hidden_roots_traversal_hardlinks_and_symlink_parent_members(self):
        def check(names):
            buffer=io.BytesIO()
            with tarfile.open(fileobj=buffer,mode='w') as out:
                for name,kind,link in names:
                    m=tarfile.TarInfo(name);m.type=kind;m.linkname=link;out.addfile(m)
            buffer.seek(0)
            with tarfile.open(fileobj=buffer,mode='r') as archive:validate_members(archive,None)
        roots=[('project',tarfile.DIRTYPE,''),('home',tarfile.DIRTYPE,'')]
        for entries in [[('tests/private.py',tarfile.REGTYPE,'')],[('project/../../outside',tarfile.REGTYPE,'')],
                        [('home/link',tarfile.LNKTYPE,'project/file')],
                        [('home/link',tarfile.SYMTYPE,'/outside'),('home/link/write',tarfile.REGTYPE,'')],
                        [('home',tarfile.DIRTYPE,'')]]:
            with self.subTest(entries=entries),self.assertRaises(ValueError):check(roots+entries)

    def test_service_snapshot_stays_separate_and_requires_same_declared_paths(self):
        class Owner:
            paths=['/etc'];uid=20000
            def snapshot(owner):
                with tarfile.open(self.root/'service-system.tar','w') as out:
                    m=tarfile.TarInfo('etc/service.conf');m.size=6;out.addfile(m,io.BytesIO(b'config'))
            def actor_argv(owner,args):return ['owned-namespace',*args]
        owner=Owner();value=capture_checkpoint(self.root,'session-fixture','/eval/runs/aaaaaaaaaaaaaaaa/home',4200,owner,49152)
        target=self.base/'bbbbbbbbbbbbbbbb';target.mkdir()
        (target/'continuation-input.tar.gz').write_bytes((self.root/'continuation.tar.gz').read_bytes())
        with self.assertRaisesRegex(ValueError,'declaration'):restore_checkpoint(target,value,['/var'])
        restore_checkpoint(target,value,['/etc'])
        with patch('os.chown'),patch('subprocess.run') as execute:
            restore_service(owner,target)
        self.assertIn('owned-namespace',execute.call_args.args[0])
        self.assertFalse((target/'continuation-service.tar').exists())
        self.assertFalse((target/'project/.continuation-service.tar').exists())


if __name__=='__main__':unittest.main()
