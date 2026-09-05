#!/usr/bin/env bash
# Issues #485/#582 E2E: WRC must infer {{workload:host}} dependencies, converge
# their NetworkPolicies from the live set, and complete finalizer cleanup before
# the WorkflowRecipe disappears.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck source=scripts/e2e/_lib/wrc-networkpolicy-evidence.sh
source "${SCRIPT_DIR}/_lib/wrc-networkpolicy-evidence.sh"

raw_run_id="${E2E_RUN_ID:-$(date +%H%M%S)-$$}"
RUN_ID="$(printf "%s" "$raw_run_id" | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g' | cut -c1-20)"
[ -n "$RUN_ID" ] || RUN_ID="run-$$"

RECIPE_NAME="${E2E_RECIPE_NAME:-e2e-wrc-intdep-${RUN_ID}}"
SOURCE_ID="${E2E_SOURCE_ID:-src-${RUN_ID}}"
KEEP_BACKEND_ID="${E2E_KEEP_BACKEND_ID:-keep-${RUN_ID}}"
DROP_BACKEND_ID="${E2E_DROP_BACKEND_ID:-drop-${RUN_ID}}"
DENIED_POD="${E2E_DENIED_POD:-deny-${RUN_ID}}"
BACKEND_PORT="${E2E_BACKEND_PORT:-8080}"
CONNECT_TIMEOUT="${E2E_CONNECT_TIMEOUT:-4}"
FINALIZER_HOLD="e2e.clerum.io/hold-networkpolicy-delete"
OWNER_SELECTOR="clerum.io/managed-by=workflow-recipes,clerum.io/policy-type=internal-dependency,clerum.io/recipe=${RECIPE_NAME}"

SOURCE_DEPLOYMENT="$SOURCE_ID"
KEEP_BACKEND_DEPLOYMENT="$KEEP_BACKEND_ID"
DROP_BACKEND_DEPLOYMENT="$DROP_BACKEND_ID"
HELD_POLICY_NS=""
HELD_POLICY_NAME=""
HELD_POLICY_UID=""
CREATED=0

need_cmd() {
  command -v "$1" >/dev/null 2>&1 && ok "Command '$1' available" && return
  fail "Command '$1' not found"
  exit 1
}

# Recovery only. The success journey never calls this function: direct child
# deletes would make a broken finalizer look green. It is intentionally shared by
# preflight residue cleanup, --cleanup-only, and the failure trap.
emergency_cleanup() {
  local status=0
  release_held_policy_finalizer || status=1
  kctl delete pod "$DENIED_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false \
    >/dev/null 2>&1 || status=1
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || status=1
  wait_for_workflowrecipe_deleted "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$TIMEOUT_DELETE" \
    >/dev/null 2>&1 || status=1
  kctl delete deployment \
    "$SOURCE_DEPLOYMENT" "$KEEP_BACKEND_DEPLOYMENT" "$DROP_BACKEND_DEPLOYMENT" \
    -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || status=1
  kctl delete service \
    "$SOURCE_DEPLOYMENT" "$KEEP_BACKEND_DEPLOYMENT" "$DROP_BACKEND_DEPLOYMENT" \
    -n "$SANDBOX_NS" --ignore-not-found >/dev/null 2>&1 || status=1
  kctl delete networkpolicy -n "$SANDBOX_NS" -l "$OWNER_SELECTOR" \
    --ignore-not-found >/dev/null 2>&1 || status=1
  return "$status"
}

