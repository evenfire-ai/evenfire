#!/usr/bin/env bash
# Branch-owned live gate for #825: one storage layout across lifecycle switches.
#
# Every Host mounts its workspace PVC root at the workspace path and keeps its
# conversation database there (CLERUM_SESSION_DB_DIR=<workspacePath>), whatever
# its lifecycle. A `workspace-layout-merge` init container moves a PVC split by
# the earlier stateless template back to the root before mcp-host starts.
#
# Each scenario creates its own Hosts through the control-api admin API and
# changes them only through that API. The trap deletes them. Named fixtures
# (logged as FAULT:<name>) are the only other cluster writes:
#   - hcc-cadence: shortens the HCC idle window so stateless Hosts suspend in
#     about a minute (opt-in E2E_ALLOW_STATELESS_CADENCE_ACCELERATION=1),
#     restored in the trap;
#   - pvc-fixture: a short-lived Pod (the Host image, uid 1001, no token) that
#     mounts a Host PVC to list it or, on a suspended Host, to seed a tree;
#   - channel: a CommunicationChannel CR that makes HCC run a stateless Host
#     as stateful;
#   - host-layout-merge: S5 and S6 run deploy/scripts/host-layout-merge.sh,
#     whose check Pods mount Host PVCs read-only and are deleted afterwards.
# No kubectl exec into Host Pods, no SQLite writes, no apply/patch of Hosts or
# their Deployments.
#
# Scenarios: S1-S7 (plan A7.10), RACE (A7.13), NEG_RV (stale resourceVersion),
# NEG_CTRL (the history and chatId-set oracles reject an empty catalog). After
# every transition the Host must list the same non-empty chatId set as before
# it and open the same database (its "[ConversationStore] opened" log line);
# each check prints E2E_825_CONTINUITY. The final line is
# E2E_825_RESULT=PASS only when every defined scenario ran and passed.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/e2e/load-dotenv.sh
source "${REPO_ROOT}/scripts/e2e/load-dotenv.sh"
dotenv_load_canonical_root "${REPO_ROOT}"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "${REPO_ROOT}/scripts/e2e/admin-credentials.sh"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"

die() { fail "$*"; exit 1; }

# ─── Preconditions ────────────────────────────────────────────────────
if [ -z "$E2E_KUBECONTEXT" ] || ! is_branch_scoped_e2e_context "$E2E_KUBECONTEXT"; then
  die 'select an explicit branch-scoped Minikube context (KUBECONTEXT=<profile>)'
fi
require_safe_kube_context
[ "${E2E_ALLOW_STATELESS_CADENCE_ACCELERATION:-0}" = 1 ] ||
  die 'set E2E_ALLOW_STATELESS_CADENCE_ACCELERATION=1 (S4-S7 shorten the HCC idle window on this owned profile)'
[ -n "${E2E_PROFILE_PORTS_ENV:-}" ] && [ -r "$E2E_PROFILE_PORTS_ENV" ] ||
  die 'provide E2E_PROFILE_PORTS_ENV from the owned branch profile'
[ -n "${E2E_DEV_LOGIN_EMAIL:-}" ] || die 'set E2E_DEV_LOGIN_EMAIL to the seeded login (admin@evenfire.local on a T2 profile)'
profile_port_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$E2E_PROFILE_PORTS_ENV"
}
CONTROL_API_BASE_URL="$(profile_port_value CONTROL_API_URL)"
CONTROL_UI_BASE_URL="$(profile_port_value CONTROL_UI_URL)"
EXTERNAL_REST_API_BASE_URL="$(profile_port_value EXTERNAL_REST_API_URL)"
RPC_PROXY_BASE_URL="$(profile_port_value RPC_PROXY_URL)"
export CONTROL_API_BASE_URL CONTROL_UI_BASE_URL EXTERNAL_REST_API_BASE_URL RPC_PROXY_BASE_URL
require_branch_profile_urls "$E2E_KUBECONTEXT" "$E2E_PROFILE_PORTS_ENV" ||
  die 'profile URLs do not match the owned ports'
kctl get nodes -o json | jq -e --arg c "$E2E_KUBECONTEXT" \
  'any(.items[]; .metadata.labels["minikube.k8s.io/name"]==$c)' >/dev/null ||
  die 'target is not the selected Minikube profile'

