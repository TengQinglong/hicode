"""Prepare four public Django instances on the existing dedicated Linux machine.
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
        if row['repo'] != 'django/django' or row['version'] != '4.2': raise ValueError('Pilot supports Django 4.2 only')
        for field in ['repo','base_commit','problem_statement']:
            if public[row['instance_id']][field] != row[field]: raise ValueError('Public/evaluator mismatch')
        # Never copy gold patch, hints, or answer commit into an environment or bundle.
        rows[row['instance_id']] = {k:row[k] for k in ['instance_id','repo','version','base_commit','environment_setup_commit','problem_statement','test_patch','FAIL_TO_PASS','PASS_TO_PASS']}
    if set(rows) != set(ids): raise ValueError('Missing selected instance')
    return [rows[id] for id in ids]

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
    reqmeta=json.loads((prep/'candidate-selection.json').read_text())['dependencySourceFiles'][0]
    requirements=prep/'artifacts/dependency-inputs'/reqmeta['artifactPath']
    if hashlib.sha256(requirements.read_bytes()).hexdigest()!=reqmeta['sha256']: raise ValueError('Original requirements changed')
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
    run('cp',str(requirements),args.machine+':'+remote+'/requirements.txt')
    for filename in ['protocol.py','swe.py']:
        run('cp',str(Path(__file__).resolve().parents[1]/'worker'/filename),args.machine+':'+remote+'/'+filename)
    run('exec',args.machine,'chmod','700',remote)
    run('cp',str(Path(__file__).with_name('swe_machine.py')),args.machine+':'+remote+'/prepare.py')
    with tempfile.TemporaryDirectory() as tmp:
        selected=Path(tmp)/'selected.json';selected.write_text(json.dumps(rows))
        run('cp',str(selected),args.machine+':'+remote+'/selected.json')
    run('exec',args.machine,'python3',remote+'/prepare.py',timeout=1800)
    out.mkdir(mode=0o700,parents=True)
    for id in args.ids:run('cp',args.machine+':/opt/hicode-swe/bundles/'+id,str(out/id))
    print(json.dumps({'prepared':args.ids,'output':str(out),'modelAttempts':0,'evaluationMode':'shared-linux-development'}))

if __name__=='__main__':main()