on_exit() {
  local status=$? cleanup_status=0
  trap - EXIT
  if [ "$CREATED" = "1" ]; then
    if [ "$status" -eq 0 ]; then
      warn "success path exited before finalizer order was verified"
      status=1
    fi
    if [ "${E2E_KEEP_RESOURCES:-0}" != "1" ]; then
      emergency_cleanup >/dev/null 2>&1 || cleanup_status=1
      [ "$cleanup_status" -eq 0 ] || warn "issues #485/#582 E2E emergency cleanup left resources behind"
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

if [ "${1:-}" = "--cleanup-only" ]; then
  need_cmd "$KUBECTL_BIN"
  require_safe_kube_context
  emergency_cleanup
  exit $?
fi

internal_condition_value() {
  kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{range .status.conditions[?(@.type=="InternalDependenciesReady")]}{.status}{"|"}{.reason}{"|"}{.message}{end}' \
    2>/dev/null || true
}

reap_condition_value() {
  kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{range .status.conditions[?(@.type=="NetworkPolicyReapFailed")]}{.status}{"|"}{.reason}{"|"}{.message}{end}' \
    2>/dev/null || true
}

recipe_phase() {
  kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || true
}

guard_recipe_nonterminal() {
  local phase
  phase="$(recipe_phase)"
  case "$phase" in
    failed|deprecated|rollback-failed)
      fail "WorkflowRecipe entered terminal phase ${phase}"
      return 1
      ;;
  esac
}

wait_internal_ready() {
  local elapsed=0 timeout=${1:-120} condition
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    condition="$(internal_condition_value)"
    case "$condition" in
      True\|Reconciled\|*) ok "InternalDependenciesReady=True (${condition})"; return 0 ;;
      False\|*) fail "InternalDependenciesReady=False (${condition})"; return 1 ;;
    esac
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "Timed out waiting for InternalDependenciesReady=True"
  return 1
}

wait_reap_reaped() {
  local elapsed=0 timeout=${1:-120} condition
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    condition="$(reap_condition_value)"
    case "$condition" in
      False\|Reaped\|*) ok "NetworkPolicyReapFailed=False (${condition})"; return 0 ;;
      True\|*) fail "NetworkPolicyReapFailed=True (${condition})"; return 1 ;;
    esac
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "Timed out waiting for NetworkPolicyReapFailed=False/Reaped"
  return 1
}

assert_reap_reaped() {
  local condition
  condition="$(reap_condition_value)"
  case "$condition" in
    False\|Reaped\|*) ok "Reaped condition remains durable (${condition})" ;;
    *) fail "Reaped condition was lost or changed (${condition:-missing})"; return 1 ;;
  esac
}

wait_recipe_active() {
  local elapsed=0 timeout=${1:-120} phase
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    phase="$(recipe_phase)"
    [ "$phase" = "active" ] && ok "WorkflowRecipe is active" && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "Timed out waiting for WorkflowRecipe active phase"
  return 1
}

