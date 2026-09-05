#!/usr/bin/env bash
# Test doubles and variables are consumed by exact journey functions loaded
# dynamically below; quoted shell fragments intentionally expand only there.
# shellcheck disable=SC2016,SC2034,SC2329
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/scripts/e2e/e2e-wrc-internal-dependency-networkpolicy.sh"
EVIDENCE_LIB="${ROOT}/scripts/e2e/_lib/wrc-networkpolicy-evidence.sh"
FAIL=0

# shellcheck source=scripts/e2e/_lib/wrc-networkpolicy-evidence.sh
source "$EVIDENCE_LIB"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

function_body() {
  local name=$1
  awk -v signature="${name}() {" '
    inside && $0 ~ /^[a-zA-Z_][a-zA-Z0-9_]*\(\) \{$/ { exit }
    inside && $0 ~ /^header "/ { exit }
    $0 == signature { inside=1 }
    inside { print }
  ' "$GATE"
}

if bash -n "$GATE"; then
  pass "WRC internal-dependency gate has valid bash syntax"
else
  fail "WRC internal-dependency gate has invalid bash syntax"
fi

# WRC persists its generated workload resource names in status before
# materializing workloads. The gate must use that public CRD contract rather
# than assuming a workload ID is also a Deployment or Service name.
# shellcheck disable=SC2016
if grep -Fq 'wait_for_workload_instance() {' "$GATE" &&
   grep -Fq 'SOURCE_DEPLOYMENT="$(wait_for_workload_instance "$SOURCE_ID"' "$GATE" &&
   grep -Fq 'KEEP_BACKEND_DEPLOYMENT="$(wait_for_workload_instance "$KEEP_BACKEND_ID"' "$GATE" &&
   grep -Fq 'DROP_BACKEND_DEPLOYMENT="$(wait_for_workload_instance "$DROP_BACKEND_ID"' "$GATE" &&
   ! grep -Fq 'wait_for_deployment "$SANDBOX_NS" "$SOURCE_ID"' "$GATE" &&
   ! grep -Fq 'wait_for_deployment "$SANDBOX_NS" "$KEEP_BACKEND_ID"' "$GATE" &&
   ! grep -Fq 'wait_for_deployment "$SANDBOX_NS" "$DROP_BACKEND_ID"' "$GATE" &&
   grep -Fq 'deploy/${SOURCE_DEPLOYMENT}' "$GATE" &&
   grep -Fq '${KEEP_BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local' "$GATE" &&
   grep -Fq '${DROP_BACKEND_DEPLOYMENT}.${SANDBOX_NS}.svc.cluster.local' "$GATE"; then
  pass "WRC gate resolves persisted workload instances before runtime assertions"
else
  fail "WRC gate assumes raw workload IDs are runtime resource names"
fi

# The live journey must begin with two routes, remove only DROP by re-applying
# the WorkflowRecipe, and prove KEEP still works after DROP is denied.
if grep -Fq 'apply_recipe "with-drop"' "$GATE" &&
   grep -Fq 'apply_recipe "without-drop"' "$GATE" &&
   grep -Fq 'name: KEEP_URL' "$GATE" &&
   grep -Fq 'name: DROP_URL' "$GATE" &&
   grep -Fq 'assert_http_allowed "$SOURCE_DEPLOYMENT" "$keep_target" "keep-route-ok"' "$GATE" &&
   grep -Fq 'assert_http_allowed "$SOURCE_DEPLOYMENT" "$drop_target" "drop-route-ok"' "$GATE" &&
   grep -Fq 'assert_service_has_ready_endpoint "$DROP_BACKEND_DEPLOYMENT" "$SANDBOX_NS"' "$GATE" &&
   grep -Fq 'assert_http_allowed "$DROP_BACKEND_DEPLOYMENT"' "$GATE" &&
   grep -Fq 'wait_http_denied "$SOURCE_DEPLOYMENT" "$drop_target"' "$GATE" &&
   grep -Fq 'assert_policy_excludes_peer "$updated_egress_ref" "$DROP_BACKEND_ID"' "$GATE" &&
   grep -Fq 'wait_for_policy_absent "$drop_ingress_ref"' "$GATE"; then
  pass "WRC gate proves selective KEEP/DROP dependency convergence"
else
  fail "WRC gate does not prove the legitimate two-route update journey"
fi

# The recipe must survive the update and carry the durable clean reap signal.
if grep -Fq 'wait_for_recipe_generation_after' "$GATE" &&
   grep -Fq 'wait_for_deployment_generation_after' "$GATE" &&
   grep -Fq 'guard_recipe_nonterminal() {' "$GATE" &&
   grep -Fq 'failed|deprecated|rollback-failed)' "$GATE" &&
   grep -Fq 'NetworkPolicyReapFailed' "$GATE" &&
   grep -Fq 'False\|Reaped\|*' "$GATE" &&
   grep -Fq 'assert_reap_reaped' "$GATE"; then
  pass "WRC gate pins generation, non-terminal phase, and durable Reaped condition"
else
  fail "WRC gate can pass without proving generation/phase/Reaped state"
fi

normal_finalizer="$(function_body delete_recipe_and_verify_finalizer_order)"
emergency="$(function_body emergency_cleanup)"

# A retained child policy makes cleanup order observable: the recipe must stay
# Terminating until the held policy is released and disappears.
if grep -Fq 'FINALIZER_HOLD="e2e.clerum.io/hold-networkpolicy-delete"' "$GATE" &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'barrier-patch install' &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'barrier-ready "$HELD_POLICY_UID" "$recipe_uid"' &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'clerum.io/workload-cleanup' &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'wait_for_policy_absent "$hold_ref"' &&
   printf '%s\n' "$normal_finalizer" | grep -Fq 'wait_for_workflowrecipe_absent_strict' &&
   ! printf '%s\n' "$normal_finalizer" | grep -Fq 'delete networkpolicy'; then
  pass "WRC gate proves NetworkPolicy-before-WorkflowRecipe finalizer order"
else
  fail "WRC gate finalizer path can be satisfied by direct child cleanup"
fi

# Direct policy cleanup is recovery-only. The successful Phase 7 must use the
# finalizer-order helper, while --cleanup-only and the failure trap may use the
# scoped emergency function.
if printf '%s\n' "$emergency" | grep -Fq 'kctl delete networkpolicy' &&
   grep -Fq 'if [ "${1:-}" = "--cleanup-only" ]; then' "$GATE" &&
   grep -Fq 'delete_recipe_and_verify_finalizer_order "$updated_keep_ingress_ref"' "$GATE" &&
   [ "$(grep -Fc 'kctl delete networkpolicy' "$GATE")" = "1" ]; then
  pass "WRC gate isolates direct NetworkPolicy deletion to emergency cleanup"
else
  fail "WRC gate mixes direct NetworkPolicy cleanup into the success journey"
fi

# Every real kubectl invocation must go through e2e-lib's context-bound kctl.
if grep -Eq '(^|[[:space:]])kubectl([[:space:]]|$)' "$GATE"; then
  fail "WRC gate contains a kubectl invocation outside kctl"
else
  pass "WRC gate routes every Kubernetes call through kctl"
fi

# Static strings cannot prove error classification. Exercise the pure evidence
# classifier used by the E2E for all observable GET outcomes.
if is_kubernetes_deletion_timestamp '2026-09-05T00:00:00Z' &&
   ! is_kubernetes_deletion_timestamp '<no value>' &&
   ! is_kubernetes_deletion_timestamp ''; then
  pass "WRC gate accepts only a real Kubernetes deletion timestamp"
else
  fail "WRC gate accepts a missing or malformed deletion timestamp"
fi

if [ "$(classify_kubernetes_get_observation 0 '')" = "absent" ]; then
  pass "WRC gate accepts explicit empty --ignore-not-found output as absence"
else
  fail "WRC gate rejects an explicitly absent NetworkPolicy"
fi

if [ "$(classify_kubernetes_get_observation 1 '')" = "absent" ]; then
  fail "WRC gate confuses a NetworkPolicy read error with absence"
else
  pass "WRC gate propagates NetworkPolicy read errors as unknown evidence"
fi

if [ "$(classify_kubernetes_get_observation 0 '{"kind":"NetworkPolicy"}')" = "absent" ]; then
  fail "WRC gate reports a live NetworkPolicy as absent"
else
  pass "WRC gate keeps waiting while the NetworkPolicy is present"
fi

# Exercise the exact shared polling helper. A mock at kctl's transport boundary
# models kubectl's --ignore-not-found contract, not a product reconciliation.
if (
  POLL_INTERVAL=1
  sleep() { :; }
  fail() { :; }
  kctl() {
    [[ "$*" == *'--ignore-not-found -o json'* ]] || return 2
    case "$OBSERVATION" in
      not_found) return 0 ;; # Explicit API 404 suppressed by --ignore-not-found.
      present) printf '{"metadata":{"uid":"still-live"}}' ;;
      forbidden|timeout|server_error|context_lost) return 1 ;;
    esac
  }
  for kind in networkpolicy workflowrecipe; do
    OBSERVATION=not_found
    wait_for_resource_absent "$kind" test-ns test-name 1 || exit 1
    for OBSERVATION in present forbidden timeout server_error context_lost; do
      if wait_for_resource_absent "$kind" test-ns test-name 1; then exit 1; fi
    done
  done
); then
  pass "Real absence polling accepts explicit NotFound and rejects live/error observations"
