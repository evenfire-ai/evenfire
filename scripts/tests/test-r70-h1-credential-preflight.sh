#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ROOT
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
BIN="$TMP/bin"
mkdir -p "$BIN"

fail() {
  echo "FAIL: $*" >&2
  if [[ -f "${FAKE_LOG:-}" ]]; then tail -n 40 "$FAKE_LOG" >&2; fi
  exit 1
}
pass() { echo "PASS: $*"; }

cat >"$BIN/openssl" <<'OPENSSL'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == rand && "${2:-}" == -hex ]] || exit 90
count_file="${FAKE_STATE_ROOT:?}/openssl.count"
count=0
if [[ -f "$count_file" ]]; then count="$(cat "$count_file")"; fi
count=$((count + 1))
printf '%s' "$count" >"$count_file"
printf '%064x\n' "$count"
OPENSSL

cat >"$BIN/kubectl" <<'KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "${args[0]:-}" == --context ]]; then
  context="${args[1]:-}"
  args=("${args[@]:2}")
elif [[ "${args[0]:-}" == --context=* ]]; then
  context="${args[0]#--context=}"
  args=("${args[@]:1}")
else
  echo 'test fixture requires an explicit context' >&2
  exit 91
fi
[[ "$context" == fixture-context ]] || exit 92
namespace=""
for ((index=0; index<${#args[@]}; index++)); do
  if [[ "${args[$index]}" == -n ]]; then
    namespace="${args[$((index + 1))]:-}"
    break
  fi
done
if [[ "${args[0]:-}" == -n ]]; then
  args=("${args[@]:2}")
fi
verb="${args[0]:-}"
resource="${args[1]:-}"
name="${args[2]:-}"
if [[ "$verb" == get ]]; then
  printf 'READ %s %s %s\n' "$namespace" "$resource" "$name" >>"${FAKE_LOG:?}"
fi
case "$verb:$resource" in
  get:namespace|get:ns)
    if [[ ":${FAKE_ABSENT_NAMESPACES:-}:" == *":$name:"* ]]; then
      echo "Error from server (NotFound): namespaces \"$name\" not found" >&2
      exit 1
    fi
    exit 0
    ;;
  get:deployment|get:deploy)
    if [[ "$name" == host-context-controller && " ${args[*]} " == *' -o json '* ]]; then
      if [[ "${FAKE_CONTROL_NAMESPACE_ABSENT:-false}" == true ]]; then
        echo 'Error from server (NotFound): namespaces "control-plane" not found' >&2
        exit 1
      fi
      if [[ "${FAKE_HCC_ABSENT:-false}" == true ]]; then
        echo 'Error from server (NotFound): deployments.apps "host-context-controller" not found' >&2
        exit 1
      fi
      if [[ -n "${FAKE_HCC_FILE:-}" ]]; then
        cat "$FAKE_HCC_FILE"
      elif [[ "${FAKE_HCC_MODE:-preselector}" == empty-containers ]]; then
        jq '.spec.template.spec.containers = []' \
          "$ROOT/scripts/tests/fixtures/rpc-proxy-edge-hcc-legacy-preselector.json"
      elif [[ "${FAKE_HCC_MODE:-preselector}" == unknown-marker ]]; then
        jq '.spec.template.metadata.labels["clerum.io/host-runtime-edge-protocol"] =
          "future-edge-protocol"' \
          "$ROOT/scripts/tests/fixtures/rpc-proxy-edge-hcc-legacy-preselector.json"
      elif [[ "${FAKE_HCC_MODE:-preselector}" == multiple ]]; then
        jq '.spec.template.spec.containers[0].env += [
          {"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","value":"legacy-headers"},
          {"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","value":"dedicated-header-v1"}
        ]' "$ROOT/scripts/tests/fixtures/rpc-proxy-edge-hcc-legacy-preselector.json"
      elif [[ "${FAKE_HCC_MODE:-preselector}" == malformed ]]; then
        jq '.spec.template.spec.containers[0].env += [
          {"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","valueFrom":{"secretKeyRef":{"name":"x","key":"y"}}}
        ]' "$ROOT/scripts/tests/fixtures/rpc-proxy-edge-hcc-legacy-preselector.json"
      elif [[ "${FAKE_HCC_MODE:-preselector}" == bad-value ]]; then
        jq '.spec.template.spec.containers[0].env += [
          {"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","value":"unsupported"}
        ]' "$ROOT/scripts/tests/fixtures/rpc-proxy-edge-hcc-legacy-preselector.json"
      elif [[ "${FAKE_HCC_MODE:-preselector}" == multi-container ]]; then
        jq '.spec.template.spec.containers[0].env += [
          {"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","value":"dedicated-header-v1"}
        ] | .spec.template.spec.containers += [{
          "name":"second-hcc",
          "env":[{"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","value":"legacy-headers"}]
        }]' "$ROOT/scripts/tests/fixtures/rpc-proxy-edge-hcc-legacy-preselector.json"
      else
        protocol="${FAKE_HCC_MODE:-preselector}"
        if [[ "$protocol" == preselector ]]; then
          cat "$ROOT/scripts/tests/fixtures/rpc-proxy-edge-hcc-legacy-preselector.json"
        else
          jq --arg protocol "$protocol" '.spec.template.spec.containers[0].env += [
            {"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","value":$protocol}
          ]' "$ROOT/scripts/tests/fixtures/rpc-proxy-edge-hcc-legacy-preselector.json"
        fi
      fi
      exit 0
    fi
    if [[ "$name" == rpc-proxy && " ${args[*]} " == *' -o json '* ]]; then
      if [[ "${FAKE_HCC_ABSENT:-false}" == true &&
            "${FAKE_RPC_DEPLOY_EXISTS:-false}" != true ]]; then
        echo 'Error from server (NotFound): deployments.apps "rpc-proxy" not found' >&2
        exit 1
      fi
      protocol="${FAKE_PROXY_MODE:-legacy}"
      if [[ "$protocol" == strict || "$protocol" == mixed ]]; then
        label='"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"'
      elif [[ "$protocol" == unsupported ]]; then
        label='"clerum.io/rpc-proxy-edge-protocol":"future-edge-protocol"'
      else
        label='"app":"rpc-proxy"'
      fi
      printf '{"metadata":{"generation":1},"spec":{"replicas":1,"template":{"metadata":{"labels":{%s}}}},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}\n' "$label"
      exit 0
    fi
    if [[ "$name" == host-context-controller ]]; then exit 0; fi
    if [[ " ${args[*]} " == *' -o jsonpath='* ]]; then
      printf 'managed-host\n'
      exit 0
    fi
    exit 0
    ;;
  get:deployments)
    if [[ "$namespace" == rpc-proxy && " ${args[*]} " == *' -o json '* ]]; then
      if [[ "${FAKE_HCC_ABSENT:-false}" == true &&
            "${FAKE_RPC_DEPLOY_EXISTS:-false}" != true ]]; then
        echo '{"items":[]}'
      else
        echo '{"items":[{"metadata":{"name":"rpc-proxy"}}]}'
      fi
    elif [[ "$namespace" == mcp-host && " ${args[*]} " == *' -o json '* &&
          " ${args[*]} " == *'clerum.io/managed-by=host-context-controller'* ]]; then
      if [[ "${FAKE_HCC_ABSENT:-false}" == true &&
            "${FAKE_HOST_DEPLOY_EXISTS:-false}" != true ]]; then
        echo '{"items":[]}'
      elif [[ "${FAKE_HOSTS_MODE:-legacy}" == unsupported ]]; then
        echo '{"items":[{"metadata":{"generation":1},"spec":{"replicas":1,"template":{"metadata":{"labels":{"app":"managed-host","clerum.io/rpc-proxy-edge-protocol":"future-edge-protocol"}}}},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}]}'
      else
        echo '{"items":[{"metadata":{"generation":1},"spec":{"replicas":1,"template":{"metadata":{"labels":{"app":"managed-host"}}}},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}]}'
      fi
    elif [[ " ${args[*]} " == *' -o jsonpath='* ]]; then
      printf 'managed-host\n'
    elif [[ "$namespace" == mcp-host && " ${args[*]} " == *'clerum.io/managed-by=host-context-controller'* ]]; then
      printf 'deployment.apps/managed-host\n'
    fi
    exit 0
    ;;
  get:pods)
    case "$namespace:${args[*]}" in
      rpc-proxy:*)
        if [[ "${FAKE_HCC_ABSENT:-false}" == true &&
              "${FAKE_RPC_DEPLOY_EXISTS:-false}" != true ]]; then
          echo '{"items":[]}'
        elif [[ "${FAKE_PROXY_MODE:-legacy}" == strict || "${FAKE_PROXY_MODE:-legacy}" == mixed ]]; then
          echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        elif [[ "${FAKE_PROXY_MODE:-legacy}" == unsupported ]]; then
          echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"future-edge-protocol"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        else
          echo '{"items":[{"metadata":{"labels":{"app":"rpc-proxy"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        fi
        ;;
      mcp-host:*clerum.io/managed-by=host-context-controller*)
        if [[ "${FAKE_HCC_ABSENT:-false}" == true &&
              "${FAKE_HOST_DEPLOY_EXISTS:-false}" != true ]]; then
          echo '{"items":[]}'
        elif [[ "${FAKE_HOSTS_MODE:-legacy}" == unsupported-pod ]]; then
          echo '{"items":[{"metadata":{"labels":{"clerum.io/managed-by":"host-context-controller","clerum.io/rpc-proxy-edge-protocol":"future-edge-protocol"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        else
          echo '{"items":[{"metadata":{"labels":{"clerum.io/managed-by":"host-context-controller"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        fi
        ;;
      control-plane:*)
        echo '{"items":[{"metadata":{"labels":{"app":"host-context-controller"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        ;;
      mcp-host:*dedicated-header-v1*)
        if [[ "${FAKE_HOSTS_MODE:-legacy}" == strict || "${FAKE_HOSTS_MODE:-legacy}" == mixed ]]; then
          echo '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        else
          echo '{"items":[]}'
        fi
        ;;
      mcp-host:*)
        if [[ "${FAKE_HCC_ABSENT:-false}" == true &&
              "${FAKE_HOST_DEPLOY_EXISTS:-false}" != true ]]; then
          echo '{"items":[]}'
        else
          echo '{"items":[{"metadata":{"labels":{"app":"managed-host"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        fi
        ;;
      *) echo '{"items":[]}' ;;
    esac
    exit 0
    ;;
  get:secret)
    if [[ " ${args[*]} " == *' -o json '* ]]; then
      proxy_credential="${FAKE_PROXY_CREDENTIAL:-$(printf 'strict-edge-credential-0123456789' | base64 | tr -d '\n')}"
      host_credential="${FAKE_HOST_CREDENTIAL:-$proxy_credential}"
      if [[ "$namespace" == rpc-proxy && "$proxy_credential" != missing ]]; then
        printf '{"data":{"RPC_PROXY_MCP_HOST_EDGE_TOKEN":"%s"}}\n' "$proxy_credential"
      elif [[ "$namespace" == mcp-host && "$host_credential" != missing ]]; then
        printf '{"data":{"RPC_PROXY_MCP_HOST_EDGE_TOKEN":"%s"}}\n' "$host_credential"
      else
        echo '{"data":{}}'
      fi
      exit 0
    fi
    key="${args[*]}"
    case "$key" in
      *INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET*) printf '%s' "${FAKE_HCC_HMAC_B64:-$(printf 'hcc-secret-for-test' | base64 | tr -d '\n')}" ;;
      *INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET*) printf '%s' "${FAKE_WRC_HMAC_B64:-$(printf 'wrc-secret-for-test' | base64 | tr -d '\n')}" ;;
      *RPC_PROXY_MCP_HOST_EDGE_TOKEN*)
        state_file="${FAKE_STATE_ROOT:?}/rpc-edge-${namespace}"
        if [[ -f "$state_file" ]]; then base64 <"$state_file" | tr -d '\n'; fi
        ;;
      *gfs-controller-service-token*|*workspace-files-controller-service-token*) printf '%s' "${FAKE_OTHER_TOKEN_B64:-$(printf 'other-token-for-test' | base64 | tr -d '\n')}" ;;
      *) : ;;
    esac
    exit 0
    ;;
  create:*|patch:*|delete:*|apply:*|scale:*)
    printf 'MUTATE %s %s %s\n' "$namespace" "$resource" "$name" >>"${FAKE_LOG:?}"
    if [[ "$verb" == patch && "$resource" == secret ]]; then
      case "$namespace/$name" in
        rpc-proxy/rpc-proxy-secrets)
          state_key=RPC_PROXY_MCP_HOST_EDGE_TOKEN
          state_file="${FAKE_STATE_ROOT:?}/rpc-edge-rpc-proxy"
          ;;
        mcp-host/rpc-proxy-edge-credentials)
          state_key=RPC_PROXY_MCP_HOST_EDGE_TOKEN
          state_file="${FAKE_STATE_ROOT:?}/rpc-edge-mcp-host"
          ;;
        *) state_key="" ;;
      esac
      if [[ -n "$state_key" ]]; then
        for ((index=0; index<${#args[@]}; index++)); do
          if [[ "${args[$index]}" == -p ]]; then
            jq -r --arg key "$state_key" '.stringData[$key] // empty' \
              <<<"${args[$((index + 1))]}" >"$state_file"
          fi
        done
      fi
    fi
    exit 0
    ;;
  rollout:*)
    case "${args[1]:-}" in
      restart|undo) printf 'MUTATE %s rollout %s\n' "$namespace" "${args[*]}" >>"${FAKE_LOG:?}" ;;
      status)
        printf 'READ %s rollout %s\n' "$namespace" "${args[*]}" >>"${FAKE_LOG:?}"
        if [[ "${FAIL_ROLLOUT_RESOURCE:-}" == "${args[2]:-}" ]]; then exit 1; fi
        ;;
    esac
    exit 0
    ;;
