#!/usr/bin/env bash
# Validate an inherited branch-profile mutation lease before a private child
# mutator performs its first Kubernetes write. The parent transition owns the
# lease; this boundary never acquires or releases it.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
T2_PROJECT_DIR="${T2_PROJECT_DIR:-${ROOT}}"
T2_PROFILE="${T2_PROFILE:-${MINIKUBE_PROFILE:-}}"
T2_CONTEXT="${T2_CONTEXT:-${CONTROL_API_REAL_PG_CONTEXT:-${T2_PROFILE}}}"
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-${T2_PROFILE}}"
CONTROL_API_REAL_PG_CONTEXT="${CONTROL_API_REAL_PG_CONTEXT:-${T2_CONTEXT}}"
T2_LOCK_TOKEN="${T2_LOCK_TOKEN:-}"
T2_SKIP_LOCK=true
T2_GATE_ID="${T2_GATE_ID:-mutation-child}"

if [[ -z "${T2_PROFILE}" || -z "${T2_CONTEXT}" || "${T2_PROFILE}" != "${T2_CONTEXT}" ]]; then
  printf 'PROFILE_LOCK_REQUIRED: mutation target profile and Kubernetes context must match\n' >&2
  exit 1
fi

# shellcheck source=scripts/minikube/t2-common.sh
source "${ROOT}/scripts/minikube/t2-common.sh"
# The public wrapper already performed repository/profile/context health checks
# before acquiring the lease. Children must revalidate the lease identity
# without doing a second status/readiness transition: this keeps the first
# child Kubernetes operation behind the same opaque owner token while allowing
# generated profile status to remain the parent's responsibility.
actual_root="$(git -C "${T2_PROJECT_DIR}" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "${actual_root}" && "$(cd -- "${actual_root}" && pwd -P)" == "${T2_PROJECT_DIR}" ]] || {
  printf 'DEVELOPMENT_SCOPE_REQUIRED: mutation child worktree does not match the lease repository\n' >&2
  exit 1
}
T2_BRANCH="$(git -C "${T2_PROJECT_DIR}" branch --show-current 2>/dev/null || true)"
T2_HEAD="$(git -C "${T2_PROJECT_DIR}" rev-parse --verify HEAD 2>/dev/null || true)"
T2_WORKTREE_ID="$(t2_worktree_id "${T2_PROJECT_DIR}")"
[[ -n "${T2_BRANCH}" && -n "${T2_HEAD}" ]] || {
  printf 'DEVELOPMENT_SCOPE_REQUIRED: mutation child cannot resolve branch and HEAD\n' >&2
  exit 1
}
t2_lock_validate_inherited
