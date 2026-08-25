#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

cat >"$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -eu
case "${FAKE_RESTORE_FAILURE:-none}:$*" in
  workflow-scale:*scale\ deployment/workflow-recipes*) exit 17 ;;
  workflow-rollout:*rollout\ status\ deployment/workflow-recipes*) exit 18 ;;
  control-scale:*scale\ deployment/control-api*) exit 27 ;;
  control-rollout:*rollout\ status\ deployment/control-api*) exit 28 ;;
esac
exit 0
STUB
chmod +x "$tmp/kubectl"

export PRE_GATE_SYNC_CONFIG_ONLY=true
export MINIKUBE_PROFILE=restore-contract
export IMAGE_SOURCE=local
# shellcheck source=/dev/null
source "$ROOT/scripts/minikube/pre-gate-sync.sh" >/dev/null

KC="$tmp/kubectl"
export KC

for failure in workflow-scale workflow-rollout; do
  WRC_FENCED=true
  WRC_REPLICAS=1
  export WRC_FENCED WRC_REPLICAS FAKE_RESTORE_FAILURE
  FAKE_RESTORE_FAILURE="$failure"
  if restore_workflow_reconciler; then
    fail "workflow reconciler restore accepted ${failure}"
  fi
  [ "$WRC_FENCED" = true ] || fail "workflow fence was cleared after ${failure}"
done

for failure in control-scale control-rollout; do
  CONTROL_API_FENCED=true
  CONTROL_API_REPLICAS=1
  export CONTROL_API_FENCED CONTROL_API_REPLICAS FAKE_RESTORE_FAILURE
  FAKE_RESTORE_FAILURE="$failure"
  if restore_control_api; then
    fail "Control API restore accepted ${failure}"
  fi
  [ "$CONTROL_API_FENCED" = true ] || fail "Control API fence was cleared after ${failure}"
done

FAKE_RESTORE_FAILURE=none
WRC_FENCED=true
restore_workflow_reconciler || fail 'workflow reconciler restore rejected a successful scale and rollout'
[ "$WRC_FENCED" = false ] || fail 'workflow fence remained armed after a successful restore'
CONTROL_API_FENCED=true
restore_control_api || fail 'Control API restore rejected a successful scale and rollout'
[ "$CONTROL_API_FENCED" = false ] || fail 'Control API fence remained armed after a successful restore'

# EXIT traps do not propagate their return value in Bash. The pre-gate
# finalizer must therefore exit explicitly when a last-chance restore fails.
set +e
PRE_GATE_SYNC_CONFIG_ONLY=true MINIKUBE_PROFILE=restore-contract IMAGE_SOURCE=local \
  bash -c '
    script="$1"; set --; source "$script" >/dev/null
    restore_pre_gate_writers() { return 31; }
  ' bash "$ROOT/scripts/minikube/pre-gate-sync.sh" >/dev/null 2>&1
exit_status=$?
set -e
[ "$exit_status" -ne 0 ] || fail 'EXIT cleanup failure was hidden behind a zero pre-gate status'

set +e
PRE_GATE_SYNC_CONFIG_ONLY=true MINIKUBE_PROFILE=restore-contract IMAGE_SOURCE=local \
  bash -c '
    script="$1"; set --; source "$script" >/dev/null
    restore_pre_gate_writers() { return 0; }
    t2_lock_release() { return 41; }
  ' bash "$ROOT/scripts/minikube/pre-gate-sync.sh" >/dev/null 2>&1
exit_status=$?
set -e
[ "$exit_status" -ne 0 ] || fail 'EXIT lock cleanup failure was hidden behind a zero pre-gate status'

set +e
PRE_GATE_SYNC_CONFIG_ONLY=true MINIKUBE_PROFILE=restore-contract IMAGE_SOURCE=local \
  bash -c '
    script="$1"; set --; source "$script" >/dev/null
    restore_pre_gate_writers() { return 0; }
    exit 23
  ' bash "$ROOT/scripts/minikube/pre-gate-sync.sh" >/dev/null 2>&1
exit_status=$?
set -e
[ "$exit_status" -eq 23 ] || fail "EXIT cleanup replaced original failure status 23 with ${exit_status}"

# Bash may enter an EXIT trap with the status of the interrupted command rather
# than the canonical signal status. Exercise the explicit handlers directly so
# they must preserve 130/143 and finish every safety cleanup exactly once.
for signal_case in INT:130 TERM:143; do
  signal="${signal_case%%:*}"
  expected_status="${signal_case##*:}"
  signal_events="$tmp/signal-${signal}.events"
  set +e
  PRE_GATE_SYNC_CONFIG_ONLY=true MINIKUBE_PROFILE=restore-contract IMAGE_SOURCE=local \
    SIGNAL_EVENTS="$signal_events" bash -c '
      script="$1"
      signal="$2"
      set --
      source "$script" >/dev/null
      restore_pre_gate_writers() { printf "restore\n" >>"$SIGNAL_EVENTS"; }
      incremental_docker_cleanup() { printf "docker-cleanup\n" >>"$SIGNAL_EVENTS"; }
      t2_lock_release() { printf "lock-release:%s\n" "$1" >>"$SIGNAL_EVENTS"; return "$1"; }
      kill "-${signal}" "$$"
      printf "signal handler returned unexpectedly\n" >>"$SIGNAL_EVENTS"
    ' bash "$ROOT/scripts/minikube/pre-gate-sync.sh" "$signal" >/dev/null 2>&1
  signal_status=$?
  set -e
  [ "$signal_status" -eq "$expected_status" ] || \
    fail "$signal cleanup returned ${signal_status}, expected ${expected_status}"
  expected_events=$'restore\ndocker-cleanup\nlock-release:0'
  actual_events="$(cat "$signal_events")"
  [ "$actual_events" = "$expected_events" ] || \
    fail "$signal cleanup did not restore writers, clean Docker state, and release the lease exactly once: ${actual_events}"
done

# Exact-head state is committed only after both fenced writers are restored.
events=""
restore_pre_gate_writers() { events+="restore "; return 1; }
persist_cluster_marker() { events+="marker "; }
persist_state() { events+="state-$1 "; }
if commit_cluster_sync_state cluster-fingerprint infra-fingerprint; then
  fail 'cluster sync state committed despite writer restore failure'
fi
[ "$events" = "restore " ] || fail "marker/state mutation ran after failed restore: ${events}"

events=""
restore_pre_gate_writers() { events+="restore "; return 0; }
commit_cluster_sync_state cluster-fingerprint infra-fingerprint || \
  fail 'cluster sync state rejected a successful writer restore'
[ "$events" = "restore marker state-cluster state-infra " ] || \
  fail "cluster marker was not persisted after restore in the required order: ${events}"

# Leave the sourced script's EXIT finalizer with a successful cleanup stub.
restore_pre_gate_writers() { return 0; }

printf 'PASS: pre-gate cleanup propagates failures and exact-head state commits only after restore\n'
