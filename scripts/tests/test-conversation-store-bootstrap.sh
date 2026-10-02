#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
node -e 'if (!process.version.startsWith("v24.")) process.exit(1)'
node --test "$ROOT/scripts/tests/test-conversation-store-bootstrap.mjs"