esac
exit 0
KUBECTL
chmod +x "$BIN/kubectl" "$BIN/openssl"

export PATH="$BIN:$PATH"
export KUBECTL_BIN="$BIN/kubectl"
export CONTEXT=fixture-context
export FAKE_LOG="$TMP/kubectl.log"
export FAKE_STATE_ROOT="$TMP"
export EDGE_PREFLIGHT_TIMEOUT_SECONDS=5

assert_no_mutations() {
  if rg -q '^MUTATE ' "$FAKE_LOG"; then
    fail "preflight mutated credentials or workloads for $1"
  fi
}

reset_log() { : >"$FAKE_LOG"; }

run_preflight() {
  FAKE_HCC_MODE="${1:-preselector}" FAKE_PROXY_MODE="${2:-legacy}" \
    FAKE_HOSTS_MODE="${3:-legacy}" \
    bash "$ROOT/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
      preflight --context fixture-context --timeout-seconds 5
}

if ! run_preflight preselector legacy legacy >"$TMP/preselector.out" 2>&1; then
  cat "$TMP/preselector.out" >&2
  fail 'pre-selector legacy cohort was not accepted'
fi
rg -q 'supported pre-selector legacy HCC cohort' "$TMP/preselector.out" || fail 'missing pre-selector proof'
assert_no_mutations 'pre-selector legacy cohort'
pass 'pre-selector legacy HCC is accepted only with ready legacy Proxy and Host cohorts'

