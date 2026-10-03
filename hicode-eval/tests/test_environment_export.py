import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from environment_export import export

class EnvironmentExportTests(unittest.TestCase):
    def test_deterministic_public_archive_and_links_are_not_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'public';source.mkdir()
            (source/'package.py').write_text('public dependency')
            private=root/'private';private.write_text('not exported')
            (source/'link').symlink_to(private)
            one=export(root/'one.tar.gz',[str(source)])
            os.utime(source/'package.py',(1234,1234))
            two=export(root/'two.tar.gz',[str(source)])
            self.assertEqual(one['sha256'],two['sha256'])
            with tarfile.open(root/'one.tar.gz') as archive:
                members=archive.getmembers()
                self.assertEqual(len(members),3)
                self.assertTrue(next(m for m in members if m.name.endswith('/link')).issym())
                self.assertFalse(any(m.name.endswith('/private') for m in members))
    def test_secret_and_special_files_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'public';source.mkdir()
            (source/'.env').write_text('private')
            with self.assertRaisesRegex(ValueError,'Credentials'):export(root/'one.tar.gz',[str(source)])
            (source/'.env').unlink();os.mkfifo(source/'pipe')
            with self.assertRaisesRegex(ValueError,'Special'):export(root/'two.tar.gz',[str(source)])
