"""Host-owned dependency and source-version preparation for reviewed Xarray recipes."""
import json
from pathlib import Path
import re
import subprocess

PINS = {
    'bottleneck': 'bottleneck==1.3.7', 'cftime': 'cftime==1.6.4',
    'sparse': 'sparse==0.13.0', 'pint': 'pint==0.19.2',
    'numexpr': 'numexpr==2.8.4', 'numba': 'numba==0.57.1',
    'numbagg': 'numbagg==0.2.2', 'flox': 'flox==0.6.10',
    'iris': 'scitools-iris==3.4.1',
}
BUILD_PINS = ['setuptools-scm[toml]==7.1.0', 'wheel==0.41.2']


def dependency_pins(declaration):
    # Input bytes already match a reviewed setup-commit SHA. Only translate
    # explicitly supported CPU test dependencies; do not execute YAML commands.
    names=set(re.findall(r'^\s*-\s*([a-zA-Z0-9_-]+)', declaration, re.MULTILINE))
    required={'bottleneck','cftime','sparse','pint','numba','numexpr','numbagg','iris'}
    if not required.issubset(names):
        raise ValueError('Incomplete reviewed Xarray dependency declaration')
    return BUILD_PINS + [pin for name,pin in PINS.items() if name in names]


def source_version(project, base_commit, python, metadata):
    if not re.fullmatch(r'[a-f0-9]{40}',base_commit):
        raise ValueError('Invalid Xarray source commit')
    metadata=Path(metadata)
    if not metadata.exists():
        metadata.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['git','init','--bare','--template=',str(metadata)],check=True,timeout=15,stdout=subprocess.DEVNULL)
    prefix=['git','-c','http.version=HTTP/1.1','-c','core.hooksPath=/dev/null','--git-dir='+str(metadata)]
    if subprocess.run([*prefix,'cat-file','-e',base_commit+'^{commit}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        # Public ancestry and release tags only. Never fetch answer patches or
        # checkout blobs; this cache remains outside every Actor mount.
        subprocess.run([*prefix,'fetch','--filter=blob:none','--no-tags',
                        'https://github.com/pydata/xarray.git','+refs/tags/*:refs/tags/*',base_commit],
                       check=True,timeout=180)
    describe=subprocess.check_output([*prefix,'describe','--tags','--long',base_commit],text=True,timeout=15).strip()
    match=re.fullmatch(r'v?([0-9]+(?:\.[0-9]+)+(?:[ab]\d+|rc\d+)?)-(\d+)-(g[a-f0-9]+)',describe)
    if not match:raise ValueError('Unsupported upstream Xarray version description')
    date=subprocess.check_output([*prefix,'show','-s','--format=%cI',base_commit],text=True,timeout=15).strip()
    program="""import sys,importlib.util,os
from setuptools_scm.version import meta,format_version
from setuptools_scm.config import Configuration
root,tag,distance,node,commit,date=sys.argv[1:]
if os.path.isfile(os.path.join(root,'versioneer.py')):
    spec=importlib.util.spec_from_file_location('versioneer',os.path.join(root,'versioneer.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    config=module.get_config_from_root(root)
    value=module.render({'closest-tag':tag,'distance':int(distance),'short':node[1:],'long':commit,'dirty':False,'date':date,'error':None},config.style)
    module.write_to_version_file(os.path.join(root,config.versionfile_source),value)
    print(value['version'])
else:
    value=meta(tag,distance=int(distance),node=node,dirty=False,config=Configuration())
    print(format_version(value,version_scheme='guess-next-dev',local_scheme='node-and-date'))
"""
    version=subprocess.check_output([str(python),'-c',program,str(project),*match.groups(),base_commit,date],text=True,timeout=15).strip().splitlines()[-1]
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+)+(?:[ab]\d+|rc\d+)?(?:\.dev[0-9]+\+g[a-f0-9]+|\+[0-9]+\.g[a-f0-9]+)?',version):
        raise ValueError('Invalid upstream Xarray build version')
    receipt={'baseCommit':base_commit,'describe':describe,'version':version}
    from protocol import atomic_json
    atomic_json(Path(project)/'.git/hicode-source-version.json',receipt)
    return receipt


def public_regression_nodes(row):
    nodes=json.loads(row['PASS_TO_PASS']) if isinstance(row['PASS_TO_PASS'],str) else row['PASS_TO_PASS']
    if not isinstance(nodes,list) or not nodes or any(not isinstance(n,str) or not n.startswith('xarray/tests/') or '..' in Path(n.split('::')[0]).parts or '\n' in n for n in nodes):
        raise ValueError('Invalid public Xarray regression selection')
    return nodes


def public_preflight(row, project, environment, root, run_namespace):
    """Run existing PASS_TO_PASS assertions only, before any model or hidden patch."""
    requested=public_regression_nodes(row)
    # cdms2 is absent from the reviewed pip recipe and has no supported pip
    # distribution for these managed interpreters. Do not silently skip it.
    program='import importlib.util;assert importlib.util.find_spec("cdms2"),"Required public regressions need cdms2; prepare a compatible CDAT environment before evaluating this task"'
    report=Path(root)/'public-regressions.json'
    from swe import xarray_arm_reporting
    reporter=Path(root)/'hicode_platform_report.py'
    # The reporter additionally emits a machine-readable proof of real call
    # outcomes; skipped/xfail tests are never silently promoted.
    import shutil
    shutil.copyfile(Path(__file__).with_name('xarray_report.py'),reporter)
    collection=Path(root)/'public-collection.json'
    modules=sorted({n.split('::')[0] for n in requested})
    run_namespace(['python','-m','pytest','--collect-only','-q','-p','hicode_platform_report',*modules],timeout=120,
                  extra={'PYTHONPATH':str(root),'HICODE_XARRAY_PREFLIGHT_COLLECT':str(collection)})
    collected=json.loads(collection.read_text())
    if not isinstance(collected,dict) or set(collected)!={'nodes','skipped'} or not isinstance(collected['skipped'],list):raise ValueError('Invalid public collection receipt')
    if collected['skipped']:raise ValueError('Required public test modules skipped collection: '+str(collected['skipped']))
    available=collected['nodes']
    if not isinstance(available,list) or any(not isinstance(n,str) for n in available):raise ValueError('Invalid public collection receipt')
    # Some official regression IDs are introduced/renamed by the hidden patch.
    # They are not public base assertions and must not be used for this probe.
    available=set(available)
    nodes=[n for n in requested if n in available]
    if not nodes:raise ValueError('No original public Xarray regressions available for preparation')
    if any('cdms2' in n for n in nodes):run_namespace(['python','-c',program],timeout=30)
    extra={'PYTHONPATH':str(root),'HICODE_XARRAY_PREFLIGHT_REPORT':str(report),
           'HICODE_XARRAY_ARM_REPORT':'1' if xarray_arm_reporting(project) else '0'}
    run_namespace(['python','-m','pytest','-q','-rA','-p','hicode_platform_report',*nodes],timeout=600,extra=extra)
    outcomes=json.loads(report.read_text())
    missing=[n for n in nodes if outcomes.get(n)!='passed']
    if missing:raise ValueError('Incomplete public Xarray regression environment: '+', '.join(missing[:8]))
    return {'sourceCommit':row['base_commit'],'environment':str(environment),'passed':True,'checked':len(nodes)}


def preflight_bundle(row, target, environment):
    import os
    import pwd
    import shutil
    import tempfile
    from protocol import namespace_argv, atomic_json
    from swe import relocate_environment,project_environment,editable_install_argv
    account=pwd.getpwnam('node')
    receipt={'sourceCommit':row['base_commit'],'environment':str(environment),'passed':False,'checked':0}
    with tempfile.TemporaryDirectory(prefix='xarray-public-',dir='/eval') as tmp:
        root=Path(tmp);project=root/'project';home=root/'home';logs=root/'logs';control=root/'control';local_env=root/'env'
        shutil.copytree(Path(target)/'repository',project,symlinks=True)
        shutil.copytree(environment,local_env,symlinks=True);relocate_environment(local_env,str(environment))
        for p in [home,logs,control]:p.mkdir()
        subprocess.run(['chown','-R',str(account.pw_uid)+':'+str(account.pw_gid),str(root)],check=True,timeout=30)
        def demote():os.setgroups([]);os.setgid(account.pw_gid);os.setuid(account.pw_uid)
        base_env={**os.environ,'HOME':str(home),'PATH':'/opt/hicode-swe/env/bin:'+os.environ['PATH'],
                  'VIRTUAL_ENV':'/opt/hicode-swe/env','PYTHONDONTWRITEBYTECODE':'1',**project_environment('pydata/xarray',project)}
        def execute(command,timeout=30,extra=None):
            argv=namespace_argv(command,project,home,logs,control,workdir='/testbed',environment=local_env)
            with (logs/'output.txt').open('a') as output:
                result=subprocess.run(argv,env={**base_env,**(extra or {})},preexec_fn=demote,stdout=output,stderr=subprocess.STDOUT,timeout=timeout)
            if result.returncode:raise ValueError('Xarray public environment preflight failed; '+(logs/'output.txt').read_text()[-3000:])
        try:
            execute(editable_install_argv('/opt/hicode-swe/env/bin/python','/testbed','pydata/xarray'),60)
            receipt=public_preflight(row,project,environment,home,execute)
        except (ValueError,subprocess.TimeoutExpired) as error:
            receipt['error']=str(error)[-4000:]
        reports=Path('/opt/hicode-swe/preflight-reports');reports.mkdir(exist_ok=True)
        shutil.copyfile(logs/'output.txt',reports/(row['instance_id']+'.txt'))
    atomic_json(Path(target)/'repository/.git/hicode-env-preflight.json',receipt)
    task_path=Path(target)/'swe-task.json';task=json.loads(task_path.read_text())
    import hashlib
    proof=Path(target)/'repository/.git/hicode-env-preflight.json'
    task['files']['repository/.git/hicode-env-preflight.json']=hashlib.sha256(proof.read_bytes()).hexdigest()
    atomic_json(task_path,task)
    return receipt
