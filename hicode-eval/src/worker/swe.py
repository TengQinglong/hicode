"""Host-owned SWE adapter. No gold patch; scoring uses pinned upstream harness."""
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import tempfile
import time
from protocol import atomic_json, namespace_argv

ENV_MOUNT = '/opt/hicode-swe/env'

def editable_install_argv(python, project, repo):
    args = [str(python), '-m', 'pip', 'install', '--no-deps']
    if repo in ('pytest-dev/pytest', 'sphinx-doc/sphinx'): args.append('--no-build-isolation')
    return [*args, '-e', str(project) + ('[test]' if repo == 'sphinx-doc/sphinx' else '')]


def snapshot(source, target):
    """Copy file objects without following symlinks or using Agent-controlled Git."""
    source, target = Path(source), Path(target)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Invalid repository root')
    target.mkdir()
    total = 0
    count = 0
    def walk(src, dst):
        nonlocal total, count
        for entry in sorted(os.scandir(src), key=lambda e: e.name):
            if entry.name == '.git':
                continue
            count += 1
            if count > 20000:
                raise ValueError('Repository file budget exceeded')
            mode = entry.stat(follow_symlinks=False).st_mode
            out = dst / entry.name
            if stat.S_ISLNK(mode):
                out.symlink_to(os.readlink(entry.path))
            elif stat.S_ISDIR(mode):
                out.mkdir(); walk(Path(entry.path), out)
            elif stat.S_ISREG(mode):
                fd = os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode):
                        raise ValueError('Changed repository file')
                    total += info.st_size
                    if total > 512 * 1024 * 1024:
                        raise ValueError('Repository byte budget exceeded')
                    with out.open('xb') as output: shutil.copyfileobj(handle, output)
                    out.chmod(0o755 if info.st_mode & 0o111 else 0o644)
            else:
                raise ValueError('Special repository file cannot be exported')
    walk(source, target)


def git(args, cwd):
    # No user/global config, templates, hooks, alternates, or external diff programs.
    env = {'PATH': os.environ['PATH'], 'HOME': '/nonexistent', 'LC_ALL': 'C',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_AUTHOR_NAME': 'HiCode Eval', 'GIT_AUTHOR_EMAIL': 'eval@localhost',
           'GIT_COMMITTER_NAME': 'HiCode Eval', 'GIT_COMMITTER_EMAIL': 'eval@localhost'}
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false',
                                   '-c', 'core.fileMode=true', *args], cwd=cwd, env=env, stderr=subprocess.PIPE)


def export_patch(baseline, final):
    with tempfile.TemporaryDirectory(prefix='hicode-swe-export-') as tmp:
        trusted = Path(tmp) / 'repo'
        snapshot(baseline, trusted)
        git(['init', '--template='], trusted)
        git(['add', '-f', '-A'], trusted)
        git(['commit', '-qm', 'Prepared baseline', '--allow-empty'], trusted)
        for child in trusted.iterdir():
            if child.name == '.git': continue
            if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
            else: child.unlink()
        other = Path(tmp) / 'final'; snapshot(final, other)
        for child in other.iterdir(): shutil.move(str(child), str(trusted / child.name))
        git(['add', '-f', '-A'], trusted)
        return git(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], trusted).decode('utf-8', errors='strict')


def relocate_environment(path, original):
    for script in (Path(path)/'bin').iterdir():
        if script.is_symlink() or not script.is_file(): continue
        data=script.read_bytes()
        if script.name in {'activate','activate.csh','activate.fish','Activate.ps1'}:
            script.write_bytes(data.replace(os.fsencode(original),ENV_MOUNT.encode()))
        elif data.startswith(b'#!'):
            first, separator, rest=data.partition(b'\n')
            prefix=b'#!'+os.fsencode(original) + b'/bin/'
            if first.startswith(prefix):script.write_bytes(b'#!'+ENV_MOUNT.encode()+b'/bin/'+first[len(prefix):]+separator+rest)


def supervise(argv, *, output, timeout, env, cwd, demote, cancelled):
    with output.open('w') as stream:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, preexec_fn=demote, start_new_session=True,
                                stdout=stream, stderr=subprocess.STDOUT)
        started = time.monotonic()
        try:
            while proc.poll() is None:
                if cancelled(): raise RuntimeError('SWE verification cancelled')
                if time.monotonic() - started > timeout: raise RuntimeError('SWE verifier timed out')
                time.sleep(.1)
            return proc.returncode
        finally:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            proc.wait()


def validate_swe_report(data, instance_id, expected_grade):
    if expected_grade not in {'passed','failed'} or set(data) != {instance_id}:raise ValueError('Invalid SWE report identity')
    item=data[instance_id]
    if any(type(item.get(k)) is not bool for k in ['patch_is_None','patch_exists','patch_successfully_applied','resolved']):raise ValueError('Invalid official SWE report')
    if item['patch_is_None'] or not item['patch_exists']:raise ValueError('Missing SWE prediction')
    if (expected_grade=='passed') != item['resolved']:raise ValueError('SWE grade and report disagree')
    if item['resolved']:
        for group in ['FAIL_TO_PASS','PASS_TO_PASS']:
            result=item.get('tests_status',{}).get(group)
            if not isinstance(result,dict) or result.get('failure')!=[] or not isinstance(result.get('success'),list):raise ValueError('Incomplete SWE success report')
        if not item['patch_successfully_applied']:raise ValueError('Unapplied SWE patch cannot pass')


