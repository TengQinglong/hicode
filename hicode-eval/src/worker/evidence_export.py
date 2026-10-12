"""Preserve Linux filenames when exporting evidence to a case-insensitive host."""
import hashlib
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


def export(source, destination):
    source, destination = Path(source), Path(destination)
    if source.resolve() != source.absolute() or not source.is_dir():
        raise ValueError('Invalid evidence source')
    if destination.parent.resolve() != destination.parent.absolute() or destination.exists() or destination.is_symlink():
        raise ValueError('Invalid evidence export destination')
    if (source / MAP_FILE).exists() or (source / MAP_FILE).is_symlink():
        raise ValueError('Evidence already contains an export path map')
    derived = set()
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
    destination.mkdir(mode=0o700)
    mappings, files, size = [], 0, 0

    def copy(current, target, original, stored):
        nonlocal files, size
        names = sorted(os.listdir(current)); encoded = stored_names(names)
        for name in names:
            item, output = current / name, target / encoded[name]
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
