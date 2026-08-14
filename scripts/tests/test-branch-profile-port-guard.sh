#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/scripts/e2e/e2e-lib.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

context='clerum-codex-port-guard-deadbeef'
ports_env="${tmp_dir}/ports.env"
cat >"${ports_env}" <<'EOF_PORTS'
CONTROL_UI_URL=http://127.0.0.1:36148
CONTROL_API_URL=http://127.0.0.1:36238
EXTERNAL_REST_API_URL=http://127.0.0.1:36239
RPC_PROXY_URL=http://127.0.0.1:36242
EOF_PORTS

export CONTROL_UI_BASE_URL=http://127.0.0.1:36148
export CONTROL_API_BASE_URL=http://127.0.0.1:36238
export EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:36239
export RPC_PROXY_BASE_URL=http://127.0.0.1:36242

require_branch_profile_urls "$context" "$ports_env"

CONTROL_API_BASE_URL=http://127.0.0.1:36239
if require_branch_profile_urls "$context" "$ports_env" >/dev/null 2>&1; then
  echo 'FAIL: accepted a URL belonging to a different profile' >&2
  exit 1
fi

if require_branch_profile_urls "$context" "${tmp_dir}/missing.env" >/dev/null 2>&1; then
  echo 'FAIL: accepted a branch profile without ports.env' >&2
  exit 1
fi

echo 'PASS: branch profile URL guard requires the exact generated ports.env mapping'
