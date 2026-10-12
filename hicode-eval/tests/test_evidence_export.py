import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from evidence_export import MAP_FILE, export, restore, stored_names, name_key


class EvidenceExportTest(unittest.TestCase):
    def test_deep_export_keeps_actor_and_reports_without_duplicate_verifier_trees(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';source.mkdir()
            (source/'job.json').write_text(json.dumps({'dataset':'deep-swe'}))
            for name in ['project','baseline','verifier-project','verifier-home']:
                package=source/name/'node_modules';package.mkdir(parents=True)
                for index in range(3):(package/str(index)).write_text('original')
            for name in ['home','logs']:
                (source/name).mkdir();(source/name/'record').write_text('sealed')
            with patch('evidence_export.MAX_FILES',12):export(source,root/'export')
            for name in ['project','home','logs']:self.assertTrue((root/'export'/name).is_dir())
            for name in ['baseline','verifier-project','verifier-home']:
                self.assertFalse((root/'export'/name).exists())
                self.assertTrue((source/name/'node_modules/0').is_file())
            self.assertEqual((root/'export/project/node_modules/0').read_text(),'original')
            (source/'project/baseline').mkdir();(source/'project/baseline/answer').write_text('keep')
            export(source,root/'second')
            self.assertEqual((root/'second/project/baseline/answer').read_text(),'keep')
            (source/'job.json').write_text(json.dumps({'dataset':'terminal-bench-2.1'}))
            export(source,root/'terminal')
            self.assertTrue((root/'terminal/baseline/node_modules/0').is_file())

    def test_case_and_unicode_aliases_get_unique_storage_names(self):
        names=['include', 'INCLUDE', 'é', 'e\u0301', 'plain']
        stored=stored_names(names)
        self.assertEqual(stored['plain'], 'plain')
        self.assertEqual(len({name_key(name) for name in stored.values()}),len(names))
        self.assertEqual(stored,stored_names(list(reversed(names))))

    def test_export_preserves_links_and_bytes_without_following_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';source.mkdir()
            (source/'file').write_bytes(b'unchanged\r\n')
            (source/'external').symlink_to('/outside/not-readable')
            (source/'cycle').symlink_to('.')
            destination=root/'export';self.assertEqual(export(source,destination),[])
            self.assertEqual((destination/'file').read_bytes(),b'unchanged\r\n')
            self.assertEqual(os.readlink(destination/'external'),'/outside/not-readable')
            self.assertEqual(os.readlink(destination/'cycle'),'.')
            self.assertFalse((destination/MAP_FILE).exists())
            self.assertEqual((source/'file').read_bytes(),b'unchanged\r\n')

    def test_real_case_distinct_files_and_alias_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';project=source/'project';project.mkdir(parents=True)
            lower=project/'include';lower.mkdir()
            upper=project/'INCLUDE'
            if upper.exists():self.skipTest('Filesystem is case insensitive; covered in Linux regression')
            upper.symlink_to('include')
            (lower/'colors.inc').write_bytes(b'lower\r\n')
            (lower/'COLORS.INC').write_bytes(b'UPPER\n')
            destination=root/'export';entries=export(source,destination)
            self.assertEqual(len(entries),4)
            self.assertTrue(upper.is_symlink())
            mapping=json.loads((destination/MAP_FILE).read_text())
            restore(destination/'project',mapping,'project')
            self.assertEqual(os.readlink(destination/'project/INCLUDE'),'include')
            self.assertEqual((destination/'project/include/colors.inc').read_bytes(),b'lower\r\n')
            self.assertEqual((destination/'project/include/COLORS.INC').read_bytes(),b'UPPER\n')

    def test_restore_refuses_traversal_links_and_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();(root/'stored').write_text('original')
            (root/'existing').write_text('keep')
            (root/'outside').symlink_to('/tmp')
            for stored,original in [('project/../escape','project/ok'),('project/stored','project/../escape'),
                                    ('project/outside/file','project/file'),('project/stored','project/existing')]:
                with self.assertRaises(ValueError):
                    restore(root,{'version':1,'entries':[{'stored':stored,'original':original}]},'project')
            self.assertEqual((root/'stored').read_text(),'original')
            self.assertEqual((root/'existing').read_text(),'keep')

    def test_export_budget_and_reserved_map_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';source.mkdir();(source/'file').write_bytes(b'large')
            with patch('evidence_export.MAX_BYTES',1),self.assertRaisesRegex(ValueError,'budget'):
                export(source,root/'export')
            self.assertFalse((root/'export').exists())
            (source/MAP_FILE).write_text('not framework metadata')
            with self.assertRaisesRegex(ValueError,'path map'):export(source,root/'export')


if __name__ == '__main__':unittest.main()
