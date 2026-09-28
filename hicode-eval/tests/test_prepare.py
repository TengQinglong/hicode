import json,subprocess,tarfile,tempfile,unittest
from pathlib import Path
from prepare import prepare

class PrepareTest(unittest.TestCase):
    def test_source_only_payload_freezes_code_and_lock_without_linux_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);repo=root/'repo';repo.mkdir();(repo/'src').mkdir()
            def git(*args):return subprocess.run(['git','-C',str(repo),*args],check=True,capture_output=True)
            git('init','-q');(repo/'src/main.ts').write_text('old');(repo/'package.json').write_text('{}');(repo/'bun.lock').write_text('old-lock')
            (repo/'tsconfig.json').write_text('{}')
            (repo/'.env').write_text('FIXTURE_KEY=not-a-real-key')
            (repo/'README.md').write_text('not a runtime input')
            (repo/'hicode-eval').mkdir();(repo/'hicode-eval/private-result.json').write_text('{}')
            git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture')
            (repo/'src/main.ts').write_text('new');(repo/'bun.lock').write_text('new-lock')
            (repo/'tsconfig.json').write_text('{"compilerOptions":{}}')
            out=prepare(repo,root/'payload',worktree=True)
            manifest=json.loads((out/'manifest.json').read_text())
            self.assertEqual(set(manifest['files']),{'source.tar.gz'})
            self.assertIn('bun.lock',manifest['worktree_overlay'])
            with tarfile.open(out/'source.tar.gz') as archive:
                self.assertEqual(archive.extractfile('src/main.ts').read(),b'new')
                self.assertEqual(archive.extractfile('bun.lock').read(),b'new-lock')
                self.assertEqual(archive.extractfile('tsconfig.json').read(),b'{"compilerOptions":{}}')
                self.assertNotIn('.env',archive.getnames())
                self.assertNotIn('README.md',archive.getnames())
                self.assertFalse(any(name.startswith('hicode-eval') for name in archive.getnames()))
            self.assertFalse((out/'bun').exists())