wait_for_workload_instance() {
  local workload_id=$1 timeout=${2:-$TIMEOUT_POD} elapsed=0 instance
  while [ "$elapsed" -lt "$timeout" ]; do
    instance="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
      -o "jsonpath={.status.workloadInstances.${workload_id}}" 2>/dev/null || true)"
    if [ -n "$instance" ]; then
      printf '%s\n' "$instance"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_recipe_generation_after() {
  local baseline=$1 timeout=${2:-120} elapsed=0 generation
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    generation="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
      -o jsonpath='{.metadata.generation}' 2>/dev/null || true)"
    if [[ "$generation" =~ ^[0-9]+$ ]] && [ "$generation" -gt "$baseline" ]; then
      printf '%s\n' "$generation"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_deployment_generation_after() {
  local name=$1 baseline=$2 timeout=${3:-120} elapsed=0 generation
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    generation="$(kctl get deployment "$name" -n "$SANDBOX_NS" \
      -o jsonpath='{.metadata.generation}' 2>/dev/null || true)"
    if [[ "$generation" =~ ^[0-9]+$ ]] && [ "$generation" -gt "$baseline" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

policy_refs() {
  kctl get networkpolicy -A -l "$1" \
    -o go-template='{{range .items}}{{.metadata.namespace}}/{{.metadata.name}}{{"\n"}}{{end}}' \
    2>/dev/null | sed '/^$/d'
}

one_policy_ref() {
  local selector=$1 description=$2 elapsed=0 timeout=${3:-90} refs count
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    refs="$(policy_refs "$selector")"
    count="$(printf "%s\n" "$refs" | sed '/^$/d' | wc -l | tr -d ' ')"
    [ "$count" = "1" ] && printf "%s\n" "$refs" && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "Expected one ${description} wr-intdep policy for selector: ${selector}"
  return 1
}

wait_for_policy_count() {
  local expected=$1 timeout=${2:-90} elapsed=0 refs count
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    refs="$(policy_refs "$OWNER_SELECTOR")"
    count="$(printf "%s\n" "$refs" | sed '/^$/d' | wc -l | tr -d ' ')"
    [ "$count" = "$expected" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "Expected ${expected} wr-intdep policies for ${RECIPE_NAME}, found ${count:-unknown}"
  return 1
}

wait_for_policy_absent() {
  local ref=$1 timeout=${2:-90}
  wait_for_resource_absent networkpolicy "${ref%%/*}" "${ref#*/}" "$timeout"
}

wait_for_workflowrecipe_absent_strict() {
  wait_for_resource_absent workflowrecipe "$1" "$2" "${3:-90}"
}

netpol_go() {
  kctl get networkpolicy "$2" -n "$1" -o "$3" 2>/dev/null || true
}

policy_hash() {
  local ref=$1 ns name
  ns="${ref%%/*}"
  name="${ref#*/}"
  netpol_go "$ns" "$name" \
    'go-template={{ index .metadata.annotations "clerum.io/internal-dependency-desired-hash" }}'
}

policy_yaml() {
  local ref=$1 ns name
  ns="${ref%%/*}"
  name="${ref#*/}"
  kctl get networkpolicy "$name" -n "$ns" -o yaml
}

assert_policy() {
  local ref=$1 direction=$2 selector_workload=$3 peer_workload=$4
  local ns="${ref%%/*}" name="${ref#*/}" policy_type policy_direction selected yaml

  case "$name" in
    wr-intdep-*) ok "${direction} policy uses wr-intdep lane: ${ref}" ;;
    *) fail "${direction} policy has wrong name: ${ref}"; return 1 ;;
  esac

  policy_type="$(netpol_go "$ns" "$name" 'go-template={{ index .metadata.labels "clerum.io/policy-type" }}')"
  policy_direction="$(netpol_go "$ns" "$name" 'go-template={{ index .metadata.labels "clerum.io/policy-direction" }}')"
  selected="$(netpol_go "$ns" "$name" 'go-template={{ index .spec.podSelector.matchLabels "clerum.io/workload" }}')"
  yaml="$(policy_yaml "$ref")"

  [ "$policy_type" = "internal-dependency" ] || { fail "${ref} missing policy-type"; return 1; }
  [ "$policy_direction" = "$direction" ] || { fail "${ref} has direction ${policy_direction}"; return 1; }
  [ "$selected" = "$selector_workload" ] || { fail "${ref} selects ${selected}, expected ${selector_workload}"; return 1; }
  printf "%s" "$yaml" | grep -Fq "clerum.io/workload: ${peer_workload}" || {
    fail "${ref} does not pin peer ${peer_workload}"
    return 1
  }
  printf "%s" "$yaml" | grep -Fq "port: ${BACKEND_PORT}" || {
    fail "${ref} does not pin port ${BACKEND_PORT}"
    return 1
  }
  if [ "$direction" = "ingress" ]; then
    printf "%s" "$yaml" | grep -Fq "from:" || {
      fail "${ref} has no Kubernetes ingress from selector"
      return 1
    }
    if printf "%s" "$yaml" | grep -Fq "_from:"; then
      fail "${ref} contains non-Kubernetes _from field"
      return 1
    fi
  fi
  ok "${ref} pins ${selector_workload} to ${peer_workload}:${BACKEND_PORT}"
}

assert_policy_excludes_peer() {
  local ref=$1 peer_workload=$2 yaml
  yaml="$(policy_yaml "$ref")"
  if printf "%s" "$yaml" | grep -Fq "clerum.io/workload: ${peer_workload}"; then
    fail "${ref} still includes removed peer ${peer_workload}"
    return 1
  fi
  ok "${ref} excludes removed peer ${peer_workload}"
}

assert_http_allowed() {
  local deployment=$1 url=$2 expected=$3 output
  output="$(kctl exec "deploy/${deployment}" -n "$SANDBOX_NS" -- \
    wget -qO- -T "$CONNECT_TIMEOUT" "$url")" || {
    fail "HTTP probe failed for ${deployment}"
    return 1
  }
  [ "$output" = "$expected" ] || {
    fail "${deployment} could not reach ${url} (output: ${output})"
    return 1
  }
  ok "${deployment} reached ${url} (${expected})"
}

assert_service_has_ready_endpoint() {
  local service=$1 namespace=$2 addresses
  if ! addresses="$(kctl get endpoints "$service" -n "$namespace" \
    -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)"; then
    fail "Could not read Endpoints for ${namespace}/${service}"
    return 1
  fi
  [ -n "$addresses" ] || {
    fail "Service ${namespace}/${service} has no ready endpoint"
    return 1
  }
  ok "Service ${namespace}/${service} has a ready endpoint"
}

wait_http_denied() {
  local deployment=$1 url=$2 timeout=$3 backend=$4 expected=$5
  local elapsed=0 consecutive=0 result service_ip host target
  case "$deployment" in pod/*) target=$deployment ;; *) target="deploy/${deployment}" ;; esac
  host="${url#http://}"
  host="${host%%:*}"
  service_ip="$(kctl get service "$backend" -n "$SANDBOX_NS" -o jsonpath='{.spec.clusterIP}')" || return 1
  service_ip="$(python3 "$WRC_EVIDENCE_PY" service-ip "$service_ip" "$BACKEND_PORT")" || return 1
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    # DNS and backend failure are failed evidence, never network enforcement.
    kctl exec "$target" -n "$SANDBOX_NS" -- timeout "$CONNECT_TIMEOUT" nslookup "$host" >/dev/null || return 1
    assert_service_has_ready_endpoint "$backend" "$SANDBOX_NS" || return 1
    assert_http_allowed "$backend" "http://127.0.0.1:${BACKEND_PORT}/" "$expected" || return 1
    result="$(probe_tcp_result "$target" "$service_ip" "$BACKEND_PORT")" || {
      fail "Could not classify TCP connect probe for ${deployment}; exec/client failure is not denial"
      return 1
    }
    assert_service_has_ready_endpoint "$backend" "$SANDBOX_NS" || return 1
    assert_http_allowed "$backend" "http://127.0.0.1:${BACKEND_PORT}/" "$expected" || return 1
    case "$result" in
      WRC_TCP_CONNECTED) consecutive=0 ;;
      WRC_TCP_CONNECT_TIMEOUT) consecutive=$((consecutive + 1)) ;;
      *) return 1 ;;
    esac
    if [ "$consecutive" -ge 3 ]; then
      ok "${deployment} had three consecutive TCP connect timeouts with DNS and backend healthy"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "${deployment} retained removed access to ${url}"
  return 1
}

apply_recipe() {
  local mode=$1
  {
    cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${WORKFLOW_RECIPE_NS}
  labels:
    e2e.clerum.io/suite: wrc-internal-dependency-networkpolicy
spec:
  description: "Issues #485/#582 E2E fixture for selective inferred dependency convergence."
  workloads:
    - id: ${SOURCE_ID}
      type: deployment
      image: busybox:1.36.1
      command: ["sh", "-c"]
      args:
        - "trap 'exit 0' TERM INT; while true; do sleep 3600; done"
      env:
        - name: KEEP_URL
          value: "http://{{${KEEP_BACKEND_ID}:host}}:{{${KEEP_BACKEND_ID}:port}}/"
YAML
    if [ "$mode" = "with-drop" ]; then
      cat <<YAML
        - name: DROP_URL
          value: "http://{{${DROP_BACKEND_ID}:host}}:{{${DROP_BACKEND_ID}:port}}/"
YAML
    fi
    cat <<YAML
    - id: ${KEEP_BACKEND_ID}
      type: deployment
      image: busybox:1.36.1
      port: ${BACKEND_PORT}
      command: ["sh", "-c"]
      args:
        - "mkdir -p /www && printf 'keep-route-ok\n' > /www/index.html && exec httpd -f -p ${BACKEND_PORT} -h /www"
    - id: ${DROP_BACKEND_ID}
      type: deployment
      image: busybox:1.36.1
      port: ${BACKEND_PORT}
      command: ["sh", "-c"]
      args:
        - "mkdir -p /www && printf 'drop-route-ok\n' > /www/index.html && exec httpd -f -p ${BACKEND_PORT} -h /www"
YAML
  } | kctl apply -f -
}

wait_source_env_without_drop() {
  local expected_keep=$1 timeout=${2:-120} elapsed=0 observed
  while [ "$elapsed" -lt "$timeout" ]; do
    guard_recipe_nonterminal || return 1
    # Read both fields in one completed exec. A failed second exec must not
    # masquerade as an absent DROP_URL after an otherwise healthy KEEP read.
    # shellcheck disable=SC2016
    observed="$(kctl exec "deploy/${SOURCE_DEPLOYMENT}" -n "$SANDBOX_NS" -- sh -c '
      if [ "${KEEP_URL-}" = "$1" ] && [ "${DROP_URL+x}" != x ]; then
        printf "WRC_ENV_CONVERGED\n"
      else
        printf "WRC_ENV_PENDING\n"
      fi
    ' sh "$expected_keep")" || return 1
    if [ "$observed" = WRC_ENV_CONVERGED ]; then
      ok "source rollout retained KEEP_URL and removed DROP_URL"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "source environment did not converge to the reduced dependency set"
  return 1
}

delete_recipe_and_verify_finalizer_order() {
  local hold_ref=$1 timeout=${2:-$TIMEOUT_DELETE}
  local elapsed=0 policy recipe recipe_uid policy_uid patch status
  local hold_ns="${hold_ref%%/*}" hold_name="${hold_ref#*/}"
  local observation_start baseline_failures current_failures

  recipe="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o json)" || return 1
  recipe_uid="$(python3 "$WRC_EVIDENCE_PY" uid "$recipe")" || return 1
  policy="$(kctl get networkpolicy "$hold_name" -n "$hold_ns" -o json)" || return 1
  policy_uid="$(python3 "$WRC_EVIDENCE_PY" uid "$policy")" || return 1
  patch="$(python3 "$WRC_EVIDENCE_PY" barrier-patch install "$policy_uid" "$policy" "$FINALIZER_HOLD")" || return 1
  kctl patch networkpolicy "$hold_name" -n "$hold_ns" --type=json -p "$patch" >/dev/null || return 1
  # Only a confirmed install grants the failure trap ownership of this hold.
  HELD_POLICY_NS="$hold_ns"
  HELD_POLICY_NAME="$hold_name"
  HELD_POLICY_UID="$policy_uid"
  ok "Installed deterministic deletion barrier on ${hold_ref}"

  observation_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  baseline_failures="$(finalizer_failure_count "$observation_start")" || return 1
  kctl delete workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" --wait=false >/dev/null || return 1
  while [ "$elapsed" -lt "$timeout" ]; do
    # Each snapshot binds UID, deletion timestamp and finalizers together.
    policy="$(kctl get networkpolicy "$HELD_POLICY_NAME" -n "$HELD_POLICY_NS" -o json)" || return 1
    recipe="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o json)" || return 1
    if python3 "$WRC_EVIDENCE_PY" barrier-ready "$HELD_POLICY_UID" "$recipe_uid" "$policy" "$recipe" "$FINALIZER_HOLD"; then
      current_failures="$(finalizer_failure_count "$observation_start")" || return 1
      if [ "$current_failures" -gt "$baseline_failures" ]; then
        # A second pair after the failed cleanup cycle prevents a transient
        # pre-cleanup snapshot from certifying a parent that has since vanished.
        policy="$(kctl get networkpolicy "$HELD_POLICY_NAME" -n "$HELD_POLICY_NS" -o json)" || return 1
        recipe="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" -o json)" || return 1
        python3 "$WRC_EVIDENCE_PY" barrier-ready "$HELD_POLICY_UID" "$recipe_uid" "$policy" "$recipe" "$FINALIZER_HOLD" || return 1
        ok "Cleanup cycle rejected while held NetworkPolicy UID=${HELD_POLICY_UID} and WorkflowRecipe UID=${recipe_uid} remain deleting with clerum.io/workload-cleanup"
        break
      fi
    else
      status=$?
      [ "$status" -eq 1 ] || return 1
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  [ "$elapsed" -lt "$timeout" ] || {
    fail "Timed out proving a rejected cleanup cycle while both original objects retain their finalizers"
    return 1
  }

  release_held_policy_finalizer || return 1
  ok "Released deterministic deletion barrier on ${hold_ref}"
  wait_for_policy_absent "$hold_ref" "$timeout" || {
    fail "Held NetworkPolicy still exists after releasing its finalizer"
    return 1
  }
  ok "Held NetworkPolicy absence confirmed after releasing its finalizer"
  wait_for_workflowrecipe_absent_strict "$WORKFLOW_RECIPE_NS" "$RECIPE_NAME" "$timeout" || {
    fail "WorkflowRecipe still exists after NetworkPolicy cleanup completed"
    return 1
  }
  HELD_POLICY_NS=""
  HELD_POLICY_NAME=""
  ok "WorkflowRecipe absence confirmed after the blocked cleanup cycle and held-policy release"
}