HOST_NS=mcp-host CHANNEL_NS=channels
HCC_NS=control-plane HCC_DEPLOY=host-context-controller
SOURCE_HOST="${E2E_SOURCE_HOST_REF:-chatllm}"
CAPI="${CONTROL_API_BASE_URL%/}/api/v1"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL%/}"
RPC_BASE="${RPC_PROXY_BASE_URL%/}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
[ -n "$ADMIN_PASSWORD" ] || ADMIN_PASSWORD="$(e2e_resolve_admin_password "$REPO_ROOT" || true)"
[ -n "$ADMIN_PASSWORD" ] || die 'admin password could not be resolved (ADMIN_PASSWORD or the canonical .env)'
DEV_EMAIL="$E2E_DEV_LOGIN_EMAIL"
DEV_PASSWORD="${E2E_USER_PASSWORD:-$ADMIN_PASSWORD}"
# od reads a fixed byte count; `tr </dev/urandom | head` dies of SIGPIPE under pipefail.
RUN="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
POD_READY_TIMEOUT="${E2E_825_POD_READY_TIMEOUT:-300}"
SUSPEND_TIMEOUT="${E2E_825_SUSPEND_TIMEOUT:-300}"
TURN_TIMEOUT="${E2E_825_TURN_TIMEOUT:-240}"
STORE_LOG_TIMEOUT="${E2E_825_STORE_LOG_TIMEOUT:-30}"
BASE_INIT_FIXTURE="${REPO_ROOT}/host-context-controller/test/__fixtures__/base-workspace-layout-init.sh"
[ -r "$BASE_INIT_FIXTURE" ] || die "missing base init fixture ${BASE_INIT_FIXTURE}"
LAYOUT_SCRIPT="${REPO_ROOT}/deploy/scripts/host-layout-merge.sh"
[ -r "$LAYOUT_SCRIPT" ] || die "missing operator script ${LAYOUT_SCRIPT}"

DEFINED_SCENARIOS=(NEG_CTRL NEG_RV S1 S2 S3 RACE S4 S5 S6 S7)
EXECUTED=0 SCENARIO_FAILURES=0 SCENARIO_LOG=''
CREATED_HOSTS=() CREATED_CHANNELS=()
HCC_ENV_SAVED='' HCC_ENV_CHANGED=0
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/e2e-825.XXXXXX")"
FIXTURE_POD_REGISTRY="${SCRATCH}/fixture-pods"
: >"$FIXTURE_POD_REGISTRY"
ADMIN_COOKIE='' SESSION_TOKEN='' RPC_TOKEN='' USER_ID='' TEAM_ID=''
HTTP_CODE='' HTTP_BODY='' HTTP_HEADERS=()

# shellcheck source=scripts/e2e/e2e-825-lib.sh
source "${SCRIPT_DIR}/e2e-825-lib.sh"

# switch_and_witness NAME STATELESS: request the switch, then require a new
# Pod with the requested lifecycle and the same storage as before.
switch_and_witness() {
  local name=$1 stateless=$2 old=$POD_UID
  set_lifecycle "$name" "$stateless" || return 1
  wait_new_ready_pod "$name" "$old" "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" "$stateless" /workspace
}

# The inventoried dev split shape: DB family and a backup under state/, every
# other root entry under workspace/, plus an agent-made symlink (A7.16).
# shellcheck disable=SC2016
SEED_SPLIT_SCRIPT='set -eu; cd "$1"; mkdir state workspace
for e in * .[!.]*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  case "$e" in lost+found|state|workspace) continue ;; state.db*) mv "$e" state/ ;; *) mv "$e" workspace/ ;; esac
done
cp state/state.db state/state.db.pre-20261014.bak
ln -s /tmp/e2e-825-link-target workspace/e2e-825-link
ls -la state workspace'
# Two live database families: the root one and a copy under state/ (F2),
# with workspace/ present so the tree carries the split-layout signature and
# a file under each directory the merge would move.
# shellcheck disable=SC2016
SEED_TWO_DB_SCRIPT='set -eu; cd "$1"; mkdir state workspace; [ -f state.db ]
for s in "" -wal -shm; do [ -e "state.db$s" ] || continue; cp "state.db$s" "workspace/state.db$s"; mv "state.db$s" "state/state.db$s"; done
printf "notes\n" > state/notes.txt; printf "x\n" > workspace/x; ls -la . state workspace'

