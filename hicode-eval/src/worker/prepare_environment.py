"""Materialize separate actor and verifier dependency views while building a layer."""
import os
import shutil
import sys
from pathlib import Path
from venv_paths import relocate_environment

source=Path(sys.argv[1])
if not source.is_dir() or source.is_symlink() or not (source/'.ready.json').is_file():
    raise ValueError('Unprepared dependency source')
for name in ('actor','verifier'):
    target=Path('/opt/hicode-swe')/name
    if target.exists():raise ValueError('Dependency view already exists')
    shutil.copytree(source,target,symlinks=True)
    relocate_environment(target,str(source))
    for root,dirs,files in os.walk(target,followlinks=False):
        os.chown(root,20000,20000)
        for file in dirs+files:os.chown(Path(root)/file,20000,20000,follow_symlinks=False)
shutil.rmtree(source)
