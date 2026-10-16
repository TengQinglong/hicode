"""Preserve Linux filenames when exporting evidence to a case-insensitive host."""
import hashlib
import gzip
import tarfile
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import unicodedata

MAP_FILE = '.hicode-evidence-paths.json'
MAX_FILES = 100000
MAX_BYTES = 8 * 1024 ** 3
DEPENDENCY_PART_ENTRIES = 50000
MAX_DEPENDENCY_ENTRIES = 1000000


def name_key(name):
    return unicodedata.normalize('NFD', name).casefold()


def stored_names(names):
    groups = {}
    for name in names: groups.setdefault(name_key(name), []).append(name)
    used = {name_key(name) for name in names}
    result = {name: name for name in names}
    for group in groups.values():
        if len(group) < 2: continue
        for name in sorted(group):
            nonce = 0
            while True:
                encoded = '.hicode-entry-' + hashlib.sha256((name + '\0' + str(nonce)).encode()).hexdigest()
                if name_key(encoded) not in used: break
                nonce += 1
            used.add(name_key(encoded)); result[name] = encoded
    return result


def stream_digest(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    return digest.hexdigest()


def dependency_inventory(root):
    """Bounded metadata inventory; never follow dependency links."""
    entries, size = [], 0
    def walk(directory):
        nonlocal size
        for item in sorted(directory.iterdir()):
            info = item.lstat()
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise ValueError('Unsupported dependency entry')
            if len(os.fsencode(str(item.relative_to(root)))) > 4096:
                raise ValueError('Dependency path exceeds budget')
            entries.append((item, info))
            if len(entries) > MAX_DEPENDENCY_ENTRIES: raise ValueError('Dependency entry budget exceeded')
            if stat.S_ISREG(info.st_mode):
                size += info.st_size
                if size > MAX_BYTES: raise ValueError('Dependency byte budget exceeded')
            elif stat.S_ISLNK(info.st_mode) and len(os.fsencode(os.readlink(item))) > 4096:
                raise ValueError('Invalid dependency link')
            if stat.S_ISDIR(info.st_mode): walk(item)
    walk(root)
    return entries, size


def unchanged(path, before):
    after = path.lstat()
    # The export view itself adds hardlinks, so inode ctime/nlink are not content evidence.
    if (before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns):
        raise ValueError('Dependency changed during export')


def archive_dependencies(root, destination, entries, original_bytes):
    """Write and read back storage-only archives; original Actor data stays untouched."""
    folder = destination / 'artifacts/dependency-archives'
    if folder.exists() or folder.is_symlink() or (destination/'dependency-archives.json').exists():
        raise ValueError('Reserved dependency archive path already exists')
    folder.parent.mkdir(exist_ok=True)
    if folder.parent.is_symlink(): raise ValueError('Symlinked dependency archive parent')
    folder.mkdir()
    archives, tree = [], hashlib.sha256()
    for offset in range(0, len(entries), DEPENDENCY_PART_ENTRIES):
        part = folder / ('part-%03d.tar.gz' % (offset // DEPENDENCY_PART_ENTRIES))
        expected = []
        with part.open('xb') as output, gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=3) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                archive.dereference = False
                for path, before in entries[offset:offset + DEPENDENCY_PART_ENTRIES]:
                    unchanged(path, before)
                    name = str(path.relative_to(root))
                    info = archive.gettarinfo(str(path), arcname=name)
                    digest = None
                    if stat.S_ISREG(before.st_mode):
                        # Do not preserve hardlinks across parts or outside this dependency tree.
                        info.type, info.linkname, info.size = tarfile.REGTYPE, '', before.st_size
                        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                        with os.fdopen(fd, 'rb') as stream:
                            digest = stream_digest(stream)
                            stream.seek(0); archive.addfile(info, stream)
                    else: archive.addfile(info)
                    unchanged(path, before)
                    record = [name, info.type.decode('ascii'), info.mode & 0o7777, info.size, info.linkname, digest]
                    expected.append(record)
                    tree.update(json.dumps(record, ensure_ascii=True, separators=(',', ':')).encode() + b'\n')
        verified = []
        with tarfile.open(part, 'r|gz') as archive:
            for member in archive:
                if not (member.isfile() or member.isdir() or member.issym()):
                    raise ValueError('Invalid archived dependency type')
                stream = archive.extractfile(member) if member.isfile() else None
                digest = stream_digest(stream) if stream is not None else None
                if stream is not None: stream.close()
                verified.append([member.name, member.type.decode('ascii'), member.mode, member.size, member.linkname, digest])
                if len(verified) > len(expected): raise ValueError('Unexpected archived dependency')
        if expected != verified: raise ValueError('Dependency archive verification failed')
        with part.open('rb') as stream: digest = stream_digest(stream)
        archives.append({'path': str(part.relative_to(destination)), 'entries': len(expected),
                         'bytes': part.stat().st_size, 'sha256': digest})
    # Recheck directory membership and file identities after all archive parts are complete.
    final, size = dependency_inventory(root)
    if size != original_bytes or [str(p.relative_to(root)) for p, _ in final] != [str(p.relative_to(root)) for p, _ in entries]:
        raise ValueError('Dependency tree changed during export')
    for path, before in entries: unchanged(path, before)
    receipt = {'version': 1, 'kind': 'retained-dependency-storage', 'originalPath': 'project/node_modules',
               'entries': len(entries), 'originalBytes': original_bytes, 'treeSha256': tree.hexdigest(),
               'archives': archives, 'answerUnchanged': True, 'autoRestore': False}
    (destination / 'dependency-archives.json').write_text(json.dumps(receipt, ensure_ascii=True) + '\n')
    return archives


def export(source, destination):
    source, destination = Path(source), Path(destination)
    if source.resolve() != source.absolute() or not source.is_dir():
        raise ValueError('Invalid evidence source')
    if destination.parent.resolve() != destination.parent.absolute() or destination.exists() or destination.is_symlink():
        raise ValueError('Invalid evidence export destination')
    if (source / MAP_FILE).exists() or (source / MAP_FILE).is_symlink():
        raise ValueError('Evidence already contains an export path map')
    derived = set()
    dependencies = None
    job = source / 'job.json'
    if job.exists() or job.is_symlink():
        fd = os.open(job, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                raise ValueError('Invalid evidence job')
            config = json.load(stream)
        if not isinstance(config, dict):raise ValueError('Invalid evidence job')
        if config.get('dataset') == 'deep-swe':
            # Recreated from the pinned image and patches; keep the full Actor instead.
            derived = {'baseline', 'verifier-project', 'verifier-home'}
            dependency_root = source / 'project/node_modules'
            if dependency_root.is_dir() and not dependency_root.is_symlink():
                if dependency_root.parent.is_symlink(): raise ValueError('Symlinked Actor project')
                entries, dependency_bytes = dependency_inventory(dependency_root)
                # Most large monorepos exceed the budget with dependencies alone. Count
                # the rest too, so trees near the limit take the same automatic path.
                count, outside_bytes = 0, 0
                def count_tree(current):
                    nonlocal count, outside_bytes
                    for item in current.iterdir():
                        if (current == source and item.name in derived) or item == dependency_root: continue
                        info = item.lstat(); count += 1
                        if count > MAX_FILES: raise ValueError('Non-dependency evidence file count exceeded')
                        if stat.S_ISREG(info.st_mode): outside_bytes += info.st_size
                        if outside_bytes + dependency_bytes > MAX_BYTES: raise ValueError('Evidence byte budget exceeded')
                        if stat.S_ISDIR(info.st_mode): count_tree(item)
                count_tree(source)
                if count + len(entries) + 1 > MAX_FILES:
                    sealed = []
                    for name in ['outcome.json', 'result.json']:
                        fd = os.open(source / name, os.O_RDONLY | os.O_NOFOLLOW)
                        with os.fdopen(fd, 'rb') as stream:
                            info = os.fstat(stream.fileno())
                            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                                raise ValueError('Invalid sealed outcome for dependency archiving')
                            sealed.append(json.load(stream))
                    if (sealed[0] != sealed[1] or not isinstance(sealed[0], dict)
                            or set(sealed[0]) != {'execution', 'grading', 'uid'}
                            or sealed[0]['execution'] not in {'completed', 'failed', 'timeout', 'cancelled'}
                            or sealed[0]['grading'] not in {'passed', 'failed', 'unavailable'}
                            or type(sealed[0]['uid']) is not int or sealed[0]['uid'] < 20000):
                        raise ValueError('Dependency archiving requires a sealed outcome')
                    dependencies = (dependency_root, entries, dependency_bytes)
    destination.mkdir(mode=0o700)
    mappings, files, size = [], 0, 0

    def copy(current, target, original, stored):
        nonlocal files, size
        names = sorted(os.listdir(current)); encoded = stored_names(names)
        for name in names:
            item, output = current / name, target / encoded[name]
            if dependencies and item == dependencies[0]: continue
            if current == source and name in derived:
                if item.is_symlink() or not item.is_dir():
                    raise ValueError('Invalid derived verifier directory')
                continue
            logical, physical = original / name, stored / encoded[name]
            if name != encoded[name]: mappings.append({'stored': str(physical), 'original': str(logical)})
            info = item.lstat(); files += 1
            if files > MAX_FILES: raise ValueError('Evidence file count exceeded')
            if stat.S_ISLNK(info.st_mode):
                link = os.readlink(item)
                if len(os.fsencode(link)) > 4096: raise ValueError('Invalid evidence link')
                output.symlink_to(link)
            elif stat.S_ISDIR(info.st_mode):
                output.mkdir(); copy(item, output, logical, physical)
            elif stat.S_ISREG(info.st_mode):
                size += info.st_size
                if size > MAX_BYTES: raise ValueError('Evidence byte budget exceeded')
                os.link(item, output, follow_symlinks=False)
            else: raise ValueError('Unsupported evidence entry')
    try:
        copy(source, destination, PurePosixPath(), PurePosixPath())
        if dependencies:
            archives = archive_dependencies(dependencies[0], destination, dependencies[1], dependencies[2])
            # Generated metadata and compressed storage also obey the host export budget.
            files += len(archives) + 3
            size += sum(row['bytes'] for row in archives) + (destination/'dependency-archives.json').stat().st_size
            if files > MAX_FILES: raise ValueError('Evidence file count exceeded after dependency archiving')
            if size > MAX_BYTES: raise ValueError('Evidence byte budget exceeded after dependency archiving')
        if mappings:
            data = json.dumps({'version': 1, 'entries': mappings}, ensure_ascii=True).encode()
            if len(data) > 16 * 1024 ** 2: raise ValueError('Evidence path map exceeded budget')
            (destination / MAP_FILE).write_bytes(data)
        return mappings
    except BaseException:
        shutil.rmtree(destination); raise


def relative_path(value):
    if not isinstance(value, str) or '\0' in value: raise ValueError('Invalid evidence path')
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or '..' in path.parts or str(path) != value:
        raise ValueError('Invalid evidence path')
    return path


def read_map(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise ValueError('Invalid evidence map file')
        data = stream.read(16 * 1024 ** 2 + 1)
    if len(data) > 16 * 1024 ** 2: raise ValueError('Evidence path map exceeded budget')
    return data


def restore(root, mapping, prefix):
    root = Path(root)
    if root.resolve() != root.absolute() or not root.is_dir(): raise ValueError('Invalid restore root')
    if not isinstance(mapping, dict) or set(mapping) != {'version', 'entries'} or mapping['version'] != 1:
        raise ValueError('Invalid evidence path map')
    entries = mapping['entries']
    if not isinstance(entries, list) or len(entries) > MAX_FILES: raise ValueError('Invalid evidence map size')
    seen, originals, selected = set(), set(), []
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'stored', 'original'}: raise ValueError('Invalid evidence mapping')
        stored, original = relative_path(entry['stored']), relative_path(entry['original'])
        if str(stored) in seen or str(original) in originals: raise ValueError('Duplicate evidence mapping')
        seen.add(str(stored)); originals.add(str(original))
        if stored.parts[0] != original.parts[0]: raise ValueError('Evidence mapping crosses roots')
        if stored.parts[0] == prefix:
            if len(stored.parts) < 2 or len(original.parts) < 2: raise ValueError('Invalid evidence mapping')
            selected.append((PurePosixPath(*stored.parts[1:]), original.name))
    # Validate every planned rename before touching the restoration copy.
    for stored, name in selected:
        parent = root / str(stored.parent)
        if parent.resolve() != parent.absolute(): raise ValueError('Evidence restore traverses a link')
        source, target = root / str(stored), parent / name
        if not source.exists() and not source.is_symlink(): raise ValueError('Mapped evidence entry missing')
        if target.exists() or target.is_symlink(): raise ValueError('Evidence restore would overwrite an entry')
    for stored, name in sorted(selected, key=lambda item: len(item[0].parts), reverse=True):
        parent = root / str(stored.parent)
        if parent.resolve() != parent.absolute(): raise ValueError('Evidence restore traverses a link')
        source, target = root / str(stored), parent / name
        if not source.exists() and not source.is_symlink(): raise ValueError('Mapped evidence entry missing')
        if target.exists() or target.is_symlink(): raise ValueError('Evidence restore would overwrite an entry')
        source.rename(target)


if __name__ == '__main__':
    if sys.argv[1] == 'export':
        source, destination = Path(sys.argv[2]), Path(sys.argv[3])
        if not re.fullmatch(r'/eval/runs/[a-f0-9]{16}', str(source)) or str(destination) != '/eval/evidence-export/' + source.name:
            raise ValueError('Invalid run evidence export paths')
        destination.parent.mkdir(exist_ok=True)
        if destination.parent.resolve() != destination.parent.absolute(): raise ValueError('Symlinked export parent')
        if destination.exists() or destination.is_symlink():
            if destination.is_symlink() or not destination.is_dir(): raise ValueError('Invalid previous export')
            shutil.rmtree(destination)
        export(source, destination)
    elif sys.argv[1] == 'restore': restore(sys.argv[2], json.loads(read_map(sys.argv[3])), sys.argv[4])
    else: raise ValueError('Invalid evidence operation')
