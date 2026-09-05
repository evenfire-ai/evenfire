#!/usr/bin/env bash
# Hermetic API/process boundary contracts; never invokes kubectl or a cluster.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/e2e/_lib/wrc-fixtures.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wrc-fixtures.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
WRC_FIXTURE_DIR="$TEST_ROOT"
WRC_FIXTURE_LEDGER="$TEST_ROOT/owned.jsonl"
E2E_RUN_ID=contract123
MODE=normal

reset_fixture() {
  MODE=normal
  : > "$WRC_FIXTURE_LEDGER"
  : > "$TEST_ROOT/calls"
  rm -f "$TEST_ROOT/live.json"
}

kctl() {
  printf '%s\n' "$*" >> "$TEST_ROOT/calls"
  case "$1" in
    create)
      [[ ! -e "$TEST_ROOT/live.json" ]] || return 1
      jq '.metadata.uid="created-uid"' > "$TEST_ROOT/live.json"
      cat "$TEST_ROOT/live.json"
      ;;
    get)
      [[ "$MODE" != read-error ]] || return 1
      if [[ "$2" == workflowrecipe ]]; then
        cat "$TEST_ROOT/parent.json"
        return
      fi
      if [[ "$2" == deployment,service,configmap,networkpolicy ]]; then
        cat "$TEST_ROOT/children.json"
        return
      fi
      [[ -e "$TEST_ROOT/live.json" ]] || return 0
      if [[ " $* " == *' -o name '* ]]; then
        printf 'configmap/fixture\n'
      else
        cat "$TEST_ROOT/live.json"
      fi
      ;;
    delete)
      [[ "$2" == --raw && "$3" == /api/v1/namespaces/sandbox-recipes/configmaps/fixture ]] || return 1
      [[ "$4" == --request-timeout=30s && "$5" == -f ]] || return 1
      jq -e '.kind=="DeleteOptions" and .preconditions.uid=="created-uid"' "$6" >/dev/null || return 1
      [[ "$MODE" != delete-error ]] || return 1
      if [[ "$MODE" == recreate-race ]]; then
        jq '.metadata.uid="replacement-uid"' "$TEST_ROOT/live.json" > "$TEST_ROOT/replacement.json"
        mv "$TEST_ROOT/replacement.json" "$TEST_ROOT/live.json"
      fi
      # Simulate the API server's atomic precondition rather than allowing a
      # name-only delete to make the ownership-race contract vacuously green.
      [[ "$(jq -r .metadata.uid "$TEST_ROOT/live.json")" == "$(jq -r .preconditions.uid "$6")" ]] || return 1
      rm "$TEST_ROOT/live.json"
      ;;
    wait) [[ ! -e "$TEST_ROOT/live.json" ]] ;;
    *) return 1 ;;
  esac
}

create_fixture() {
  jq -n '{apiVersion:"v1",kind:"ConfigMap",metadata:{namespace:"sandbox-recipes",name:"fixture"},
    data:{message:"not retained in ownership evidence"}}' | wrc_create_owned
}

must_reject() {
  if "$@" > "$TEST_ROOT/rejected.out" 2>&1; then
    echo "Expected rejection: $*" >&2
    exit 1
  fi
}

reset_fixture
create_fixture
jq -e '.metadata.uid=="created-uid" and .metadata.labels["e2e.clerum.io/run"]=="contract123" and (has("data")|not)' \
  "$WRC_FIXTURE_LEDGER" >/dev/null
must_reject create_fixture
[[ "$(wc -l < "$WRC_FIXTURE_LEDGER" | tr -d ' ')" == 1 ]]
[[ "$(jq -r .metadata.uid "$TEST_ROOT/live.json")" == created-uid ]]
echo 'PASS: collision preserves prior object and does not enroll it twice'

MODE=read-error
must_reject wrc_delete_owned sandbox-recipes ConfigMap fixture
[[ "$(rg -c '^delete ' "$TEST_ROOT/calls" || true)" == '' ]]
MODE=normal
jq '.metadata.uid="replacement-uid"' "$TEST_ROOT/live.json" > "$TEST_ROOT/replacement.json"
mv "$TEST_ROOT/replacement.json" "$TEST_ROOT/live.json"
must_reject wrc_delete_owned sandbox-recipes ConfigMap fixture
[[ "$(rg -c '^delete ' "$TEST_ROOT/calls" || true)" == '' ]]
echo 'PASS: read errors and changed UID refuse deletion'

