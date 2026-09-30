#!/usr/bin/env bash
set -euo pipefail
module_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bun "$module_dir/src/cli.ts" "$@"
