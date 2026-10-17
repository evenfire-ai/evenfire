#!/usr/bin/env bash
# Branch-owned live lane for #825: upgrade an installation from v0.11.0 to this
# head and prove the Host PVC layout and history survive it (plan A7.40).
#
# Usage: e2e-hcc-layout-upgrade.sh main|control, each on a FRESH branch
# profile (no host-context-controller yet). The launcher deletes and recreates
# the profile between the two modes.
#
#   main     installs v0.11.0 (published images), seeds one Host per row, runs
#            deploy/scripts/host-layout-merge.sh inventory, upgrades to this
#            head with no manual step (the merge init supersedes the T5 split
#            database, plan A7.46; images
#            built from this tree, database kept), then checks verify and the
#            history of every row. Rows:
#              T1 stateful;
#              T2 stateless, active at the upgrade;
#              T3 stateless, suspended at the upgrade (woken afterwards);
#              T5 created stateless, used, switched to stateful by a
#                 CommunicationChannel and used again (root database plus the
#                 older state/ one, renamed by the merge init);
#              T6 stateless -> stateful -> stateless.
#            Prints E2E_UPGRADE_MAIN=PASS|FAIL and E2E_UPGRADE_HEAD=<sha>.
#   control  the negative control: CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE=false
#            in the upgrade deploy. inventory must report
#            FLAG_FALSE_WITH_SPLIT_TREES and the history check must fail on a
#            T2-shaped Host. Needs E2E_UPGRADE_MAIN_EVIDENCE (the main log of
#            the same HEAD). Prints E2E_UPGRADE_RESULT=PASS only when main
#            passed and the control failed as expected.
#
# Install path (plan A7.43): `git archive v0.11.0 deploy` into a scratch
# directory, then this head's `make minikube-setup IMAGE_SOURCE=ghcr
# MINIKUBE_IMAGE_TAG=v0.11.0` with BRANCH_PROFILE_DEPLOY_DIR pointing at it, so
# the manifests and images are the release's. v0.11.0's own full-setup.sh cannot
# run here: it requires a branch checkout with origin/dev as an ancestor. The
# setup applies this tree's CRDs, so the lane refuses unless they equal
# v0.11.0's apart from descriptions.
#
# Cluster writes besides the setups and the admin API: the named fixtures of
# e2e-hcc-storage-layout-switch.sh (hcc-cadence, pvc-fixture, channel,
# host-layout-merge) and, in control mode,
# FAULT:flag-false (kubectl set env on the HCC Deployment, undone in the
# trap). No kubectl exec into Host Pods, no SQLite reads or writes.
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

MODE="${1:-}"
case "$MODE" in main | control) ;; *) die 'usage: e2e-hcc-layout-upgrade.sh main|control' ;; esac

RELEASE=v0.11.0
# main_evidence_ok FILE HEAD: the main log passed on this same HEAD.
main_evidence_ok() {
  [ -r "$1" ] && grep -qx 'E2E_UPGRADE_MAIN=PASS' "$1" && grep -qx "E2E_UPGRADE_HEAD=$2" "$1"
}

# crd_schema REPO REF FILE: the CRD without its string-valued descriptions (a
# property named description is a map and stays).
crd_schema() {
  git -C "$1" show "$2:$3" |
    yq -o=json -I=0 'del(.. | select(tag == "!!map") | select(.description | tag == "!!str") | .description)'
}
# release_crds_match REPO RELEASE: HEAD has the release's CRD files, each equal
# to the release's apart from descriptions.
release_crds_match() {
  local repo=$1 release=$2 dir=charts/clerum-crds/crds file a b mismatched=''
  a="$(git -C "$repo" ls-tree --name-only "$release" "$dir/")" || { fail "cannot list ${dir} at ${release}"; return 1; }
  b="$(git -C "$repo" ls-tree --name-only HEAD "$dir/")" || { fail "cannot list ${dir} at HEAD"; return 1; }
  [ -n "$a" ] || { fail "no CRDs under ${dir} at ${release}"; return 1; }
  if [ "$a" != "$b" ]; then
    fail "CRD files differ from ${release}: $(diff <(echo "$a") <(echo "$b") | grep '^[<>]' | tr '\n' ' ')"
    return 1
  fi
  while IFS= read -r file; do
    [ "$(crd_schema "$repo" "$release" "$file")" = "$(crd_schema "$repo" HEAD "$file")" ] || mismatched="${mismatched} ${file}"
  done <<<"$a"
  [ -z "$mismatched" ] || { fail "CRD schema differs from ${release}:${mismatched}"; return 1; }
}
# extract_release_deploy REPO RELEASE DIR: the release's deploy/ tree in DIR.
extract_release_deploy() {
  # Through a file, so a failed archive is not hidden behind tar's exit code.
  mkdir -p "$3" || { fail "cannot create $3"; return 1; }
  git -C "$1" archive -o "$3/deploy.tar" "$2" deploy || { fail "git archive of deploy/ at $2 failed"; return 1; }
  tar -x -f "$3/deploy.tar" -C "$3" || { fail "could not extract deploy/ at $2"; return 1; }
  rm -f "$3/deploy.tar"
  [ -d "$3/deploy/overlays/minikube-ghcr" ] || { fail "$2 deploy tree has no minikube-ghcr overlay"; return 1; }
}