header "WRC internal dependency NetworkPolicy E2E"
log "Recipe=${RECIPE_NAME} source=${SOURCE_ID} keep=${KEEP_BACKEND_ID} drop=${DROP_BACKEND_ID}"
log "Context=$(current_e2e_context || true)"

header "Phase 0 - Safety"
need_cmd "$KUBECTL_BIN"
need_cmd python3
require_safe_kube_context
if kctl cluster-info >/dev/null 2>&1; then
  ok "Kubernetes cluster reachable"
else
  fail "Kubernetes cluster not reachable"
  exit 1
fi
for ns in "$WORKFLOW_RECIPE_NS" "$SANDBOX_NS" "$CONTROL_NS"; do
  if kctl get ns "$ns" >/dev/null 2>&1; then
    ok "Namespace ${ns} exists"
  else
    fail "Namespace ${ns} not found"
    exit 1
  fi
done
if kctl get crd workflowrecipes.clerum.io >/dev/null 2>&1; then
  ok "WorkflowRecipe CRD installed"
else
  fail "WorkflowRecipe CRD not installed"
  exit 1
fi
if kctl -n "$CONTROL_NS" rollout status deploy/workflow-recipes --timeout=120s \
  >/dev/null 2>&1; then
  ok "workflow-recipes rolled out"
