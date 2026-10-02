"""Pinned Python 3.6 runtime for original SWE environments on the Linux machine."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile

PYTHON_SHA256 = '6e28d7cdd6dd513dd190e49bca3972e20fcf455090ccf2ef3f1a227614135d91'
OPENSSL_SHA256 = 'cf3098950cb4d853ad95c0841f1f9c6d3dc102dccfcacd521d93925208b76ac8'


def run(args, **kwargs):
    subprocess.run(args, check=True, timeout=1200, **kwargs)


def source_archive(path, url, sha):
    if not path.exists():
        partial=path.with_suffix('.partial')
        try:
            run(['curl','--http1.1','-fL','--retry','2','--retry-all-errors','--connect-timeout','20','--max-time','180',url,'-o',str(partial)])
            if hashlib.sha256(partial.read_bytes()).hexdigest()!=sha:raise ValueError('Runtime source hash mismatch')
            partial.replace(path)
        finally:partial.unlink(missing_ok=True)
    if hashlib.sha256(path.read_bytes()).hexdigest()!=sha:raise ValueError('Cached runtime source changed')


def unpack(path, target):
    with tarfile.open(path) as archive:
        members=archive.getmembers()
        for member in members:
            name=Path(member.name)
            if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe runtime source member')
        archive.extractall(target, members=members)


def ensure_python36(root):
    root=Path(root);prefix=root/'python/cpython-3.6.15-source';ready=prefix/'.runtime-ready.json'
    if ready.exists():
        receipt=json.loads(ready.read_text())
        if receipt!={'python':'3.6.15','pythonSha256':PYTHON_SHA256,'opensslSha256':OPENSSL_SHA256,'compilerFlags':'-O0 -fwrapv -fcommon'}:
            raise ValueError('Unexpected Python 3.6 runtime receipt')
        run([str(prefix/'bin/python3.6'),'-c',"import sys,ssl,sqlite3,ctypes,zlib,bz2,lzma;assert sys.version_info[:3]==(3,6,15)"])
        return prefix/'bin/python3.6'
    if prefix.exists():raise ValueError('Incomplete Python 3.6 runtime; inspect before removing')
    run(['apt-get','-o','Acquire::Retries=1','-o','Acquire::https::Timeout=20','update'])
    run(['apt-get','install','-y','--no-install-recommends','build-essential','perl','libffi-dev','zlib1g-dev','libbz2-dev','liblzma-dev','libreadline-dev','libsqlite3-dev','libncurses-dev','uuid-dev'])
    sources=root/'runtime-sources';sources.mkdir(exist_ok=True)
    py=sources/'Python-3.6.15.tar.xz';ssl=sources/'openssl-1.1.1w.tar.gz'
    source_archive(py,'https://www.python.org/ftp/python/3.6.15/Python-3.6.15.tar.xz',PYTHON_SHA256)
    source_archive(ssl,'https://github.com/openssl/openssl/releases/download/OpenSSL_1_1_1w/openssl-1.1.1w.tar.gz',OPENSSL_SHA256)
    ssl_prefix=root/'python/openssl-1.1.1w'
    with tempfile.TemporaryDirectory(prefix='python36-build-',dir=str(root)) as tmp:
        build=Path(tmp);unpack(ssl,build);unpack(py,build)
        ssl_source=build/'openssl-1.1.1w';py_source=build/'Python-3.6.15'
        run(['./config','--prefix='+str(ssl_prefix),'--openssldir=/etc/ssl','shared'],cwd=ssl_source)
        run(['make','-j4'],cwd=ssl_source);run(['make','install_sw'],cwd=ssl_source)
        # Use conservative compiler settings for this historical interpreter.
        # Source remains unpatched and the flags are recorded in its receipt.
        env=dict(os.environ,CFLAGS='-O0 -fwrapv -fcommon',CPPFLAGS='-I'+str(ssl_prefix/'include'),
                 LDFLAGS='-L'+str(ssl_prefix/'lib')+' -Wl,-rpath,'+str(ssl_prefix/'lib'))
        run(['./configure','--prefix='+str(prefix),'--with-ensurepip=install'],cwd=py_source,env=env)
        run(['make','-j4'],cwd=py_source,env=env);run(['make','install'],cwd=py_source,env=env)
    python=prefix/'bin/python3.6'
    run([str(python),'-c',"import sys,ssl,sqlite3,ctypes,zlib,bz2,lzma;assert sys.version_info[:3]==(3,6,15);print(sys.version,ssl.OPENSSL_VERSION)"])
    ready.write_text(json.dumps({'python':'3.6.15','pythonSha256':PYTHON_SHA256,'opensslSha256':OPENSSL_SHA256,'compilerFlags':'-O0 -fwrapv -fcommon'}))
    return python