def verify_swe(root, config, uid, gid, cancelled):
    """Seal/export, replay in clean code+dependencies, then invoke official grading."""
    root = Path(root)
    logs = root / 'logs' / 'verifier'
    if logs.is_symlink() or (logs.exists() and not logs.is_dir()):logs.unlink()
    elif logs.exists():shutil.rmtree(logs)
    logs.mkdir(mode=0o755)
    patch = export_patch(root / 'baseline', root / 'project')
    prediction = {'instance_id': config['swe']['instanceId'], 'model_name_or_path': config['model']['model'], 'model_patch': patch}
    atomic_json(root / 'prediction.json', prediction)
    atomic_json(root / 'patch-manifest.json', {'sha256': hashlib.sha256(patch.encode()).hexdigest(),
                'baseCommit': config['swe']['baseCommit'], 'baselineCommit': config['swe']['baselineCommit'],
                'revision': config['swe']['revision'], 'method': 'host-owned-tree-diff'})
    row = json.loads((root / 'tests' / 'evaluation.json').read_text())
    if row['instance_id'] != prediction['instance_id'] or row['base_commit'] != config['swe']['baseCommit'] or 'patch' in row:
        raise ValueError('SWE grading identity mismatch or gold material present')
    work = root / 'grading-project'
    shutil.copytree(root / 'baseline', work, symlinks=True)
    grade_env = Path('/eval/swe-grader-envs') / root.name
    shutil.copytree(config['swe']['environment'], grade_env, symlinks=True)
    relocate_environment(grade_env,config['swe']['environment'])
    grade_home = root / 'grading-home'; grade_home.mkdir()
    subprocess.run(['chown', '-R', f'{uid}:{gid}', str(work), str(grade_env), str(grade_home)], check=True)
    def demote(): os.setgroups([]); os.setgid(gid); os.setuid(uid)
    env = {'PATH': ENV_MOUNT+'/bin:'+os.environ['PATH'], 'HOME': str(grade_home), 'LANG': 'C.UTF-8',
           'VIRTUAL_ENV': ENV_MOUNT, 'PYTHONDONTWRITEBYTECODE':'1', 'PIP_DISABLE_PIP_VERSION_CHECK':'1'}
    args = namespace_argv(['git','apply','--whitespace=nowarn','/tests/model.patch'], work, grade_home,
                          root/'logs', root/'control-placeholder', root/'tests', workdir='/testbed', environment=grade_env, readonly_logs=True)
    # Patch replay happens after stopping every Actor process. Hidden data is only in this view.
    (root/'tests'/'model.patch').write_text(patch)
    (root/'control-placeholder').mkdir(exist_ok=True)
    if patch:
        code = supervise(args, output=logs/'patch-apply.txt', timeout=30, env=env, cwd=work, demote=demote, cancelled=cancelled)
        if code:
            atomic_json(logs/'report.json',{prediction['instance_id']:{'patch_is_None':False,'patch_exists':True,'patch_successfully_applied':False,'resolved':False}})
            return 'failed', 'Exported patch could not be applied to the protected prepared baseline.'
    # Upstream script needs a reachable clean commit for resetting test files. Our prepared
    # Git baseline has precisely the original source plus installation bookkeeping.
    from swebench.harness.test_spec.test_spec import TestSpec
    from swebench.harness.test_spec.python import make_eval_script_list_py
    from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS
    from swebench.harness.grading import get_eval_report
    official = dict(row); official['base_commit'] = config['swe']['baselineCommit']
    commands = make_eval_script_list_py(official,MAP_REPO_VERSION_TO_SPECS[row['repo']][row['version']],
                                       'testbed','/testbed',official['base_commit'],row['test_patch'])
    spec = TestSpec(instance_id=row['instance_id'],repo=row['repo'],version=row['version'],repo_script_list=[],
                    eval_script_list=commands,env_script_list=[],arch='arm64' if platform.machine()=='aarch64' else 'x86_64',
                    FAIL_TO_PASS=json.loads(row['FAIL_TO_PASS']) if isinstance(row['FAIL_TO_PASS'],str) else row['FAIL_TO_PASS'],
                    PASS_TO_PASS=json.loads(row['PASS_TO_PASS']) if isinstance(row['PASS_TO_PASS'],str) else row['PASS_TO_PASS'],
                    language='py',docker_specs={},namespace=None)
    commands = []
    for command in spec.eval_script_list:
        if command.startswith('source /opt/miniconda3/bin/activate') or command.startswith('conda activate '):
            continue
        commands.append(command)
    script = '#!/bin/bash\nset -uxo pipefail\n'+'\n'.join(commands)+'\n'
    (root/'tests'/'eval.sh').write_text(script)
    argv = namespace_argv(['bash','/tests/eval.sh'], work, grade_home, root/'logs', root/'control-placeholder',
                          root/'tests', workdir='/testbed', environment=grade_env, readonly_logs=True)
    supervise(argv, output=logs/'output.txt', timeout=config['verifierSeconds'], env=env, cwd=work, demote=demote, cancelled=cancelled)
    report = get_eval_report(spec, prediction, str(logs/'output.txt'), include_tests_status=True)
    atomic_json(logs/'report.json', report)
    item = report[prediction['instance_id']]
    if not item['patch_successfully_applied']:
        return 'unavailable', 'Official test output incomplete; see verifier/output.txt and report.json.'
    grade = 'passed' if item['resolved'] else 'failed'
    validate_swe_report(report,prediction['instance_id'],grade)
    return grade, json.dumps(report, ensure_ascii=False, indent=2)
