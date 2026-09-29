import hashlib
import json
import os
import re
from pathlib import Path


def package_install_argv(packages, target, cache=Path('/opt/hicode-eval/wheels')):
    if not packages or any(not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.+-]*', p) for p in packages):
        raise ValueError('Expected pinned Python packages')
    wheels = [cache / p.replace('==', '-') for p in packages]
    # A prepared wheelhouse is resolved entirely offline, including dependencies.
    offline = all(path.is_dir() for path in wheels)
    args = ['/opt/python313/bin/python3.13', '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', '--only-binary=:all:', '--target', target]
    if offline:
        args += ['--no-index']
        for path in wheels: args += ['--find-links', str(path)]
    else:
        args += ['--timeout', '15', '--retries', '1']
    return args + packages, offline


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    with temp.open('w') as handle:
        os.chmod(temp, 0o600)
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()



class Events:
    def __init__(self):
        self.partial = b''
        self.sequence = 0
        self.ready = False
        self.started = False
        self.busy = False
        self.waiting = False
        self.settled = None
        self.ending = None
        self.last_type = None
        self.session_id = None

    def accept(self, data):
        self.partial += data
        if len(self.partial) > 8 * 1024 * 1024:
            raise ValueError('Event record exceeds its budget')
        lines = self.partial.split(b'\n')
        self.partial = lines.pop()
        for raw in lines:
            if not raw:
                continue
            event = json.loads(raw)
            if not isinstance(event,dict) or type(event.get('version')) is not int or event.get('version') != 1 or type(event.get('sequence')) is not int or event.get('sequence') != self.sequence + 1:
                raise ValueError('Event sequence gap; refusing to infer completion')
            session_id=event.get('sessionId')
            if not isinstance(session_id,str) or not 0<len(session_id)<=256 or any(ord(c)<32 for c in session_id):
                raise ValueError('Invalid session identity in event export')
            if self.session_id is not None and session_id!=self.session_id:raise ValueError('Mixed sessions in one event stream')
            self.session_id=session_id
            self.sequence += 1
            kind = event['type']
            if kind not in {'ready','state','settled','agent_event'}:raise ValueError('Unknown interactive event')
            if kind=='state' and any(type(event.get(k)) is not bool for k in ['busy','waitingForApproval']):raise ValueError('Invalid UI state')
            if kind=='settled':
                if type(event.get('sealed')) is not bool:raise ValueError('Missing execution seal state')
                if any(type(event.get(k)) is not int or event[k]<0 for k in ['runningAgents','pendingAgentMessages']):raise ValueError('Invalid Agent completion counters')
                if event.get('reason') not in {'completed','incomplete','max_turns','permission_denied','hook_blocked','hook_error','hook_limit','no_tool_calls','interrupted'}:raise ValueError('Unknown stop reason')
            if kind=='agent_event' and (not isinstance(event.get('event'),dict) or not isinstance(event['event'].get('type'),str)):
                raise ValueError('Invalid Agent event')
            if kind == 'ready': self.ready = True
            elif kind == 'state':
                if event['busy'] and not self.busy:
                    self.settled = None; self.ending = None
                self.busy = event['busy']
                self.waiting = event['waitingForApproval']
            elif kind == 'settled': self.settled = event
            elif kind == 'agent_event':
                self.last_type = event['event']['type']
                if self.last_type == 'model_stream_start': self.started = True; self.settled = None; self.ending = None
                if self.last_type == 'turn_end': self.ending = event['event']['input']

    def complete(self):
        return (self.settled is not None and self.settled.get('sealed') is True and not self.busy and self.settled['runningAgents'] == 0 and self.settled.get('pendingAgentMessages') == 0
                and self.ending is not None and self.ending['persistence_status'] == 'saved')


def namespace_argv(args, project, home, logs, control, tests=None):
    result=['bwrap','--unshare-user','--unshare-pid','--die-with-parent','--ro-bind','/','/','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',str(project),'/app','--bind',str(home),str(home),'--bind',str(logs),str(logs),'--ro-bind',str(control),str(control),'--chdir','/app']
    if tests is not None:result+=['--ro-bind',str(tests),'/tests','--bind',str(Path(logs)/'verifier'),'/logs/verifier']
    return result+args
