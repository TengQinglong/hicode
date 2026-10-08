import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from prepare_source_environment import validate_recipe, unpack, stage_runtime_archive
from prepare_source_environment37 import validate_recipe as validate_python37_recipe
import hashlib


class SourceEnvironmentTests(unittest.TestCase):
    def recipe(self):
        return {'version': 1, 'python': '3.6.15', 'requirements': ['pip==21.3.1'],
                'buildRequirements': [], 'buildEnvironment': {}, 'buildGroups': [],
                'systemPackages': ['build-essential'], 'provenance': 'Reviewed public declarations'}

    def test_only_the_pinned_source_interpreter_and_public_packages_are_accepted(self):
        self.assertEqual(validate_recipe(self.recipe())['python'], '3.6.15')
        self.assertEqual(validate_python37_recipe({**self.recipe(), 'python': '3.7.17'})['python'], '3.7.17')
        ordered = {**self.recipe(), 'buildGroups': [{'packages': ['pip==21.3.1'], 'requirements': []}]}
        self.assertEqual(validate_recipe(ordered)['buildGroups'], ordered['buildGroups'])
        for value in ['3.6', '3.6.14', '3.7.16', '3.7.17', '3.9.23']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_recipe({**self.recipe(), 'python': value})
        for pins in [['pip'], ['pkg @ file:///answer'], ['--index-url=https://example.com'], ['pkg==1', 'PKG==1']]:
            with self.subTest(pins=pins), self.assertRaises(ValueError):
                validate_recipe({**self.recipe(), 'requirements': pins})
        for field, value in [('buildEnvironment', {'LD_PRELOAD': '/tmp/library'}),
                             ('buildRequirements', ['other==1']), ('buildGroups', [{}]),
                             ('systemPackages', ['gcc;id'])]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_recipe({**self.recipe(), field: value})

    def test_archive_rejects_traversal_links_and_devices_before_extracting_any_member(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root/'source.tar'
            for name, kind in [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                               ('link', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE), ('device', tarfile.CHRTYPE)]:
                with tarfile.open(archive, 'w') as stream:
                    good = tarfile.TarInfo('source/good'); good.size = 2
                    stream.addfile(good, io.BytesIO(b'ok'))
                    bad = tarfile.TarInfo(name); bad.type = kind; bad.linkname = '../escape'
                    stream.addfile(bad)
                with self.subTest(name=name), self.assertRaises(ValueError):
                    unpack(archive, root/'output')
                self.assertFalse((root/'output/source/good').exists())
            with tarfile.open(archive, 'w') as stream:
                item = tarfile.TarInfo('source/file'); item.size = 2
                stream.addfile(item, io.BytesIO(b'ok'))
            unpack(archive, root/'output')
            self.assertEqual((root/'output/source/file').read_bytes(), b'ok')

    def test_runtime_archive_must_match_reviewed_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'source.tar.gz'
            target = root/'staged.tar.gz'
            source.write_bytes(b'public runtime source')
            expected = hashlib.sha256(source.read_bytes()).hexdigest()
            stage_runtime_archive(source, target, expected)
            self.assertEqual(target.read_bytes(), source.read_bytes())
            with self.assertRaises(ValueError):
                stage_runtime_archive(source, target, '0'*64)
            source.unlink()
            source.symlink_to(target)
            with self.assertRaises(ValueError):
                stage_runtime_archive(source, target, expected)
