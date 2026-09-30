"""Linux setup stage. Cached dependencies once; independent frozen public base trees."""
import hashlib
import json
import os
import platform
import posixpath
from pathlib import Path
import shutil
import subprocess
import tempfile
import pwd
import tarfile
import re

ROOT=Path('/opt/hicode-swe'); STAGE=ROOT/'staging'

def project_tool_pins(repo, python):
    program="""import json,sys,yaml
document=yaml.safe_load(open(sys.argv[1]))
names={'https://github.com/psf/black':'black','https://github.com/PyCQA/isort':'isort','https://github.com/PyCQA/flake8':'flake8'}
print(json.dumps({names[r['repo']]:r['rev'] for r in document['repos'] if r.get('repo') in names}))
"""
    versions=json.loads(subprocess.check_output([str(python),'-c',program,str(repo/'.pre-commit-config.yaml')],text=True))
    if not isinstance(versions,dict) or set(versions)!={'black','isort','flake8'}:raise ValueError('Missing project development-tool pins')
    pins=[]
    for name,version in sorted(versions.items()):
        if not isinstance(version,str) or not re.fullmatch(r'v?[0-9]+(?:\.[0-9]+)+',version):raise ValueError('Unsupported development-tool revision')
        pins.append(name+'=='+version.removeprefix('v'))
    return pins

def run(args,timeout=600,**kwargs):
    subprocess.run(args,check=True,timeout=timeout,**kwargs)

def git(args,cwd):
    return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=cwd,text=True).strip()

def extract(archive,target):
    target.mkdir()
    with tarfile.open(archive) as source:
        members=source.getmembers();prefix=members[0].name.split('/')[0]
        for entry in members:
            path=Path(entry.name)
            if path.is_absolute() or '..' in path.parts or path.parts[0]!=prefix or entry.islnk():raise ValueError('Unsafe upstream archive path')
            entry.name=str(Path(*path.parts[1:]))
            if entry.name=='.':continue
            out=target/entry.name
            if any(parent.is_symlink() for parent in out.parents if parent!=target.parent):raise ValueError('Archive writes through symlink')
            if entry.issym():
                resolved=posixpath.normpath(posixpath.join(posixpath.dirname(entry.name),entry.linkname))
                if entry.linkname.startswith('/') or resolved=='..' or resolved.startswith('../'):raise ValueError('Source link escapes repository')
                out.parent.mkdir(parents=True,exist_ok=True);out.symlink_to(entry.linkname)
            elif entry.isdir():out.mkdir(parents=True,exist_ok=True)
            elif entry.isfile():
                out.parent.mkdir(parents=True,exist_ok=True)
                with source.extractfile(entry) as src,out.open('xb') as dst:shutil.copyfileobj(src,dst)
                out.chmod(0o755 if entry.mode & 0o111 else 0o644)
            else:raise ValueError('Special archive member')