for protocol in legacy-headers dedicated-header-v1; do
  reset_log
  if [[ "$protocol" == dedicated-header-v1 ]]; then
    if ! FAKE_HCC_MODE="$protocol" FAKE_PROXY_MODE=strict FAKE_HOSTS_MODE=strict \
      bash "$ROOT/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
        preflight --context fixture-context --timeout-seconds 5 >"$TMP/strict.out" 2>&1; then
      cat "$TMP/strict.out" >&2
      fail 'strict cohort with matching credentials was rejected'
    fi
  else
    if ! run_preflight "$protocol" legacy legacy >"$TMP/legacy.out" 2>&1; then
      cat "$TMP/legacy.out" >&2
      fail 'explicit legacy cohort was rejected'
    fi
  fi
  assert_no_mutations "$protocol selector"
done
pass 'explicit legacy and strict selectors require their supported cohorts and credentials'

for bad_hcc in empty-containers multiple malformed bad-value multi-container; do
  reset_log
  if FAKE_HCC_MODE="$bad_hcc" bash "$ROOT/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
    preflight --context fixture-context --timeout-seconds 5 >"$TMP/bad.out" 2>&1; then
    fail "$bad_hcc HCC selector was accepted"
  fi
  if [[ "$bad_hcc" == empty-containers ]]; then
    rg -q 'no usable container specification' "$TMP/bad.out" || \
      fail 'empty HCC container specification was not diagnosed'
  else
    rg -q 'selector' "$TMP/bad.out" || fail "$bad_hcc rejection did not identify the selector"
  fi
  assert_no_mutations "$bad_hcc selector"
