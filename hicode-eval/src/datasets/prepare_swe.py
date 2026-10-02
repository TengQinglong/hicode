"""Prepare supported public SWE instances on the existing dedicated Linux machine.
Host keeps test patches; repository and problem statement alone enter the Actor view.
"""
import argparse
import hashlib
from sphinx_setup import VERSIONS as SPHINX_VERSIONS
from reviewed_test_deps import reviewed_test_dependencies
import json
from pathlib import Path
import subprocess
import tempfile

IDS = ['django__django-15731', 'django__django-15741', 'django__django-15863', 'django__django-16136']
REVISION = 'c104f840cc67f8b6eec6f759ebc8b2693d585d4a'
PYTHON_BY_REPO_VERSION = {
    ('django/django','3.2'): '3.6',
    ('django/django', '4.0'): '3.8',
    ('django/django', '4.1'): '3.9',
    ('django/django', '4.2'): '3.9',
    ('django/django', '5.0'): '3.11',
    **{('sympy/sympy', version): '3.9' for version in ('1.0', '1.1', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.10', '1.11', '1.12')},
    **{('pytest-dev/pytest', version): '3.9' for version in ('5.0', '5.1', '5.2', '5.4', '6.0', '6.2', '7.2')},
    **{('sphinx-doc/sphinx', version): '3.9' for version in SPHINX_VERSIONS},
    **{('pydata/xarray', version): '3.10' for version in ('0.12', '2022.03', '2022.06', '2022.09')},
}

# Hashes of the reviewed official harness recipe dictionaries. The downloaded
# preparation declaration is data, never an authority to run new setup commands.
RECIPE_SHA256 = {
    **{('pytest-dev/pytest', version): '343c239ba4e31dae7be6f5a328648b4b0785ce7369d84ae929e3e075b54d00d8'
       for version in ('5.0', '5.1', '5.2')},
    ('pytest-dev/pytest', '5.4'): '4ac5016914409fcda7bf9a1bdb8d6fc7c136898b6a1e5eadd2761df98872b926',
    ('pytest-dev/pytest', '6.0'): '986f45a4ed4997a29d8b459005911016141f10b10668dea3b0497ce95145509c',
    ('pytest-dev/pytest', '6.2'): '270c8f1a85e201c503edde159a224830f1c83a398192f42254b47d6494c6fae9',
    ('pytest-dev/pytest', '7.2'): '630357129367829193422741c8de4b4c1c4153e9473037379615e9b08616e625',
    **{('pydata/xarray', version): '57cd6f90cac8623e1c337e57b766848e6e527b44d41f311d587d0db62dc9f944'
       for version in ('0.12', '2022.03', '2022.06', '2022.09')},
}
PYTEST_LEGACY_BACKPORT = 'importlib-metadata==4.13.0'
PYTEST_BUILD_BACKEND = 'setuptools-scm[toml]==7.1.0'

def selected_rows(dataset, ids):
    dataset = Path(dataset)
    manifest = json.loads((dataset/'manifest.json').read_text())
    if manifest['revision'] != REVISION: raise ValueError('Unexpected Verified revision')
    rows = {}
    public = {r['instance_id']: r for r in map(json.loads, (dataset/'tasks.jsonl').read_text().splitlines())}
    for filename in ['tasks.jsonl','evaluation-only/test.jsonl']:
        blob = (dataset/filename).read_bytes()
        if hashlib.sha256(blob).hexdigest() != manifest['files'][filename]['sha256']:
            raise ValueError('Dataset manifest hash mismatch')
    for line in (dataset/'evaluation-only/test.jsonl').read_text().splitlines():
        row = json.loads(line)
        if row['instance_id'] not in ids: continue
        if (row['repo'], row['version']) not in PYTHON_BY_REPO_VERSION: raise ValueError('Unsupported SWE repository/version')
        for field in ['repo','base_commit','problem_statement']:
            if public[row['instance_id']][field] != row[field]: raise ValueError('Public/evaluator mismatch')
        # Never copy gold patch, hints, or answer commit into an environment or bundle.
        rows[row['instance_id']] = {k:row[k] for k in ['instance_id','repo','version','base_commit','environment_setup_commit','problem_statement','test_patch','FAIL_TO_PASS','PASS_TO_PASS']}
    if set(rows) != set(ids): raise ValueError('Missing selected instance')
    return [rows[id] for id in ids]

def environment_groups(prep, rows):
    """Resolve each selected setup commit to its own verified dependency input."""
    prep = Path(prep)
    declarations = json.loads((prep/'environment-groups.json').read_text())['groups']
    result = {}
    for row in rows:
        identity = (row['repo'], row['version'], row['environment_setup_commit'])
        python = PYTHON_BY_REPO_VERSION.get((row['repo'], row['version']))
        if row['repo'] == 'django/django':
            expected_recipe = {'python':python, 'packages':'requirements.txt',
                               'install':'python -m pip install -e .',
                               'test_cmd':'./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1'}
            if row['version']=='3.2':
                expected_recipe['eval_commands']=["sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen",
                                                   'export LANG=en_US.UTF-8','export LANGUAGE=en_US:en','export LC_ALL=en_US.UTF-8']
        elif row['repo'] == 'sympy/sympy':
            expected_recipe = {'python':python, 'packages':'mpmath flake8',
                               'pip_packages':['mpmath==1.3.0','flake8-comprehensions'],
                               'install':'python -m pip install -e .',
                               'test_cmd':"PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose"}
        elif row['repo'] == 'sphinx-doc/sphinx':
            from sphinx_setup import reviewed_recipe
            expected_recipe = reviewed_recipe(row['version'])
        else:
            expected_recipe = None
        if identity in result:
            result[identity]['rows'].append(row)
            continue
        matches = [g for g in declarations if
                   (g['repo'], g['version'], g['environmentSetupCommit']) == identity]
        if len(matches) != 1: raise ValueError('Missing or ambiguous environment group')
        group = matches[0]
        recipe_hash = hashlib.sha256(json.dumps(group['recipe'], sort_keys=True,
                                                separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        reviewed = (group['recipe'] == expected_recipe if expected_recipe is not None else
                    recipe_hash == RECIPE_SHA256.get((row['repo'], row['version'])))
        if (python is None or group['harnessRelease'] != '4.1.0' or not reviewed or
            group['pythonVersion'] != python):
            raise ValueError('Unsupported environment recipe')
        sources = group['dependencySourceFiles']
        if row['repo'] == 'django/django':
            if len(sources) != 1 or sources[0]['repoPath'] != 'tests/requirements/py3.txt':
                raise ValueError('Unsupported dependency input layout')
            meta = sources[0]
            root = (prep/'artifacts/dependency-inputs').resolve()
            requirements = (root/meta['artifactPath']).resolve()
            if root not in requirements.parents: raise ValueError('Dependency input escapes preparation directory')
            requirement_bytes = requirements.read_bytes()
            if hashlib.sha256(requirement_bytes).hexdigest() != meta['sha256']:
                raise ValueError('Original requirements changed')
        elif row['repo'] == 'sympy/sympy':
            if sources: raise ValueError('Unexpected SymPy dependency source')
            # Both the original package list and its explicit pip pins are preserved.
            requirement_bytes = b'mpmath==1.3.0\nflake8-comprehensions\nflake8\n'
        else:
            expected_paths = ['ci/requirements/environment.yml'] if row['repo'] == 'pydata/xarray' else []
            if [source['repoPath'] for source in sources] != expected_paths:
                raise ValueError('Unsupported dependency input layout')
            root = (prep/'artifacts/dependency-inputs').resolve()
            for source in sources:
                dependency = (root/source['artifactPath']).resolve()
                if root not in dependency.parents or hashlib.sha256(dependency.read_bytes()).hexdigest() != source['sha256']:
                    raise ValueError('Original dependency input changed or escaped')
            # The reviewed recipes explicitly use these pip pins (xarray has no_use_env).
            pins = list(group['recipe']['pip_packages'])
            if row['repo'] == 'pydata/xarray':
                from xarray_setup import dependency_pins
                pins.extend(dependency_pins(dependency.read_text()))
                if row['version']=='0.12':
                    # The harness bucket includes 0.12–0.16 source trees.
                    # Pandas 1.5 requires Xarray >=0.19; use its compatible
                    # Python 3.10 predecessor without falsifying Xarray's version.
                    pins=[('pandas==1.3.5' if pin=='pandas==1.5.3' else pin) for pin in pins]
            if row['repo'] == 'sphinx-doc/sphinx' and row['version'] in ('3.1', '3.2', '3.3'):
                # These public base trees import pkg_resources at runtime.
                # Current setuptools removed it, and new docutils removed the
                # bundled roman module. Both pins satisfy original requirements.
                pins.extend(['setuptools==70.0.0', 'docutils==0.16'])
            pins.extend(reviewed_test_dependencies(row['repo'], row['version']))
            if row['repo'] == 'pytest-dev/pytest':
                # The project declares this build backend; keep it in the task
                # cache because isolated build downloads are not reliable.
                pins.append(PYTEST_BUILD_BACKEND)
                if row['version'] in ('5.0', '5.1', '5.2', '5.4'):
                    # Pytest 5.x also declares this runtime dependency, but
                    # the harness pin list omits it. Runtime uses --no-deps.
                    pins.append(PYTEST_LEGACY_BACKPORT)
            requirement_bytes = ('\n'.join(pins) + '\n').encode()
        result[identity] = {'rows':[row], 'requirements':requirement_bytes}
    return list(result.values())

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--dataset',required=True);parser.add_argument('--prep',required=True)
    parser.add_argument('--output',required=True);parser.add_argument('--context',default='colima-hicode')
    parser.add_argument('--machine',default='hicode-eval-linux');parser.add_argument('--ids',nargs='+',default=IDS)
    args=parser.parse_args();out=Path(args.output).resolve()
    if out.exists(): raise ValueError('Output must be a new external directory')
    checkout=Path(__file__).resolve().parents[3]
    if checkout == out or checkout in out.parents: raise ValueError('Keep data outside checkout')
    rows=selected_rows(args.dataset,args.ids)
    prep=Path(args.prep)
    profile=json.loads((prep/'harness-profile.json').read_text())
    wheel=prep/'artifacts/harness-4.1.0'/profile['distribution']['filename']
    if hashlib.sha256(wheel.read_bytes()).hexdigest()!=profile['distribution']['sha256']: raise ValueError('Harness wheel changed')
    groups=environment_groups(prep,rows)
    docker=['docker','--context',args.context]
    def run(*cmd,timeout=600):subprocess.run([*docker,*cmd],check=True,timeout=timeout)
    info=json.loads(subprocess.check_output([*docker,'inspect',args.machine]))[0]
    if not info['State']['Running'] or info['Config']['Labels'].get('dev.hicode.role')!='eval':raise ValueError('Dedicated eval machine required')
    # Refuse preparation while a task owns the machine (pgrep 1 means no matches).
    probe=subprocess.run([*docker,'exec',args.machine,'pgrep','-f','[r]unner.py'],stdout=subprocess.PIPE)
    if probe.returncode!=1:raise ValueError('Wait for active evaluation runners before preparing dependencies')
    run('exec',args.machine,'mkdir','-p','/opt/hicode-swe/staging','/opt/hicode-swe/env','/testbed')
    remote='/opt/hicode-swe/staging'
    run('cp',str(wheel),args.machine+':'+remote+'/harness.whl')
    run('cp',str(Path(__file__).with_name('legacy_python.py')),args.machine+':'+remote+'/legacy_python.py')
    run('cp',str(Path(__file__).with_name('sphinx_setup.py')),args.machine+':'+remote+'/sphinx_setup.py')
    run('cp',str(Path(__file__).with_name('xarray_setup.py')),args.machine+':'+remote+'/xarray_setup.py')
    run('cp',str(Path(__file__).with_name('source_version.py')),args.machine+':'+remote+'/source_version.py')
    run('cp',str(Path(__file__).with_name('reviewed_test_deps.py')),args.machine+':'+remote+'/reviewed_test_deps.py')
    for filename in ['protocol.py','swe.py','scm.py','xarray_report.py']:
        run('cp',str(Path(__file__).resolve().parents[1]/'worker'/filename),args.machine+':'+remote+'/'+filename)
    run('exec',args.machine,'chmod','700',remote)
    run('cp',str(Path(__file__).with_name('swe_machine.py')),args.machine+':'+remote+'/prepare.py')
    failed_groups=[]
    for group in groups:
        with tempfile.TemporaryDirectory() as tmp:
            requirements=Path(tmp)/'requirements.txt';requirements.write_bytes(group['requirements'])
            selected=Path(tmp)/'selected.json';selected.write_text(json.dumps(group['rows']))
            run('cp',str(requirements),args.machine+':'+remote+'/requirements.txt')
            run('cp',str(selected),args.machine+':'+remote+'/selected.json')
        try:run('exec',args.machine,'python3',remote+'/prepare.py',timeout=1800)
        except subprocess.CalledProcessError:
            failed_groups.extend(row['instance_id'] for row in group['rows'])
    if failed_groups:raise ValueError('Preparation/preflight failed; no incomplete catalog was published: '+', '.join(failed_groups))
    out.mkdir(mode=0o700,parents=True)
    for id in args.ids:run('cp',args.machine+':/opt/hicode-swe/bundles/'+id,str(out/id))
    print(json.dumps({'prepared':args.ids,'output':str(out),'modelAttempts':0,'evaluationMode':'shared-linux-development'}))

if __name__=='__main__':main()
