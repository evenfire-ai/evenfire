#!/usr/bin/env bash
# Functions under test are evaluated from the E2E source, so ShellCheck cannot
# see their use of the mock environment variables declared by each harness.
# shellcheck disable=SC2034
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOYMENT="${ROOT}/deploy/base/control-plane/host-context-controller-api-gateway.yaml"
CONFIGMAP="${ROOT}/deploy/base/control-plane/configmaps.yaml"
BOOTSTRAP_E2E="${ROOT}/scripts/e2e/e2e-hcc-readiness-bootstrap.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

readiness_probe="$(
  awk '
    /^[[:space:]]*readinessProbe:/ { in_probe = 1; next }
    in_probe && /^[[:space:]]*resources:/ { exit }
    in_probe { print }
  ' "${DEPLOYMENT}"
)"

if ! grep -Eq '^[[:space:]]*path:[[:space:]]*/health[[:space:]]*$' <<<"${readiness_probe}"; then
  fail "HCC API gateway readiness probe must use the gateway-local /health endpoint"
fi
echo "PASS: HCC API gateway readiness probe uses the gateway-local /health endpoint"

hcc_config="$(
  awk '
    BEGIN { RS = "---" }
    /name:[[:space:]]*host-context-controller-api-gateway/ { print; exit }
  ' "${CONFIGMAP}"
)"

if [[ -z "${hcc_config}" ]]; then
  fail "HCC API gateway nginx ConfigMap is missing"
fi

health_location="$(
  awk '
    /^[[:space:]]*location = \/health \{/ { in_location = 1 }
    in_location { print }
    in_location && /^[[:space:]]*\}[[:space:]]*$/ { exit }
  ' <<<"${hcc_config}"
)"

if [[ "${health_location}" != *'return 200'* ]] ||
   [[ "${health_location}" == *'proxy_pass'* ]]; then
  fail "HCC API gateway /health must remain a local nginx health response"
fi
echo "PASS: HCC API gateway /health remains local to nginx"

ready_location="$(
  awk '
    /^[[:space:]]*location = \/ready \{/ { in_location = 1 }
    in_location { print }
    in_location && /^[[:space:]]*\}[[:space:]]*$/ { exit }
  ' <<<"${hcc_config}"
)"

if [[ "${ready_location}" != *'proxy_pass http://host_context_controller_upstream;'* ]]; then
  fail "HCC API gateway /ready must continue proxying the HCC readiness contract"
fi
echo "PASS: HCC API gateway /ready continues proxying HCC readiness"

runtime_hold_function="$(
  sed -n '/^hcc_gateway_remains_ready_without_hcc() {$/,/^}$/p' "${BOOTSTRAP_E2E}"
)"
unavailable_probe_function="$(
  sed -n '/^hcc_gateway_ready_proxy_unavailable() {$/,/^}$/p' "${BOOTSTRAP_E2E}"
)"
gateway_pod_function="$(
  sed -n '/^running_hcc_gateway_pod() {$/,/^}$/p' "${BOOTSTRAP_E2E}"
)"
if [[ "${gateway_pod_function}" != *'ready_pod_name "$HCC_NS" "app=${HCC_GATEWAY_DEPLOY}"'* ]] ||
   [[ "${gateway_pod_function}" == *'running_pod_name'* ]]; then
  fail "gateway runtime proof must select a Ready pod through the shared E2E helper"
fi
echo "PASS: gateway runtime proof selects a Ready pod through the shared helper"

if [[ "${runtime_hold_function}" != *'hcc_gateway_deployment_ready'* ]] ||
   [[ "${runtime_hold_function}" != *'hcc_gateway_local_health_ok'* ]] ||
   [[ "${runtime_hold_function}" != *'hcc_gateway_ready_proxy_unavailable'* ]] ||
   ! grep -Fq 'hcc_gateway_remains_ready_without_hcc 20' "${BOOTSTRAP_E2E}"; then
  fail "bootstrap E2E must hold HCC unavailable across a full gateway probe-failure window"
