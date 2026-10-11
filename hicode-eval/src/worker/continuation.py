"""Pre-verifier checkpoints contain only stopped Actor files and its session."""
import json
import os
import re
import shutil
import stat
import tarfile
from pathlib import Path
from protocol import atomic_json, digest
from urllib.parse import urlsplit

MAX_BYTES = 8 * 1024 ** 3
MAX_FILES = 100000


def model_bridge_port(path, source):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>4*1024*1024:raise ValueError('Invalid continuation model settings')
        data=stream.read(4*1024*1024+1)
    if len(data)>4*1024*1024:raise ValueError('Continuation model settings exceed budget')
    try:
        connection=urlsplit(json.loads(data)['sources'][source]['baseUrl'])
        if (connection.scheme!='http' or connection.hostname!='127.0.0.1' or connection.path!='/v1'
                or connection.username is not None or connection.password is not None or connection.query or connection.fragment
                or connection.port is None or not 1024<=connection.port<=65535):
            raise ValueError('Invalid continuation model transport')
        return connection.port
    except (KeyError,TypeError) as error:raise ValueError('Continuation model transport is missing') from error


def validate_identity(value):
    if (not isinstance(value, dict) or type(value.get('version')) is not int or value.get('version') != 1
            or not re.fullmatch(r'[a-f0-9]{16}', value.get('runId', ''))
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}', value.get('sessionId', ''))
            or not re.fullmatch(r'/eval/runs/[a-f0-9]{16}/home', value.get('homePath', ''))
            or type(value.get('elapsedSeconds')) not in {int, float} or not 0 <= value['elapsedSeconds'] <= 10800000
            or type(value.get('modelBridgePort')) is not int or not 1024 <= value['modelBridgePort'] <= 65535
            or not re.fullmatch(r'[a-f0-9]{64}', value.get('sha256', ''))
            or type(value.get('bytes')) is not int or not 0 < value['bytes'] <= MAX_BYTES
            or (value.get('servicePaths') is not None and (not isinstance(value['servicePaths'], list) or len(value['servicePaths']) > 6
                or any(not isinstance(p,str) or p not in {'/etc','/var','/run','/home','/git','/srv'} for p in value['servicePaths'])
                or len(set(value['servicePaths'])) != len(value['servicePaths'])))):
        raise ValueError('Invalid continuation checkpoint identity')


