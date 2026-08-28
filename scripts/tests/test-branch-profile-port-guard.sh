#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/scripts/e2e/e2e-lib.sh"
OWNER_SCRIPT="${ROOT_DIR}/scripts/minikube/profile-owner.sh"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

repo_dir="${tmp_dir}/worktree"
mkdir -p "${repo_dir}"
identity_a="$("${OWNER_SCRIPT}" identity --repo-dir "${repo_dir}" \
  --branch fix/port-guard --created-head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)"
identity_b="$("${OWNER_SCRIPT}" identity --repo-dir "${repo_dir}" \
  --branch fix/port-guard --created-head bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)"
context="$(awk -F= '$1 == "PROFILE" { print $2; exit }' <<<"${identity_a}")"
context_after_head="$(awk -F= '$1 == "PROFILE" { print $2; exit }' <<<"${identity_b}")"
[[ "${context}" == "${context_after_head}" ]] || {
  echo 'FAIL: profile context changed when HEAD advanced' >&2
  exit 1
}
is_branch_scoped_e2e_context "${context}" || {
  echo 'FAIL: stable owner-derived profile is not recognized as branch-scoped' >&2
  exit 1
}

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

ports_hash_before="$(shasum "${ports_env}" | awk '{print $1}')"
require_branch_profile_urls "$context" "$ports_env"
require_branch_profile_urls "$context_after_head" "$ports_env"
ports_hash_after="$(shasum "${ports_env}" | awk '{print $1}')"
[[ "${ports_hash_before}" == "${ports_hash_after}" ]] || {
  echo 'FAIL: branch profile URL validation rewrote persisted ports.env' >&2
  exit 1
}

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
