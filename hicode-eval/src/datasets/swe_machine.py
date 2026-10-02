"""Linux setup stage. Cached dependencies once; independent frozen public base trees."""
import hashlib
from sphinx_setup import VERSIONS as SPHINX_VERSIONS
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
PYTHON_BY_REPO_VERSION={
    ('django/django','3.2'): '3.6',
    ('django/django','4.0'):'3.8',
    ('django/django','4.1'):'3.9',
    ('django/django','4.2'):'3.9',
    ('django/django','5.0'):'3.11',
    **{('sympy/sympy',version):'3.9' for version in ('1.0','1.1','1.4','1.5','1.6','1.7','1.8','1.9','1.10','1.11','1.12')},
    **{('pytest-dev/pytest',version):'3.9' for version in ('5.0','5.1','5.2','5.4','6.0','6.2','7.2')},
    **{('sphinx-doc/sphinx', version): '3.9' for version in SPHINX_VERSIONS},
    **{('pydata/xarray',version):'3.10' for version in ('0.12','2022.03','2022.06','2022.09')},
}

def install_argv(uv, environment, version, requirements):
    if version=='3.6':return [str(environment/'bin/python'),'-m','pip','install',*requirements]
    return [uv,'pip','install','--python',str(environment/'bin/python'),*requirements]

def freeze_argv(uv, environment, version):
    if version=='3.6':return [str(environment/'bin/python'),'-m','pip','freeze']
    return [uv,'pip','freeze','--python',str(environment/'bin/python')]

def project_tool_pins(repo, python):
    # Older base trees may not declare pre-commit tools; never borrow newer pins.
    if not (repo/'.pre-commit-config.yaml').exists(): return []
    program="""import json,sys,yaml
document=yaml.safe_load(open(sys.argv[1]))
names={'https://github.com/psf/black':'black','https://github.com/PyCQA/isort':'isort','https://github.com/PyCQA/flake8':'flake8'}
print(json.dumps({names[r['repo']]:r['rev'] for r in document['repos'] if r.get('repo') in names}))
"""
    versions=json.loads(subprocess.check_output([str(python),'-c',program,str(repo/'.pre-commit-config.yaml')],text=True))
    if not isinstance(versions,dict) or not set(versions).issubset({'black','isort','flake8'}):raise ValueError('Invalid project development-tool pins')
    pins=[]
    for name,version in sorted(versions.items()):
        if not isinstance(version,str) or not re.fullmatch(r'v?[0-9]+(?:\.[0-9]+)+',version):raise ValueError('Unsupported development-tool revision')
        pins.append(name+'=='+version.removeprefix('v'))
    return pins

def run(args,timeout=600,**kwargs):
    subprocess.run(args,check=True,timeout=timeout,**kwargs)

def git(args,cwd):
    return subprocess.check_output(['git','-c','core.hooksPath=/dev/null','-c','gc.auto=0',*args],cwd=cwd,text=True).strip()

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

def dependency_cache_key(rows, requirements, architecture):
    identities={(r['repo'],r['version'],r['environment_setup_commit']) for r in rows}
    if len(identities)!=1:raise ValueError('Prepare one environment group at a time')
    repo,version,setup=next(iter(identities))
    python=PYTHON_BY_REPO_VERSION.get((repo,version))
    if python is None or not re.fullmatch(r'[a-f0-9]{40}',setup):
        raise ValueError('Unsupported environment identity')
    identity=json.dumps([repo,version,setup,python,architecture,'development-v2'])
    return hashlib.sha256(requirements+identity.encode()).hexdigest()