# A new stateless Host with history, a seeded file, then suspended.
suspended_host_with_history() { # NAME
  create_host "$1" true || return 1
  wait_new_ready_pod "$1" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$1" true /workspace || return 1
  seed_history "$1" 2 1 || return 1
  pvc_fixture "$1" rw seed-file "$WRITE_FILE_SCRIPT" "seed ${RUN}" seed.txt >/dev/null || return 1
  wait_suspended "$1"
}

# ─── Scenarios ────────────────────────────────────────────────────────
scenario_NEG_CTRL() {
  local digest set_a empty='{"agent":"x","chatId":"y","totalTurns":0,"turns":[]}'
  local real='{"turns":[{"number":1,"user_input":"a","response":"b"}]}'
  digest="$(history_digest "$real")"
  history_matches "$digest" "$real" || { fail 'NEG_CTRL witness: the oracle rejects a matching history'; return 1; }
  if history_matches "$digest" "$empty"; then fail 'NEG_CTRL: the history oracle accepts an empty catalog'; return 1; fi
  if history_matches "0 $(jq -cS '[]' <<<'null' | shasum -a 256 | cut -d' ' -f1)" "$empty"; then
    fail 'NEG_CTRL: the history oracle accepts zero turns as a match'
    return 1
  fi
  session_listed '{"items":[{"agent":"h","chatId":"t"}]}' h t || { fail 'NEG_CTRL witness: list oracle rejects a listed session'; return 1; }
  if session_listed '{"items":[]}' h t; then fail 'NEG_CTRL: the list oracle accepts an empty catalog'; return 1; fi
  set_a="$(chat_set '{"items":[{"agent":"h","chatId":"b"},{"agent":"h","chatId":"a"},{"agent":"x","chatId":"c"}]}' h)"
  [ "$set_a" = '2:a,b' ] || { fail "NEG_CTRL witness: chat_set returned '${set_a}', expected '2:a,b'"; return 1; }
  chats_match "$set_a" "$set_a" || { fail 'NEG_CTRL witness: the set oracle rejects an equal set'; return 1; }
  if chats_match "$set_a" "$(chat_set '{"items":[{"agent":"h","chatId":"a"}]}' h)"; then
    fail 'NEG_CTRL: the set oracle accepts a lost chat'
    return 1
  fi
  if chats_match "$(chat_set '{"items":[]}' h)" "$(chat_set '{"items":[]}' h)"; then
    fail 'NEG_CTRL: the set oracle accepts an empty set on both sides'
    return 1
  fi
  ok 'NEG_CTRL: oracles reject an empty catalog, a lost chat and empty-on-both-sides, and accept a real one'
}

scenario_NEG_RV() {
  local name rv1 spec
  name="$(truncate_rfc1123 "e2e-825-rv-${RUN}")"
  create_host "$name" false || return 1
  admin GET "${CAPI}/admin/hosts/${name}" || true
  [ "$HTTP_CODE" = 200 ] || { fail "NEG_RV: GET returned ${HTTP_CODE}"; return 1; }
  rv1="$(jq -r '.metadata.resourceVersion' <<<"$HTTP_BODY")"
  spec="$(jq -c '.spec | .lifecycle = {stateless:true}' <<<"$HTTP_BODY")"
  admin PUT "${CAPI}/admin/hosts/${name}" "$(jq -cn --arg rv "$rv1" --argjson s "$spec" '{metadata:{resourceVersion:$rv},spec:$s}')" || true
  [ "$HTTP_CODE" = 200 ] || { fail "NEG_RV witness: fresh PUT returned ${HTTP_CODE}"; return 1; }
  spec="$(jq -c '.lifecycle = {stateless:false}' <<<"$spec")"
  admin PUT "${CAPI}/admin/hosts/${name}" "$(jq -cn --arg rv "$rv1" --argjson s "$spec" '{metadata:{resourceVersion:$rv},spec:$s}')" || true
  if [ "$HTTP_CODE" != 409 ] || ! jq -e '.reason == "resource_changed"' <<<"$HTTP_BODY" >/dev/null; then
    fail "NEG_RV: stale PUT returned ${HTTP_CODE}: ${HTTP_BODY}"
    return 1
  fi
  [ "$(kctl get host "$name" -n "$HOST_NS" -o jsonpath='{.spec.lifecycle.stateless}')" = true ] ||
    { fail 'NEG_RV: the stale PUT changed the lifecycle'; return 1; }
  ok 'NEG_RV: stale resourceVersion → 409 resource_changed, lifecycle unchanged; fresh PUT applied'
}