else
  fail "Absence polling permits false deletion evidence"
fi

# Execute the remote probe script locally with a controlled nc function;
# never start a real process or network connection through the kctl boundary.
if (
  SANDBOX_NS=test-ns CONNECT_TIMEOUT=1
  kctl() {
    [ "$PROBE_CASE" != exec_failure ] || return 1
    while [ "$1" != -- ]; do shift; done
    shift
    [ "$1" = sh ] && [ "$2" = -c ] || return 2
    shift 2
    local remote_script=$1
    shift
    nc() {
      [ "$*" = '-w 1 10.0.0.1 8080 -e true' ] || return 2
      case "$PROBE_CASE" in
        allowed|http_stall) return 0 ;;
        timeout) echo 'nc: timed out' >&2; return 1 ;;
        refused) echo "nc: can't connect to remote host: Connection refused" >&2; return 1 ;;
        dns_failure) echo "nc: bad address 'backend'" >&2; return 1 ;;
        invalid_option) echo 'nc: invalid option -- e' >&2; return 1 ;;
        missing_client) echo 'nc: not found' >&2; return 127 ;;
      esac
    }
    # The real script is POSIX shell; eval retains the fixture nc function.
    shift
    eval "$remote_script"
  }
  for PROBE_CASE in allowed http_stall; do
    [ "$(probe_tcp_result deploy/source 10.0.0.1 8080)" = WRC_TCP_CONNECTED ] || exit 1
  done
  PROBE_CASE=timeout
  [ "$(probe_tcp_result deploy/source 10.0.0.1 8080)" = WRC_TCP_CONNECT_TIMEOUT ] || exit 1
  for PROBE_CASE in exec_failure refused dns_failure invalid_option missing_client; do
    if probe_tcp_result deploy/source 10.0.0.1 8080; then exit 1; fi
  done
); then
  pass "Real remote probe accepts only connect timeout as denial; HTTP stalls remain connected"
