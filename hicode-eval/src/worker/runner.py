"""One assignment, one Linux user, one tmux session. No installs or per-task containers."""
import base64,fcntl,json,os,pwd,signal,subprocess,sys,time,shutil
from pathlib import Path
from protocol import Events,atomic_json,namespace_argv,package_install_argv,prepare_verifier_root,wait_verifier_handoff
from verifier import verify,verifier_environment
from terminal import capture,settle,submit_prompt
from cleanup import stop_task_processes,finalize_task,open_task_cli,terminate_task_cli
from recovery import process_start

run_id=sys.argv[1]
if len(run_id)!=16 or any(c not in '0123456789abcdef' for c in run_id):raise ValueError('Invalid run ID')
root=Path('/eval/runs')/run_id
config=json.loads((root/'job.json').read_text())
is_swe=config.get('dataset')=='swe-bench-verified'
swe_environment=Path('/eval/swe-envs')/run_id if is_swe else None
project=root/'project';home=root/'home';logs=root/'logs';control=Path('/run/hicode-eval')/run_id
name='eval-'+run_id
cancelled=False
verifier_root=None

def emit(kind,**value):
    print(json.dumps({'type':kind,**value},ensure_ascii=False),flush=True)

def interrupt(*_):
    global cancelled
    cancelled=True
signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)

with open('/eval/users.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    try:pwd.getpwnam(name)
    except KeyError:pass
    else:raise ValueError('Run user already exists; attempts cannot be resumed')
    uid=20000+int(run_id[:8],16)%1000000
    while True:
        try:pwd.getpwuid(uid);uid+=1
        except KeyError:break
    subprocess.run(['useradd','--uid',str(uid),'--user-group','--no-create-home','--shell','/bin/bash',name],check=True)
    account=pwd.getpwnam(name)
for p in [root,project,home,logs,control]:p.mkdir(parents=True,exist_ok=True)
subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(project),str(home),str(logs),str(control)],check=True)
if config.get('publicTestInputs'):
    subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(root/'public-tests')],check=True)
os.chown(root,uid,account.pw_gid);os.chmod(root,0o700)
for p in [project,home,logs,control]:os.chmod(p,0o700)
atomic_json(root/'identity.json',{'version':2,'uid':uid,'user':name,'pid':os.getpid(),'runnerStart':process_start(os.getpid()),'run':run_id})

def demote():
    os.setgroups([]);os.setgid(account.pw_gid);os.setuid(uid)

def namespace(args,verifier=False,setup=False):
    return namespace_argv(args,project,home,logs,control,root/'tests' if verifier else None,
                          writable_tests=verifier and not is_swe and config['verifierPrelude']=='compile-feal-extension',
                          root_overlay=verifier and not setup and config.get('verifierRootOverlay',False),
                          workdir='/testbed' if is_swe else '/app',environment=swe_environment,
                          public_tests=root/'public-tests' if not verifier and config.get('publicTestInputs') else None,
                          private_root=verifier_root if verifier else None)

def command(args,timeout=15,extra=None,cwd=None,output_path=None):
    env={'PATH':'/opt/python313/bin:'+str(home/'.local/bin')+':'+str(home/'bin')+':'+os.environ['PATH'],'HOME':str(home),'TERM':'xterm-256color','COLORTERM':'truecolor','LANG':'C.UTF-8'}
    if is_swe:
        env.update(PATH='/opt/hicode-swe/env/bin:'+str(home/'.local/bin')+':'+str(home/'bin')+':'+os.environ['PATH'],VIRTUAL_ENV='/opt/hicode-swe/env',PYTHONDONTWRITEBYTECODE='1')
    if config.get('packages'):
        env['PYTHONPATH']='/app/.eval-python'
        env['PIP_CACHE_DIR']='/tmp/pip-cache'
    env.update(config.get('environment',{}))
    if extra:env.update(extra)
    r=subprocess.run(args,cwd=cwd or project,env=env,preexec_fn=demote,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout)
    if output_path is not None:output_path.write_text(r.stdout+'\n'+r.stderr)
    if r.returncode:raise RuntimeError((r.stderr or r.stdout or 'Command failed')[-2000:])
    return r.stdout

socket=str(control/'tmux.sock')
def tmux(*args,**kwargs):return command(['tmux','-S',socket,*args],**kwargs)

