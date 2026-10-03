"""Export only public runtime/dependency inputs; no tasks, homes or grading data."""
import hashlib
import gzip
import json
import os
import re
import stat
import sys
import tarfile
from pathlib import Path

BASE_PATHS = [
    '/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt/python313', '/opt/hicode-verifier',
    '/opt/hicode/package.json','/opt/hicode/bun.lock','/opt/hicode/node_modules','/opt/hicode/dependencies',
    '/opt/hicode-swe/python', '/opt/hicode-swe/grader',
    '/etc/alternatives', '/etc/ld.so.cache', '/etc/locale.gen', '/etc/locale.alias',
    '/etc/fonts', '/etc/ImageMagick-6', '/etc/R', '/etc/python3.11',
]


def export(destination, paths):
    destination = Path(destination)
    if destination.is_symlink() or destination.exists():
        raise ValueError('Export destination must be new')
    total = 0
    with destination.open('xb') as raw, gzip.GzipFile(filename='',fileobj=raw,mode='wb',mtime=0,compresslevel=1) as compressed, tarfile.open(fileobj=compressed,mode='w|',dereference=False) as archive:
        def add(path):
            nonlocal total
            info = path.lstat()
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise ValueError('Special file in public environment')
            if path.name in {'.env', '.env.local', '.env.qwen-token-plan'}:
                raise ValueError('Credentials cannot enter environment images')
            member = archive.gettarinfo(str(path), str(path).lstrip('/'))
            member.uid = member.gid = 0
            member.uname = member.gname = ''
            member.mtime = 0
            if member.isfile():
                total += member.size
                if total > 8 * 1024**3:
                    raise ValueError('Environment archive exceeds size budget')
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as stream:archive.addfile(member, stream)
            else:archive.addfile(member)
            if member.isdir():
                for child in sorted(path.iterdir()):add(child)
        for value in paths:
            path = Path(value)
            if path.exists() or path.is_symlink():add(path)
    h = hashlib.sha256()
    with destination.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024), b''):h.update(block)
    digest=h.hexdigest()
    return {'sha256':digest,'archiveBytes':destination.stat().st_size,'expandedBytes':total}


def main():
    kind, destination, *values = sys.argv[1:]
    if not re.fullmatch(r'/tmp/hicode-environment-[a-f0-9]{32}\.tar\.gz', destination):
        raise ValueError('Invalid export destination')
    if kind == 'base':
        if values:raise ValueError('Base export takes no paths')
        paths = BASE_PATHS
    elif kind == 'swe':
        if len(values)!=1 or not re.fullmatch(r'/opt/hicode-swe/cache/[a-f0-9]{64}',values[0]):
            raise ValueError('Invalid dependency cache')
        path=Path(values[0])
        if path.is_symlink() or not (path/'.ready.json').is_file():raise ValueError('Unprepared dependency cache')
        paths=values
    elif kind == 'wheels':
        if any(not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.+-]*',value) for value in values):
            raise ValueError('Unpinned dependency')
        paths=['/opt/hicode-eval/wheels/'+value.replace('==','-') for value in sorted(set(values))]
        if any(not Path(path).is_dir() or Path(path).is_symlink() for path in paths):raise ValueError('Missing cached wheels')
    else:raise ValueError('Invalid environment export kind')
    print(json.dumps(export(destination,paths)))

if __name__=='__main__':main()
