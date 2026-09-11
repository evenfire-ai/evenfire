#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v openssl >/dev/null || { echo 'FAIL: openssl is required' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error("FAIL: Node 24 is required"); process.exit(1) }'
# Test certificates and the generator output stay in Node memory; never tee or
# redirect the generator itself to any artifact. The reporter prints test results.
exec node --test --test-timeout=15000 "$SCRIPT_DIR/hcc-watch-api-proxy.test.mjs"