def stop_user():
    stop_task_processes(uid)

terminal_started=False;cli_fd=None;shutdown_attempted=False
model=config['model'];release=config['release'];status='failed';grade='unavailable';events=Events();offset=0

def drain_events():
    global offset
    event_path=logs/'events.jsonl'
    if event_path.exists():
        if event_path.is_symlink():raise ValueError('Event file replaced with symlink')
        with event_path.open('rb') as f:f.seek(offset);data=f.read(256*1024)
        offset+=len(data)
        if data:events.accept(data);emit('events',data=base64.b64encode(data).decode())
        return bool(data)
    return False

def shutdown_cli():
    global shutdown_attempted
    if shutdown_attempted or cli_fd is None:return
    shutdown_attempted=True
    emit('phase',phase='Stopping HiCode: '+status)
    started=time.monotonic();exited=False;error=None
    try:exited=terminate_task_cli(cli_fd,drain_events)
    except (OSError,RuntimeError,ValueError) as exc:error=str(exc)[-2000:]
    receipt={'version':1,'reason':status,'graceSeconds':10,'elapsedSeconds':round(time.monotonic()-started,3),
        'cliExited':exited,'turnSaved':events.ending is not None and events.ending.get('persistence_status')=='saved',
        'pendingToolCallIds':sorted(events.pending_tools),'eventStreamComplete':not bool(events.partial.strip()),'error':error}
    atomic_json(root/'shutdown.json',receipt)
    if error or not exited:emit('error',message='Graceful shutdown incomplete; forcing task cleanup. '+(error or 'CLI did not exit within 10 seconds.'))
    elif events.started and (not receipt['turnSaved'] or receipt['pendingToolCallIds'] or not receipt['eventStreamComplete']):
        emit('error',message='CLI exited, but execution records did not close completely; see shutdown.json.')

