"""Derive source versions from public upstream ancestry, never synthetic Git commits."""
from pathlib import Path
import re
import subprocess


def prepare_source_version(repo, project, base_commit, python, metadata):
    if repo not in {'pydata/xarray', 'pytest-dev/pytest'} or not re.fullmatch(r'[a-f0-9]{40}', base_commit):
        raise ValueError('Unsupported source-version identity')
    metadata = Path(metadata)
    if metadata.is_symlink(): raise ValueError('Symlinked upstream metadata')
    if not metadata.exists():
        metadata.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'init', '--bare', '--template=', str(metadata)], check=True, timeout=15, stdout=subprocess.DEVNULL)
    prefix = ['git', '-c', 'http.version=HTTP/1.1', '-c', 'core.hooksPath=/dev/null', '--git-dir=' + str(metadata)]
    if subprocess.run([*prefix, 'cat-file', '-e', base_commit + '^{commit}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        subprocess.run([*prefix, 'fetch', '--filter=blob:none', '--no-tags',
                        'https://github.com/' + repo + '.git', '+refs/tags/*:refs/tags/*', base_commit],
                       check=True, timeout=180)
    describe = subprocess.check_output([*prefix, 'describe', '--tags', '--long', base_commit], text=True, timeout=15).strip()
    match = re.fullmatch(r'v?([0-9]+(?:\.[0-9]+)+(?:[ab]\d+|rc\d+)?(?:\.dev\d+)?)-(\d+)-(g[a-f0-9]+)', describe)
    if not match: raise ValueError('Unsupported upstream source-version description')
    date = subprocess.check_output([*prefix, 'show', '-s', '--format=%cI', base_commit], text=True, timeout=15).strip()
    # Supported source trees use their standard default SCM schemes. Versioneer
    # additionally generates its original sdist artifact, exactly as upstream.
    program = """import sys,importlib.util,os
from setuptools_scm.version import meta,format_version
from setuptools_scm.config import Configuration
repo,root,tag,distance,node,commit,date=sys.argv[1:]
if repo=='pydata/xarray' and os.path.isfile(os.path.join(root,'versioneer.py')):
    spec=importlib.util.spec_from_file_location('versioneer',os.path.join(root,'versioneer.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    config=module.get_config_from_root(root)
    value=module.render({'closest-tag':tag,'distance':int(distance),'short':node[1:],'long':commit,'dirty':False,'date':date,'error':None},config.style)
    module.write_to_version_file(os.path.join(root,config.versionfile_source),value)
    print(value['version'])
else:
    value=meta(tag,distance=int(distance),node=node,dirty=False,config=Configuration())
    print(format_version(value,version_scheme='guess-next-dev',local_scheme='node-and-date'))
"""
    version = subprocess.check_output([str(python), '-c', program, repo, str(project), *match.groups(), base_commit, date], text=True, timeout=15).strip().splitlines()[-1]
    receipt = {'baseCommit': base_commit, 'describe': describe, 'version': version}
    from protocol import atomic_json
    from scm import read_source_version
    atomic_json(Path(project) / '.git/hicode-source-version.json', receipt)
    return read_source_version(project, base_commit)