reset_fixture
create_fixture
jq '.metadata.labels["e2e.clerum.io/run"]="foreign"' "$TEST_ROOT/live.json" > "$TEST_ROOT/replacement.json"
mv "$TEST_ROOT/replacement.json" "$TEST_ROOT/live.json"
must_reject wrc_delete_owned sandbox-recipes ConfigMap fixture
[[ -e "$TEST_ROOT/live.json" ]]
echo 'PASS: changed ownership label refuses deletion'

reset_fixture
create_fixture
jq '.metadata.labels["controller-added"]="retained"' "$TEST_ROOT/live.json" > "$TEST_ROOT/replacement.json"
mv "$TEST_ROOT/replacement.json" "$TEST_ROOT/live.json"
wrc_delete_owned sandbox-recipes ConfigMap fixture
[[ ! -e "$TEST_ROOT/live.json" ]]
echo 'PASS: extra controller labels accepted; DELETE carries exact UID and proves absence'

reset_fixture
create_fixture
MODE=recreate-race
must_reject wrc_delete_owned sandbox-recipes ConfigMap fixture
[[ "$(jq -r .metadata.uid "$TEST_ROOT/live.json")" == replacement-uid ]]
echo 'PASS: API UID precondition preserves concurrent replacement'

reset_fixture
create_fixture
MODE=delete-error
must_reject wrc_cleanup_owned
[[ -e "$TEST_ROOT/live.json" ]]
echo 'PASS: cleanup failure is nonzero and leaves evidence'

reset_fixture
# Only owner UID, complete cross-namespace recipe binding, or WRC's exact
# same-namespace managed recipe label can enroll a generated child.
jq -n '{items:[
  {apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",metadata:{name:"ownerless",namespace:"sandbox-recipes",uid:"child1",labels:{"clerum.io/managed-by":"workflow-recipes","clerum.io/recipe":"fixture"}}},
  {apiVersion:"v1",kind:"Service",metadata:{name:"cross-ns",namespace:"sandbox-ui",uid:"child2",labels:{"clerum.io/recipe-namespace":"sandbox-recipes","clerum.io/recipe-name":"fixture"}}},
  {apiVersion:"apps/v1",kind:"Deployment",metadata:{name:"owned",namespace:"sandbox-recipes",uid:"child3",ownerReferences:[{uid:"recipe-uid"}]}},
  {apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",metadata:{name:"foreign",namespace:"sandbox-recipes",uid:"foreign1",labels:{"clerum.io/managed-by":"workflow-recipes","clerum.io/recipe":"another"}}},
  {apiVersion:"v1",kind:"Service",metadata:{name:"foreign-ns",namespace:"sandbox-ui",uid:"foreign2",labels:{"clerum.io/recipe-namespace":"other-namespace","clerum.io/recipe-name":"fixture"}}}
]}' > "$TEST_ROOT/children.json"
jq -n '{apiVersion:"clerum.io/v1alpha1",kind:"WorkflowRecipe",metadata:{name:"fixture",namespace:"sandbox-recipes",uid:"recipe-uid",labels:{"e2e.clerum.io/run":"contract123"}}}' > "$TEST_ROOT/parent.json"
wrc_record_owned < "$TEST_ROOT/parent.json"
wrc_capture_recipe_children sandbox-recipes fixture recipe-uid
jq -se 'map(select(.kind!="WorkflowRecipe")|.metadata.name)|unique|sort == ["cross-ns","owned","ownerless"]' "$WRC_FIXTURE_LEDGER" >/dev/null
echo 'PASS: generated ownerless/cross-namespace children captured without foreign resources'

# Validate rejected IDs before any fixture directory or cluster operation.
wrc_require_networkpolicy_lease() { return 0; }
for invalid in 'UPPER' 'contains-dash' '../escape' '1234567890123'; do
  E2E_RUN_ID="$invalid" must_reject wrc_fixture_init
done
echo 'PASS: invalid run IDs fail without lossy normalization'

printf 'Forwarding from 127.0.0.1:38123 -> 8080\n' > "$TEST_ROOT/port-forward.log"
[[ "$(wrc_port_forward_reported_port 8080)" == 38123 ]]
must_reject wrc_port_forward_reported_port 8090
printf 'Forwarding from [::1]:38123 -> 8080\n' > "$TEST_ROOT/port-forward.log"
must_reject wrc_port_forward_reported_port 8080
printf 'Forwarding from 127.0.0.1:70000 -> 8080\n' > "$TEST_ROOT/port-forward.log"
must_reject wrc_port_forward_reported_port 8080
printf 'Forwarding from 127.0.0.1:38123 -> 8080\nForwarding from 127.0.0.1:39123 -> 8080\n' > "$TEST_ROOT/port-forward.log"
must_reject wrc_port_forward_reported_port 8080
echo 'PASS: dynamic binding comes only from one valid matching IPv4 child report'

