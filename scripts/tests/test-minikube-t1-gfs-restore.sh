#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Source only the T1 definitions, then replace the Kubernetes probe with a
# deterministic unreadable-Secret response. The production cleanup trap is
# removed before the subshell exits so this test cannot touch a cluster.
if ! (
  set +e
  export MINIKUBE_PROFILE=t1-restore-contract
  export T2_CONTEXT=t1-restore-contract
  source "$ROOT/scripts/e2e/minikube-real-postgres.sh" >/dev/null 2>&1
  trap - EXIT INT TERM
  set +e
  T1_GFS_RESTORE_REQUIRED=true
  t2_kc() { return 1; }
  if restore_gfs_runtime_credentials; then
    exit 1
  fi
  exit 0
); then
  fail 'T1 accepted an unreadable required gfs-controller-db Secret'
fi

printf 'PASS: T1 GFS restore fails closed on a missing or unreadable Secret\n'