done
pass 'malformed, unsupported, and multiple selectors fail before mutations'

reset_log
if FAKE_HCC_MODE=preselector FAKE_PROXY_MODE=mixed \
  bash "$ROOT/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
    preflight --context fixture-context --timeout-seconds 5 >"$TMP/mixed.out" 2>&1; then
  fail 'pre-selector HCC with a mixed/strict Proxy cohort was accepted'
fi
assert_no_mutations 'mixed legacy and strict cohorts'
pass 'mixed legacy and strict cohorts fail without mutations'

reset_log
if FAKE_HCC_MODE=preselector FAKE_PROXY_MODE=unsupported \
  bash "$ROOT/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
    preflight --context fixture-context --timeout-seconds 5 >"$TMP/unsupported-proxy.out" 2>&1; then
  fail 'pre-selector HCC with an unsupported Proxy edge label was accepted'
fi
assert_no_mutations 'unsupported Proxy edge label'
pass 'unsupported Proxy edge labels fail before credential or workload mutations'

for unsupported_host_state in hcc-marker deployment pod; do
  reset_log
  if [[ "$unsupported_host_state" == hcc-marker ]]; then
    if run_preflight unknown-marker >"$TMP/unsupported-host.out" 2>&1; then
      fail 'pre-selector HCC with an unsupported runtime marker was accepted'
    fi
  elif [[ "$unsupported_host_state" == deployment ]]; then
    if run_preflight preselector legacy unsupported >"$TMP/unsupported-host.out" 2>&1; then
      fail 'pre-selector HCC with an unsupported Host Deployment label was accepted'
    fi
  else
    if run_preflight preselector legacy unsupported-pod >"$TMP/unsupported-host.out" 2>&1; then
      fail 'pre-selector HCC with an unsupported managed Host Pod label was accepted'
    fi
  fi
  assert_no_mutations "unsupported Host $unsupported_host_state label"
