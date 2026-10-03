"""Keep prepared Python entry points stable inside the task mount."""
import os
from pathlib import Path

ENV_MOUNT = '/opt/hicode-swe/env'

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
