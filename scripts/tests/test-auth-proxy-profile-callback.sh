#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

ports_env="${tmp_dir}/ports.env"
printf '%s\n' \
  'AUTH_PROXY_PORT=36196' \
  'AUTH_PROXY_URL=http://127.0.0.1:36196' \
  'AUTH_PROXY_BASE_URL=http://127.0.0.1:36196' >"${ports_env}"

actual="$(
  MINIKUBE_PROFILE=clerum-feat-teams-deadbeef \
    CLERUM_PROFILE_PORTS_ENV="${ports_env}" \
    bash "${ROOT_DIR}/scripts/minikube/sync-auth-callback-base-url.sh" --print-url
)"
if [[ "${actual}" != 'http://127.0.0.1:36196' ]]; then
  echo "FAIL: expected profile auth callback port, got ${actual}" >&2
  exit 1
fi

if MINIKUBE_PROFILE=clerum-feat-teams-deadbeef \
  CLERUM_PROFILE_PORTS_ENV="${tmp_dir}/missing.env" \
  bash "${ROOT_DIR}/scripts/minikube/sync-auth-callback-base-url.sh" --print-url \
  >/dev/null 2>&1; then
  echo 'FAIL: accepted a branch profile without ports.env' >&2
  exit 1
fi

echo 'PASS: OAuth callback base follows the branch profile auth-proxy port'