done
pass 'unsupported HCC, managed Host Deployment, and Host Pod labels fail before mutation'

for credential_case in missing mismatched malformed placeholder too-short; do
  reset_log
  proxy_credential="$(printf 'strict-edge-credential-0123456789' | base64 | tr -d '\n')"
  host_credential="$proxy_credential"
  case "$credential_case" in
    missing) proxy_credential=missing; host_credential=missing ;;
    mismatched) host_credential="$(printf 'different-edge-credential-0123456789' | base64 | tr -d '\n')" ;;
    malformed) proxy_credential='%%%'; host_credential='%%%' ;;
    placeholder) proxy_credential="$(printf 'replace-with-test-placeholder' | base64 | tr -d '\n')"; host_credential="$proxy_credential" ;;
    too-short) proxy_credential="$(printf 'short' | base64 | tr -d '\n')"; host_credential="$proxy_credential" ;;
  esac
  if FAKE_HCC_MODE=dedicated-header-v1 FAKE_PROXY_MODE=strict \
    FAKE_PROXY_CREDENTIAL="$proxy_credential" FAKE_HOST_CREDENTIAL="$host_credential" \
    bash "$ROOT/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
      preflight --context fixture-context --timeout-seconds 5 >"$TMP/credential.out" 2>&1; then
    fail "strict cohort with $credential_case credentials was accepted"
  fi
  assert_no_mutations "strict $credential_case credentials"
done
pass 'strict cohorts with absent, mismatched, malformed, placeholder, or short credentials fail before mutations'