# S1: stateful → stateless → stateful, 3 conversations x 2 turns, a file.
scenario_S1() {
  local name
  name="$(truncate_rfc1123 "e2e-825-s1-${RUN}")"
  create_host "$name" false || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" false /workspace || return 1
  seed_history "$name" 3 2 || return 1
  pvc_fixture "$name" rw seed-file "$WRITE_FILE_SCRIPT" "s1 ${RUN}" seed.txt >/dev/null || return 1
  switch_and_witness "$name" true || return 1
  assert_history "$name" 'stateful->stateless' || return 1
  read_seed_file "$name" seed.txt "s1 ${RUN}" || return 1
  switch_and_witness "$name" false || return 1
  assert_history "$name" 'stateless->stateful' || return 1
  read_seed_file "$name" seed.txt "s1 ${RUN}"
}

# S2: created stateless → stateful → stateless.
scenario_S2() {
  local name
  name="$(truncate_rfc1123 "e2e-825-s2-${RUN}")"
  create_host "$name" true || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  seed_history "$name" 2 2 || return 1
  switch_and_witness "$name" false || return 1
  assert_history "$name" 'stateless->stateful' || return 1
  switch_and_witness "$name" true || return 1
  assert_history "$name" 'stateful->stateless'
}

# S3: a CommunicationChannel makes HCC run the stateless Host as stateful;
# deleting it returns the Host to stateless.
scenario_S3() {
  local name channel old reason elapsed=0
  name="$(truncate_rfc1123 "e2e-825-s3-${RUN}")"
  channel="$(truncate_rfc1123 "e2e-825-s3-${RUN}")"
  create_host "$name" true || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  seed_history "$name" 2 1 || return 1
  log "FAULT:channel ${CHANNEL_NS}/${channel} → ${name}"
  printf '%s\n' 'apiVersion: clerum.io/v1alpha1' 'kind: CommunicationChannel' 'metadata:' \
    "  name: ${channel}" "  namespace: ${CHANNEL_NS}" 'spec:' "  hostRef: ${name}" '  telegram:' \
    "    - channelId: \"e2e-825-${RUN}\"" '      chatType: "private"' '      userIds: ["000000000"]' |
    kctl create -f - >/dev/null || { fail 'S3: CommunicationChannel create failed'; return 1; }
  CREATED_CHANNELS+=("$channel")
  old=$POD_UID
  wait_new_ready_pod "$name" "$old" "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" false /workspace || return 1
  reason="$(kctl get host "$name" -n "$HOST_NS" -o jsonpath='{.status.conditions[?(@.type=="StatelessEnableRejected")].status}')"
  [ "$reason" = True ] || { fail "S3: StatelessEnableRejected is '${reason}', expected True"; return 1; }
  assert_history "$name" 'stateless->stateful(channel)' || return 1
  kctl delete communicationchannel "$channel" -n "$CHANNEL_NS" --wait=true --timeout=60s >/dev/null ||
    { fail 'S3: CommunicationChannel delete failed'; return 1; }
  old=$POD_UID
  wait_new_ready_pod "$name" "$old" "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  assert_history "$name" 'stateful->stateless(channel-deleted)'
}

# S4: switch to stateful while suspended, then back to stateless (history
# checked on the active Pod), suspend and wake.
scenario_S4() {
  local name
  name="$(truncate_rfc1123 "e2e-825-s4-${RUN}")"
  suspended_host_with_history "$name" || return 1
  switch_and_witness "$name" false || return 1
  assert_history "$name" 'suspended->stateful' || return 1
  read_seed_file "$name" seed.txt "seed ${RUN}" || return 1
  switch_and_witness "$name" true || return 1
  # The active stateless Pod between the switch and the suspend serves the
  # same history too, not only the Pod that wakes afterwards.
  assert_history "$name" 'stateful->stateless(active)' || return 1
  wait_suspended "$name" || return 1
  post_wake "$name" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  assert_history "$name" 'stateless-suspend->wake'
}