# ─── Preconditions ────────────────────────────────────────────────────
if [ -z "$E2E_KUBECONTEXT" ] || ! is_branch_scoped_e2e_context "$E2E_KUBECONTEXT"; then
  die 'select an explicit branch-scoped Minikube context (KUBECONTEXT=<profile>)'
fi
require_safe_kube_context
[ "${E2E_ALLOW_STATELESS_CADENCE_ACCELERATION:-0}" = 1 ] ||
  die 'set E2E_ALLOW_STATELESS_CADENCE_ACCELERATION=1 (T3 shortens the HCC idle window on this owned profile)'
[ -n "${E2E_PROFILE_PORTS_ENV:-}" ] && [ -r "$E2E_PROFILE_PORTS_ENV" ] ||
  die 'provide E2E_PROFILE_PORTS_ENV from the owned branch profile'
[ -n "${E2E_DEV_LOGIN_EMAIL:-}" ] || die 'set E2E_DEV_LOGIN_EMAIL to the seeded login (admin@evenfire.local)'
[ -n "${E2E_UPGRADE_EVIDENCE_DIR:-}" ] && [ -d "$E2E_UPGRADE_EVIDENCE_DIR" ] ||
  die 'set E2E_UPGRADE_EVIDENCE_DIR to an existing directory for the setup logs'
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] ||
  die 'the worktree is dirty; the head images would not be this HEAD'
if [ "$MODE" = control ]; then
  main_evidence_ok "${E2E_UPGRADE_MAIN_EVIDENCE:-}" "$HEAD_SHA" ||
    die "E2E_UPGRADE_MAIN_EVIDENCE must be a main log with E2E_UPGRADE_MAIN=PASS and E2E_UPGRADE_HEAD=${HEAD_SHA}"
fi
git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/${RELEASE}" >/dev/null || die "tag ${RELEASE} is not in this clone"
command -v yq >/dev/null || die 'yq is required to compare the CRDs with the release'
release_crds_match "$REPO_ROOT" "$RELEASE" ||
  die "this tree's CRDs differ from ${RELEASE} beyond descriptions; the setup would not install the release's CRDs"
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
RUN="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
POD_READY_TIMEOUT="${E2E_825_POD_READY_TIMEOUT:-300}"
SUSPEND_TIMEOUT="${E2E_825_SUSPEND_TIMEOUT:-300}"
TURN_TIMEOUT="${E2E_825_TURN_TIMEOUT:-240}"
STORE_LOG_TIMEOUT="${E2E_825_STORE_LOG_TIMEOUT:-30}"
LAYOUT_SCRIPT="${REPO_ROOT}/deploy/scripts/host-layout-merge.sh"
[ -r "$LAYOUT_SCRIPT" ] || die "missing operator script ${LAYOUT_SCRIPT}"

ROWS=(T1 T2 T3 T5 T6)
ROWS_DONE=0 LANE_OK=0
CREATED_HOSTS=() CREATED_CHANNELS=()
HCC_ENV_SAVED='' HCC_ENV_CHANGED=0 FLAG_FALSE_SET=0
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/e2e-825-upgrade.XXXXXX")"
RELEASE_TREE="${SCRATCH}/release-${RELEASE}"
FIXTURE_POD_REGISTRY="${SCRATCH}/fixture-pods"
: >"$FIXTURE_POD_REGISTRY"
ADMIN_COOKIE='' SESSION_TOKEN='' RPC_TOKEN='' USER_ID='' TEAM_ID='' FIXTURE_IMAGE='' POD_UID=''
HTTP_CODE='' HTTP_BODY='' HTTP_HEADERS=()

