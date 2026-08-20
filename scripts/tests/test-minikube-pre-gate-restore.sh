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

printf 'PASS: pre-gate restores fail closed and preserve writer fences\n'