def main():
    architecture=platform.machine()
    if architecture not in {'aarch64','x86_64'}:raise ValueError('Unsupported Linux architecture')
    rows=json.loads((STAGE/'selected.json').read_text())
    identities={(row['repo'],row['version'],row['environment_setup_commit']) for row in rows}
    if len(identities)!=1:raise ValueError('Prepare one environment group at a time')
    repo_name,version,_=next(iter(identities))
    python=PYTHON_BY_REPO_VERSION.get((repo_name,version))
    if python is None:raise ValueError('Unsupported environment group')
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
    if repo_name=='pydata/xarray':env['UDUNITS2_XML_PATH']='/usr/share/xml/udunits/udunits2.xml'
    wheel=STAGE/'swebench-4.1.0-py3-none-any.whl'
    shutil.copyfile(STAGE/'harness.whl',wheel)
    if not (ROOT/'grader/bin/python').exists():run(['/opt/python313/bin/python3.13','-m','venv',str(ROOT/'grader')])
    probe=subprocess.run([str(ROOT/'grader/bin/python'),'-c',"import swebench; assert swebench.__version__=='4.1.0'"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if probe.returncode:run([uv,'pip','install','--python',str(ROOT/'grader/bin/python'),str(wheel)],env=env)
    run([str(ROOT/'grader/bin/python'),'-c',"import swebench; assert swebench.__version__=='4.1.0'"])
    legacy_interpreter=None
    if python=='3.6':
        from legacy_python import ensure_python36
        legacy_interpreter=ensure_python36(ROOT)
    key=dependency_cache_key(rows,(STAGE/'requirements.txt').read_bytes(),architecture)
    cache=ROOT/'cache'/key; ready=cache/'.ready.json'
    if not ready.exists():
        if cache.exists():shutil.rmtree(cache)
        # Original requirements include native bindings; install their actual headers once.
        run(['apt-get','-o','Acquire::Retries=1','-o','Acquire::http::Timeout=20','-o','Acquire::https::Timeout=20','update'])
        headers=['python3.11-dev'] if python=='3.11' else []
        if repo_name=='sphinx-doc/sphinx': headers.append('graphviz')
        if repo_name=='pydata/xarray':headers.append('libudunits2-dev')
        run(['apt-get','install','-y','--no-install-recommends','libmemcached-dev','zlib1g-dev','libffi-dev',*headers])
        if python=='3.6':
            run([str(legacy_interpreter),'-m','venv',str(cache)])
            run(install_argv(uv,cache,python,['pip==21.3.1','setuptools==59.6.0','wheel==0.37.1']),env=env)
            run(['apt-get','install','-y','--no-install-recommends','locales','gettext'])
            locale=Path('/etc/locale.gen');locale.write_text(locale.read_text().replace('# en_US.UTF-8 UTF-8','en_US.UTF-8 UTF-8'))
            run(['locale-gen'])
        else:run([uv,'venv','--seed','--python',python,str(cache)],env=env)
        run(install_argv(uv,cache,python,['-r',str(STAGE/'requirements.txt')]),env=env)
        installed=subprocess.check_output(freeze_argv(uv,cache,python),env=env,text=True)
        ready.write_text(json.dumps({'python':python,'requirementsSha256':hashlib.sha256((STAGE/'requirements.txt').read_bytes()).hexdigest(),'resolvedPackages':installed,'mode':'shared-linux-development'}))
    bundles=ROOT/'bundles';bundles.mkdir(exist_ok=True)
    from swe import editable_install_argv, project_environment
    for row in rows:
        id=row['instance_id'];target=bundles/id
        reused=False
        if target.exists():
            if (target/'swe-task.json').exists():
                existing=json.loads((target/'swe-task.json').read_text())
                if existing['instanceId']==id and existing['baseCommit']==row['base_commit'] and existing['version']==row['version']:
                    for name,sha in existing['files'].items():
                        if hashlib.sha256(os.fsencode(os.readlink(target/name)) if (target/name).is_symlink() else (target/name).read_bytes()).hexdigest()!=sha:raise ValueError('Cached SWE bundle changed')
                    (target/'repository/.git/hooks').mkdir(exist_ok=True)
                    reused=True
            if not reused:raise ValueError('Incomplete or mismatched cached bundle; inspect before removing: '+id)
        else:
            archive=STAGE/(row['base_commit']+'.tar.gz')
            if not archive.exists():
                partial=archive.with_suffix('.partial')
                try:
                    run(['curl','--http1.1','-fL','--retry','3','--retry-all-errors','--retry-delay','1',
                         '--connect-timeout','20','--max-time','120',
                         'https://codeload.github.com/'+repo_name+'/tar.gz/'+row['base_commit'],'-o',str(partial)])
                    partial.replace(archive)
                finally:partial.unlink(missing_ok=True)
            target.mkdir(mode=0o700)
            extract(archive,target/'repository')
        repo=target/'repository'
        from reviewed_test_deps import reviewed_test_dependencies
        reviewed_test_dependencies(repo_name,version,repo)
        declaration=''
        if repo_name=='sphinx-doc/sphinx':
            from sphinx_setup import apply_setup, dependency_identity, build_requirements
            if not reused: apply_setup(repo,version)
            declaration=dependency_identity(repo)
        pins=project_tool_pins(repo,cache/'bin/python') if repo_name=='django/django' else []
        tooling_key=hashlib.sha256((key+json.dumps(pins)+declaration+'-development-tools-v1').encode()).hexdigest()
        task_cache=ROOT/'cache'/tooling_key;tooling_ready=task_cache/'.ready.json'
        if not tooling_ready.exists():
            if task_cache.exists():raise ValueError('Incomplete development-tool cache; inspect before removing')
            shutil.copytree(cache,task_cache,symlinks=True)
            from swe import relocate_environment
            relocate_environment(task_cache,str(cache));tooling_ready.unlink()
            if pins:run(install_argv(uv,task_cache,python,pins),env=env)
            packages=subprocess.check_output(freeze_argv(uv,task_cache,python),env=env,text=True)
            tooling_ready.write_text(json.dumps({'python':python,'requirementsSha256':hashlib.sha256((STAGE/'requirements.txt').read_bytes()).hexdigest(),
                'developmentTools':pins,'resolvedPackages':packages,'mode':'shared-linux-development'}))
        if repo_name=='sphinx-doc/sphinx':
            proof=task_cache/'.project-dependencies.json'
            backend=build_requirements(repo)
            installed_proof=json.loads(proof.read_text()) if proof.exists() else {}
            if installed_proof.get('buildRequirements')!=backend:
                if backend:run([uv,'pip','install','--python',str(task_cache/'bin/python'),*backend],env=env)
            if not proof.exists():
                run([str(task_cache/'bin/python'),'-m','pip','install','--no-build-isolation','-e',str(repo)+'[test]'])
                run([str(task_cache/'bin/python'),'-m','pip','uninstall','-y','Sphinx'])
                packages=subprocess.check_output(freeze_argv(uv,task_cache,python),env=env,text=True)
                proof.write_text(json.dumps({'declarations':declaration,'buildRequirements':backend,'resolvedPackages':packages}))
            elif installed_proof.get('buildRequirements')!=backend:
                installed_proof['buildRequirements']=backend
                installed_proof['resolvedPackages']=subprocess.check_output(freeze_argv(uv,task_cache,python),env=env,text=True)
                proof.write_text(json.dumps(installed_proof))
            if json.loads(proof.read_text())['declarations']!=declaration:raise ValueError('Sphinx dependencies do not match source declarations')
        tooling_proof=json.loads(tooling_ready.read_text())
        if tooling_proof.get('developmentTools')!=pins:raise ValueError('Development-tool cache does not match this project')
        if repo_name in ('pydata/xarray','pytest-dev/pytest') and reused:
            from source_version import prepare_source_version
            prepare_source_version(repo_name,repo,row['base_commit'],task_cache/'bin/python',ROOT/'upstream-metadata'/(repo_name.split('/')[-1]+'.git'))
            # Only bookkeeping under .git changes; task source and assertions
            # stay frozen. Historical local bundles and runs are never rewritten.
            existing['files']['repository/.git/hicode-source-version.json']=hashlib.sha256((repo/'.git/hicode-source-version.json').read_bytes()).hexdigest()
            if (repo/'versioneer.py').is_file():
                # Versioneer's own sdist helper generates only its version
                # artifact. Freeze that generated file in the prepared baseline.
                if git(['diff','--','xarray/_version.py'],repo):
                    git(['add','xarray/_version.py'],repo)
                    git(['commit','-qm','Prepared upstream build version'],repo)
                existing['baselineCommit']=git(['rev-parse','HEAD'],repo)
                existing['files']={str(p.relative_to(target)):hashlib.sha256(os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()).hexdigest()
                                   for p in sorted(target.rglob('*')) if (p.is_file() or p.is_symlink()) and p!=target/'swe-task.json'}
        if reused:
            if existing['environment']!=str(task_cache):
                from protocol import atomic_json
                existing['environment']=str(task_cache)
                atomic_json(target/'swe-task.json',existing)
                print('Updated cached bundle environment: '+id,flush=True)
            else:print('Reusing frozen public bundle: '+id,flush=True)
            if repo_name in ('pydata/xarray','pytest-dev/pytest'):
                from protocol import atomic_json
                atomic_json(target/'swe-task.json',existing)
            continue
        git(['init','--template='],repo)
        (repo/'.git/hooks').mkdir(exist_ok=True)
        git(['config','user.email','eval@localhost'],repo);git(['config','user.name','HiCode Eval'],repo)
        git(['add','-A'],repo);git(['commit','-qm','Original base tree '+row['base_commit']],repo)
        if repo_name in ('pydata/xarray','pytest-dev/pytest'):
            from source_version import prepare_source_version
            prepare_source_version(repo_name,repo,row['base_commit'],task_cache/'bin/python',ROOT/'upstream-metadata'/(repo_name.split('/')[-1]+'.git'))
        # Runtime replays this repository installation at the stable /testbed mount.
        run(editable_install_argv(task_cache/'bin/python',repo,repo_name),env={**os.environ,**project_environment(repo_name,repo)})
        git(['add','-A'],repo);git(['commit','--allow-empty','-qm','Prepared baseline'],repo)
        baseline=git(['rev-parse','HEAD'],repo)
        git(['gc','--prune=now'],repo)
        # Remove path-specific editable registration from the reusable cache.
        project_package={
            'django/django':'Django',
            'sympy/sympy':'sympy',
            'pytest-dev/pytest':'pytest',
            'pydata/xarray':'xarray',
            'sphinx-doc/sphinx':'Sphinx',
        }[repo_name]
        run([str(task_cache/'bin/python'),'-m','pip','uninstall','-y',project_package])
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
              'environment':str(task_cache),'python':python,'verifierSeconds':1800,'baselineCommit':baseline,'files':files,
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
        version_tuple=tuple(map(int,python.split('.')))
        imports={
            'django/django':'django,asgiref,sqlparse',
            'sympy/sympy':'sympy,mpmath',
            'pytest-dev/pytest':'pytest,pluggy',
            'pydata/xarray':'xarray,numpy,pandas',
            'sphinx-doc/sphinx':'sphinx,pytest,tox,jinja2',
        }[repo_name]
        probe_env={'PATH':'/opt/hicode-swe/env/bin:'+os.environ['PATH'],
                   'HOME':str(home),'LANG':'C.UTF-8','VIRTUAL_ENV':'/opt/hicode-swe/env'}
        probe_env.update(project_environment(repo_name,project))
        if repo_name in ('pytest-dev/pytest','sphinx-doc/sphinx','pydata/xarray'):
            # Install the task's source registration using cached build backends,
            # matching the real runner before imports and tox discovery.
            install=namespace_argv(editable_install_argv('/opt/hicode-swe/env/bin/python','/testbed',repo_name),
                                   project,home,logs,control,workdir='/testbed',environment=local_env)
            run(install,timeout=60,preexec_fn=demote,env=probe_env)
        program=f"import sys,{imports};assert sys.version_info[:2]=={version_tuple!r};assert sys.prefix=='/opt/hicode-swe/env';print('SWE namespace/import preflight passed')"
        if repo_name=='django/django' and version=='3.2':
            program+=";import ssl,sqlite3,ctypes,zlib,locale,os;locale.setlocale(locale.LC_ALL,'en_US.UTF-8');sys.path.insert(0,'/testbed/tests');os.environ['DJANGO_SETTINGS_MODULE']='test_sqlite';django.setup();print('Django 3.2 settings/locale preflight passed')"
        argv=namespace_argv(['/opt/hicode-swe/env/bin/python','-c',program],project,home,logs,control,workdir='/testbed',environment=local_env)
        run(argv,timeout=30,preexec_fn=demote,env=probe_env)
        if repo_name=='pydata/xarray':
            program="import bottleneck,cftime,sparse,pint,numba,numexpr,numbagg;import pandas as pd,xarray as xr;assert not xr.__version__.startswith('0.1.dev');pd.Series([1,2]).to_xarray();print('Xarray dependencies/version preflight passed')"
            argv=namespace_argv(['/opt/hicode-swe/env/bin/python','-c',program],project,home,logs,control,workdir='/testbed',environment=local_env)
            run(argv,timeout=60,preexec_fn=demote,env=probe_env)
        if repo_name=='sympy/sympy' and version in ('1.1','1.4'):
            # Keep the reviewed upstream Python 3.9 recipe. Check common parsing
            # separately from the legacy AST path, whose constructors changed
            # in Python 3.9; never repair benchmark source during preparation.
            program="""import sympy
from sympy.parsing.sympy_parser import parse_expr
assert parse_expr('x + 1')==sympy.Symbol('x')+1
assert sympy.sympify('1/2')==sympy.Rational(1,2)
from sympy.parsing.ast_parser import parse_expr as ast_parse
try:
    ast_parse('x + 1', {})
except TypeError as error:
    if 'Call constructor takes at most 3 positional arguments' not in str(error):raise
    print('Original SymPy/Python 3.9 baseline AST incompatibility: '+str(error))
print('SymPy original-runtime/common-parsing preflight passed')
"""
            argv=namespace_argv(['/opt/hicode-swe/env/bin/python','-c',program],project,home,logs,control,workdir='/testbed',environment=local_env)
            run(argv,timeout=30,preexec_fn=demote,env=probe_env)
        if repo_name=='pytest-dev/pytest':
            # Import alone accepts a bogus 0.1.dev build. Ask the project's own
            # CLI to collect an existing public module and enforce minversion.
            public_modules=sorted((project/'testing').glob('test_*.py'))
            if not public_modules:raise ValueError('Missing original public Pytest test modules')
            relative=str(public_modules[0].relative_to(project))
            argv=namespace_argv(['python','-m','pytest','--collect-only','-q',relative],
                                project,home,logs,control,workdir='/testbed',environment=local_env)
            run(argv,timeout=120,preexec_fn=demote,env=probe_env)
        if repo_name=='sphinx-doc/sphinx':
            argv=namespace_argv(['tox','--current-env','-epy39','--showconfig'],project,home,logs,control,workdir='/testbed',environment=local_env)
            with (logs/'tox-preflight.txt').open('w') as output:
                run(argv,timeout=60,preexec_fn=demote,env=probe_env,stdout=output,stderr=subprocess.STDOUT)
            public_modules=sorted((project/'tests').glob('test_*.py'))
            if not public_modules:raise ValueError('Missing original public Sphinx test modules')
            relative=str(public_modules[0].relative_to(project))
            argv=namespace_argv(['tox','--current-env','-epy39','-v','--','--collect-only','-q',relative],
                                project,home,logs,control,workdir='/testbed',environment=local_env)
            with (logs/'collection-preflight.txt').open('w') as output:
                try:run(argv,timeout=120,preexec_fn=demote,env=probe_env,stdout=output,stderr=subprocess.STDOUT)
                except subprocess.CalledProcessError:
                    print((logs/'collection-preflight.txt').read_text()[-8000:],flush=True)
                    raise
            print('Sphinx tox/public-test collection preflight passed',flush=True)
    if repo_name=='pydata/xarray':
        from xarray_setup import preflight_bundle
        blocked=[]
        for row in rows:
            target=bundles/row['instance_id']
            environment=Path(json.loads((target/'swe-task.json').read_text())['environment'])
            proof=preflight_bundle(row,target,environment)
            print('Public regression preflight: '+row['instance_id']+' '+('passed' if proof['passed'] else 'blocked: '+proof['error']),flush=True)
            if not proof['passed']:blocked.append(row['instance_id'])
        if blocked:raise ValueError('Xarray environments are not ready; no model may run: '+', '.join(blocked))
    print('Ready: '+str(len(rows))+' SWE bundles; no model or hidden assertions executed',flush=True)

if __name__=='__main__':main()