# shellcheck source=scripts/e2e/e2e-825-lib.sh
source "${SCRIPT_DIR}/e2e-825-lib.sh"

# Seed files sit where the agent sees /workspace: the PVC root for a stateful
# Host, PVC/workspace for a stateless one on the old release.
# shellcheck disable=SC2016
WRITE_AT_SCRIPT='mkdir -p "$1/$2/e2e-825" && printf "%s\n" "$3" > "$1/$2/e2e-825/$4"'
# shellcheck disable=SC2016
READ_AT_SCRIPT='cat "$1/$2/e2e-825/$3"'

# run_logged LABEL CMD...: runs CMD from the repository root, its output in the
# evidence directory, and reports the command's own exit code.
run_logged() {
  local label=$1 rc=0 logf
  shift
  logf="${E2E_UPGRADE_EVIDENCE_DIR}/${MODE}-${RUN}-${label}.log"
  log "${label}: $* (log ${logf})"
  (cd "$REPO_ROOT" && "$@") >"$logf" 2>&1 || rc=$?
  echo "${label}_EXIT=${rc}" >>"$logf"
  [ "$rc" = 0 ] || { fail "${label} exited ${rc}: $(tail -n 5 "$logf" | tr '\n' ' ')"; return 1; }
  ok "${label} exit 0"
}

# Every setup restarts the services, so the forwards are re-held and probed.
hold_forwards() {
  local label=$1 key url code failures=0
  run_logged "${label}-stop-pf" make -f scripts/minikube-profiles/branch.mk branch-profile-stop-pf || return 1
  run_logged "${label}-pf" make -f scripts/minikube-profiles/branch.mk branch-profile-pf || return 1
  for key in CONTROL_API_URL CONTROL_UI_URL EXTERNAL_REST_API_URL RPC_PROXY_URL; do
    url="$(profile_port_value "$key")"
    code="$(curl -sS -o /dev/null -m 6 -w '%{http_code}' "$url" 2>/dev/null)" || code=000
    if [ "$code" = 000 ]; then
      fail "forward ${key} (${url}) did not answer"
      failures=$((failures + 1))
    else
      ok "forward ${key} answers HTTP ${code}"
    fi
  done
  [ "$failures" = 0 ]
}

login_all() {
  admin_login || return 1
  admin GET "${CAPI}/admin/users?q=$(jq -rn --arg q "$DEV_EMAIL" '$q|@uri')" || true
  USER_ID="$(jq -r --arg e "$DEV_EMAIL" '.items[]? | select((.email // "") == $e) | .id' <<<"$HTTP_BODY" | head -n1)"
  [ -n "$USER_ID" ] || { fail "user ${DEV_EMAIL} not found (${HTTP_CODE})"; return 1; }
  admin GET "${CAPI}/admin/users/${USER_ID}/teams" || true
  TEAM_ID="$(jq -r '.items[0].id // empty' <<<"$HTTP_BODY")"
  user_login || return 1
  # bash 3.2 treats "${empty[@]}" as unbound under set -u.
  [ "${#CREATED_HOSTS[@]}" -eq 0 ] && return 0
  if [ "${1:-}" = regrant ]; then
    local host
    for host in "${CREATED_HOSTS[@]}"; do grant_host "$host" || return 1; done
  fi
  mint_rpc_token
}

hcc_image() {
  kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}'
}
read_fixture_image() {
  FIXTURE_IMAGE="$(kctl get deployment "$SOURCE_HOST" -n "$HOST_NS" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="mcp-host")].image}')"
  [ -n "$FIXTURE_IMAGE" ] || { fail "could not read the ${SOURCE_HOST} image for the PVC fixture"; return 1; }
}