else
    fail "workflow-recipes deployment is not ready"
    exit 1
fi

header "Phase 1 - Apply isolated two-route fixture"
emergency_cleanup >/dev/null 2>&1 || true
apply_recipe "with-drop"
CREATED=1
ok "WorkflowRecipe fixture applied with KEEP and DROP routes"

if kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
  -o jsonpath='{.spec.workloads[*].egressBindings}' | grep -q .; then
  fail "Fixture contains egressBindings; that would hide inferred dependencies"
  exit 1
fi
ok "Fixture has no egressBindings shortcut"

header "Phase 2 - Initial WRC reconciliation"
SOURCE_DEPLOYMENT="$(wait_for_workload_instance "$SOURCE_ID" "$TIMEOUT_POD")" || {
  fail "Source workload instance was not assigned"
  exit 1
}
KEEP_BACKEND_DEPLOYMENT="$(wait_for_workload_instance "$KEEP_BACKEND_ID" "$TIMEOUT_POD")" || {
  fail "KEEP backend workload instance was not assigned"
  exit 1
}
DROP_BACKEND_DEPLOYMENT="$(wait_for_workload_instance "$DROP_BACKEND_ID" "$TIMEOUT_POD")" || {
  fail "DROP backend workload instance was not assigned"
  exit 1
}
for deployment in "$SOURCE_DEPLOYMENT" "$KEEP_BACKEND_DEPLOYMENT" "$DROP_BACKEND_DEPLOYMENT"; do
  wait_for_deployment "$SANDBOX_NS" "$deployment" "$TIMEOUT_POD" || {
    fail "Deployment ${deployment} not ready"
    exit 1
  }
  ok "Deployment ${deployment} ready"
