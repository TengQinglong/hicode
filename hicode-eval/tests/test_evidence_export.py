import json
import hashlib
import tarfile
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
            for name in ['outcome.json','result.json']:(source/name).write_text(json.dumps({'execution':'completed','grading':'failed','uid':20000}))
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

    def test_large_dependencies_are_verified_in_parts_without_changing_actor(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';project=source/'project';project.mkdir(parents=True)
            (source/'job.json').write_text(json.dumps({'dataset':'deep-swe'}))
            for name in ['outcome.json','result.json']:(source/name).write_text(json.dumps({'execution':'completed','grading':'failed','uid':20000}))
            (project/'answer.ts').write_bytes(b'original answer')
            deps=project/'node_modules';deps.mkdir()
            for i in range(45):(deps/str(i)).write_bytes(('dependency-%s' % i).encode())
            (deps/'external').symlink_to('/not-exported/secret')
            (deps/'cycle').symlink_to('.')
            original=(deps/'0').stat()
            with patch('evidence_export.MAX_FILES',20),patch('evidence_export.DEPENDENCY_PART_ENTRIES',15):
                export(source,root/'export')
            receipt=json.loads((root/'export/dependency-archives.json').read_text())
            self.assertEqual(receipt['entries'],47)
            self.assertFalse(receipt['autoRestore'])
            self.assertEqual(receipt['originalPath'],'project/node_modules')
            self.assertFalse((root/'export/project/node_modules').exists())
            self.assertEqual((root/'export/project/answer.ts').read_bytes(),b'original answer')
            self.assertEqual((deps/'0').stat().st_ino,original.st_ino)
            members={}
            for part in receipt['archives']:
                path=root/'export'/part['path']
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),part['sha256'])
                with tarfile.open(path,'r:gz') as archive:
                    self.assertLessEqual(len(archive.getmembers()),15)
                    for member in archive:
                        members[member.name]=archive.extractfile(member).read() if member.isfile() else member.linkname
            self.assertEqual(members['0'],b'dependency-0')
            self.assertEqual(members['external'],'/not-exported/secret')
            self.assertEqual(members['cycle'],'.')
            # Repeat recovery produces the same verified archives; no source metadata is inserted.
            with patch('evidence_export.MAX_FILES',20),patch('evidence_export.DEPENDENCY_PART_ENTRIES',15):
                export(source,root/'second')
            self.assertEqual(json.loads((root/'second/dependency-archives.json').read_text()),receipt)
            self.assertFalse((source/'dependency-archives.json').exists())

    def test_dependency_archiving_does_not_hide_source_overflow_or_change_other_datasets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';deps=source/'project/node_modules';deps.mkdir(parents=True)
            (source/'job.json').write_text(json.dumps({'dataset':'terminal-bench-2.1'}))
            for i in range(30):(deps/str(i)).write_text('dependency')
            with patch('evidence_export.MAX_FILES',20),self.assertRaisesRegex(ValueError,'file count'):
                export(source,root/'terminal')
            (source/'job.json').write_text(json.dumps({'dataset':'deep-swe'}))
            for name in ['outcome.json','result.json']:(source/name).write_text(json.dumps({'execution':'completed','grading':'failed','uid':20000}))
            for i in range(30):(source/('source-'+str(i))).write_text('answer')
            with patch('evidence_export.MAX_FILES',20),self.assertRaisesRegex(ValueError,'Non-dependency'):
                export(source,root/'deep')
            self.assertTrue((deps/'0').exists())
            self.assertFalse((root/'deep').exists())

    def test_dependency_mutation_aborts_export_and_keeps_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';deps=source/'project/node_modules';deps.mkdir(parents=True)
            (source/'job.json').write_text(json.dumps({'dataset':'deep-swe'}))
            for name in ['outcome.json','result.json']:(source/name).write_text(json.dumps({'execution':'completed','grading':'failed','uid':20000}))
            for i in range(30):(deps/str(i)).write_text('original')
            addfile=tarfile.TarFile.addfile
            def changing(archive,info,stream=None):
                result=addfile(archive,info,stream)
                if info.name=='0':(deps/'0').write_text('changed during export')
                return result
            with patch('evidence_export.MAX_FILES',20),patch.object(tarfile.TarFile,'addfile',changing),self.assertRaisesRegex(ValueError,'changed during export'):
                export(source,root/'export')
            self.assertFalse((root/'export').exists())
            self.assertEqual((deps/'0').read_text(),'changed during export')

    def test_archives_preserve_hardlink_bytes_and_nested_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';deps=source/'project/node_modules';(deps/'package').mkdir(parents=True)
            (source/'job.json').write_text(json.dumps({'dataset':'deep-swe'}))
            for name in ['outcome.json','result.json']:(source/name).write_text(json.dumps({'execution':'completed','grading':'failed','uid':20000}))
            for i in range(30):(deps/'package'/str(i)).write_text('original')
            os.link(deps/'package/0',deps/'linked')
            with patch('evidence_export.MAX_FILES',20),patch('evidence_export.DEPENDENCY_PART_ENTRIES',15):
                export(source,root/'export')
            receipt=json.loads((root/'export/dependency-archives.json').read_text())
            count=0
            for part in receipt['archives']:
                with tarfile.open(root/'export'/part['path'],'r:gz') as archive:
                    for member in archive:
                        if member.isfile():self.assertEqual(archive.extractfile(member).read(),b'original');count+=1
            self.assertEqual(count,31)

    def test_large_dependencies_require_consistent_terminal_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();source=root/'source';deps=source/'project/node_modules';deps.mkdir(parents=True)
            (source/'job.json').write_text(json.dumps({'dataset':'deep-swe'}))
            for i in range(30):(deps/str(i)).write_text('original')
            with patch('evidence_export.MAX_FILES',20),self.assertRaises(FileNotFoundError):export(source,root/'unsealed')
            (source/'outcome.json').write_text(json.dumps({'execution':'completed','grading':'failed','uid':20000}))
            (source/'result.json').write_text(json.dumps({'execution':'completed','grading':'passed','uid':20000}))
            with patch('evidence_export.MAX_FILES',20),self.assertRaisesRegex(ValueError,'sealed outcome'):export(source,root/'mismatched')
            self.assertFalse((root/'unsealed').exists())
            self.assertFalse((root/'mismatched').exists())
            self.assertEqual((deps/'0').read_text(),'original')

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