install_release() {
  [ -z "$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" --ignore-not-found -o name)" ] ||
    { fail "deployment/${HCC_DEPLOY} already exists; the lane needs a fresh profile"; return 1; }
  extract_release_deploy "$REPO_ROOT" "$RELEASE" "$RELEASE_TREE" || return 1
  run_logged "install-${RELEASE}" env BRANCH_PROFILE_DEPLOY_DIR="$RELEASE_TREE/deploy" \
    make minikube-setup MINIKUBE_PROFILE="$E2E_KUBECONTEXT" \
    IMAGE_SOURCE=ghcr MINIKUBE_IMAGE_TAG="$RELEASE" || return 1
  case "$(hcc_image)" in
    *":${RELEASE}") ok "HCC runs $(hcc_image)" ;;
    *) fail "HCC runs '$(hcc_image)', expected the ${RELEASE} image"; return 1 ;;
  esac
  # Witness that the release's manifests were applied: v0.11.0's HCC Deployment
  # sets STDIO_BRIDGE_IMAGE, this head's does not.
  kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" -o json | jq -e \
    '[.spec.template.spec.containers[] | select(.name=="host-context-controller") | .env[]? | select(.name=="STDIO_BRIDGE_IMAGE")] | length == 1' >/dev/null ||
    { fail "HCC Deployment lacks STDIO_BRIDGE_IMAGE; the ${RELEASE} manifests were not applied"; return 1; }
  ok "HCC Deployment carries the ${RELEASE} manifest (STDIO_BRIDGE_IMAGE set)"
  # Built now and loaded next to the release images, so the upgrade below is a
  # deploy of minutes and the active Hosts stay active through it.
  run_logged build-head-images make minikube-build-images MINIKUBE_PROFILE="$E2E_KUBECONTEXT" || return 1
  hold_forwards release || return 1
  login_all || return 1
  SOURCE_HOST_JSON="$(kctl get host "$SOURCE_HOST" -n "$HOST_NS" -o json)" ||
    { fail "source Host ${SOURCE_HOST} not found"; return 1; }
  # Personalization writes IDENTITY.md and friends into the workspace; the
  # clones would then collide on F3 instead of exercising the rows.
  jq -e '.spec.personalization.enabled != true' <<<"$SOURCE_HOST_JSON" >/dev/null ||
    { fail "source Host ${SOURCE_HOST} has personalization enabled"; return 1; }
  # verify's fleet verdict below must be decided by the rows' Hosts alone.
  kctl get hosts -n "$HOST_NS" -o json | jq -e '[.items[] | select(.spec.lifecycle.stateless == true)] | length == 0' >/dev/null ||
    { fail 'the fresh install already has stateless Hosts'; return 1; }
  read_fixture_image
}

upgrade_to_head() {
  run_logged upgrade-to-head make minikube-setup MINIKUBE_PROFILE="$E2E_KUBECONTEXT" \
    IMAGE_SOURCE=local REUSE_DB=true ARGS=--skip-build || return 1
  case "$(hcc_image)" in
    *":${RELEASE}") fail "HCC still runs $(hcc_image) after the upgrade"; return 1 ;;
    *) ok "HCC runs $(hcc_image)" ;;
  esac
  hold_forwards head || return 1
  # The setup's seed (seed-e2e-data.sh put_agents) sets the user's and team's
  # agents to the source Host only, revoking the rows' grants.
  login_all regrant || return 1
  read_fixture_image
}

HOST_T1='' HOST_T2='' HOST_T3='' HOST_T5='' HOST_T6=''
new_host() { # ROW STATELESS: creates the row's Host, sets HOST_<row>
  local name
  name="$(truncate_rfc1123 "e2e-up-$(tr '[:upper:]' '[:lower:]' <<<"$1")-${RUN}")"
  printf -v "HOST_$1" '%s' "$name"
  create_host "$name" "$2" || return 1
  wait_new_ready_pod "$name" '' "$POD_READY_TIMEOUT" || return 1
  printf '%s' "$POD_UID" >"${SCRATCH}/${name}.uid"
}

seed_file() { # HOST DIR(.|workspace)
  pvc_fixture "$1" rw write-file "$WRITE_AT_SCRIPT" "$2" "upgrade ${RUN} $1" seed.txt >/dev/null
}