else
  fail "TCP probe confuses operational failure or HTTP stall with network denial"
fi

if python3 "$ROOT/scripts/tests/test_wrc_networkpolicy_evidence.py"; then
  pass "Snapshot and CAS finalizer behavioral contracts pass"
else
  fail "Snapshot or CAS finalizer behavioral contract failed"
fi

# Run the actual orchestration function (not a rewritten miniature). The
# transport double models API observations and records barrier removal.
if (
  eval "$(function_body delete_recipe_and_verify_finalizer_order)"
  eval "$(function_body wait_for_policy_absent)"
  eval "$(function_body wait_for_workflowrecipe_absent_strict)"
  POLL_INTERVAL=1 TIMEOUT_DELETE=1 WORKFLOW_RECIPE_NS=test-ns RECIPE_NAME=test-recipe
  FINALIZER_HOLD=e2e.clerum.io/hold-networkpolicy-delete
  # This private fixture records the observer call across command substitutions.
  BARRIER_SIGNAL_FILE="$(mktemp)" || exit 1
  trap 'rm -f -- "$BARRIER_SIGNAL_FILE"' EXIT
  ok() { :; }
  fail() { :; }
  sleep() { :; }
  finalizer_failure_count() {
    case "$BARRIER_CASE" in
      stale_signal) printf 1 ;;
      logs_error) return 1 ;;
      *)
        if [ "$DELETING" -eq 1 ]; then
          printf observed > "$BARRIER_SIGNAL_FILE"
          printf 1
        else
          printf 0
        fi
        ;;
    esac
  }
  kctl() {
    local kind=$2 uid stamp finalizers
    case "$1" in
      patch)
        [ "$BARRIER_CASE" != install_failed ] || return 1
        PATCHES=$((PATCHES + 1)); return 0 ;;
      delete) DELETING=1; return 0 ;;
      get)
        [ "$PATCHES" -lt 2 ] || return 0
        if [ "$kind" = networkpolicy ]; then
          uid=child
          stamp=""
          finalizers='"foreign"'
          if [ "$BARRIER_CASE" = preexisting_hold ]; then
            finalizers='"foreign","e2e.clerum.io/hold-networkpolicy-delete"'
          fi
          if [ "$PATCHES" -eq 1 ]; then
            finalizers='"foreign","e2e.clerum.io/hold-networkpolicy-delete"'
            stamp=2026-09-05T00:00:00Z
            case "$BARRIER_CASE" in
              sentinel) stamp='<no value>' ;;
              invalid) stamp=2026-02-30T00:00:00Z ;;
              child_replaced) uid=replacement ;;
              api_error) return 1 ;;
            esac
          fi
        else
          uid=parent
          finalizers='"clerum.io/workload-cleanup"'
          stamp=""
          if [ "$DELETING" -eq 1 ]; then
            stamp=2026-09-05T00:00:00Z
            case "$BARRIER_CASE" in
              parent_replaced) uid=replacement ;;
              parent_finalizer_lost) finalizers='' ;;
              parent_lost_after_signal) [ ! -s "$BARRIER_SIGNAL_FILE" ] || return 1 ;;
            esac
          fi
        fi
        if [ -n "$stamp" ]; then
          stamp=",\"deletionTimestamp\":\"${stamp}\""
        fi
        printf '{"metadata":{"uid":"%s","resourceVersion":"1","finalizers":[%s]%s}}' "$uid" "$finalizers" "$stamp"
        ;;
      *) return 2 ;;
    esac
  }
  for BARRIER_CASE in healthy sentinel invalid child_replaced parent_replaced parent_finalizer_lost api_error stale_signal parent_lost_after_signal logs_error preexisting_hold install_failed; do
    PATCHES=0 DELETING=0 HELD_POLICY_UID="" HELD_POLICY_NS="" HELD_POLICY_NAME=""
    : > "$BARRIER_SIGNAL_FILE"
    if delete_recipe_and_verify_finalizer_order test-ns/test-policy 1; then
      [ "$BARRIER_CASE" = healthy ] && [ "$PATCHES" -eq 2 ] || exit 1
    else
      case "$BARRIER_CASE" in
        preexisting_hold|install_failed)
          [ -z "$HELD_POLICY_UID" ] && [ "$PATCHES" -eq 0 ] || exit 1
          release_held_policy_finalizer || exit 1
          [ "$PATCHES" -eq 0 ] || exit 1
          ;;
        *) [ "$BARRIER_CASE" != healthy ] && [ "$PATCHES" -eq 1 ] || exit 1 ;;
      esac
    fi
  done
) >/dev/null 2>&1; then
  pass "Real finalizer journey requires a new failed cleanup cycle and owns only confirmed barrier installs"
