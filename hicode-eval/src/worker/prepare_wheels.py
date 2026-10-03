"""Prepare reviewed pure-Python compatibility wheels before an environment is frozen."""
import fcntl
import re
import subprocess
import sys
from pathlib import Path

environment,*pins=sys.argv[1:]
if not re.fullmatch(r'/opt/hicode-swe/cache/[a-f0-9]{64}',environment):raise ValueError('Invalid source environment')
if any(not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.+-]*',pin) for pin in pins):raise ValueError('Unpinned dependency')
root=Path('/opt/hicode-eval/wheels');root.mkdir(exist_ok=True)
with (root/'.prepare.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    for pin in pins:
        target=root/pin.replace('==','-')
        if target.is_symlink():raise ValueError('Symlinked wheel cache')
        target.mkdir(exist_ok=True)
        # The audited compatibility table contains only platform-independent packages.
        if any(target.glob('*-none-any.whl')):continue
        subprocess.run([environment+'/bin/python','-m','pip','download','--no-deps','--only-binary=:all:',
                        '--disable-pip-version-check','--timeout','15','--retries','1','--dest',str(target),pin],
                       check=True,timeout=90)
