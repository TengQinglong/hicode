"""Offline check of the frozen HiCode payload against the actual prepared repository."""
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tempfile

sys.path.insert(0, '/opt/hicode-eval')
from protocol import namespace_argv


if __name__ == '__main__':
    release = sys.argv[1]
    subprocess.run(['useradd', '--uid', '20000', '--user-group', '--no-create-home',
                    '--shell', '/bin/bash', 'eval-preflight'], check=True)
    account = pwd.getpwnam('eval-preflight')
    project = Path('/testbed')
    environment = Path('/opt/hicode-swe/actor')
    with tempfile.TemporaryDirectory(prefix='actor-preflight-', dir='/eval') as temp:
        root = Path(temp)
        root.chmod(0o755)
        home, logs, control, events = [root/name for name in ['home', 'logs', 'control', 'events']]
        for path in [home, logs, control, events]:
            path.mkdir(mode=0o700)
            os.chown(path, account.pw_uid, account.pw_gid)
        subprocess.run(['chown', '-R', f'{account.pw_uid}:{account.pw_gid}',
                        str(project), str(environment)], check=True)

        def demote():
            os.setgroups([])
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)

        args = namespace_argv(['bun', '/opt/hicode-eval/preflight.ts'], project, home, logs, control,
                              workdir='/testbed', environment=environment, actor_release=release,
                              actor_events=events, isolated_network=True)
        subprocess.run(args, preexec_fn=demote, check=True, timeout=40,
                       env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8',
                            'HICODE_EVAL_SOURCE': release, 'HICODE_EVAL_HOME': str(home/'.hicode')})
    print('CLEAN_ACTOR_PREFLIGHT_OK')
