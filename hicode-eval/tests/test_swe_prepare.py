import json
import unittest
from pathlib import Path
from unittest.mock import patch
from swe_machine import project_tool_pins

class DevelopmentToolsTest(unittest.TestCase):
    def test_pins_follow_project_versions_instead_of_latest_environment(self):
        document={'black':'22.10.0','isort':'v5.10.1','flake8':'5.0.4'}
        with patch('pathlib.Path.exists',return_value=True),patch('swe_machine.subprocess.check_output',return_value=json.dumps(document)):
            self.assertEqual(project_tool_pins(Path('/repo'),Path('/python')),['black==22.10.0','flake8==5.0.4','isort==5.10.1'])

    def test_unknown_tools_and_non_version_revisions_fail_closed(self):
        for document in [{'unknown':'22.10.0'}, {'black':'main','isort':'5.10.1','flake8':'5.0.4'}, {'black':None,'isort':'5.10.1','flake8':'5.0.4'}]:
            with patch('pathlib.Path.exists',return_value=True),patch('swe_machine.subprocess.check_output',return_value=json.dumps(document)):
                with self.assertRaises(ValueError):project_tool_pins(Path('/repo'),Path('/python'))

import hashlib
import tempfile
from prepare_swe import environment_groups
from swe_machine import dependency_cache_key

