"""One assignment, one Linux user, one tmux session. No installs or per-task containers."""
import base64,fcntl,json,os,pwd,signal,subprocess,sys,time
from pathlib import Path
from protocol import Events,atomic_json,namespace_argv
from verifier import verify
from terminal import capture,settle

run_id=sys.argv[1]
if len(run_id)!=16 or any(c not in '0123456789abcdef' for c in run_id):raise ValueError('Invalid run ID')
root=Path('/eval/runs')/run_id
config=json.loads((root/'job.json').read_text())
project=root/'project';home=root/'home';logs=root/'logs';control=Path('/run/hicode-eval')/run_id
name='eval-'+run_id
cancelled=False

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
os.chown(root,uid,account.pw_gid);os.chmod(root,0o700)
for p in [project,home,logs,control]:os.chmod(p,0o700)
atomic_json(root/'identity.json',{'uid':uid,'user':name,'pid':os.getpid(),'run':run_id})

def demote():
    os.setgroups([]);os.setgid(account.pw_gid);os.setuid(uid)

def namespace(args,verifier=False):
    return namespace_argv(args,project,home,logs,control,root/'tests' if verifier else None)

def command(args,timeout=15,extra=None,cwd=None,output_path=None):
    env={'PATH':'/opt/python313/bin:'+os.environ['PATH'],'HOME':str(home),'TERM':'xterm-256color','COLORTERM':'truecolor','LANG':'C.UTF-8'}
    if extra:env.update(extra)
    r=subprocess.run(args,cwd=cwd or project,env=env,preexec_fn=demote,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout)
    if output_path is not None:output_path.write_text(r.stdout+'\n'+r.stderr)
    if r.returncode:raise RuntimeError((r.stderr or r.stdout or 'Command failed')[-2000:])
    return r.stdout

socket=str(control/'tmux.sock')
def tmux(*args,**kwargs):return command(['tmux','-S',socket,*args],**kwargs)

def stop_user():
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():continue
        try:
            if path.stat().st_uid==uid:os.kill(int(path.name),signal.SIGKILL)
        except (ProcessLookupError,FileNotFoundError):pass
    for _ in range(50):
        alive=False
        for p in Path('/proc').iterdir():
            try:
                if p.name.isdigit() and p.stat().st_uid==uid and p.joinpath('stat').read_text().rsplit(')',1)[1].split()[0]!='Z':alive=True
            except FileNotFoundError:pass
        if not alive:return
        time.sleep(.1)
    raise RuntimeError('Task processes could not be stopped')