# snapshot_served HOST: what the Host serves now, the history oracle's
# baseline. Every listed chat gets a digest; an empty catalog fails.
snapshot_served() {
  local host=$1 sessions chats chat digest
  rpc GET "${RPC_BASE}/api/v1/rpc/hosts/${host}/sessions?agent=${host}&limit=100" || true
  [ "$HTTP_CODE" = 200 ] || { fail "${host}: sessions returned ${HTTP_CODE}"; return 1; }
  sessions="$HTTP_BODY"
  chat_set "$sessions" "$host" >"${SCRATCH}/${host}.chats"
  chats="$(jq -r --arg a "$host" '[.items[]? | select(.agent == $a) | .chatId] | unique | .[]' <<<"$sessions")"
  [ -n "$chats" ] || { fail "${host}: serves no conversation before the upgrade"; return 1; }
  : >"${SCRATCH}/${host}.threads"
  for chat in $chats; do
    read_messages "$host" "$chat" || return 1
    digest="$(history_digest "$HTTP_BODY")"
    [ "${digest%% *}" -gt 0 ] || { fail "${host}/${chat}: empty history"; return 1; }
    printf '%s %s\n' "$chat" "$digest" >>"${SCRATCH}/${host}.threads"
  done
  ok "${host}: serves $(cat "${SCRATCH}/${host}.chats" | cut -d: -f1) conversation(s) before the upgrade"
}

# wait_upgraded_pod HOST: the Host's Pod after the upgrade (a new UID), waking
# a stateless Host that suspended while the deploy ran.
wait_upgraded_pod() {
  local host=$1 state
  state="$(kctl get host "$host" -n "$HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true)"
  if [ "$state" = suspended ]; then
    log "${host} suspended during the upgrade; waking it"
    post_wake "$host" || return 1
  fi
  wait_new_ready_pod "$host" "$(cat "${SCRATCH}/${host}.uid")" "$POD_READY_TIMEOUT"
}

# The head HCC renders the merge init on every Host Deployment it converged.
wait_merge_templates() {
  local host elapsed=0 pending
  while [ "$elapsed" -lt "$POD_READY_TIMEOUT" ]; do
    pending=''
    for host in "$@"; do
      kctl get deployment "$host" -n "$HOST_NS" -o json | jq -e '
        [.spec.template.spec.initContainers[]?.name] == ["workspace-layout-merge"]' >/dev/null || pending+="${host} "
    done
    [ -n "$pending" ] || { ok "every row's Deployment renders workspace-layout-merge"; return 0; }
    sleep 5
    elapsed=$((elapsed + 5))
  done
  fail "Deployments not re-rendered by the head HCC within ${POD_READY_TIMEOUT}s: ${pending}"
  return 1
}

# run_layout CMD: one run of the operator script; output in LAYOUT_OUT, exit in LAYOUT_RC.
run_layout() {
  LAYOUT_OUT="${SCRATCH}/layout-$1-${SECONDS}.out"
  LAYOUT_RC=0
  bash "$LAYOUT_SCRIPT" "$1" --context "$E2E_KUBECONTEXT" >"$LAYOUT_OUT" 2>&1 || LAYOUT_RC=$?
  cp "$LAYOUT_OUT" "${E2E_UPGRADE_EVIDENCE_DIR}/${MODE}-${RUN}-layout-$1-${SECONDS}.out"
}
row_of() { # HOST → the result of the Host's PVC row in LAYOUT_OUT
  local row
  row="$(grep -F "PVC ${HOST_NS}/${1}-workspace " "$LAYOUT_OUT")" || return 1
  printf '%s' "${row#*result=}"
}
expect_row() { # HOST PATTERN LABEL
  local row
  row="$(row_of "$1")" || { fail "$3: no row for ${1}-workspace"; return 1; }
  # shellcheck disable=SC2254 # PATTERN is a case pattern on purpose
  case "$row" in $2) ok "$3: ${1}-workspace is ${row%% workspace layout*}" ;; *) fail "$3: ${1}-workspace is '${row}', expected $2"; return 1 ;; esac
}

