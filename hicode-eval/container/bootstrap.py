"""One-time release preparation on the persistent evaluation machine."""
import hashlib,json,os,shutil,subprocess,sys,tarfile
from pathlib import Path
archive=Path(sys.argv[1]);release=Path('/opt/hicode/releases')/sys.argv[2]
subprocess.run(['mkdir','-p','/app','/tests','/logs/verifier'],check=True)
if release.exists():
    if not (release/'.ready').is_file():raise RuntimeError('Incomplete release; inspect before retrying')
    archive.unlink(missing_ok=True)
    print(release);raise SystemExit(0)
release.mkdir(parents=True)
try:
    with tarfile.open(archive) as t:
        for m in t:
            if not (m.isfile() or m.isdir()) or m.name.startswith('/') or '..' in Path(m.name).parts:raise ValueError('Unsafe source archive')
            t.extract(m,release)
    dep_hash=hashlib.sha256((release/'package.json').read_bytes()+(release/'bun.lock').read_bytes()).hexdigest()
    deps=Path('/opt/hicode/dependencies')/dep_hash
    if not (deps/'.ready').exists():
        deps.mkdir(parents=True,exist_ok=True)
        prepared=Path('/opt/hicode')
        reusable=(prepared/'node_modules').is_dir() and all((prepared/n).is_file() and (prepared/n).read_bytes()==(release/n).read_bytes() for n in ['package.json','bun.lock'])
        if reusable:
            (deps/'node_modules').symlink_to(prepared/'node_modules',target_is_directory=True)
        else:
            for n in ['package.json','bun.lock']:shutil.copyfile(release/n,deps/n)
            subprocess.run(['bun','install','--production','--frozen-lockfile'],cwd=deps,check=True,timeout=600,stdout=sys.stderr)
        (deps/'.ready').write_text('ready\n')
    (release/'node_modules').symlink_to(deps/'node_modules',target_is_directory=True)
    (release/'.ready').write_text(dep_hash)
    print(release)
except BaseException:
    shutil.rmtree(release)
    raise
finally:archive.unlink(missing_ok=True)
