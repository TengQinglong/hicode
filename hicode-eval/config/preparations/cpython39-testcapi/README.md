# CPython 3.9.23 test C API extension

Used by Sphinx public inspect tests when the standalone interpreter omits `_testcapi`.
Stage `build.sh` with the official `Python-3.9.23.tar.xz` from
https://www.python.org/ftp/python/3.9.23/Python-3.9.23.tar.xz before freezing the preparation directory.
Expected SHA256: `61a42919e13d539f7673cf11d1c404380e28e540510860b9d242196e165709c9`.

The dependency image must provide CPython 3.9.23, its development headers and a C compiler.
The script verifies the archive, builds the real extension offline and checks both Actor
and Verifier interpreters. It neither installs Sphinx nor changes tests. Bind the frozen
directory through the existing catalog `preparation` entry and run environment preparation.
