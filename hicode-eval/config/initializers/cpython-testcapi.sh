#!/bin/bash
set -euo pipefail

# Build the real CPython extension omitted by the minimal Python distribution.
/opt/hicode-swe/actor/bin/python - <<'PY'
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import tempfile

if sys.version_info[:3] != (3, 9, 23):
    raise RuntimeError('Frozen _testcapi source requires CPython 3.9.23')
source = Path('/opt/hicode-task/source')
hashes = {
    '_testcapimodule.c': '9a26bf9be2915b15529780ec55d1e94b2d2a94988cf5238c79deed745853db98',
    'testcapi_long.h': '8ce2eca8c074b28d4c1b7190d1608ea91d8648530bd0bcc4e2397a6f137318f3',
}
for name, expected in hashes.items():
    path = source / name
    if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError('CPython source identity mismatch: ' + name)
with tempfile.TemporaryDirectory(prefix='cpython-testcapi-') as directory:
    artifact = Path(directory) / ('_testcapi' + sysconfig.get_config_var('EXT_SUFFIX'))
    subprocess.run(['cc', '-shared', '-fPIC', '-O2', '-pthread',
                    '-I' + sysconfig.get_path('include'), '-I' + str(source),
                    str(source / '_testcapimodule.c'), '-o', str(artifact)], check=True, timeout=120)
    for view in ('actor', 'verifier'):
        python = '/opt/hicode-swe/' + view + '/bin/python'
        target = Path(subprocess.check_output([python, '-c',
            'import sys,sysconfig;assert sys.version_info[:3]==(3,9,23);print(sysconfig.get_path("platlib"))'], text=True).strip())
        shutil.copyfile(artifact, target / artifact.name)
        (target / artifact.name).chmod(0o644)
        subprocess.run([python, '-c', 'import _testcapi; assert callable(_testcapi.instancemethod(str.__repr__))'],
                       check=True, timeout=15)
    receipt = {'version': 1, 'python': '3.9.23', 'sources': hashes,
               'artifactSha256': hashlib.sha256(artifact.read_bytes()).hexdigest()}
    Path('/opt/hicode-task/testcapi.json').write_text(json.dumps(receipt, sort_keys=True) + '\n')
PY
