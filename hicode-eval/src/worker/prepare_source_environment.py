"""Build the reviewed CPython 3.6 dependency image from checksum-pinned public source."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from venv_paths import relocate_environment

PYTHON_SHA256 = '6e28d7cdd6dd513dd190e49bca3972e20fcf455090ccf2ef3f1a227614135d91'
OPENSSL_SHA256 = 'cf3098950cb4d853ad95c0841f1f9c6d3dc102dccfcacd521d93925208b76ac8'


def validate_recipe(value):
    fields = {'version', 'python', 'requirements', 'buildRequirements', 'buildEnvironment', 'buildGroups', 'systemPackages', 'provenance'}
    if not isinstance(value, dict) or set(value) != fields or value['version'] != 1 or value['python'] != '3.6.15':
        raise ValueError('Unsupported source-runtime recipe')
    if value['buildRequirements'] != [] or value['buildEnvironment'] != {} or value['buildGroups'] != []:
        raise ValueError('Source-runtime recipes do not accept custom build steps or variables')
    pins = value['requirements']
    if not isinstance(pins, list) or not 0 < len(pins) <= 500 or any(not isinstance(p, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9.!+_-]*', p) for p in pins):
        raise ValueError('Only pinned public packages are allowed')
    names = [re.sub(r'[-_.]+', '-', p.split('==')[0]).lower() for p in pins]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate dependency name')
    if not isinstance(value['systemPackages'], list) or len(value['systemPackages']) > 100 or any(not isinstance(p, str) or not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9:.+~_-]+)?', p) for p in value['systemPackages']):
        raise ValueError('Invalid system package declaration')
    if not isinstance(value['provenance'], str) or not 0 < len(value['provenance']) <= 1000:
        raise ValueError('Missing recipe provenance')
    return value


def run(args, **kwargs):
    subprocess.run(args, check=True, timeout=1200, **kwargs)


def unpack(path, target):
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        for member in members:
            name = Path(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe runtime source member')
        archive.extractall(target, members=members)


def build_runtime(root):
    prefix = root/'python/cpython-3.6.15-source'
    ssl_prefix = root/'python/openssl-1.1.1w'
    if prefix.exists() or ssl_prefix.exists():
        raise ValueError('Source runtime already exists')
    with tempfile.TemporaryDirectory(prefix='python36-build-', dir=root) as tmp:
        build = Path(tmp)
        for filename, url, checksum in [
            ('Python-3.6.15.tar.xz', 'https://www.python.org/ftp/python/3.6.15/Python-3.6.15.tar.xz', PYTHON_SHA256),
            ('openssl-1.1.1w.tar.gz', 'https://github.com/openssl/openssl/releases/download/OpenSSL_1_1_1w/openssl-1.1.1w.tar.gz', OPENSSL_SHA256),
        ]:
            archive = build/filename
            run(['curl', '--http1.1', '-fL', '--retry', '2', '--retry-all-errors', '--connect-timeout', '20', '--max-time', '180', '--max-filesize', '100000000', url, '-o', str(archive)])
            if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
                raise ValueError('Runtime source hash mismatch')
            unpack(archive, build)
        ssl_source = build/'openssl-1.1.1w'
        run(['./config', '--prefix='+str(ssl_prefix), '--openssldir=/etc/ssl', 'shared'], cwd=ssl_source)
        run(['make', '-s', '-j2'], cwd=ssl_source)
        run(['make', '-s', 'install_sw'], cwd=ssl_source)
        # These flags avoid modern-compiler assumptions unsupported by the original interpreter.
        env = dict(os.environ, CFLAGS='-O0 -fwrapv -fcommon', CPPFLAGS='-I'+str(ssl_prefix/'include'),
                   LDFLAGS='-L'+str(ssl_prefix/'lib')+' -Wl,-rpath,'+str(ssl_prefix/'lib'))
        py_source = build/'Python-3.6.15'
        run(['./configure', '--prefix='+str(prefix), '--with-ensurepip=install'], cwd=py_source, env=env)
        run(['make', '-s', '-j2'], cwd=py_source, env=env)
        run(['make', '-s', 'install'], cwd=py_source, env=env)
    python = prefix/'bin/python3.6'
    run([str(python), '-c', 'import sys,ssl,sqlite3,ctypes,zlib,bz2,lzma;assert sys.version_info[:3]==(3,6,15)'])
    (prefix/'.runtime-ready.json').write_text(json.dumps({'python': '3.6.15', 'pythonSha256': PYTHON_SHA256,
        'opensslSha256': OPENSSL_SHA256, 'compilerFlags': '-O0 -fwrapv -fcommon'}))
    return python


def main():
    recipe = validate_recipe(json.loads(Path(sys.argv[1]).read_text()))
    root = Path('/opt/hicode-swe')
    for name in ['seed', 'actor', 'verifier']:
        if (root/name).exists():
            raise ValueError('Dependency view already exists')
    python = build_runtime(root)
    seed = root/'seed'
    run([str(python), '-m', 'venv', str(seed)])
    pip = [str(seed/'bin/python'), '-m', 'pip', '--disable-pip-version-check']
    bootstrap = [p for p in recipe['requirements'] if p.split('==')[0].lower() in {'pip', 'setuptools', 'wheel'}]
    if bootstrap:
        run([*pip, 'install', '--no-deps', *bootstrap])
    lock = root/'requirements.lock'
    lock.write_text('\n'.join(recipe['requirements'])+'\n')
    run([*pip, 'install', '--no-deps', '--no-build-isolation', '-r', str(lock)])
    run([*pip, 'check'])
    normalize = lambda name: re.sub(r'[-_.]+', '-', name).lower()
    installed = {normalize(p['name']): p['version'] for p in json.loads(subprocess.check_output([*pip, 'list', '--format=json'], text=True, timeout=30))}
    if any(installed.get(normalize(p.split('==')[0])) != p.split('==')[1] for p in recipe['requirements']):
        raise ValueError('Installed versions differ from recipe')
    run(['localedef', '-i', 'en_US', '-f', 'UTF-8', 'en_US.UTF-8'])
    (seed/'.ready.json').write_text(json.dumps({'version': 2, 'python': recipe['python'], 'requirements': recipe['requirements'], 'mode': 'clean-recipe'}))
    for name in ['actor', 'verifier']:
        target = root/name
        shutil.copytree(seed, target, symlinks=True)
        relocate_environment(target, str(seed))
        for directory, dirs, files in os.walk(target, followlinks=False):
            os.chown(directory, 20000, 20000)
            for entry in dirs+files:
                os.chown(Path(directory)/entry, 20000, 20000, follow_symlinks=False)
    shutil.rmtree(seed)


if __name__ == '__main__':
    main()