# S5: the inventoried split tree (state/ with a backup, workspace/ with a
# symlink) merges on wake; history, file, backup and link at the root.
scenario_S5() {
  local name listing row
  name="$(truncate_rfc1123 "e2e-825-s5-${RUN}")"
  suspended_host_with_history "$name" || return 1
  pvc_fixture "$name" rw seed-split "$SEED_SPLIT_SCRIPT" >/dev/null || return 1
  listing="$(pvc_fixture "$name" ro list-split "$LIST_SCRIPT")" || return 1
  if ! grep -qx 'd ./state' <<<"$listing" || ! grep -qx 'f ./state/state.db'<<<"$listing"; then
    fail "S5: seeded tree is not split: ${listing}"
    return 1
  fi
  row="$(layout_row inventory "$name" '0 1')" || return 1
  [ "$row" = WILL_MERGE ] || { fail "S5: inventory reads ${name}-workspace as '${row}', expected WILL_MERGE"; return 1; }
  # A split tree is a blocker for turning the flag off, whatever the rest of the fleet.
  row="$(layout_row verify "$name" 1)" || return 1
  [ "$row" = SPLIT ] || { fail "S5: verify reads ${name}-workspace as '${row}', expected SPLIT"; return 1; }
  ok "S5: host-layout-merge.sh reads the seeded tree as WILL_MERGE (inventory) and SPLIT (verify)"
  post_wake "$name" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  listing="$(pvc_fixture "$name" ro list-merged "$LIST_SCRIPT")" || return 1
  if grep -Eq '^d \./(state|workspace)$' <<<"$listing"; then fail "S5: split directories remain: ${listing}"; return 1; fi
  if ! grep -qx 'f ./state.db'<<<"$listing" ||
    ! grep -qx 'f ./state.db.pre-20261014.bak'<<<"$listing" ||
    ! grep -qx 'l ./e2e-825-link /tmp/e2e-825-link-target' <<<"$listing"; then
    fail "S5: merged tree lacks the database, backup or link at the root: ${listing}"
    return 1
  fi
  ok "S5: split tree merged to the root"
  row="$(layout_row verify "$name" '0 1')" || return 1
  [ "$row" = POD_OK ] || { fail "S5: verify reads ${name}-workspace as '${row}' after the merge, expected POD_OK"; return 1; }
  ok "S5: host-layout-merge.sh verify reads the merged Host as POD_OK"
  assert_history "$name" 'suspend->wake(split-tree-merged)' || return 1
  read_seed_file "$name" seed.txt "seed ${RUN}"
}

