#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
E2E_SCRIPT="${ROOT}/scripts/e2e/e2e-np08-hcc-authorization.sh"

# shellcheck source=scripts/e2e/_lib/np08-cleanup.sh
source "${ROOT}/scripts/e2e/_lib/np08-cleanup.sh"
# shellcheck source=scripts/e2e/_lib/np08-provenance.sh
source "${ROOT}/scripts/e2e/_lib/np08-provenance.sh"

MCP_NS='mcp-server'
KCTL_RESULT='empty'

kctl() {
  case "${KCTL_RESULT}" in
    empty)
      return 0
      ;;
    residual)
      printf '%s\n' 'mcpserver/owned-fixture'
      return 0
      ;;
    error)
      printf '%s\n' 'secret/owned-fixture'
      printf '%s\n' 'simulated kubectl read error' >&2
      return 42
      ;;
    *)
      return 99
      ;;
  esac
}

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

KCTL_RESULT='empty'
np08_cleanup_check_residual mcpserver 'np08.evenfire/run=test' || \
  fail 'an empty successful residual read failed cleanup'
pass 'cleanup accepts an empty successful residual read'

KCTL_RESULT='empty'
set +e
marker_output="$(np08_read_sync_marker control-plane marker 2>&1)"
marker_rc=$?
set -e
if [[ "${marker_rc}" -eq 0 || -n "${marker_output}" ]]; then
  fail 'an empty marker read was treated as a valid marker'
fi
pass 'provenance rejects an empty marker read without disclosure'

KCTL_RESULT='error'
set +e
marker_output="$(np08_read_sync_marker control-plane marker 2>&1)"
marker_rc=$?
set -e
if [[ "${marker_rc}" -eq 0 || -n "${marker_output}" ]]; then
  fail 'a failed marker read was treated as a valid marker'
fi
pass 'provenance fails closed on a marker read error without disclosure'

KCTL_RESULT='residual'
set +e
cleanup_output="$(np08_cleanup_check_residual mcpserver 'np08.evenfire/run=test' 2>&1)"
cleanup_rc=$?
set -e
if [[ "${cleanup_rc}" -eq 0 ]]; then
  fail 'a residual object was treated as clean'
fi
if [[ -n "${cleanup_output}" ]]; then
  fail 'the residual check disclosed a resource name'
fi
pass 'cleanup rejects a residual object without disclosing it'

KCTL_RESULT='error'
set +e
cleanup_output="$(np08_cleanup_check_residual secret 'np08.evenfire/run=test' 2>&1)"
cleanup_rc=$?
set -e
if [[ "${cleanup_rc}" -eq 0 ]]; then
  fail 'a failed residual read was treated as an empty result'
fi
if [[ -n "${cleanup_output}" ]]; then
  fail 'the failed residual read emitted command or Secret output'
fi
pass 'cleanup fails closed on a read error without disclosure'

if [[ "$(np08_cleanup_final_status 17 0)" != '17' ]]; then
  fail 'successful cleanup erased the prior journey failure'
fi
if [[ "$(np08_cleanup_final_status 0 1)" != '1' ]]; then
  fail 'cleanup failure did not fail an otherwise successful journey'
fi
if [[ "$(np08_cleanup_final_status 17 1)" != '1' ]]; then
  fail 'cleanup failure did not preserve a failed overall result'
fi
pass 'cleanup preserves prior failures and promotes cleanup failures'

marker_json() {
  local cluster="$1"
  local generated="$2"
  printf '%s' "{\"data\":{\"worktreeId\":\"worktree-a\",\"gitHead\":\"head-a\",\"clusterFingerprint\":\"${cluster}\",\"infraFingerprint\":\"infra-a\",\"imageSource\":\"local\",\"imageTag\":\"\",\"imagesGeneratedAt\":\"${generated}\"}}"
}

exact_marker="$(marker_json 'cluster-a' '2026-08-17T12:54:11Z')"
np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-a' 'infra-a' \
  'local' '' '2026-08-17T12:54:11Z' "${exact_marker}" || \
  fail 'the exact provenance tuple was rejected'
pass 'provenance accepts the exact marker tuple'

if np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-current' 'infra-a' \
  'local' '' '2026-08-17T12:54:11Z' "${exact_marker}" >/dev/null 2>&1; then
  fail 'a wrong but non-empty cluster fingerprint was accepted'
fi
pass 'provenance rejects a wrong cluster fingerprint'

if np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-a' 'infra-a' \
  'local' '' '2026-08-17T13:00:00Z' "${exact_marker}" >/dev/null 2>&1; then
  fail 'a stale image acquisition timestamp was accepted'
fi
pass 'provenance rejects a stale image acquisition timestamp'

if np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-a' 'infra-a' \
  'local' '' '2026-08-17T12:54:11Z' 'not-json' >/dev/null 2>&1; then
  fail 'a malformed marker read was accepted'
fi
pass 'provenance fails closed on a malformed marker read'

if np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-a' 'infra-a' \
  'ghcr' 'v0.0.0' '2026-08-17T12:54:11Z' "${exact_marker}" >/dev/null 2>&1; then
  fail 'the local-only NP-08 E2E accepted a non-local image coordinate'
fi
pass 'provenance rejects a non-local image coordinate'

if ! grep -Fq 'np08_cleanup_check_residual' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_cleanup_final_status' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_read_sync_marker' "${E2E_SCRIPT}" ||
  ! grep -Fq 'pre_gate_marker_cluster_fingerprint' "${E2E_SCRIPT}" ||
  ! grep -Fq 'image_mode_images_generated_at' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_verify_sync_marker' "${E2E_SCRIPT}" ||
  ! grep -Eq '^for command_name in .* node;' "${E2E_SCRIPT}"; then
  fail 'the deployed E2E is not wired to every tested guard'
fi
pass 'the deployed E2E is wired to cleanup and provenance guards'