# ─── main ─────────────────────────────────────────────────────────────
seed_rows() {
  # T3 first: the shortened idle window suspends every idle stateless Host,
  # so the others are created after it is restored.
  new_host T3 true && seed_history "$HOST_T3" 3 1 && seed_file "$HOST_T3" workspace && snapshot_served "$HOST_T3" || return 1
  set_hcc_cadence && wait_suspended "$HOST_T3" && restore_hcc_cadence || return 1
  new_host T1 false && seed_history "$HOST_T1" 3 1 && seed_file "$HOST_T1" . && snapshot_served "$HOST_T1" || return 1
  # T5: the old history under state/, then a channel makes HCC run it
  # stateful on the PVC root, where mcp-host opens a second database.
  new_host T5 true && seed_history "$HOST_T5" 3 1 && seed_file "$HOST_T5" workspace || return 1
  local channel
  channel="$(truncate_rfc1123 "e2e-up-t5-${RUN}")"
  log "FAULT:channel ${CHANNEL_NS}/${channel} → ${HOST_T5}"
  printf '%s\n' 'apiVersion: clerum.io/v1alpha1' 'kind: CommunicationChannel' 'metadata:' \
    "  name: ${channel}" "  namespace: ${CHANNEL_NS}" 'spec:' "  hostRef: ${HOST_T5}" '  telegram:' \
    "    - channelId: \"e2e-up-${RUN}\"" '      chatType: "private"' '      userIds: ["000000000"]' |
    kctl create -f - >/dev/null || { fail 'T5: CommunicationChannel create failed'; return 1; }
  CREATED_CHANNELS+=("$channel")
  wait_new_ready_pod "$HOST_T5" "$(cat "${SCRATCH}/${HOST_T5}.uid")" "$POD_READY_TIMEOUT" || return 1
  printf '%s' "$POD_UID" >"${SCRATCH}/${HOST_T5}.uid"
  seed_history "$HOST_T5" 1 1 && snapshot_served "$HOST_T5" || return 1
  # T6: the release's stateless entry keeps the newer database, so what T6
  # serves afterwards is what the snapshot records.
  new_host T6 true && seed_history "$HOST_T6" 2 1 && seed_file "$HOST_T6" workspace || return 1
  local stateless
  for stateless in false true; do
    set_lifecycle "$HOST_T6" "$stateless" || return 1
    wait_new_ready_pod "$HOST_T6" "$(cat "${SCRATCH}/${HOST_T6}.uid")" "$POD_READY_TIMEOUT" || return 1
    printf '%s' "$POD_UID" >"${SCRATCH}/${HOST_T6}.uid"
  done
  seed_history "$HOST_T6" 1 1 && snapshot_served "$HOST_T6" || return 1
  # T2 last, so it is still active when the upgrade replaces its Pod.
  new_host T2 true && seed_history "$HOST_T2" 3 1 && seed_file "$HOST_T2" workspace && snapshot_served "$HOST_T2"
}

predict_rows() {
  run_layout inventory
  [ "$LAYOUT_RC" = 0 ] || { fail "inventory exited ${LAYOUT_RC}, expected 0: $(tail -n 3 "$LAYOUT_OUT" | tr '\n' ' ')"; return 1; }
  grep -qx 'UPGRADE_BLOCKERS=0' "$LAYOUT_OUT" || { fail "inventory: $(grep UPGRADE_BLOCKERS "$LAYOUT_OUT"), expected UPGRADE_BLOCKERS=0"; return 1; }
  expect_row "$HOST_T5" WILL_SUPERSEDE 'inventory T5' &&
    expect_row "$HOST_T2" WILL_MERGE 'inventory T2' &&
    expect_row "$HOST_T3" WILL_MERGE 'inventory T3' &&
    expect_row "$HOST_T6" WILL_MERGE 'inventory T6' &&
    expect_row "$HOST_T1" NO_SPLIT_SIGNATURE 'inventory T1'
}

check_upgraded() {
  local host
  wait_merge_templates "$HOST_T1" "$HOST_T2" "$HOST_T3" "$HOST_T5" "$HOST_T6" || return 1
  wait_upgraded_pod "$HOST_T1" && assert_pod "$HOST_T1" false /workspace || return 1
  wait_upgraded_pod "$HOST_T2" && assert_pod "$HOST_T2" true /workspace || return 1
  wait_upgraded_pod "$HOST_T5" && assert_pod "$HOST_T5" false /workspace || return 1
  wait_upgraded_pod "$HOST_T6" && assert_pod "$HOST_T6" true /workspace || return 1
  [ "$(kctl get host "$HOST_T3" -n "$HOST_NS" -o jsonpath='{.status.lifecycle.state}')" = suspended ] ||
    { fail 'T3: no longer suspended before verify'; return 1; }
  run_layout verify
  [ "$LAYOUT_RC" = 1 ] || { fail "verify exited ${LAYOUT_RC}, expected 1 (T3 split)"; return 1; }
  for host in "$HOST_T1" "$HOST_T2" "$HOST_T5" "$HOST_T6"; do expect_row "$host" POD_OK 'verify' || return 1; done
  expect_row "$HOST_T3" SPLIT 'verify T3' || return 1

  # T3 merges on its natural wake.
  post_wake "$HOST_T3" && wait_new_ready_pod "$HOST_T3" '' "$POD_READY_TIMEOUT" && assert_pod "$HOST_T3" true /workspace || return 1

  run_layout verify
  if [ "$LAYOUT_RC" != 0 ] || ! grep -qx 'HOST_LAYOUT_VERIFY=PASS' "$LAYOUT_OUT"; then
    fail "verify after the T3 wake exited ${LAYOUT_RC}: $(tail -n 3 "$LAYOUT_OUT" | tr '\n' ' ')"
    return 1
  fi
  for host in "$HOST_T1" "$HOST_T2" "$HOST_T3" "$HOST_T5" "$HOST_T6"; do expect_row "$host" POD_OK 'verify after wake' || return 1; done
}

