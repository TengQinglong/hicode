import io
import subprocess
import tarfile
from pathlib import Path
from protocol import atomic_json, digest


def prepare(source, destination, *, worktree=False):
    source=Path(source).resolve();destination=Path(destination).resolve()
    if destination==source or destination.is_relative_to(source):raise ValueError('Payload must be outside the source checkout')
    def git(*args):return subprocess.check_output(['git','-C',str(source),*args],timeout=30)
    status=git('status','--porcelain').decode()
    if status and not worktree:raise ValueError('Checkout is dirty; use --snapshot-worktree to explicitly freeze current source')
    sha=git('rev-parse','HEAD').decode().strip()
    destination.mkdir(parents=True,exist_ok=False)
    # Deploy runtime inputs only; repository docs, datasets and local configuration
    # must not become visible to the evaluated Agent through its source release.
    archive=git('archive','--format=tar','HEAD','src','package.json','bun.lock','tsconfig.json')
    changed=[]
    if worktree:
        changed=sorted(set(git('diff','HEAD','--name-only','-z').decode().split('\0')+
                           git('ls-files','--others','--exclude-standard','-z').decode().split('\0')))
        changed=[p for p in changed if p.startswith('src/') or p in {'package.json','bun.lock','tsconfig.json'}]
    with tarfile.open(fileobj=io.BytesIO(archive)) as baseline,tarfile.open(destination/'source.tar.gz','w:gz') as out:
        for member in baseline:
            if not (member.isfile() or member.isdir()):raise ValueError('Only regular source files and directories may be archived')
            if member.name in changed:continue
            out.addfile(member,baseline.extractfile(member) if member.isfile() else None)
        for name in changed:
            path=source/name
            if path.exists():
                if path.is_symlink() or not path.is_file():raise ValueError('Only regular source files may be overlaid')
                out.add(path,arcname=name)
    atomic_json(destination/'manifest.json',{'commit':sha,'worktree_overlay':changed,
        'files':{'source.tar.gz':digest(destination/'source.tar.gz')}})
    return destination

if __name__ == '__main__':
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument('--source',required=True);p.add_argument('--payload',required=True)
    p.add_argument('--snapshot-worktree',action='store_true')
    a=p.parse_args();print(prepare(a.source,a.payload,worktree=a.snapshot_worktree))