# S6: two live database families, under state/ and workspace/ with none at
# the root (a T5 tree with a root database is superseded, not refused): the
# merge refuses, the Pod stays in Init:Error and the tree is unchanged.
scenario_S6() {
  local name before after list_before list_after elapsed=0 pod logs row
  local f2='workspace layout merge refused: more than one live SQLite database across'
  name="$(truncate_rfc1123 "e2e-825-s6-${RUN}")"
  suspended_host_with_history "$name" || return 1
  pvc_fixture "$name" rw seed-two-db "$SEED_TWO_DB_SCRIPT" >/dev/null || return 1
  before="$(pvc_fixture "$name" ro hash-before "$HASH_SCRIPT")" || return 1
  list_before="$(pvc_fixture "$name" ro list-before "$LIST_SCRIPT")" || return 1
  grep -q ' ./state/state.db$' <<<"$before" || { fail "S6 witness: state/state.db not seeded: ${before}"; return 1; }
  grep -q ' ./workspace/state.db$' <<<"$before" || { fail "S6 witness: workspace/state.db not seeded: ${before}"; return 1; }
  ! grep -qx 'f ./state.db' <<<"$list_before" || { fail "S6 witness: a root state.db remains: ${list_before}"; return 1; }
  if ! grep -qx 'f ./state/notes.txt' <<<"$list_before" || ! grep -qx 'f ./workspace/x' <<<"$list_before"; then
    fail "S6 witness: state/notes.txt or workspace/x not seeded: ${list_before}"
    return 1
  fi
  # inventory must name the seeded tree as an upgrade blocker before the merge
  # runs. Its
  # check Pod runs between the two hashes, so the comparison below also
  # proves it changed nothing.
  row="$(layout_row inventory "$name" 1)" || return 1
  case "$row" in "WILL_REFUSE_F2 ${f2}"*) ;; *) fail "S6: inventory reads ${name}-workspace as '${row}', expected WILL_REFUSE_F2"; return 1 ;; esac
  ok "S6: host-layout-merge.sh inventory predicts the F2 refusal"
  post_wake "$name" || return 1
  while [ "$elapsed" -lt "$POD_READY_TIMEOUT" ]; do
    pod="$(host_pods "$name" | jq -r '[.items[] | select(any(.status.initContainerStatuses[]?;
      .name == "workspace-layout-merge" and ((.state.terminated.exitCode // 0) == 1 or (.lastState.terminated.exitCode // 0) == 1)))][0].metadata.name // ""')"
    [ -n "$pod" ] && break
    sleep 3
    elapsed=$((elapsed + 3))
  done
  [ -n "$pod" ] || { fail "S6: no Pod with workspace-layout-merge exit 1 within ${POD_READY_TIMEOUT}s"; return 1; }
  logs="$(kctl logs "$pod" -n "$HOST_NS" -c workspace-layout-merge --previous 2>/dev/null ||
    kctl logs "$pod" -n "$HOST_NS" -c workspace-layout-merge)"
  grep -q "$f2" <<<"$logs" || { fail "S6: merge refused without the F2 line: ${logs}"; return 1; }
  row="$(layout_row verify "$name" 1)" || return 1
  case "$row" in "MERGE_REFUSED ${f2}"*) ;; *) fail "S6: verify reads ${name}-workspace as '${row}', expected MERGE_REFUSED with the F2 line"; return 1 ;; esac
  ok "S6: host-layout-merge.sh verify reports MERGE_REFUSED with the F2 line"
  if host_pods "$name" | jq -e 'any(.items[]; any(.status.conditions[]?; .type == "Ready" and .status == "True"))' >/dev/null; then
    fail 'S6: a Pod became Ready on a refused tree'
    return 1
  fi
  after="$(pvc_fixture "$name" ro hash-after "$HASH_SCRIPT")" || return 1
  [ "$before" = "$after" ] || { fail "S6: tree changed after the refusal"; diff <(echo "$before") <(echo "$after") >&2 || true; return 1; }
  list_after="$(pvc_fixture "$name" ro list-after "$LIST_SCRIPT")" || return 1
  [ "$list_before" = "$list_after" ] ||
    { fail "S6: tree layout changed after the refusal"; diff <(echo "$list_before") <(echo "$list_after") >&2 || true; return 1; }
  ok 'S6: two live families → Init:Error with the F2 line, tree unchanged'
}

# S7: a merged tree re-split by the previous init (an HCC rollback), then
# woken: the merge restores the root layout and the history.
scenario_S7() {
  local name before listing script
  name="$(truncate_rfc1123 "e2e-825-s7-${RUN}")"
  suspended_host_with_history "$name" || return 1
  before="$(pvc_fixture "$name" ro list-before "$LIST_SCRIPT")" || return 1
  script="$(cat "$BASE_INIT_FIXTURE")"
  pvc_fixture "$name" rw base-init "$script" >/dev/null || return 1
  listing="$(pvc_fixture "$name" ro list-split "$LIST_SCRIPT")" || return 1
  if ! grep -qx 'd ./state' <<<"$listing" || ! grep -qx 'd ./workspace' <<<"$listing"; then
    fail "S7: the previous init did not split the tree: ${listing}"
    return 1
  fi
  post_wake "$name" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" true /workspace || return 1
  listing="$(pvc_fixture "$name" ro list-after "$LIST_SCRIPT")" || return 1
  # Only the live writer's journals may differ: the suspended Host closed its
  # database (no -wal/-shm), the woken one holds it open. state.db itself and
  # any state.db*.bak must match, so a lost or extra backup fails here.
  grep -qx 'f ./state.db' <<<"$listing" || { fail "S7: no state.db at the PVC root after the merge: ${listing}"; return 1; }
  [ "$(grep -vxE 'f \./state\.db-(wal|shm)' <<<"$before")" = "$(grep -vxE 'f \./state\.db-(wal|shm)' <<<"$listing")" ] ||
    { fail 'S7: root entries differ from the tree before the re-split'; diff <(echo "$before") <(echo "$listing") >&2 || true; return 1; }
  ok 'S7: re-split tree merged back to the same root entries'
  assert_history "$name" 'suspend->wake(re-split-tree-merged)' || return 1
  read_seed_file "$name" seed.txt "seed ${RUN}"
}