class EnvironmentGroupsTest(unittest.TestCase):
    def fixture(self, root):
        rows=[];groups=[]
        recipe={'python':'3.9','packages':'requirements.txt','install':'python -m pip install -e .',
                'test_cmd':'./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1'}
        for version,commit in [('4.1','a'*40),('4.2','b'*40),('5.0','c'*40)]:
            python='3.11' if version=='5.0' else '3.9'
            row={'instance_id':'django__django-'+version.replace('.',''), 'repo':'django/django',
                 'version':version,'environment_setup_commit':commit}
            rows.append(row)
            path=root/'artifacts/dependency-inputs'/version
            path.parent.mkdir(parents=True,exist_ok=True);path.write_text('dependency-'+version)
            groups.append({'repo':'django/django','version':version,'environmentSetupCommit':commit,
                'harnessRelease':'4.1.0','recipe':dict(recipe,python=python),'pythonVersion':python,
                'dependencySourceFiles':[{'repoPath':'tests/requirements/py3.txt','artifactPath':version,
                                         'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}]})
        (root/'environment-groups.json').write_text(json.dumps({'groups':groups}))
        return rows,groups

    def test_mixed_versions_keep_their_own_requirements_and_reuse_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);rows,_=self.fixture(root)
            result=environment_groups(root,[rows[0],rows[1],rows[2],dict(rows[0],instance_id='django__django-42')])
            self.assertEqual([len(g['rows']) for g in result],[2,1,1])
            self.assertEqual([g['requirements'] for g in result],[b'dependency-4.1',b'dependency-4.2',b'dependency-5.0'])

    def test_django_40_and_supported_sympy_use_distinct_original_recipes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            django={'instance_id':'django__django-14007','repo':'django/django',
                    'version':'4.0','environment_setup_commit':'a'*40}
            sympy={'instance_id':'sympy__sympy-12345','repo':'sympy/sympy',
                   'version':'1.12','environment_setup_commit':'b'*40}
            requirement=root/'artifacts/dependency-inputs/django.txt'
            requirement.parent.mkdir(parents=True);requirement.write_text('django-original-requirements')
            groups=[
                {'repo':'django/django','version':'4.0','environmentSetupCommit':'a'*40,
                 'harnessRelease':'4.1.0','pythonVersion':'3.8',
                 'recipe':{'python':'3.8','packages':'requirements.txt',
                           'install':'python -m pip install -e .',
                           'test_cmd':'./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1'},
                 'dependencySourceFiles':[{'repoPath':'tests/requirements/py3.txt',
                                           'artifactPath':'django.txt',
                                           'sha256':hashlib.sha256(requirement.read_bytes()).hexdigest()}]},
                {'repo':'sympy/sympy','version':'1.12','environmentSetupCommit':'b'*40,
                 'harnessRelease':'4.1.0','pythonVersion':'3.9',
                 'recipe':{'python':'3.9','packages':'mpmath flake8',
                           'pip_packages':['mpmath==1.3.0','flake8-comprehensions'],
                           'install':'python -m pip install -e .',
                           'test_cmd':"PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose"},
                 'dependencySourceFiles':[]},
            ]
            (root/'environment-groups.json').write_text(json.dumps({'groups':groups}))
            result=environment_groups(root,[django,sympy,dict(sympy,instance_id='sympy__sympy-12346')])
            self.assertEqual([len(g['rows']) for g in result],[1,2])
            self.assertEqual(result[0]['requirements'],b'django-original-requirements')
            self.assertEqual(result[1]['requirements'],b'mpmath==1.3.0\nflake8-comprehensions\nflake8\n')
            groups[1]['recipe']['pip_packages']=['mpmath==1.3.0','unreviewed-tool']
            (root/'environment-groups.json').write_text(json.dumps({'groups':groups}))
            with self.assertRaises(ValueError):environment_groups(root,[sympy])

    def test_early_sympy_versions_keep_the_official_python_and_dependency_recipe(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            recipe={'python':'3.9','packages':'mpmath flake8',
                    'pip_packages':['mpmath==1.3.0','flake8-comprehensions'],
                    'install':'python -m pip install -e .',
                    'test_cmd':"PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose"}
            rows=[];groups=[]
            for version,commit in [('1.0','f'*40),('1.1','a'*40),('1.4','b'*40),('1.5','c'*40),
                                   ('1.6','d'*40),('1.7','e'*40)]:
                rows.append({'instance_id':'sympy__sympy-'+version.replace('.',''),
                             'repo':'sympy/sympy','version':version,'environment_setup_commit':commit})
                groups.append({'repo':'sympy/sympy','version':version,
                               'environmentSetupCommit':commit,'harnessRelease':'4.1.0',
                               'pythonVersion':'3.9','recipe':recipe,'dependencySourceFiles':[]})
            (root/'environment-groups.json').write_text(json.dumps({'groups':groups}))
            prepared=environment_groups(root,rows)
            self.assertEqual([group['requirements'] for group in prepared],
                             [b'mpmath==1.3.0\nflake8-comprehensions\nflake8\n']*6)
            self.assertNotEqual(dependency_cache_key([rows[0]],prepared[0]['requirements'],'aarch64'),
                                dependency_cache_key([rows[1]],prepared[1]['requirements'],'aarch64'))
            groups[1]['pythonVersion']='3.8'
            (root/'environment-groups.json').write_text(json.dumps({'groups':groups}))
            with self.assertRaises(ValueError):environment_groups(root,rows)

    def test_reviewed_pip_recipes_and_xarray_source_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            source=root/'artifacts/dependency-inputs/xarray.yml'
            source.parent.mkdir(parents=True)
            source.write_text('original conda declaration')
            rows=[{'instance_id':'pytest-dev__pytest-10081','repo':'pytest-dev/pytest',
                   'version':'7.2','environment_setup_commit':'a'*40},
                  {'instance_id':'pydata__xarray-3095','repo':'pydata/xarray',
                   'version':'2022.09','environment_setup_commit':'b'*40}]
            recipes=[{'python':'3.9','pip_packages':['pluggy==0.13.1'],
                      'install':'python -m pip install -e .','test_cmd':'pytest -rA'},
                     {'python':'3.10','pip_packages':['numpy==1.23.0','pandas==1.5.3'],
                      'install':'python -m pip install -e .','no_use_env':True,'test_cmd':'pytest -rA'}]
            groups=[{'repo':row['repo'],'version':row['version'],
                     'environmentSetupCommit':row['environment_setup_commit'],
                     'harnessRelease':'4.1.0','pythonVersion':recipe['python'],
                     'recipe':recipe,'dependencySourceFiles':
                     [{'repoPath':'ci/requirements/environment.yml','artifactPath':'xarray.yml',
                       'sha256':hashlib.sha256(source.read_bytes()).hexdigest()}] if index else []}
                    for index,(row,recipe) in enumerate(zip(rows,recipes))]
            hashes={(row['repo'],row['version']):hashlib.sha256(json.dumps(recipe,sort_keys=True,
                separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
                for row,recipe in zip(rows,recipes)}
            with patch.dict('prepare_swe.RECIPE_SHA256',hashes):
                (root/'environment-groups.json').write_text(json.dumps({'groups':groups}))
                prepared=environment_groups(root,rows)
                self.assertEqual([group['requirements'] for group in prepared],
                                 [b'pluggy==0.13.1\n',b'numpy==1.23.0\npandas==1.5.3\n'])
                source.write_text('tampered')
                with self.assertRaises(ValueError):environment_groups(root,rows)
                source.write_text('original conda declaration')
                groups[0]['recipe']['pip_packages']=['pluggy==9.9.9']
                (root/'environment-groups.json').write_text(json.dumps({'groups':groups}))
                with self.assertRaises(ValueError):environment_groups(root,rows)

    def test_mismatch_hash_escape_and_unknown_recipe_fail_closed(self):
        for fault in ['setup','hash','escape','recipe','duplicate','wrong-python']:
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);rows,groups=self.fixture(root)
                if fault=='setup':rows[0]['environment_setup_commit']='c'*40
                if fault=='hash':groups[0]['dependencySourceFiles'][0]['sha256']='0'*64
                if fault=='escape':groups[0]['dependencySourceFiles'][0]['artifactPath']='../../outside'
                if fault=='recipe':groups[0]['recipe']['python']='3.11'
                if fault=='duplicate':groups.append(groups[0])
                if fault=='wrong-python':groups[2]['pythonVersion']='3.9'
                (root/'environment-groups.json').write_text(json.dumps({'groups':groups}))
                with self.assertRaises(ValueError):environment_groups(root,rows)

    def test_cache_separates_version_setup_and_architecture(self):
        row={'repo':'django/django','version':'4.1','environment_setup_commit':'a'*40}
        keys={dependency_cache_key([r],b'same requirements',arch) for r,arch in [
            (row,'aarch64'),(dict(row,version='4.2'),'aarch64'),
            (dict(row,environment_setup_commit='b'*40),'aarch64'),(row,'x86_64'),
            (dict(row,version='5.0'),'aarch64'),
            (dict(row,repo='sympy/sympy',version='1.12'),'aarch64')]}
        self.assertEqual(len(keys),6)
        with self.assertRaises(ValueError):dependency_cache_key([row,dict(row,version='4.2')],b'', 'aarch64')

class OlderToolDeclarationsTest(unittest.TestCase):
    def test_absent_config_does_not_invent_tool_pins(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(project_tool_pins(Path(tmp),Path('/unused')),[])

    def test_partial_declaration_pins_only_declared_tools(self):
        with patch('pathlib.Path.exists',return_value=True),patch('swe_machine.subprocess.check_output',return_value='{"black":"22.1.0"}'):
            self.assertEqual(project_tool_pins(Path('/repo'),Path('/python')),['black==22.1.0'])