# These process doubles exercise fail-closed cleanup without launching a
# process, touching user forwards, or relying on machine-specific ps output.
WRC_PORT_FORWARD_PID=99999
WRC_PORT_FORWARD_START=original
WRC_PORT_FORWARD_COMMAND='kubectl --context=owned -n sandbox-recipes port-forward --address=127.0.0.1 svc/fixture :8080'
PROCESS_STATE=live
PROCESS_START=original
PROCESS_COMMAND="$WRC_PORT_FORWARD_COMMAND"
SIGNALLED=0
pf_owner_write_record_atomic "$TEST_ROOT/port-forward.pid" "$WRC_PORT_FORWARD_PID" \
  "$WRC_PORT_FORWARD_START" owned owned "$ROOT" sandbox-recipes fixture 38123 8080
pf_owner_process_state() { printf '%s\n' "$PROCESS_STATE"; }
pf_owner_process_start() { printf '%s\n' "$PROCESS_START"; }
pf_owner_process_command() { printf '%s\n' "$PROCESS_COMMAND"; }
pf_owner_signal_process() { SIGNALLED=$((SIGNALLED + 1)); PROCESS_STATE=dead; }
pf_owner_reap_process() { :; }
wrc_assert_port_forward
PROCESS_START=reused
must_reject wrc_stop_port_forward
[[ "$SIGNALLED" == 0 ]]
PROCESS_START=original
PROCESS_COMMAND='foreign process'
must_reject wrc_stop_port_forward
[[ "$SIGNALLED" == 0 ]]
PROCESS_COMMAND="$WRC_PORT_FORWARD_COMMAND"
PROCESS_STATE=dead
must_reject wrc_stop_port_forward
[[ "$SIGNALLED" == 0 ]]
PROCESS_STATE=live
wrc_stop_port_forward
[[ "$SIGNALLED" == 1 && -z "$WRC_PORT_FORWARD_PID" ]]
[[ ! -e "$TEST_ROOT/port-forward.pid" ]] || {
  echo 'FAIL: normal exit left the dead owned port-forward record' >&2
  exit 1
}
echo 'PASS: dead/reused/foreign forwards fail; exact live child is stopped and reaped'

WRC_PORT_FORWARD_PID=99999
SIGNALLED=0
pf_owner_write_record_atomic "$TEST_ROOT/port-forward.pid" "$WRC_PORT_FORWARD_PID" \
  "$WRC_PORT_FORWARD_START" owned owned "$ROOT" sandbox-recipes fixture 38123 8080
printf '0\n' > "$TEST_ROOT/process-reads"
pf_owner_process_state() {
  if [[ "$SIGNALLED" == 0 ]]; then
    printf 'live\n'
    return
  fi
  local reads
  reads="$(cat "$TEST_ROOT/process-reads")"
  printf '%s\n' "$((reads + 1))" > "$TEST_ROOT/process-reads"
  if [[ "$reads" -lt 2 ]]; then printf 'live\n'; else printf 'dead\n'; fi
}
pf_owner_process_start() {
  # Model death between the post-TERM state check and the identity read.
  [[ "$SIGNALLED" == 0 ]] || return 1
  printf '%s\n' "$PROCESS_START"
}
wrc_stop_port_forward
[[ "$SIGNALLED" == 1 && -z "$WRC_PORT_FORWARD_PID" && ! -e "$TEST_ROOT/port-forward.pid" ]]
echo 'PASS: death during post-TERM identity read also removes the owned record'

WRC_PORT_FORWARD_PID=99999
pf_owner_write_record_atomic "$TEST_ROOT/port-forward.pid" 99998 original \
  owned owned "$ROOT" sandbox-recipes fixture 38123 8080
must_reject wrc_reap_port_forward
[[ -e "$TEST_ROOT/port-forward.pid" && "$WRC_PORT_FORWARD_PID" == 99999 ]]
rm "$TEST_ROOT/port-forward.pid"
pf_owner_write_record_atomic "$TEST_ROOT/port-forward.pid" 99999 foreign-start \
  owned owned "$ROOT" sandbox-recipes fixture 38123 8080
must_reject wrc_reap_port_forward
[[ -e "$TEST_ROOT/port-forward.pid" && "$WRC_PORT_FORWARD_PID" == 99999 ]]
echo 'PASS: cleanup preserves records with a different PID or process start'

echo 'WRC_FIXTURES_CONTRACT_PASS'