def capture_checkpoint(root, session_id, home_path, elapsed_seconds, service, model_bridge_port):
    root = Path(root)
    target = root / 'continuation.tar.gz'
    temporary = target.with_suffix('.tmp')
    sources = [('project', root / 'project'), ('home', root / 'home')]
    paths = None if service is None else list(service.paths)
    if paths:
        service.snapshot()
        sources.append(('service-system.tar', root / 'service-system.tar'))
    total = count = 0
    try:
        with tarfile.open(temporary, 'w:gz', compresslevel=1) as archive:
            def add(path, name):
                nonlocal count, total
                info = path.lstat()
                if stat.S_ISSOCK(info.st_mode) or stat.S_ISFIFO(info.st_mode): return
                if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    raise ValueError('Special checkpoint file')
                count += 1
                total += info.st_size if stat.S_ISREG(info.st_mode) else 0
                if count > MAX_FILES or total > MAX_BYTES: raise ValueError('Checkpoint exceeds evidence budget')
                archive.inodes.clear()  # Store hardlinked files independently; never restore archive hardlinks.
                archive.add(path, arcname=name, recursive=False)
                if stat.S_ISDIR(info.st_mode):
                    for child in sorted(path.iterdir()): add(child, name + '/' + child.name)
                after = path.lstat()
                if (info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                    raise ValueError('Checkpoint source changed after Actor shutdown')
            for name, source in sources: add(source, name)
        # A checkpoint must not turn an otherwise collectible attempt into an
        # oversized Run. It shares the existing evidence budget with the scene.
        scene_bytes = scene_files = 0
        def measure(path):
            nonlocal scene_bytes, scene_files
            info=path.lstat()
            if stat.S_ISDIR(info.st_mode):
                for child in path.iterdir():measure(child)
            elif stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                scene_files+=1;scene_bytes+=info.st_size
                if scene_files>=MAX_FILES or scene_bytes>MAX_BYTES:raise ValueError('Checkpoint leaves no room in the Run evidence budget')
        measure(root)
        value = {'version':1, 'runId':root.name, 'sessionId':session_id, 'homePath':home_path,
                 'elapsedSeconds':elapsed_seconds, 'servicePaths':paths, 'modelBridgePort':model_bridge_port,
                 'sha256':digest(temporary), 'bytes':temporary.stat().st_size}
        validate_identity(value)
        os.replace(temporary, target)
        atomic_json(root / 'continuation.json', value)
        return value
    finally:
        temporary.unlink(missing_ok=True)


def validate_members(archive, service_paths):
    members = []
    names, links, total = set(), set(), 0
    for member in archive:
        members.append(member)
        if len(members) > MAX_FILES: raise ValueError('Excessive checkpoint members')
        name = Path(member.name)
        if (name.is_absolute() or '..' in name.parts or not name.parts or len(member.name) > 1024
                or name.parts[0] not in {'project','home','service-system.tar'}
                or (name.parts[0] == 'service-system.tar' and (len(name.parts) != 1 or not service_paths or not member.isfile()))
                or not (member.isfile() or member.isdir() or member.issym())
                or str(name) in names or member.size < 0):
            raise ValueError('Unsafe checkpoint member')
        if str(name) in {'project','home'} and not member.isdir(): raise ValueError('Invalid checkpoint root')
        names.add(str(name)); total += member.size
        if total > MAX_BYTES: raise ValueError('Checkpoint exceeds evidence budget')
        if member.issym():
            if len(member.linkname.encode()) > 4096 or '\0' in member.linkname: raise ValueError('Invalid checkpoint link')
            links.add(str(name))
    if not {'project','home'} <= names: raise ValueError('Incomplete checkpoint')
    if bool(service_paths) != ('service-system.tar' in names): raise ValueError('Checkpoint service mismatch')
    for name in names:
        if any(str(parent) in links for parent in Path(name).parents): raise ValueError('Checkpoint traverses a symlink')
    return members


def restore_checkpoint(root, value, service_paths):
    root = Path(root)
    validate_identity(value)
    if value['servicePaths'] != service_paths: raise ValueError('Continuation service declaration changed')
    source = root / 'continuation-input.tar.gz'
    if source.is_symlink() or source.stat().st_size != value['bytes'] or digest(source) != value['sha256']:
        raise ValueError('Continuation archive differs from its checkpoint')
    staging = root / 'continuation-restore'
    staging.mkdir(mode=0o700)
    try:
        with tarfile.open(source, 'r:gz') as archive:
            members = validate_members(archive, service_paths)
            for member in sorted(members, key=lambda m: (len(Path(m.name).parts), m.name)):
                target = staging / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                if member.isdir(): target.mkdir(exist_ok=True)
                elif member.issym(): target.symlink_to(member.linkname)
                else:
                    with target.open('xb') as output: shutil.copyfileobj(archive.extractfile(member), output)
                if not member.issym(): os.chmod(target, member.mode & 0o777)
        for name in ['project','home']:
            destination = root / name
            if destination.is_symlink(): raise ValueError('Symlinked continuation destination')
            if destination.exists(): shutil.rmtree(destination)
            os.replace(staging / name, destination)
        if service_paths: os.replace(staging / 'service-system.tar', root / 'continuation-service.tar')
        source.unlink()  # The restored files replace this staging copy; the parent checkpoint remains immutable.
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def restore_service(owner, root):
    if not owner.paths: return
    from service_regrade import validate_snapshot
    source = Path(root) / 'continuation-service.tar'
    validate_snapshot(source, owner.paths)
    destination = Path(root) / 'project/.continuation-service.tar'
    if destination.exists() or destination.is_symlink():raise ValueError('Reserved continuation service path exists')
    with source.open('rb') as original, destination.open('xb') as output:shutil.copyfileobj(original,output)
    os.chown(destination, owner.uid, owner.uid)
    try:
        import subprocess
        subprocess.run(owner.actor_argv(['tar','--numeric-owner','-xf','/app/.continuation-service.tar','-C','/']),
                       check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    finally:
        destination.unlink(missing_ok=True)
    source.unlink()
