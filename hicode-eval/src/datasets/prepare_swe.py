"""Prepare supported public SWE instances on the existing dedicated Linux machine.
Host keeps test patches; repository and problem statement alone enter the Actor view.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

IDS = ['django__django-15731', 'django__django-15741', 'django__django-15863', 'django__django-16136']
REVISION = 'c104f840cc67f8b6eec6f759ebc8b2693d585d4a'
PYTHON_BY_REPO_VERSION = {
    ('django/django', '4.0'): '3.8',
    ('django/django', '4.1'): '3.9',
    ('django/django', '4.2'): '3.9',
    ('django/django', '5.0'): '3.11',
    **{('sympy/sympy', version): '3.9' for version in ('1.8', '1.9', '1.10', '1.11', '1.12')},
}

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
        else:
            expected_recipe = {'python':python, 'packages':'mpmath flake8',
                               'pip_packages':['mpmath==1.3.0','flake8-comprehensions'],
                               'install':'python -m pip install -e .',
                               'test_cmd':"PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose"}
        if identity in result:
            result[identity]['rows'].append(row)
            continue
        matches = [g for g in declarations if
                   (g['repo'], g['version'], g['environmentSetupCommit']) == identity]
        if len(matches) != 1: raise ValueError('Missing or ambiguous environment group')
        group = matches[0]
        if (python is None or group['harnessRelease'] != '4.1.0' or group['recipe'] != expected_recipe or
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
        else:
            if sources: raise ValueError('Unexpected SymPy dependency source')
            # Both the original package list and its explicit pip pins are preserved.
            requirement_bytes = b'mpmath==1.3.0\nflake8-comprehensions\nflake8\n'
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
    for filename in ['protocol.py','swe.py']:
        run('cp',str(Path(__file__).resolve().parents[1]/'worker'/filename),args.machine+':'+remote+'/'+filename)
    run('exec',args.machine,'chmod','700',remote)
    run('cp',str(Path(__file__).with_name('swe_machine.py')),args.machine+':'+remote+'/prepare.py')
    for group in groups:
        with tempfile.TemporaryDirectory() as tmp:
            requirements=Path(tmp)/'requirements.txt';requirements.write_bytes(group['requirements'])
            selected=Path(tmp)/'selected.json';selected.write_text(json.dumps(group['rows']))
            run('cp',str(requirements),args.machine+':'+remote+'/requirements.txt')
            run('cp',str(selected),args.machine+':'+remote+'/selected.json')
        run('exec',args.machine,'python3',remote+'/prepare.py',timeout=1800)
    out.mkdir(mode=0o700,parents=True)
    for id in args.ids:run('cp',args.machine+':/opt/hicode-swe/bundles/'+id,str(out/id))
    print(json.dumps({'prepared':args.ids,'output':str(out),'modelAttempts':0,'evaluationMode':'shared-linux-development'}))

if __name__=='__main__':main()