run_helper() {
  CONTROL_API_INTERNAL_TOKEN_EXT_REST=ext-rest-token-for-test \
  CONTROL_API_INTERNAL_TOKEN_RPC=rpc-control-token-for-test \
  CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY=webhook-token-for-test \
  CONTROL_API_INTERNAL_TOKEN_WA_READER=reader-token-for-test \
  CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY=codex-token-for-test \
  CONTROL_API_INTERNAL_TOKEN_GFSC=gfsc-token-for-test \
  CONTROL_API_INTERNAL_TOKEN_WFC=wfc-token-for-test \
  CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY=grok-token-for-test \
  CHANNEL_READER_HANDOFF_TOKEN=reader-handoff-token-for-test \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET=wrc-secret-for-test \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET=hcc-secret-for-test \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=member-registration-secret-for-test \
  FAKE_OTHER_TOKEN_B64="$(printf 'gfsc-token-for-test' | base64 | tr -d '\n')" \
  KUBE_DEPLOY_EXISTS=1 \
  bash "$TOKEN_SCRIPT"
}

TOKEN_SCRIPT="$ROOT/deploy/scripts/apply-inter-service-tokens.sh"
reset_log
if ! FAKE_CONTROL_NAMESPACE_ABSENT=true \
  FAKE_ABSENT_NAMESPACES=:control-plane:rpc-proxy:mcp-host: \
  run_preflight preselector legacy legacy >"$TMP/cold-start.out" 2>&1; then
  cat "$TMP/cold-start.out" >&2
  fail 'empty cold-start state was not accepted'
fi
assert_no_mutations 'empty cold-start state'
pass 'missing HCC is accepted only when no Proxy or managed Host workloads exist'

for partial_state in proxy host; do
  reset_log
  if [[ "$partial_state" == proxy ]]; then
    if FAKE_HCC_ABSENT=true FAKE_RPC_DEPLOY_EXISTS=true run_preflight \
      preselector legacy legacy >"$TMP/partial.out" 2>&1; then
      fail 'HCC-absent state with an RPC Proxy workload was accepted'
    fi
  else
    if FAKE_HCC_ABSENT=true FAKE_HOST_DEPLOY_EXISTS=true run_preflight \
      preselector legacy legacy >"$TMP/partial.out" 2>&1; then
      fail 'HCC-absent state with managed Hosts was accepted'
    fi
  fi
  rg -q 'HCC is absent while an RPC Proxy or managed Host workload exists' \
    "$TMP/partial.out" || fail "missing HCC/edge partial state was not diagnosed: $partial_state"
  assert_no_mutations "HCC-absent $partial_state partial state"
done
pass 'HCC-absent partial edge states fail before credential or workload mutations'

for rejected_mode in multiple mixed; do
  reset_log
  if [[ "$rejected_mode" == mixed ]]; then
    if FAKE_HCC_MODE=preselector FAKE_PROXY_MODE=mixed run_helper >"$TMP/helper-reject.out" 2>&1; then
      fail 'helper accepted a selector-free mixed Proxy cohort'
    fi
  else
    if FAKE_HCC_MODE=multiple run_helper >"$TMP/helper-reject.out" 2>&1; then
      fail 'helper accepted multiple HCC selectors'
    fi
  fi
  assert_no_mutations "helper rejected $rejected_mode state"
done
pass 'credential helper performs no Secret or workload mutation after rejected preflight'

reset_log
rm -f -- "$TMP/rpc-edge-rpc-proxy" "$TMP/rpc-edge-mcp-host"
if FAIL_ROLLOUT_RESOURCE=deployment/rpc-proxy run_helper >"$TMP/interrupted.out" 2>&1; then
  fail 'credential preparation unexpectedly passed the injected Proxy rollout failure'
fi
rg -q 'supported pre-selector legacy HCC cohort' "$TMP/interrupted.out" || \
  fail 'helper skipped preflight before the interrupted preparation'