# RACE: concurrent model selections on new chats create one session each and
# never restart the Host (A7.13).
race_host() { # NAME STATELESS
  local name=$1 stateless=$2 model uid restarts round i chat codes pids pods rpc_header
  create_host "$name" "$stateless" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  assert_pod "$name" "$stateless" /workspace || return 1
  uid=$POD_UID
  restarts="$(jq -r '[.status.containerStatuses[] | select(.name == "mcp-host") | .restartCount] | first' <<<"$POD_JSON")"
  rpc GET "${RPC_BASE}/api/v1/rpc/hosts/${name}/models" || true
  model="$(jq -er '.hostDefault' <<<"$HTTP_BODY")" || { fail "${name}: models returned ${HTTP_CODE}: ${HTTP_BODY}"; return 1; }
  rpc_header="$(auth_header rpc "Authorization: Bearer ${RPC_TOKEN}")"
  for round in 1 2 3 4 5; do
    chat="e2e-825-race-${RUN}-${round}"
    pids=()
    for i in 1 2 3 4; do
      curl -sS -m 60 -o /dev/null -w '%{http_code}\n' -X POST "${RPC_BASE}/api/v1/rpc/hosts/${name}/model" \
        -H "@${rpc_header}" -H 'Content-Type: application/json' \
        -d "$(jq -cn --arg c "$chat" --arg m "$model" '{chatId:$c,model:$m}')" >"${SCRATCH}/race-${round}-${i}" &
      pids+=("$!")
    done
    for i in "${pids[@]}"; do wait "$i" || true; done
    codes="$(cat "${SCRATCH}"/race-"${round}"-* | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
    [ "$(cat "${SCRATCH}"/race-"${round}"-* | grep -cx 200)" = 4 ] ||
      { fail "${name}: round ${round} model selections returned ${codes}"; return 1; }
    send_turn "$name" "$chat" "e2e-825 ${RUN} race ${round}: reply with one short sentence." || return 1
    rpc GET "${RPC_BASE}/api/v1/rpc/hosts/${name}/sessions?agent=${name}&limit=100" || true
    session_listed "$HTTP_BODY" "$name" "$chat" || { fail "${name}: round ${round} chat not listed exactly once"; return 1; }
  done
  # The original Pod must be the only Pod, not terminating: a replacement
  # leaves the old Pod Terminating next to a new one, and items[0] could be
  # either of them.
  pods="$(host_pods "$name")" || { fail "${name}: could not list Pods after the race"; return 1; }
  POD_JSON="$(jq -c --arg uid "$uid" '[.items[] | select(.metadata.uid == $uid and .metadata.deletionTimestamp == null)] | first // empty' <<<"$pods")"
  [ "$(jq '.items | length' <<<"$pods")" = 1 ] && [ -n "$POD_JSON" ] &&
    [ "$(jq -r '[.status.containerStatuses[] | select(.name == "mcp-host") | .restartCount] | first' <<<"$POD_JSON")" = "$restarts" ] ||
    { fail "${name}: the Pod restarted or was replaced during the race: $(jq -c '[.items[] | {uid: .metadata.uid, deleting: (.metadata.deletionTimestamp != null)}]' <<<"$pods")"; return 1; }
  ok "${name}: 5 rounds x 4 concurrent selections, one session per chat, Pod ${uid:0:8} restartCount ${restarts}"
}
scenario_RACE() {
  race_host "$(truncate_rfc1123 "e2e-825-race-sf-${RUN}")" false || return 1
  race_host "$(truncate_rfc1123 "e2e-825-race-sl-${RUN}")" true
}

run_scenario() {
  local id=$1
  header "Scenario ${id}"
  EXECUTED=$((EXECUTED + 1))
  if "scenario_${id}"; then
    ok "SCENARIO ${id} PASS"
    SCENARIO_LOG+="${id}=PASS "
  else
    fail "SCENARIO ${id} FAIL"
    SCENARIO_LOG+="${id}=FAIL "
    SCENARIO_FAILURES=$((SCENARIO_FAILURES + 1))
  fi
}

