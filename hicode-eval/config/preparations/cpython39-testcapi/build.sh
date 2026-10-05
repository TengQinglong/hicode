#!/bin/bash
set -euo pipefail
# Some standalone CPython distributions omit this public C-API test extension.
# Sphinx's inspect tests import its real built-in callables; a Python shim is invalid.
command -v cc >/dev/null
command -v make >/dev/null
/opt/hicode-swe/actor/bin/python - <<'PY'
import hashlib, pathlib, shutil, subprocess, sys, sysconfig, tarfile, tempfile
assert sys.version_info[:3] == (3, 9, 23), 'This preparation is pinned to CPython 3.9.23'
with tempfile.TemporaryDirectory(prefix='cpython-testcapi-') as tmp:
    root = pathlib.Path(tmp)
    archive = pathlib.Path('/opt/hicode-task/source/Python-3.9.23.tar.xz')
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == '61a42919e13d539f7673cf11d1c404380e28e540510860b9d242196e165709c9'
    with tarfile.open(archive) as source:
        for name in ['_testcapimodule.c', 'testcapi_long.h']:
            member = source.getmember('Python-3.9.23/Modules/' + name)
            assert member.isfile()
            (root / name).write_bytes(source.extractfile(member).read())
    (root / 'setup.py').write_text("from setuptools import setup, Extension\nsetup(name='cpython-testcapi', ext_modules=[Extension('_testcapi', ['_testcapimodule.c'])])\n")
    subprocess.run([sys.executable, 'setup.py', 'build_ext', '--inplace'], cwd=root, check=True)
    suffix = sysconfig.get_config_var('EXT_SUFFIX')
    module = root / ('_testcapi' + suffix)
    assert module.is_file()
    target = pathlib.Path(sysconfig.get_path('stdlib')) / 'lib-dynload' / module.name
    shutil.copy2(module, target)
    target.chmod(0o755)
for view in ['actor', 'verifier']:
    subprocess.run(['/opt/hicode-swe/' + view + '/bin/python', '-c', 'import _testcapi; assert _testcapi.instancemethod(str.__repr__)'], check=True)
PY