check_history() {
  local listing
  assert_history "$HOST_T1" "upgrade(stateful)" && read_seed_file "$HOST_T1" seed.txt "upgrade ${RUN} ${HOST_T1}" || return 1
  ROWS_DONE=$((ROWS_DONE + 1))
  assert_history "$HOST_T2" "upgrade(stateless-active)" && read_seed_file "$HOST_T2" seed.txt "upgrade ${RUN} ${HOST_T2}" || return 1
  ROWS_DONE=$((ROWS_DONE + 1))
  assert_history "$HOST_T3" "upgrade(stateless-suspended)->wake" && read_seed_file "$HOST_T3" seed.txt "upgrade ${RUN} ${HOST_T3}" || return 1
  ROWS_DONE=$((ROWS_DONE + 1))
  # T5 serves the root family it served before the upgrade; the merge init
  # renamed the older state/ to state.db.superseded-<ts>, and the old files
  # stay under workspace/.
  assert_history "$HOST_T5" "two-databases->upgrade(superseded)" || return 1
  listing="$(pvc_fixture "$HOST_T5" ro list-superseded "$LIST_SCRIPT")" || return 1
  grep -Eq '^f \./state\.db\.superseded-[0-9]{8}T[0-9]{6}Z/state\.db$' <<<"$listing" ||
    { fail "T5: no state.db.superseded-*/state.db: ${listing}"; return 1; }
  ! grep -Eq '^d \./state$' <<<"$listing" || { fail "T5: state/ still present: ${listing}"; return 1; }
  [ "$(pvc_fixture "$HOST_T5" ro read-file "$READ_AT_SCRIPT" workspace seed.txt)" = "upgrade ${RUN} ${HOST_T5}" ] ||
    { fail 'T5: the old seed file is not under workspace/'; return 1; }
  ok 'T5: old database kept as state.db.superseded-*/state.db, old files under workspace/'
  ROWS_DONE=$((ROWS_DONE + 1))
  assert_history "$HOST_T6" "upgrade(stateless-stateful-stateless)" && read_seed_file "$HOST_T6" seed.txt "upgrade ${RUN} ${HOST_T6}" || return 1
  ROWS_DONE=$((ROWS_DONE + 1))
}

run_main() {
  header "Install ${RELEASE}" && install_release &&
    header 'Seed rows on the release' && seed_rows &&
    header 'Predict with inventory' && predict_rows &&
    header 'Upgrade to this head' && upgrade_to_head &&
    header 'Verify and wake' && check_upgraded &&
    header 'History of every row' && check_history
}