done
wait_internal_ready "$TIMEOUT_POD"
wait_reap_reaped "$TIMEOUT_POD"
wait_recipe_active "$TIMEOUT_POD"

keep_target="http://${KEEP_BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local:${BACKEND_PORT}/"
drop_target="http://${DROP_BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local:${BACKEND_PORT}/"
resolved_keep="$(kctl exec "deploy/${SOURCE_DEPLOYMENT}" -n "$SANDBOX_NS" -- printenv KEEP_URL)"
resolved_drop="$(kctl exec "deploy/${SOURCE_DEPLOYMENT}" -n "$SANDBOX_NS" -- printenv DROP_URL)"
[ "$resolved_keep" = "$keep_target" ] || { fail "KEEP_URL resolved to ${resolved_keep}"; exit 1; }
[ "$resolved_drop" = "$drop_target" ] || { fail "DROP_URL resolved to ${resolved_drop}"; exit 1; }
ok "Source environment resolved both runtime routes"

header "Phase 3 - Baseline policy shape and two-route packet flow"
egress_selector="${OWNER_SELECTOR},clerum.io/source-workload=${SOURCE_ID}"
keep_ingress_selector="${OWNER_SELECTOR},clerum.io/target-workload=${KEEP_BACKEND_ID}"
drop_ingress_selector="${OWNER_SELECTOR},clerum.io/target-workload=${DROP_BACKEND_ID}"
egress_ref="$(one_policy_ref "$egress_selector" "egress")"
keep_ingress_ref="$(one_policy_ref "$keep_ingress_selector" "KEEP ingress")"
drop_ingress_ref="$(one_policy_ref "$drop_ingress_selector" "DROP ingress")"
wait_for_policy_count 3 "$TIMEOUT_POD"
assert_policy "$egress_ref" "egress" "$SOURCE_ID" "$KEEP_BACKEND_ID"
assert_policy "$egress_ref" "egress" "$SOURCE_ID" "$DROP_BACKEND_ID"
assert_policy "$keep_ingress_ref" "ingress" "$KEEP_BACKEND_ID" "$SOURCE_ID"
assert_policy "$drop_ingress_ref" "ingress" "$DROP_BACKEND_ID" "$SOURCE_ID"
baseline_egress_hash="$(policy_hash "$egress_ref")"
[ -n "$baseline_egress_hash" ] || { fail "Baseline egress policy has no desired hash"; exit 1; }
assert_http_allowed "$SOURCE_DEPLOYMENT" "$keep_target" "keep-route-ok"
assert_http_allowed "$SOURCE_DEPLOYMENT" "$drop_target" "drop-route-ok"