def main():
    architecture=platform.machine()
    if architecture not in {'aarch64','x86_64'}:raise ValueError('Unsupported Linux architecture')
    rows=json.loads((STAGE/'selected.json').read_text())
    if not shutil.which('uv') and not (ROOT/'uv').exists():
        # Pinned official uv, cached on the evaluation machine. No per-task installer.
        archive=STAGE/'uv.tar.gz'
        run(['curl','-fL','--retry','1','--max-time','120','https://github.com/astral-sh/uv/releases/download/0.8.15/uv-'+architecture+'-unknown-linux-gnu.tar.gz','-o',str(archive)])
        with tarfile.open(archive) as tar:
            member=tar.getmember('uv-'+architecture+'-unknown-linux-gnu/uv')
            with tar.extractfile(member) as src,(ROOT/'uv').open('wb') as dst:shutil.copyfileobj(src,dst)
        (ROOT/'uv').chmod(0o755)
    uv=shutil.which('uv') or str(ROOT/'uv')
    env=dict(os.environ,UV_PYTHON_INSTALL_DIR=str(ROOT/'python'),UV_CACHE_DIR=str(ROOT/'uv-cache'))
    wheel=STAGE/'swebench-4.1.0-py3-none-any.whl'
    shutil.copyfile(STAGE/'harness.whl',wheel)
    if not (ROOT/'grader/bin/python').exists():run(['/opt/python313/bin/python3.13','-m','venv',str(ROOT/'grader')])
    probe=subprocess.run([str(ROOT/'grader/bin/python'),'-c',"import swebench; assert swebench.__version__=='4.1.0'"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if probe.returncode:run([uv,'pip','install','--python',str(ROOT/'grader/bin/python'),str(wheel)],env=env)
    run([str(ROOT/'grader/bin/python'),'-c',"import swebench; assert swebench.__version__=='4.1.0'"])
    key=hashlib.sha256((STAGE/'requirements.txt').read_bytes()+('django4.2-python3.9-'+('arm64' if architecture=='aarch64' else 'x86_64')+'-development-v1').encode()).hexdigest()
    cache=ROOT/'cache'/key; ready=cache/'.ready.json'
    if not ready.exists():
        if cache.exists():shutil.rmtree(cache)
        # Original requirements include native bindings; install their actual headers once.
        run(['apt-get','-o','Acquire::Retries=1','-o','Acquire::http::Timeout=20','-o','Acquire::https::Timeout=20','update'])
        run(['apt-get','install','-y','--no-install-recommends','libmemcached-dev','zlib1g-dev','libffi-dev'])
        run([uv,'venv','--seed','--python','3.9',str(cache)],env=env)
        run([uv,'pip','install','--python',str(cache/'bin/python'),'-r',str(STAGE/'requirements.txt')],env=env)
        installed=subprocess.check_output([uv,'pip','freeze','--python',str(cache/'bin/python')],env=env,text=True)
        ready.write_text(json.dumps({'python':'3.9','requirementsSha256':hashlib.sha256((STAGE/'requirements.txt').read_bytes()).hexdigest(),'resolvedPackages':installed,'mode':'shared-linux-development'}))
    bundles=ROOT/'bundles';bundles.mkdir(exist_ok=True)
    for row in rows:
        id=row['instance_id'];target=bundles/id
        if target.exists():
            if (target/'swe-task.json').exists():
                existing=json.loads((target/'swe-task.json').read_text())
                if existing['instanceId']==id and existing['baseCommit']==row['base_commit']:
                    for name,sha in existing['files'].items():
                        if hashlib.sha256(os.fsencode(os.readlink(target/name)) if (target/name).is_symlink() else (target/name).read_bytes()).hexdigest()!=sha:raise ValueError('Cached SWE bundle changed')
                    (target/'repository/.git/hooks').mkdir(exist_ok=True)
                    print('Reusing frozen public bundle: '+id,flush=True);continue
            raise ValueError('Incomplete or mismatched cached bundle; inspect before removing: '+id)
        archive=STAGE/(row['base_commit']+'.tar.gz')
        if not archive.exists():
            partial=archive.with_suffix('.partial')
            try:
                run(['curl','-fL','--retry','1','--max-time','120','https://codeload.github.com/django/django/tar.gz/'+row['base_commit'],'-o',str(partial)])
                partial.replace(archive)
            finally:partial.unlink(missing_ok=True)
        target.mkdir(mode=0o700)
        repo=target/'repository';extract(archive,repo)
        pins=project_tool_pins(repo,cache/'bin/python')
        tooling_key=hashlib.sha256((key+json.dumps(pins)+'-development-tools-v1').encode()).hexdigest()
        task_cache=ROOT/'cache'/tooling_key;tooling_ready=task_cache/'.ready.json'
        if not tooling_ready.exists():
            if task_cache.exists():raise ValueError('Incomplete development-tool cache; inspect before removing')
            shutil.copytree(cache,task_cache,symlinks=True)
            from swe import relocate_environment
            relocate_environment(task_cache,str(cache));tooling_ready.unlink()
            run([uv,'pip','install','--python',str(task_cache/'bin/python'),*pins],env=env)
            packages=subprocess.check_output([uv,'pip','freeze','--python',str(task_cache/'bin/python')],env=env,text=True)
            tooling_ready.write_text(json.dumps({'python':'3.9','requirementsSha256':hashlib.sha256((STAGE/'requirements.txt').read_bytes()).hexdigest(),
                'developmentTools':pins,'resolvedPackages':packages,'mode':'shared-linux-development'}))
        tooling_proof=json.loads(tooling_ready.read_text())
        if tooling_proof.get('developmentTools')!=pins:raise ValueError('Development-tool cache does not match this project')
        git(['init','--template='],repo)
        (repo/'.git/hooks').mkdir(exist_ok=True)
        git(['config','user.email','eval@localhost'],repo);git(['config','user.name','HiCode Eval'],repo)
        git(['add','-A'],repo);git(['commit','-qm','Original base tree '+row['base_commit']],repo)
        # Django 4.2 official repo installation. venv is only transient during setup;
        # runtime replays the same installation at the stable /testbed mount.
        run([str(task_cache/'bin/python'),'-m','pip','install','--no-deps','-e',str(repo)])
        git(['add','-A'],repo);git(['commit','--allow-empty','-qm','Prepared baseline'],repo)
        baseline=git(['rev-parse','HEAD'],repo)
        git(['gc','--prune=now'],repo)
        # Remove path-specific editable registration from the reusable cache.
        run([str(task_cache/'bin/python'),'-m','pip','uninstall','-y','Django'])
        (target/'instruction.md').write_text(row['problem_statement'])
        hidden=target/'hidden';hidden.mkdir(mode=0o700)
        evaluator={k:v for k,v in row.items() if k!='problem_statement'}
        (hidden/'evaluation.json').write_text(json.dumps(evaluator))
        files={}
        for path in sorted(target.rglob('*')):
            if path.is_symlink():files[str(path.relative_to(target))]=hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
            elif path.is_file():files[str(path.relative_to(target))]=hashlib.sha256(path.read_bytes()).hexdigest()
        task={'kind':'swe-bench-verified','instanceId':id,'revision':'c104f840cc67f8b6eec6f759ebc8b2693d585d4a',
              'repo':row['repo'],'version':row['version'],'baseCommit':row['base_commit'],'harnessVersion':'4.1.0',
              'environment':str(task_cache),'python':'3.9','verifierSeconds':1800,'baselineCommit':baseline,'files':files,
              'evaluationMode':'shared-linux-development'}
        (target/'swe-task.json').write_text(json.dumps(task,indent=2)+'\n')
        print('Prepared public base tree: '+id,flush=True)
    # One real namespace/import probe for this shared environment group, no tests/answers.
    from protocol import namespace_argv
    from swe import relocate_environment
    account=pwd.getpwnam('node')
    with tempfile.TemporaryDirectory(prefix='swe-preflight-',dir='/eval') as tmp:
        probe=Path(tmp);project=probe/'project';home=probe/'home';logs=probe/'logs';control=probe/'control';local_env=probe/'env'
        shutil.copytree(bundles/rows[0]['instance_id']/'repository',project,symlinks=True)
        selected_cache=Path(json.loads((bundles/rows[0]['instance_id']/'swe-task.json').read_text())['environment'])
        shutil.copytree(selected_cache,local_env,symlinks=True);relocate_environment(local_env,str(selected_cache))
        for path in [home,logs,control]:path.mkdir()
        run(['chown','-R',str(account.pw_uid)+':'+str(account.pw_gid),str(probe)])
        def demote():os.setgroups([]);os.setgid(account.pw_gid);os.setuid(account.pw_uid)
        argv=namespace_argv(['/opt/hicode-swe/env/bin/python','-c',"import sys,django,asgiref,sqlparse;assert sys.version_info[:2]==(3,9);assert sys.prefix=='/opt/hicode-swe/env';print('SWE namespace/import preflight passed')"],project,home,logs,control,workdir='/testbed',environment=local_env)
        run(argv,timeout=30,preexec_fn=demote,env={'PATH':'/opt/hicode-swe/env/bin:'+os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8'})
    print('Ready: '+str(len(rows))+' SWE bundles; no model or hidden assertions executed',flush=True)

if __name__=='__main__':main()