terminal_started=False
model=config['model'];release=config['release'];status='failed';grade='unavailable';events=Events();offset=0
try:
    emit('phase',phase='Deploying task on shared Linux')
    settings={'sources':{model['source']:{'baseUrl':model['baseUrl'],'apiKeyEnv':model['apiKeyEnv'],'models':[{'id':model['model'],'label':model['model'],'imageInput':model.get('imageInput',False)}]}},'models':{'primary':{'source':model['source'],'model':model['model']}},'memory':{'enabled':False},'permissions':{'defaultMode':'auto-review','deny':[f'{t}({p}/**)' for t in ['write_file','edit_file'] for p in [str(logs),str(control)]]},'sandbox':{'network':{'mode':'open'},'filesystem':{'denyWrite':[str(logs),str(control)]}}}
    conf=home/'.hicode';conf.mkdir(exist_ok=True);atomic_json(conf/'settings.json',settings)
    subprocess.run(['chown','-R',f'{uid}:{account.pw_gid}',str(home)],check=True)
    extra={'HICODE_EVAL_SOURCE':release,'HICODE_EVAL_HOME':str(conf)}
    if config['initializer']:
        command(namespace(['/opt/python313/bin/python3.13','/app/'+config['initializer']]),timeout=30)
        (project/config['initializer']).unlink()
    command(namespace(['bun','/opt/hicode-eval/preflight.ts']),timeout=30,extra=extra)
    emit('phase',phase='Running HiCode')
    launch=control/'launch.sh'
    import shlex
    launch.write_text('#!/bin/bash\nset -eu\nexec '+shlex.join(namespace(['bun',release+'/src/index.tsx','--single-task','--event-log',str(logs/'events.jsonl'),'--permission-mode','auto-review','--source',model['source'],'--model',model['model']]))+'\n')
    launch.chmod(0o755)
    secret={model['apiKeyEnv']:os.environ[model['apiKeyEnv']]}
    tmux('new-session','-d','-s','hicode','-x','140','-y','40','bash --noprofile --norc',extra=secret)
    terminal_started=True
    tmux('set-option','-t','hicode','remain-on-exit','on')
    tmux('set-option','-t','hicode','history-limit','20000')
    tmux('pipe-pane','-O','-t','hicode:0.0',shlex.join(['python3','/opt/hicode-eval/record.py',str(logs/'terminal.bin')]))
    tmux('send-keys','-t','hicode:0.0','-l','exec bash '+shlex.quote(str(launch)));tmux('send-keys','-t','hicode:0.0','Enter')
    start=time.monotonic();sent=False;last_screen=0;old_screen=None
    while time.monotonic()-start<config['agentSeconds']:
        if (logs/'terminal.overflow').exists():raise RuntimeError('Terminal recording exceeds limit')
        if cancelled or (root/'cancel').exists():status='cancelled';break
        event_path=logs/'events.jsonl'
        if event_path.exists():
            if event_path.is_symlink():raise ValueError('Event file replaced with symlink')
            with event_path.open('rb') as f:f.seek(offset);data=f.read(256*1024)
            offset+=len(data)
            if data:events.accept(data);emit('events',data=base64.b64encode(data).decode())
        if time.monotonic()-last_screen>=2:
            screen=tmux('capture-pane','-p','-e','-S','-20000','-t','hicode:0.0')
            if len(screen.encode())>8*1024*1024:raise ValueError('Terminal exceeds budget')
            if screen!=old_screen:emit('screen',screen=screen);old_screen=screen
            last_screen=time.monotonic()
        if events.ready and not sent:
            prompt=control/'prompt.txt';prompt.write_text((root/'instruction.md').read_text());prompt.chmod(0o644)
            tmux('load-buffer',str(prompt));tmux('paste-buffer','-p','-t','hicode:0.0');tmux('send-keys','-t','hicode:0.0','Enter');sent=True
        if events.complete():
            if events.settled['reason']!='completed':raise RuntimeError('Agent stopped: '+events.settled['reason'])
            status='completed';break
        if not sent and time.monotonic()-start>40:raise RuntimeError('TUI ready event missing')
        if tmux('display-message','-p','-t','hicode:0.0','#{pane_dead}').strip()=='1':raise RuntimeError('HiCode exited before completion')
        time.sleep(.5)
    else:status='timeout'
    if terminal_started:
        try:
            if status=='completed':
                if not settle(tmux,emit,lambda:cancelled or (root/'cancel').exists()):
                    emit('error',message='Final terminal paint did not stabilize before the capture deadline; execution and grading are recorded separately.')
            else:capture(tmux,emit)
        except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
            emit('error',message='Final terminal capture failed: '+str(error)[-1000:])
    if status in ['completed','timeout']:
        if status=='timeout':stop_user();terminal_started=False
        emit('phase',phase='Awaiting local verification')
        # Host uploads checks only after the assignment is sealed.
        deadline=time.monotonic()+30
        while not (root/'verify.ready').exists():
            if cancelled or (root/'cancel').exists():status='cancelled';break
            if time.monotonic()>deadline:raise RuntimeError('Verifier handoff timed out')
            time.sleep(.2)
        if status in ['completed','timeout']:
            emit('phase',phase='Verifying result')
            try:
                verifier_log=logs/'verifier';verifier_log.mkdir(exist_ok=True);os.chown(verifier_log,uid,account.pw_gid)
                if config['verifierPrelude']=='copy-test-helper':
                    command(namespace(['cp','/tests/test.py','/app/test.py'],verifier=True))
                grade,output=verify(namespace(['/opt/hicode-verifier/bin/python','-m','pytest','--ctrf','/logs/verifier/ctrf.json','/tests/test_outputs.py','-rA'],verifier=True),
                    timeout=config['verifierSeconds'],output_path=verifier_log/'output.txt',report_path=verifier_log/'ctrf.json',cwd=project,
                    env={'PATH':'/opt/hicode-verifier/bin:/opt/python313/bin:'+os.environ['PATH'],'HOME':str(home),'LANG':'C.UTF-8'},
                    preexec_fn=demote,cancelled=lambda:cancelled or (root/'cancel').exists())
            except (OSError,RuntimeError,subprocess.TimeoutExpired) as e:
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
    # Verification can take longer than the final UI paint. Refresh once more before teardown.
    if terminal_started:
        try:capture(tmux,emit)
        except (OSError,RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
            emit('error',message='Final terminal capture failed: '+str(error)[-1000:])
    stop_user()
    result={'execution':status,'grading':grade,'uid':uid}
    atomic_json(root/'result.json',result)
    emit('result',**result)
