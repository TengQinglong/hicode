# Matplotlib pybind11 build dependency

Bind only commits whose public setup imports `pybind11.setup_helpers`.
Freeze the official `pybind11-2.10.4-py3-none-any.whl` beside `build.sh` before
binding the preparation directory. SHA256:
`ec9be0c45061c829648d7e8c98a7d041768b768c934acd15196e0f1943d9a818`.

This offline step adds the same public C++ headers and build helper to Actor and
Verifier views. It does not install Matplotlib or change its source/tests.