header "Phase 4 - Unassociated caller remains denied"
kctl delete pod "$DENIED_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
cat <<YAML | kctl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${DENIED_POD}
  namespace: ${SANDBOX_NS}
  labels:
    run: ${DENIED_POD}
    e2e.clerum.io/suite: wrc-internal-dependency-networkpolicy
spec:
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: denied
      image: busybox:1.36.1
      command: ["sh", "-c", "trap 'exit 0' TERM INT; while true; do sleep 3600; done"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
YAML
wait_for_pod "$SANDBOX_NS" "run=${DENIED_POD}" 60 || { fail "Unassociated pod not ready"; exit 1; }
wait_http_denied "pod/${DENIED_POD}" "$keep_target" 60 "$KEEP_BACKEND_DEPLOYMENT" "keep-route-ok"
ok "Unassociated pod cannot reach KEEP backend"

header "Phase 5 - Legitimately remove only the DROP dependency"
baseline_recipe_generation="$(kctl get workflowrecipe "$RECIPE_NAME" -n "$WORKFLOW_RECIPE_NS" \
  -o jsonpath='{.metadata.generation}')"
baseline_source_generation="$(kctl get deployment "$SOURCE_DEPLOYMENT" -n "$SANDBOX_NS" \
  -o jsonpath='{.metadata.generation}')"
apply_recipe "without-drop"
updated_recipe_generation="$(wait_for_recipe_generation_after "$baseline_recipe_generation" "$TIMEOUT_POD")" || {
  fail "WorkflowRecipe generation did not advance after removing DROP_URL"
  exit 1
}
ok "WorkflowRecipe generation advanced ${baseline_recipe_generation}->${updated_recipe_generation}"
wait_for_deployment_generation_after "$SOURCE_DEPLOYMENT" "$baseline_source_generation" "$TIMEOUT_POD" || {
  fail "Source Deployment generation did not advance"
  exit 1
}
kctl rollout status "deployment/${SOURCE_DEPLOYMENT}" -n "$SANDBOX_NS" --timeout="${TIMEOUT_POD}s" >/dev/null
wait_source_env_without_drop "$keep_target" "$TIMEOUT_POD"

header "Phase 6 - Selective policy and packet convergence"
wait_for_policy_absent "$drop_ingress_ref" "$TIMEOUT_POD" || {
  fail "Stale DROP ingress policy still exists"
  exit 1
}
ok "Stale DROP ingress policy was reaped"
wait_for_policy_count 2 "$TIMEOUT_POD"
updated_egress_ref="$(one_policy_ref "$egress_selector" "updated egress")"
updated_keep_ingress_ref="$(one_policy_ref "$keep_ingress_selector" "retained KEEP ingress")"
[ "$updated_egress_ref" = "$egress_ref" ] || { fail "Egress policy identity changed"; exit 1; }
[ "$updated_keep_ingress_ref" = "$keep_ingress_ref" ] || { fail "KEEP ingress policy identity changed"; exit 1; }
updated_egress_hash="$(policy_hash "$updated_egress_ref")"
[ -n "$updated_egress_hash" ] && [ "$updated_egress_hash" != "$baseline_egress_hash" ] || {
  fail "Egress desired hash did not change after removing DROP"
  exit 1
}
assert_policy "$updated_egress_ref" "egress" "$SOURCE_ID" "$KEEP_BACKEND_ID"
assert_policy_excludes_peer "$updated_egress_ref" "$DROP_BACKEND_ID"
assert_policy "$updated_keep_ingress_ref" "ingress" "$KEEP_BACKEND_ID" "$SOURCE_ID"
wait_internal_ready "$TIMEOUT_POD"
wait_reap_reaped "$TIMEOUT_POD"
wait_recipe_active "$TIMEOUT_POD"
wait_for_deployment "$SANDBOX_NS" "$DROP_BACKEND_DEPLOYMENT" "$TIMEOUT_POD"
assert_service_has_ready_endpoint "$DROP_BACKEND_DEPLOYMENT" "$SANDBOX_NS"
assert_http_allowed "$DROP_BACKEND_DEPLOYMENT" \
  "http://127.0.0.1:${BACKEND_PORT}/" "drop-route-ok"
wait_http_denied "$SOURCE_DEPLOYMENT" "$drop_target" "$TIMEOUT_POD" "$DROP_BACKEND_DEPLOYMENT" "drop-route-ok"
assert_http_allowed "$SOURCE_DEPLOYMENT" "$keep_target" "keep-route-ok"
assert_reap_reaped
guard_recipe_nonterminal

header "Phase 7 - Finalizer blocks on the held NetworkPolicy, then completes"
kctl delete pod "$DENIED_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null
delete_recipe_and_verify_finalizer_order "$updated_keep_ingress_ref" "$TIMEOUT_DELETE"
final_policy_refs="$(policy_refs "$OWNER_SELECTOR")" || {
  fail "Could not inventory wr-intdep policies after finalizer completion"
  exit 1
}
[ -z "$final_policy_refs" ] || {
  fail "wr-intdep policies still exist after finalizer completion"
  exit 1
}
ok "All wr-intdep policies are absent after finalizer completion"
CREATED=0

print_results