# ─── Cleanup ──────────────────────────────────────────────────────────
cleanup() {
  local status=$? failed=0 name pod channel
  # bash 3.2 treats "${empty[@]}" as unbound under set -u.
  set +eu
  while IFS= read -r pod; do
    kctl delete pod "$pod" -n "$HOST_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done <"$FIXTURE_POD_REGISTRY"
  for channel in "${CREATED_CHANNELS[@]}"; do
    kctl delete communicationchannel "$channel" -n "$CHANNEL_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done
  restore_hcc_cadence || { failed=1; echo "HCC cadence restore failed; check deployment/${HCC_DEPLOY}" >&2; }
  for name in "${CREATED_HOSTS[@]}"; do
    admin DELETE "${CAPI}/admin/hosts/${name}" >/dev/null 2>&1
    case "$HTTP_CODE" in 200 | 404) ;; *) failed=1; echo "delete Host ${name} returned ${HTTP_CODE}" >&2 ;; esac
    [ -z "$USER_ID" ] || set_agent_grant "${CAPI}/admin/users/${USER_ID}/agents" "$name" remove >/dev/null 2>&1 || failed=1
    [ -z "$TEAM_ID" ] || set_agent_grant "${CAPI}/admin/teams/${TEAM_ID}/agents" "$name" remove >/dev/null 2>&1 || failed=1
  done
  for name in "${CREATED_HOSTS[@]}"; do
    kctl wait --for=delete "deployment/${name}" -n "$HOST_NS" --timeout=120s >/dev/null 2>&1
    kctl delete pvc "${name}-workspace" -n "$HOST_NS" --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || failed=1
  done
  rm -rf "$SCRATCH"
  [ "$failed" = 0 ] || { status=1; fail 'cleanup left resources behind (see stderr)'; }
  echo "E2E_825_SCENARIOS ${SCENARIO_LOG}"
  echo "E2E_825_EXECUTED=${EXECUTED} E2E_825_DEFINED=${#DEFINED_SCENARIOS[@]}"
  print_results || status=1
  if [ "$status" = 0 ] && [ "$SCENARIO_FAILURES" = 0 ] && [ "$EXECUTED" = "${#DEFINED_SCENARIOS[@]}" ]; then
    echo 'E2E_825_RESULT=PASS'
  else
    echo 'E2E_825_RESULT=FAIL'
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

# ─── Run ──────────────────────────────────────────────────────────────
header "#825 storage layout across lifecycle switches (run ${RUN}, ${E2E_KUBECONTEXT})"
# S5-S7 need HCC to render workspace-layout-merge; its flag defaults to true
# when unset or empty (A7.24). A literal value is the only one checkable here.
MERGE_FLAG="$(kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" -o json | jq -r '
  [.spec.template.spec.containers[].env[]? | select(.name == "CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE")]
  | if length == 0 then "<unset>" elif .[0].valueFrom then "<valueFrom>" else (.[0].value // "") end')" ||
  die "could not read deployment/${HCC_DEPLOY}"
case "$MERGE_FLAG" in
  '<unset>' | '' | true) ok "HCC CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE=${MERGE_FLAG:-<empty>} (merge init rendered)" ;;
  *) die "HCC CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE is '${MERGE_FLAG}'; this E2E needs it unset, empty or 'true'" ;;
esac
SOURCE_HOST_JSON="$(kctl get host "$SOURCE_HOST" -n "$HOST_NS" -o json)" || die "source Host ${SOURCE_HOST} not found"
FIXTURE_IMAGE="$(kctl get deployment "$SOURCE_HOST" -n "$HOST_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="mcp-host")].image}')"
[ -n "$FIXTURE_IMAGE" ] || die "could not read the ${SOURCE_HOST} image for the PVC fixture"
admin_login || die 'admin login failed'
admin GET "${CAPI}/admin/users?q=$(jq -rn --arg q "$DEV_EMAIL" '$q|@uri')" || true
USER_ID="$(jq -r --arg e "$DEV_EMAIL" '.items[]? | select((.email // "") == $e) | .id' <<<"$HTTP_BODY" | head -n1)"
[ -n "$USER_ID" ] || die "user ${DEV_EMAIL} not found (${HTTP_CODE})"
admin GET "${CAPI}/admin/users/${USER_ID}/teams" || true
TEAM_ID="$(jq -r '.items[0].id // empty' <<<"$HTTP_BODY")"
user_login || die 'user login failed'
ok "logged in as ${DEV_EMAIL}; fixture image ${FIXTURE_IMAGE}"

for id in NEG_CTRL NEG_RV S1 S2 S3 RACE; do run_scenario "$id"; done
header 'Suspended-Host scenarios'
if set_hcc_cadence; then
  for id in S4 S5 S6 S7; do run_scenario "$id"; done
else
  fail 'hcc-cadence fixture failed; S4-S7 not executed'
fi
