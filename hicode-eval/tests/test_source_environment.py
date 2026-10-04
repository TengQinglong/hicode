import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from prepare_source_environment import validate_recipe, unpack


class SourceEnvironmentTests(unittest.TestCase):
    def recipe(self):
        return {'version': 1, 'python': '3.6.15', 'requirements': ['pip==21.3.1'],
                'buildRequirements': [], 'buildEnvironment': {}, 'buildGroups': [],
                'systemPackages': ['build-essential'], 'provenance': 'Reviewed public declarations'}

    def test_only_the_pinned_source_interpreter_and_public_packages_are_accepted(self):
        self.assertEqual(validate_recipe(self.recipe())['python'], '3.6.15')
        for value in ['3.6', '3.6.14', '3.9.23']:
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