first_mutation="$(rg -n '^MUTATE ' "$FAKE_LOG" | head -1 | cut -d: -f1)"
first_hcc_read="$(rg -n '^READ control-plane deployment host-context-controller$' "$FAKE_LOG" | head -1 | cut -d: -f1)"
[[ -n "$first_mutation" && -n "$first_hcc_read" && "$first_hcc_read" -lt "$first_mutation" ]] ||
  fail 'helper mutated before it inspected the legacy HCC'
rg -q '^MUTATE rpc-proxy secret rpc-proxy-secrets$' "$FAKE_LOG" ||
  fail 'helper did not prepare the missing RPC edge credential before interruption'
rg -q '^MUTATE rpc-proxy rollout .*restart.*rpc-proxy' "$FAKE_LOG" ||
  fail 'injected interruption did not occur at the coordinated Proxy rollout'
[[ -s "$TMP/rpc-edge-rpc-proxy" && -s "$TMP/rpc-edge-mcp-host" ]] ||
  fail 'interrupted preparation did not persist both edge credential projections'
prepared_edge_token="$(cat "$TMP/rpc-edge-rpc-proxy")"
[[ "$prepared_edge_token" == "$(cat "$TMP/rpc-edge-mcp-host")" ]] ||
  fail 'interrupted preparation left mismatched Proxy and Host credentials'
pass 'actual helper prepares the missing edge Secret before an injected rollout interruption'

reset_log
if ! run_helper >"$TMP/retry.out" 2>&1; then
  cat "$TMP/retry.out" >&2
  fail 'interrupted-preparation retry did not remain safe'
fi
[[ "$prepared_edge_token" == "$(cat "$TMP/rpc-edge-rpc-proxy")" &&
   "$prepared_edge_token" == "$(cat "$TMP/rpc-edge-mcp-host")" ]] ||
  fail 'retry rotated or split the persisted edge identity after interruption'
if rg -q '^MUTATE rpc-proxy rollout .*restart.*rpc-proxy' "$FAKE_LOG"; then
  fail 'idempotent retry restarted the Proxy after the credential had been persisted'
fi
pass 'retry after interrupted preparation reuses the same edge identity without Proxy restart'

reset_log
if ! bash "$ROOT/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
  rollback-proxy --context fixture-context --to-hcc-revision 2 --to-proxy-revision 3 \
  --timeout-seconds 5 >"$TMP/rollback.out" 2>&1; then
  cat "$TMP/rollback.out" >&2
  fail 'ordered legacy rollback was rejected'
fi
hcc_undo="$(rg -n '^MUTATE control-plane rollout .*undo.*host-context-controller' "$FAKE_LOG" | head -1 | cut -d: -f1)"
proxy_undo="$(rg -n '^MUTATE rpc-proxy rollout .*undo.*rpc-proxy' "$FAKE_LOG" | head -1 | cut -d: -f1)"
[[ -n "$hcc_undo" && -n "$proxy_undo" && "$hcc_undo" -lt "$proxy_undo" ]] ||
  fail 'rollback did not restore HCC and Hosts before the Proxy'
pass 'the existing Host-first rollback order remains intact'

# The independently materialized previous-head tree must fail for the original
# explicit-selector predicate, after demonstrating the unsafe late preflight.
if [[ -n "${PREVIOUS_TREE:-}" ]]; then
  reset_log
  rm -f -- "$TMP/rpc-edge-rpc-proxy" "$TMP/rpc-edge-mcp-host"
  TOKEN_SCRIPT="$PREVIOUS_TREE/deploy/scripts/apply-inter-service-tokens.sh"
  if run_helper >"$TMP/previous.out" 2>&1; then
    fail 'previous head unexpectedly accepted the pre-selector HCC fixture'
  fi
  rg -q 'protocol selector must be explicit' "$TMP/previous.out" || {
    cat "$TMP/previous.out" >&2
    fail 'previous-head RED was not caused by the missing explicit selector'
  }
  rg -q '^MUTATE ' "$FAKE_LOG" || fail 'previous-head RED did not expose mutation before failure'
  pass 'previous head REDs at the missing-selector coordinator check after partial preparation'
fi

bash -n "$ROOT/deploy/scripts/apply-inter-service-tokens.sh"
bash -n "$ROOT/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh"
pass 'R70-H1 shell syntax checks pass'
