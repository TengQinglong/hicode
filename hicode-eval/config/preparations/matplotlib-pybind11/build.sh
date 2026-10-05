#!/bin/bash
set -euo pipefail
# Newer public Matplotlib commits import pybind11 during setup.
# Freeze the official wheel beside this script before binding the preparation.
python3 - <<'PY'
from pathlib import Path
import hashlib
wheel=Path('/opt/hicode-task/source/pybind11-2.10.4-py3-none-any.whl')
assert hashlib.sha256(wheel.read_bytes()).hexdigest()=='ec9be0c45061c829648d7e8c98a7d041768b768c934acd15196e0f1943d9a818'
PY
for view in actor verifier; do
    "/opt/hicode-swe/$view/bin/python" -m pip install --no-index --no-deps --no-build-isolation /opt/hicode-task/source/pybind11-2.10.4-py3-none-any.whl
    "/opt/hicode-swe/$view/bin/python" -c 'import pybind11; assert pybind11.__version__ == "2.10.4"'
done
chown -R 20000:20000 /opt/hicode-swe/actor /opt/hicode-swe/verifier
