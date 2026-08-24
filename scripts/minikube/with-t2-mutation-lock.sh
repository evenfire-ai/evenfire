#!/usr/bin/env bash
# Run one mutating Minikube command under the canonical branch-profile lease.
# A nested T2/full-setup/pre-gate child validates the inherited lease instead
# of acquiring a second lock for the same profile.
set -euo pipefail

if [[ "${1:-}" != "--" || "$#" -lt 2 ]]; then
  printf 'usage: %s -- command [args...]\n' "${0##*/}" >&2
  exit 2
fi
shift

# GNU Make executes recipe lines containing $(MAKE) during `make -n` so the
# recursive make can print its own plan. Never let that dry-run escape hatch
# enter a mutating wrapper. Match the actual dry-run flags rather than looking
# for the letter `n`, because normal recursive builds carry --no-print-directory.
for make_flag in ${MAKEFLAGS:-}; do
  case "${make_flag}" in
    -n|n|--just-print|--dry-run) exit 0 ;;
  esac
done

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
T2_PROJECT_DIR="${T2_PROJECT_DIR:-${ROOT}}"
T2_PROFILE="${T2_PROFILE:-${MINIKUBE_PROFILE:-}}"
T2_CONTEXT="${T2_CONTEXT:-${CONTROL_API_REAL_PG_CONTEXT:-${T2_PROFILE}}}"
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-${T2_PROFILE}}"
CONTROL_API_REAL_PG_CONTEXT="${CONTROL_API_REAL_PG_CONTEXT:-${T2_CONTEXT}}"
T2_SKIP_LOCK="${T2_SKIP_LOCK:-false}"
T2_GATE_ID="${T2_GATE_ID:-mutation-wrapper}"

if [[ -z "${T2_PROFILE}" || -z "${T2_CONTEXT}" || "${T2_PROFILE}" != "${T2_CONTEXT}" ]]; then
  printf 'PROFILE_LOCK_REQUIRED: mutation target profile and Kubernetes context must match\n' >&2
  exit 1
fi

# shellcheck source=scripts/minikube/t2-common.sh
source "${ROOT}/scripts/minikube/t2-common.sh"
t2_require_commands
t2_repo_metadata
t2_profile_scope
t2_profile_status
if [[ "${T2_BOOTSTRAP_REQUIRED}" == true ]]; then
  T2_NEXT_COMMAND="bootstrap the branch-owned profile, then retry the mutating target"
  t2_fail DEVELOPMENT_SCOPE_REQUIRED "branch-owned Minikube profile is not bootstrapped: ${T2_PROFILE}"
fi
t2_context_check
t2_profile_context_identity_check
t2_mutation_lock

export T2_PROJECT_DIR T2_PROFILE T2_CONTEXT T2_PROFILE_ROOT T2_PROFILE_ENV T2_PORTS_ENV \
  T2_LOCK_ROOT T2_LOCK_TOKEN MINIKUBE_PROFILE CONTROL_API_REAL_PG_CONTEXT
export T2_SKIP_LOCK=true T2_MUTATION_LOCK_WRAPPED=true

cleanup_wrapper() {
  local status=$? cleanup_status=0
  trap - EXIT INT TERM
  t2_lock_release "${status}" || cleanup_status=$?
  if [[ "${status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then
    status="${cleanup_status}"
  fi
  exit "${status}"
}
trap cleanup_wrapper EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_status=0
"$@" || run_status=$?
exit "${run_status}"