# ─── control ──────────────────────────────────────────────────────────
run_control() {
  local flag sessions before after
  header "Install ${RELEASE}" && install_release || return 1
  header 'Seed a T2-shaped Host'
  new_host T2 true && seed_history "$HOST_T2" 2 1 && snapshot_served "$HOST_T2" || return 1
  header 'Upgrade with the merge flag off'
  # Set on the release HCC, which ignores it; the setup's client-side apply
  # keeps an env entry it never owned, so the head HCC starts with "false".
  log "FAULT:flag-false CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE=false on deployment/${HCC_DEPLOY}"
  FLAG_FALSE_SET=1
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE=false >/dev/null ||
    { fail 'flag-false: kubectl set env failed'; return 1; }
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null ||
    { fail 'flag-false: HCC rollout did not complete'; return 1; }
  upgrade_to_head || return 1
  flag="$(kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" -o json | jq -r '
    [.spec.template.spec.containers[].env[]? | select(.name == "CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE") | .value] | first // "<unset>"')"
  [ "$flag" = false ] || { fail "control: the head HCC runs with the flag '${flag}', the control did not happen"; return 1; }
  ok 'control: the head HCC runs with CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE=false'
  wait_upgraded_pod "$HOST_T2" || return 1
  jq -e '.inits == [] and .mounts == [{mountPath:"/workspace", name:"workspace"}]' <<<"$(pod_storage)" >/dev/null ||
    { fail "control: T2 Pod storage is $(pod_storage), expected the root mount without the merge init"; return 1; }
  [ "$(store_path "$HOST_T2")" = /workspace/state.db ] || { fail 'control: T2 did not open /workspace/state.db'; return 1; }
  ok 'control: T2 starts on the root mount with no merge init'
  run_layout inventory
  if [ "$LAYOUT_RC" != 1 ] || ! grep -q '^FLAG_FALSE_WITH_SPLIT_TREES=' "$LAYOUT_OUT"; then
    fail "control: inventory exited ${LAYOUT_RC} without FLAG_FALSE_WITH_SPLIT_TREES"
    return 1
  fi
  ok "control: inventory reports $(grep '^FLAG_FALSE_WITH_SPLIT_TREES=' "$LAYOUT_OUT")"
  # The oracle has to run (sessions 200) and then disagree with the baseline.
  rpc GET "${RPC_BASE}/api/v1/rpc/hosts/${HOST_T2}/sessions?agent=${HOST_T2}&limit=100" || true
  [ "$HTTP_CODE" = 200 ] || { fail "control: sessions returned ${HTTP_CODE}"; return 1; }
  sessions="$HTTP_BODY"
  before="$(cat "${SCRATCH}/${HOST_T2}.chats")"
  after="$(chat_set "$sessions" "$HOST_T2")"
  if chats_match "$before" "$after"; then
    fail "control: T2 still serves its history (${after}); the control did not fail"
    return 1
  fi
  echo "E2E_UPGRADE_CONTROL_DIVERGED ${HOST_T2} before=${before} after=${after}"
  ok 'control: history check fails with the flag off, as expected'
}

# ─── Cleanup ──────────────────────────────────────────────────────────
cleanup() {
  local status=$? failed=0 name pod channel
  set +eu
  while IFS= read -r pod; do
    kctl delete pod "$pod" -n "$HOST_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done <"$FIXTURE_POD_REGISTRY"
  for channel in "${CREATED_CHANNELS[@]}"; do
    kctl delete communicationchannel "$channel" -n "$CHANNEL_NS" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done
  restore_hcc_cadence || { failed=1; echo "HCC cadence restore failed; check deployment/${HCC_DEPLOY}" >&2; }
  if [ "$FLAG_FALSE_SET" = 1 ]; then
    kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE- >/dev/null 2>&1 || failed=1
  fi
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
  print_results || status=1
  echo "E2E_UPGRADE_HEAD=${HEAD_SHA}"
  if [ "$MODE" = main ]; then
    echo "E2E_UPGRADE_ROWS_EXECUTED=${ROWS_DONE} E2E_UPGRADE_ROWS_DEFINED=${#ROWS[@]}"
    if [ "$status" = 0 ] && [ "$LANE_OK" = 1 ] && [ "$ROWS_DONE" = "${#ROWS[@]}" ]; then
      echo 'E2E_UPGRADE_MAIN=PASS'
    else
      echo 'E2E_UPGRADE_MAIN=FAIL'
      status=1
    fi
  else
    if [ "$status" = 0 ] && [ "$LANE_OK" = 1 ]; then
      echo 'E2E_UPGRADE_CONTROL=FAILED_AS_EXPECTED'
      echo 'E2E_UPGRADE_RESULT=PASS'
    else
      echo 'E2E_UPGRADE_CONTROL=NOT_PROVEN'
      echo 'E2E_UPGRADE_RESULT=FAIL'
      status=1
    fi
  fi
  echo "E2E_UPGRADE_EXIT=${status}"
  exit "$status"
}
trap cleanup EXIT

header "#825 upgrade lane ${RELEASE} → ${HEAD_SHA:0:9} (${MODE}, run ${RUN}, ${E2E_KUBECONTEXT})"
if [ "$MODE" = main ]; then run_main && LANE_OK=1; else run_control && LANE_OK=1; fi