fi
echo "PASS: bootstrap E2E proves gateway readiness remains local while HCC is unavailable"

# Exercise the full conjunction with a bounded synthetic clock. Each required
# observation must independently fail the hold; this kills a permissive
# && -> || mutation without requiring a cluster or a real sleep.
gateway_hold_case() (
  local failed_observation=$1 clock_file
  clock_file="$(mktemp "${TMPDIR:-/tmp}/hcc-gateway-clock.XXXXXX")"
  printf '%s' 0 >"$clock_file"
  trap 'rm -f "$clock_file"' EXIT
  HCC_NS=control-plane
  date() {
    local calls
    calls="$(<"$clock_file")"
    calls=$((calls + 1))
    printf '%s' "$calls" >"$clock_file"
    [ "$calls" -le 2 ] && printf '%s\n' 0 || printf '%s\n' 1
  }
  sleep() { :; }
  hcc_gateway_deployment_ready() {
    [ "$failed_observation" != deployment ]
  }
  hcc_gateway_local_health_ok() {
    [ "$failed_observation" != health ]
  }
  hcc_gateway_ready_proxy_unavailable() {
    [ "$failed_observation" != proxy ]
  }
  eval "${runtime_hold_function}"
  hcc_gateway_remains_ready_without_hcc 1
)

if gateway_hold_case none &&
   ! gateway_hold_case deployment &&
   ! gateway_hold_case health &&
   ! gateway_hold_case proxy; then
  echo "PASS: gateway hold requires every readiness, health, and proxy-unavailable observation"
else
  fail "gateway hold can accept a failed readiness, health, or proxy observation"
fi

for unavailable_status in 502 503 504; do
  if (
    HCC_NS=control-plane
    running_hcc_gateway_pod() { printf '%s\n' gateway-pod; }
    kctl() {
      printf '  HTTP/1.1 %s upstream unavailable\n' "${unavailable_status}"
      return 8
    }
    eval "${unavailable_probe_function}"
    hcc_gateway_ready_proxy_unavailable
  ); then
    echo "PASS: gateway hold accepts explicit upstream-unavailable HTTP ${unavailable_status}"
  else
    fail "gateway hold rejects expected upstream-unavailable HTTP ${unavailable_status}"
  fi
done

if (
  HCC_NS=control-plane
  running_hcc_gateway_pod() { printf '%s\n' gateway-pod; }
  kctl() {
    printf '%s\n' 'error: unable to upgrade connection: container not found'
    return 1
  }
  eval "${unavailable_probe_function}"
  ! hcc_gateway_ready_proxy_unavailable
); then
  echo "PASS: gateway hold rejects kubectl or container transport failure"
else
  fail "gateway hold can mistake kubectl or container transport failure for upstream unavailability"
fi

if (
  HCC_NS=control-plane
  running_hcc_gateway_pod() { printf '%s\n' gateway-pod; }
  kctl() {
    printf '%s\n' 'healthy upstream response'
    return 0
  }
  eval "${unavailable_probe_function}"
  ! hcc_gateway_ready_proxy_unavailable
); then
  echo "PASS: gateway hold rejects a successful proxied /ready response"
else
  fail "gateway hold can accept a successful proxied /ready response as unavailable"
fi

hold_line="$(grep -nF 'hcc_gateway_remains_ready_without_hcc 20' "${BOOTSTRAP_E2E}" | cut -d: -f1)"
restart_line="$(grep -nF 'kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=1' "${BOOTSTRAP_E2E}" | cut -d: -f1)"
recovery_line="$(grep -nF 'hcc_gateway_ready_proxy_recovers ||' "${BOOTSTRAP_E2E}" | cut -d: -f1)"
if [[ -z "${hold_line}" || -z "${restart_line}" || -z "${recovery_line}" ]] ||
   (( hold_line >= restart_line || restart_line >= recovery_line )); then
  fail "gateway unavailable/ready/recovery assertions must surround the HCC restart"
fi
echo "PASS: bootstrap E2E proves proxied /ready failure and recovery in causal order"