try:
    # Approval is granted for this disposable assignment, inside the outer namespace.
    config['permissionMode']='full-access'
    atomic_json(root/'job.json',config)
    emit('phase',phase='Deploying task on shared Linux')
    settings={'sources':{model['source']:{'baseUrl':model['baseUrl'],'apiKeyEnv':model['apiKeyEnv'],'models':[{'id':model['model'],'label':model['model'],'imageInput':model.get('imageInput',False)}]}},'models':{'primary':{'source':model['source'],'model':model['model']}},'memory':{'enabled':False},'permissions':{'defaultMode':config['permissionMode'],'deny':[f'{t}({p}/**)' for t in ['write_file','edit_file'] for p in [str(logs),str(control)]]},'sandbox':{'network':{'mode':'open'},'filesystem':{'denyWrite':[str(logs),str(control)]}}}
    conf=home/'.hicode';conf.mkdir(exist_ok=True);atomic_json(conf/'settings.json',settings)
    subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(home)],check=True)
    extra={'HICODE_EVAL_SOURCE':release,'HICODE_EVAL_HOME':str(conf)}
    if is_swe:
        if swe_environment.exists():raise ValueError('SWE attempt environment already exists')
        shutil.copytree(config['swe']['environment'],swe_environment,symlinks=True)
        from swe import relocate_environment
        relocate_environment(swe_environment,config['swe']['environment'])
        subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(swe_environment)],check=True)
        command(namespace(['/opt/hicode-swe/env/bin/python','-m','pip','install','--no-deps','-e','/testbed']),timeout=60,output_path=logs/'repo-install.txt')
    for required in config.get('commands',[]):
        if not shutil.which(required):raise RuntimeError('Task environment missing command: '+required)
    packages=config.get('packages',[])
    if packages:
        argv,offline=package_install_argv(packages,'/app/.eval-python')
        emit('phase',phase='Installing task packages from local wheels' if offline else 'Downloading pinned task packages')
        command(namespace(argv),timeout=300,output_path=logs/'package-install.txt')
    verifier_packages=config.get('verifierPackages',[])
    if verifier_packages:
        argv,offline=package_install_argv(verifier_packages,'/app/.eval-verifier-python')
        emit('phase',phase='Installing verifier packages from local wheels' if offline else 'Downloading pinned verifier packages')
        command(namespace(argv),timeout=300,output_path=logs/'verifier-package-install.txt')
    initializer=config['initializer']
    if initializer:
        script=project/initializer['file']
        app_script='/app/'+initializer['file']
        if initializer['kind']=='python':argv=['/opt/python313/bin/python3.13',app_script]
        elif initializer['kind']=='bash':argv=['bash',app_script]
        else:argv=['gzip','-d','--',app_script]
        command(namespace(argv),timeout=30,output_path=logs/'initializer.txt')
        script.unlink(missing_ok=True)
    command(namespace(['bun','/opt/hicode-eval/preflight.ts']),timeout=30,extra=extra)
    emit('phase',phase='Starting HiCode')
    launch=control/'launch.sh'
    import shlex
    launch.write_text('#!/bin/bash\nset -eu\nexec '+shlex.join(namespace(['bun',release+'/src/index.tsx','--single-task','--event-log',str(logs/'events.jsonl'),'--permission-mode',config['permissionMode'],'--source',model['source'],'--model',model['model']]))+'\n')
    launch.chmod(0o755)
    secret={model['apiKeyEnv']:os.environ[model['apiKeyEnv']]}
    tmux('new-session','-d','-s','hicode','-x','140','-y','40','bash --noprofile --norc',extra=secret)
    terminal_started=True
    tmux('set-option','-t','hicode','remain-on-exit','on')
    tmux('set-option','-t','hicode','history-limit','20000')
    tmux('pipe-pane','-O','-t','hicode:0.0',shlex.join(['python3','/opt/hicode-eval/record.py',str(logs/'terminal.bin')]))
    tmux('send-keys','-t','hicode:0.0','-l','exec bash '+shlex.quote(str(launch)));tmux('send-keys','-t','hicode:0.0','Enter')
    startup=time.monotonic();start=None;submitted=None;last_screen=0;old_screen=None
    while start is None or time.monotonic()-start<config['agentSeconds']:
        if (logs/'terminal.overflow').exists():raise RuntimeError('Terminal recording exceeds limit')
        if cancelled or (root/'cancel').exists():status='cancelled';break
        drain_events()
        if time.monotonic()-last_screen>=1:
            screen=tmux('capture-pane','-p','-e','-S','-20000','-t','hicode:0.0')
            if len(screen.encode())>8*1024*1024:raise ValueError('Terminal exceeds budget')
            if screen!=old_screen:emit('screen',screen=screen);old_screen=screen
            last_screen=time.monotonic()
        if events.started and start is None:
            start=time.monotonic()
            emit('phase',phase='Running HiCode')
        if events.ready and submitted is None:
            cli_fd=open_task_cli(uid,release+'/src/index.tsx',logs/'events.jsonl')
            prompt=control/'prompt.txt';prompt.write_text((root/'instruction.md').read_text());prompt.chmod(0o644)
            submit_prompt(tmux,prompt);submitted=time.monotonic()
        if events.complete():
            if events.settled['reason']!='completed':raise RuntimeError('Agent stopped: '+events.settled['reason'])
            status='completed';break
        if submitted is None and time.monotonic()-startup>40:raise RuntimeError('TUI ready event missing')
        if submitted is not None and not events.started and time.monotonic()-submitted>15:raise RuntimeError('Prompt submission was not acknowledged; no model request started')
        if tmux('display-message','-p','-t','hicode:0.0','#{pane_dead}').strip()=='1':raise RuntimeError('HiCode exited before completion')
        time.sleep(.5)
    else:status='timeout'
    if status in ['timeout','cancelled']:shutdown_cli()
    if terminal_started:
        try:
            if status=='completed':
                if not settle(tmux,emit,lambda:cancelled or (root/'cancel').exists()):
                    emit('error',message='Final terminal paint did not stabilize before the capture deadline; execution and grading are recorded separately.')
            else:capture(tmux,emit)
        except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
            emit('error',message='Final terminal capture failed: '+str(error)[-1000:])
    if status in ['completed','timeout']:
        # Stop all assignment processes before exposing the original verifier.
        stop_user();terminal_started=False
        emit('phase',phase='Awaiting local verification')
        # Host uploads checks only after the assignment is sealed.
        emit('verification_request',runId=run_id)
        if not wait_verifier_handoff(root,run_id,lambda:cancelled or (root/'cancel').exists()):status='cancelled'
        if status in ['completed','timeout']:
            emit('phase',phase='Verifying result')
            try:
                verifier_log=logs/'verifier'
                if verifier_log.is_symlink():raise ValueError('Verifier log directory replaced with symlink')
                verifier_log.mkdir(exist_ok=True);os.chown(verifier_log,uid,account.pw_gid)
                if config.get('verifierChroot'):
                    verifier_root=root/'verifier-root'
                    prepare_verifier_root(project,verifier_root)
                    subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(verifier_root)],check=True)
                    command(namespace(['/opt/python313/bin/python3.13','-c',
                        "import os,tempfile; f=tempfile.NamedTemporaryFile(dir='/app',delete=False);f.close(); dest='/tmp/'+os.path.basename(f.name);os.rename(f.name,dest);os.unlink(dest);os.chroot('/');assert os.getuid()==0"],verifier=True),
                        timeout=15,output_path=verifier_log/'namespace-check.txt')
                if config['verifierPrelude']=='reset-large-csv':
                    command(namespace(['bash','-c','rm -f -- /app/*.csv && /opt/python313/bin/python3.13 /tests/gen_large_csv.py input'],verifier=True),timeout=30)
                if is_swe:
                    from swe import verify_swe
                    grade,output=verify_swe(root,config,uid,account.pw_gid,lambda:cancelled or (root/'cancel').exists())
                if config['verifierPrelude']=='copy-test-helper':
                    command(namespace(['cp','/tests/test.py','/app/test.py'],verifier=True))
                if not is_swe:
                    if config['verifierPrelude']=='compile-feal-extension':
                        # The original verifier rebuilds in-place. Only its private copy is writable,
                        # after all Agent processes are stopped; the source dataset is never mounted.
                        subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(root/'tests')],check=True)
                        command(namespace(['--chdir','/tests','/opt/hicode-verifier/bin/python','-s','-P','setup.py','build_ext','--inplace'],verifier=True,setup=True),
                                timeout=60,extra={'PYTHONPATH':'/app/.eval-verifier-python','PYTHONNOUSERSITE':'1'},output_path=verifier_log/'setup.txt')
                    grade,output=verify(namespace(['/opt/hicode-verifier/bin/python','-m','pytest','-o','cache_dir=/logs/verifier/.pytest_cache','--ctrf','/logs/verifier/ctrf.json','/tests/test_outputs.py','-rA'],verifier=True),
                        timeout=config['verifierSeconds'],output_path=verifier_log/'output.txt',report_path=verifier_log/'ctrf.json',cwd=project,
                        env={**verifier_environment(config,home),**config.get('verifierEnvironment',{})},
                        preexec_fn=demote,cancelled=lambda:cancelled or (root/'cancel').exists())
            except (OSError,RuntimeError,ValueError,subprocess.SubprocessError) as e:
                output='Verifier setup failed: '+str(e);grade='unavailable'
                (verifier_log/'output.txt').write_text(output)
            if cancelled or (root/'cancel').exists():status='cancelled';grade='unavailable'
            if grade in ['passed','failed']:
                (verifier_log/'reward.txt').write_text('1\n' if grade=='passed' else '0\n')
            emit('verification',text=output)
            if grade=='unavailable':emit('error',message=output[-2000:])
except BaseException as error:
    if cancelled or (root/'cancel').exists():status='cancelled'
    emit('error',message=str(error)[-2000:])
finally:
    try:
        try:
            if terminal_started and status!='completed':shutdown_cli()
        except (OSError,RuntimeError,ValueError) as error:
            emit('error',message='Could not finish graceful shutdown: '+str(error)[-1000:])
        # Keep the final cancellation frame, independently of live sampling.
        if terminal_started:
            try:capture(tmux,emit)
            except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
                emit('error',message='Final terminal capture failed: '+str(error)[-1000:])
    finally:
        # Even a broken output pipe or failed shutdown receipt must clean the UID.
        result={'execution':status,'grading':grade,'uid':uid}
        try:finalize_task(root,result)
        finally:
            if is_swe:
                for env_root in ['/eval/swe-envs','/eval/swe-grader-envs']:
                    shutil.rmtree(Path(env_root)/run_id,ignore_errors=True)
            if cli_fd is not None:os.close(cli_fd)
    emit('result',**result)