else
  fail "Finalizer journey released its barrier on missing, invalid or changed evidence"
fi

# A packet timeout is only one signal. Exercise the real negative journey to
# ensure that failed DNS, endpoints or backend health cannot turn it green.
if (
  eval "$(function_body wait_http_denied)"
  POLL_INTERVAL=1 SANDBOX_NS=test-ns BACKEND_PORT=8080 CONNECT_TIMEOUT=1
  ok() { :; }
  fail() { :; }
  sleep() { :; }
  guard_recipe_nonterminal() { return 0; }
  kctl() {
    case "$1" in
      get) printf '10.0.0.1' ;;
      exec) [ "$DENIAL_CASE" != dns_failure ] ;;
      *) return 1 ;;
    esac
  }
  assert_service_has_ready_endpoint() { [ "$DENIAL_CASE" != endpoint_failure ]; }
  assert_http_allowed() {
    HEALTH_READS=$((HEALTH_READS + 1))
    [ "$DENIAL_CASE" != backend_failure ] || return 1
    [ "$DENIAL_CASE" != backend_failed_after_probe ] || [ "$HEALTH_READS" -eq 1 ]
  }
  probe_tcp_result() {
    case "$DENIAL_CASE" in
      exec_failure) return 1 ;;
      allowed) printf WRC_TCP_CONNECTED ;;
      *) printf WRC_TCP_CONNECT_TIMEOUT ;;
    esac
  }
  for DENIAL_CASE in timeout dns_failure endpoint_failure backend_failure backend_failed_after_probe exec_failure allowed; do
    HEALTH_READS=0
    if wait_http_denied source http://backend.test-ns.svc.cluster.local:8080/ 3 backend expected; then
      [ "$DENIAL_CASE" = timeout ] && [ "$HEALTH_READS" -eq 6 ] || exit 1
    else
      [ "$DENIAL_CASE" != timeout ] || exit 1
    fi
  done
) >/dev/null 2>&1; then
  pass "Real denial journey requires consecutive timeouts with healthy DNS, endpoints and backend"
else
  fail "Denial journey can certify a broken probe or unhealthy backend"
fi

exit "$FAIL"
