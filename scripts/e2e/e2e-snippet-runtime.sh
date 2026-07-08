#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
export RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

MCP_SERVER_NS="${MCP_SERVER_NS:-mcp-server}"
CONTROL_PORT="${CONTROL_API_PORT:-8090}"
CONTROL_URL="${E2E_CONTROL_API_URL:-http://127.0.0.1:${CONTROL_PORT}}"
E2E_ADMIN_AUTH="${E2E_CONTROL_API_ADMIN_TOKEN:-}"
ADMIN_USERNAME="${E2E_ADMIN_USERNAME:-${ADMIN_USERNAME:-admin}}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"

DIRECT_NAME="e2e-layer3a-snippet-direct-db"
DIRECT_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-direct-db.yaml"
API_MONGO_PG_NAME="e2e-layer3a-snippet-api-mongo-pg-chain"
API_MONGO_PG_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-api-mongo-postgres-chain.yaml"
API_MONGO_PG_SECRET_NAME="e2e-layer3a-snippet-api-mongo-pg-chain-secret"
HTTP_NAME="e2e-layer3a-snippet-http-egress"
HTTP_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-http-egress.yaml"
MANUAL_MCP_NAME="e2e-layer3a-snippet-manual-mcp"
MANUAL_MCP_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-manual-mcp.yaml"
MANUAL_MCP_TIMEOUT_NAME="e2e-layer3a-snippet-manual-mcp-timeout"
MANUAL_MCP_TIMEOUT_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-manual-mcp-timeout.yaml"
HYBRID_NAME="e2e-layer3a-hybrid-secret-pvc-5step-long-name"
HYBRID_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-hybrid-agentic.yaml"
SECRET_REF_NAME="e2e-layer3a-snippet-secret-ref"
SECRET_REF_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-secret-ref.yaml"
SECRET_REF_SECRET_NAME="e2e-layer3a-snippet-secret-ref-secret"

NEG_PLATFORM_NAME="e2e-layer3a-snippet-negative-platform-secret"
NEG_PLATFORM_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-negative-platform-secret.yaml"
NEG_MISSING_SECRET_NAME="e2e-layer3a-snippet-negative-missing-secret"
NEG_MISSING_SECRET_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-negative-missing-secret.yaml"
NEG_HTTP_EGRESS_NAME="e2e-layer3a-snippet-negative-http-egress"
NEG_HTTP_EGRESS_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-negative-http-egress.yaml"
NEG_HTTP_ADMISSION_NAME="e2e-layer3a-snippet-negative-http-admission"
NEG_HTTP_ADMISSION_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-negative-http-admission.yaml"
NEG_MCP_WILDCARD_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-negative-mcp-wildcard.yaml"
NEG_UNDECLARED_POSTGRES_NAME="e2e-layer3a-snippet-negative-undeclared-postgres"
NEG_UNDECLARED_POSTGRES_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-negative-undeclared-postgres.yaml"
NEG_UNSAFE_ARTIFACT_NAME="e2e-layer3a-snippet-negative-unsafe-artifact"
NEG_UNSAFE_ARTIFACT_FILE="${PROJECT_DIR}/tests/e2e/fixtures/layer3a-snippet-negative-unsafe-artifact.yaml"

workflow_service_name() {
  local recipe_name=$1 suffix=$2
  RECIPE_NAME="$recipe_name" SERVICE_SUFFIX="$suffix" python3 - <<'PY'
import hashlib
import os

max_len = 63
prefix = "wf-"
recipe_name = os.environ["RECIPE_NAME"]
suffix = os.environ["SERVICE_SUFFIX"]
direct = f"{prefix}{recipe_name}{suffix}"
if len(direct) <= max_len:
    print(direct)
    raise SystemExit(0)

digest = hashlib.sha256(recipe_name.encode()).hexdigest()[:8]
reserved_len = len(prefix) + len(suffix) + len(digest) + 1
max_stem_len = max(1, max_len - reserved_len)
stem = recipe_name[:max_stem_len].rstrip("-") or recipe_name[:max_stem_len]
print(f"{prefix}{stem}-{digest}{suffix}")
PY
}

snippet_runner_service_name() {
  workflow_service_name "$1" "-snippet-runner"
}

artifact_reader_service_name() {
  workflow_service_name "$1" "-artifact-reader"
}

ALL_RECIPES=(
  "$DIRECT_NAME"
  "$API_MONGO_PG_NAME"
  "$HTTP_NAME"
  "$MANUAL_MCP_NAME"
  "$MANUAL_MCP_TIMEOUT_NAME"
  "$HYBRID_NAME"
  "$SECRET_REF_NAME"
  "$NEG_PLATFORM_NAME"
  "$NEG_MISSING_SECRET_NAME"
  "$NEG_HTTP_EGRESS_NAME"
  "$NEG_HTTP_ADMISSION_NAME"
  e2e-layer3a-snippet-negative-mcp-wildcard
  "$NEG_UNDECLARED_POSTGRES_NAME"
  "$NEG_UNSAFE_ARTIFACT_NAME"
)

cleanup_one() {
  local name=$1
  local children child
  children=$(kctl get workflowrecipe -n "$RECIPE_NS" \
    -l "clerum.io/parent-recipe=${name}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
  for child in $children; do
    kctl delete workflowrecipe "$child" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  kctl delete workflowrecipe "$name" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  wait_for_workflowrecipe_deleted "$RECIPE_NS" "$name" "$TIMEOUT_DELETE" >/dev/null 2>&1 || true
  for ns in "$SANDBOX_NS" "$MCP_SERVER_NS" "$RECIPE_NS"; do
    kctl delete pod,svc,configmap,secret,networkpolicy,pvc,statefulset,deployment,job \
      -n "$ns" -l "clerum.io/recipe=${name}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    for child in $children; do
      kctl delete pod,svc,configmap,secret,networkpolicy,pvc,statefulset,deployment,job \
        -n "$ns" -l "clerum.io/recipe=${child}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    done
  done
  kctl delete mcpserver,context -n "$MCP_SERVER_NS" -l "clerum.io/recipe=${name}" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
  for child in $children; do
    kctl delete mcpserver,context -n "$MCP_SERVER_NS" -l "clerum.io/recipe=${child}" \
      --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  kctl delete context "wf-${name}" -n "$MCP_SERVER_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}

create_secret_ref_secret() {
  cat <<YAML | kctl apply -f - >/dev/null
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_REF_SECRET_NAME}
  namespace: ${SANDBOX_NS}
  labels:
    clerum.io/recipe: ${SECRET_REF_NAME}
    clerum.io/owner-recipe: ${SECRET_REF_NAME}
    clerum.io/test-fixture: layer3a-snippet-secret-ref
type: Opaque
stringData:
  apiKey: e2e-secret-token-value
YAML
  ok "${SECRET_REF_NAME} test Secret created in ${SANDBOX_NS}"
}

create_api_mongo_pg_secret() {
  cat <<YAML | kctl apply -f - >/dev/null
apiVersion: v1
kind: Secret
metadata:
  name: ${API_MONGO_PG_SECRET_NAME}
  namespace: ${SANDBOX_NS}
  labels:
    clerum.io/recipe: ${API_MONGO_PG_NAME}
    clerum.io/owner-recipe: ${API_MONGO_PG_NAME}
    clerum.io/test-fixture: layer3a-snippet-api-mongo-pg-chain
type: Opaque
stringData:
  apiKey: e2e-vendor-api-key-value
  pgPassword: e2e-postgres-password
YAML
  ok "${API_MONGO_PG_NAME} API and PostgreSQL Secret created in ${SANDBOX_NS}"
}

cleanup_all() {
  for name in "${ALL_RECIPES[@]}"; do
    cleanup_one "$name"
  done
}

if [ "${1:-}" = "--cleanup-only" ]; then
  cleanup_all
  exit 0
fi

if [ -z "$E2E_ADMIN_AUTH" ] && [ -z "$ADMIN_PASSWORD" ]; then
  fail "E2E_CONTROL_API_ADMIN_TOKEN or E2E_ADMIN_PASSWORD is required for the full snippet runtime gate because the hybrid agentic case must trigger a real on-demand child run"
  exit 1
fi

trap cleanup_all EXIT

wait_for_phase() {
  local name=$1 expected=$2 timeout=${3:-300} elapsed=0 phase=""
  while [ "$elapsed" -lt "$timeout" ]; do
    phase=$(kctl get workflowrecipe "$name" -n "$RECIPE_NS" -o jsonpath='{.status.workflowExecution.phase}' 2>/dev/null || true)
    [ "$phase" = "$expected" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  echo "last phase for ${name}: ${phase:-<empty>}"
  return 1
}

wait_for_labeled_pod_ready() {
  local namespace=$1 label=$2 timeout=${3:-240} elapsed=0 ready=""
  while [ "$elapsed" -lt "$timeout" ]; do
    ready=$(kctl get pods -n "$namespace" -l "$label" \
      -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    [ "$ready" = "True" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  kctl get pods -n "$namespace" -l "$label" 2>/dev/null || true
  return 1
}

wait_for_named_pod_ready() {
  local namespace=$1 pod_name=$2 timeout=${3:-240} elapsed=0 ready=""
  while [ "$elapsed" -lt "$timeout" ]; do
    ready=$(kctl get pod "$pod_name" -n "$namespace" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
    [ "$ready" = "True" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  kctl get pod "$pod_name" -n "$namespace" 2>/dev/null || true
  return 1
}

apply_recipe() {
  local name=$1 file=$2
  cleanup_one "$name"
  kctl apply -f "$file" >/dev/null
  ok "WorkflowRecipe '${name}' applied in ${RECIPE_NS}"
}

curl_config_quote() {
  local value=$1
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

http_json() {
  local method=$1 url=$2 body=${3:-}
  shift 3 2>/dev/null || shift $#

  local cfg body_file raw rc header_file
  cfg=$(mktemp "${TMPDIR:-/tmp}/clerum-snippet-e2e-curl.XXXXXX")
  chmod 600 "$cfg"
  header_file="${HTTP_HEADER_FILE:-}"
  body_file=""
  if [ -n "$body" ]; then
    body_file=$(mktemp "${TMPDIR:-/tmp}/clerum-snippet-e2e-body.XXXXXX")
    chmod 600 "$body_file"
    printf '%s' "$body" >"$body_file"
  fi

  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'write-out = "\\n%%{http_code}"\n'
    printf 'max-time = 30\n'
    printf 'request = "%s"\n' "$(curl_config_quote "$method")"
    printf 'url = "%s"\n' "$(curl_config_quote "$url")"
    [ -n "$header_file" ] && printf 'dump-header = "%s"\n' "$(curl_config_quote "$header_file")"
    printf 'header = "Content-Type: application/json"\n'
    for hdr in "$@"; do
      printf 'header = "%s"\n' "$(curl_config_quote "$hdr")"
    done
    [ -n "$body_file" ] && printf 'data-binary = "@%s"\n' "$(curl_config_quote "$body_file")"
  } >"$cfg"

  raw=$(curl --config "$cfg" 2>/dev/null)
  rc=$?
  rm -f "$cfg" "$body_file"
  if [ "$rc" -ne 0 ]; then
    HTTP_STATUS="000"
    HTTP_BODY='{"error":"curl failed"}'
    return 1
  fi
  HTTP_STATUS=$(printf '%s' "$raw" | tail -n1)
  HTTP_BODY=$(printf '%s' "$raw" | sed '$d')
}


admin_session_from_headers() {
  local header_file=$1
  awk '
    BEGIN { IGNORECASE = 1 }
    /^[Ss]et-[Cc]ookie:[[:space:]]*control_ui_admin_session=/ {
      sub(/^[Ss]et-[Cc]ookie:[[:space:]]*control_ui_admin_session=/, "")
      sub(/;.*/, "")
      print
      exit
    }
  ' "$header_file"
}
json_get() {
  local json=$1 path=$2
  JSON_INPUT="$json" JSON_PATH="$path" python3 - <<'PY'
import json
import os

value = json.loads(os.environ["JSON_INPUT"])
for key in os.environ["JSON_PATH"].split("."):
    if not key:
        continue
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(key)
if value is None:
    value = ""
print(value)
PY
}

require_admin_auth() {
  if [ -z "$E2E_ADMIN_AUTH" ]; then
    local body header_file
    body=$(ADMIN_USERNAME="$ADMIN_USERNAME" ADMIN_PASSWORD="$ADMIN_PASSWORD" node --no-warnings -e '
const body = {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
}
process.stdout.write(JSON.stringify(body))
')
    header_file=$(mktemp "${TMPDIR:-/tmp}/clerum-snippet-e2e-headers.XXXXXX")
    chmod 600 "$header_file"
    if ! HTTP_HEADER_FILE="$header_file" http_json POST "${CONTROL_URL}/api/v1/admin/auth/login" "$body"; then
      rm -f "$header_file"
      fail "admin login request failed for hybrid on-demand workflow (HTTP ${HTTP_STATUS}): ${HTTP_BODY}" >&2
      exit 1
    fi
    if [ "$HTTP_STATUS" != "200" ]; then
      rm -f "$header_file"
      fail "admin login failed for hybrid on-demand workflow (HTTP ${HTTP_STATUS})" >&2
      exit 1
    fi
    E2E_ADMIN_AUTH=$(json_get "$HTTP_BODY" token)
    if [ -z "$E2E_ADMIN_AUTH" ]; then
      E2E_ADMIN_AUTH=$(admin_session_from_headers "$header_file")
    fi
    rm -f "$header_file"
    if [ -z "$E2E_ADMIN_AUTH" ]; then
      fail "admin login response missing token for hybrid on-demand workflow" >&2
      exit 1
    fi
    log "admin JWT obtained for hybrid on-demand workflow" >&2
  fi
  printf '%s' "$E2E_ADMIN_AUTH"
}

trigger_workflow_as_admin() {
  local name=$1 auth=$2 body idempotency_key run_id
  body='{"inputs":{"requestId":"layer3a-hybrid-agentic-e2e"}}'
  idempotency_key="snippet-hybrid-${name}-$(date +%s)-${RANDOM}"
  if ! http_json POST "${CONTROL_URL}/api/v1/admin/workflows/${RECIPE_NS}/${name}/trigger" \
    "$body" \
    "Authorization: Bearer ${auth}" \
    "Idempotency-Key: ${idempotency_key}"; then
    fail "admin trigger request failed for ${name} (HTTP ${HTTP_STATUS}): ${HTTP_BODY}"
    exit 1
  fi
  if [ "$HTTP_STATUS" != "201" ] && [ "$HTTP_STATUS" != "200" ]; then
    fail "admin trigger failed for ${name} (HTTP ${HTTP_STATUS}): ${HTTP_BODY}"
    exit 1
  fi
  run_id=$(json_get "$HTTP_BODY" id)
  if [ -z "$run_id" ]; then
    fail "admin trigger response missing run id for ${name}: ${HTTP_BODY}"
    exit 1
  fi
  printf '%s' "$run_id"
}

wait_for_child_recipe_by_run_id() {
  local run_id=$1 timeout=${2:-180} elapsed=0 child=""
  while [ "$elapsed" -lt "$timeout" ]; do
    child=$(kctl get workflowrecipe -n "$RECIPE_NS" \
      -l "clerum.io/workflow-run-id=${run_id}" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [ -n "$child" ]; then
      printf '%s' "$child"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

assert_snippet_runner_contract() {
  local name=$1
  local pod="${name}-snippet-runner"
  if wait_for_named_pod_ready "$SANDBOX_NS" "$pod" 240; then
    ok "${name} snippet runner pod is ready"
  else
    fail "${name} snippet runner pod did not become ready"
    kctl describe pod "$pod" -n "$SANDBOX_NS" 2>/dev/null || true
    exit 1
  fi

  kctl get svc "$(snippet_runner_service_name "$name")" -n "$SANDBOX_NS" >/dev/null
  ok "${name} snippet runner service exists"

  local pod_json
  pod_json=$(kctl get pod "$pod" -n "$SANDBOX_NS" -o json)
  if POD_JSON="$pod_json" python3 - <<'PY'
import json
import os

pod = json.loads(os.environ["POD_JSON"])
spec = pod["spec"]
container = spec["containers"][0]
env_names = {item["name"] for item in container.get("env", [])}
if spec.get("automountServiceAccountToken") is not False:
    raise SystemExit("service account token must be disabled")
sc = container.get("securityContext", {})
pod_sc = spec.get("securityContext", {})
if pod_sc.get("runAsNonRoot") is not True:
    raise SystemExit("pod runAsNonRoot must be true")
if sc.get("readOnlyRootFilesystem") is not True:
    raise SystemExit("readOnlyRootFilesystem must be true")
if sc.get("allowPrivilegeEscalation") is not False:
    raise SystemExit("allowPrivilegeEscalation must be false")
if "ALL" not in sc.get("capabilities", {}).get("drop", []):
    raise SystemExit("all Linux capabilities must be dropped")
if "CLERUM_WORKFLOW_NAME" not in env_names:
    raise SystemExit("workflow binding is missing")
mounts = {item["name"] for item in container.get("volumeMounts", [])}
for required in ["workflow-config", "recipe-output", "tmp"]:
    if required not in mounts:
        raise SystemExit(f"required mount missing: {required}")
PY
  then
    ok "${name} snippet runner pod hardening and env contract are correct"
  else
    fail "${name} snippet runner pod contract mismatch"
    exit 1
  fi
}

assert_coordinator_snippet_contract() {
  local name=$1
  local env_names
  env_names=$(kctl get pod "${name}-coordinator" -n "$SANDBOX_NS" -o jsonpath='{.spec.containers[0].env[*].name}' 2>/dev/null || true)
  if printf "%s\n" "$env_names" | tr ' ' '\n' | grep -Fxq CLERUM_SNIPPET_RUNNER_URL; then
    ok "${name} coordinator receives snippet runner URL"
  else
    fail "${name} coordinator missing snippet runner URL"
    exit 1
  fi
}

assert_no_mcp_host() {
  local name=$1
  if kctl get pod "${name}-mcp-host" -n "$SANDBOX_NS" >/dev/null 2>&1; then
    fail "${name} unexpectedly created mcp-host pod"
    exit 1
  fi
  ok "${name} did not create mcp-host pod"
}

assert_artifact_reader_exists() {
  local name=$1
  if kctl get pod "${name}-artifact-reader" -n "$SANDBOX_NS" >/dev/null 2>&1 &&
     kctl get svc "$(artifact_reader_service_name "$name")" -n "$SANDBOX_NS" >/dev/null 2>&1; then
    ok "${name} has platform artifact-reader for output downloads"
  else
    fail "${name} missing platform artifact-reader"
    exit 1
  fi
}

assert_public_http_egress_policy() {
  local name=$1 component=$2 policy_name=$3
  local pod_json
  local policy_json
  local all_policies_json
  pod_json=$(kctl get pod "${name}-snippet-runner" -n "$SANDBOX_NS" -o json)
  policy_json=$(kctl get networkpolicy "$policy_name" -n "$SANDBOX_NS" -o json)
  all_policies_json=$(kctl get networkpolicy -n "$SANDBOX_NS" -o json)
  if POD_JSON="$pod_json" POLICY_JSON="$policy_json" ALL_POLICIES_JSON="$all_policies_json" COMPONENT="$component" python3 - <<'PY'
import json
import os
import ipaddress

pod = json.loads(os.environ["POD_JSON"])
policy = json.loads(os.environ["POLICY_JSON"])
all_policies = json.loads(os.environ["ALL_POLICIES_JSON"]).get("items", [])
component = os.environ["COMPONENT"]
selector = policy.get("spec", {}).get("podSelector", {}).get("matchLabels", {})
if selector.get("clerum.io/component") != component:
    raise SystemExit(f"component selector mismatch: {selector}")
pod_labels = pod.get("metadata", {}).get("labels", {})

blocked = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.31.196.0/24",
    "192.52.193.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "192.175.48.0/24",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
]
blocked_nets = [ipaddress.ip_network(item) for item in blocked]

def is_public_resolved_cidr(cidr):
    try:
        network = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False
    return (
        network.version == 4
        and network.prefixlen == 32
        and not any(network.subnet_of(blocked_net) or network.overlaps(blocked_net) for blocked_net in blocked_nets)
    )

resolved_cidrs = set(
    item.strip()
    for item in policy.get("metadata", {})
    .get("annotations", {})
    .get("clerum.io/runtime-http-egress-current-cidrs", "")
    .split(",")
    if item.strip()
)
previous_cidrs = set(
    item.strip()
    for item in policy.get("metadata", {})
    .get("annotations", {})
    .get("clerum.io/runtime-http-egress-previous-cidrs", "")
    .split(",")
    if item.strip()
)
effective_resolved_cidrs = resolved_cidrs | previous_cidrs

def selector_matches(selector_spec, labels):
    selector_spec = selector_spec or {}
    for key, value in (selector_spec.get("matchLabels") or {}).items():
        if labels.get(key) != value:
            return False
    for expression in selector_spec.get("matchExpressions") or []:
        key = expression.get("key")
        operator = expression.get("operator")
        values = expression.get("values") or []
        if not key or not operator:
            raise SystemExit(f"unsupported podSelector expression: {expression}")
        has_key = key in labels
        label_value = labels.get(key)
        if operator == "In":
            if not has_key or label_value not in values:
                return False
        elif operator == "NotIn":
            if has_key and label_value in values:
                return False
        elif operator == "Exists":
            if not has_key:
                return False
        elif operator == "DoesNotExist":
            if has_key:
                return False
        else:
            raise SystemExit(f"unsupported podSelector operator {operator}: {expression}")
    return True

def rule_ports(rule):
    ports = rule.get("ports")
    if not ports:
        return None
    return {(item.get("protocol", "TCP"), item.get("port")) for item in ports}

def rule_has_http_surface(rule):
    ports = rule_ports(rule)
    if ports is None:
        return True
    return bool({("TCP", 80), ("TCP", 443)} & ports)

def cidrs_for_rule(rule):
    cidrs = set()
    for target in rule.get("to", []):
        block = target.get("ipBlock")
        if not block or set(target.keys()) != {"ipBlock"}:
            raise SystemExit(f"HTTP egress peer must be ipBlock-only, got: {target}")
        cidr = block.get("cidr")
        if not cidr:
            raise SystemExit(f"HTTP egress ipBlock missing cidr: {target}")
        cidrs.add(cidr)
    return cidrs

def is_resolved_public_http_rule(rule, require_annotation):
    cidrs = cidrs_for_rule(rule)
    if not cidrs or not all(is_public_resolved_cidr(cidr) for cidr in cidrs):
        return False
    if require_annotation:
        if not resolved_cidrs:
            raise SystemExit("runtime HTTP egress current CIDR annotation missing")
        if cidrs != effective_resolved_cidrs:
            raise SystemExit(
                f"resolved CIDR annotation mismatch: policy={cidrs} current={resolved_cidrs} previous={previous_cidrs}"
            )
    return True

def is_safe_public_http_rule(rule, require_annotation=False):
    ports = rule_ports(rule)
    if ports is None:
        return False
    if not {("TCP", 80), ("TCP", 443)} & ports:
        return None
    if ports != {("TCP", 80), ("TCP", 443)}:
        return False
    if is_resolved_public_http_rule(rule, require_annotation):
        return True
    return False

matching_safe_rule_found = False
for rule in policy.get("spec", {}).get("egress", []):
    if is_safe_public_http_rule(rule, require_annotation=True):
        matching_safe_rule_found = True

if not matching_safe_rule_found:
    raise SystemExit("public HTTP egress rule not found")

primary_name = policy.get("metadata", {}).get("name")
for item in all_policies:
    item_selector = item.get("spec", {}).get("podSelector", {})
    if not selector_matches(item_selector, pod_labels):
        continue
    item_name = item.get("metadata", {}).get("name", "<unknown>")
    for index, rule in enumerate(item.get("spec", {}).get("egress", [])):
        if not rule_has_http_surface(rule):
            continue
        if item_name != primary_name:
            raise SystemExit(
                f"unexpected HTTP egress surface from NetworkPolicy {item_name} selecting snippet pod egress[{index}]: {rule}"
            )
        safe = is_safe_public_http_rule(rule, require_annotation=True)
        if safe is False:
            raise SystemExit(f"unsafe HTTP egress rule in NetworkPolicy {item_name} egress[{index}]: {rule}")
PY
  then
    ok "${name} ${component} public HTTP egress NetworkPolicy is pinned to resolved public CIDRs"
  else
    fail "${name} ${component} public HTTP egress NetworkPolicy mismatch"
    kctl get networkpolicy "$policy_name" -n "$SANDBOX_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

assert_snippet_secret_env_contract() {
  local name=$1 alias=$2 secret_name=$3 secret_key=$4
  local pod_json
  pod_json=$(kctl get pod "${name}-snippet-runner" -n "$SANDBOX_NS" -o json)
  if POD_JSON="$pod_json" ALIAS="$alias" SECRET_NAME="$secret_name" SECRET_KEY="$secret_key" python3 - <<'PY'
import json
import os

pod = json.loads(os.environ["POD_JSON"])
alias = os.environ["ALIAS"]
secret_name = os.environ["SECRET_NAME"]
secret_key = os.environ["SECRET_KEY"]
expected_env = "CLERUM_SNIPPET_SECRET_" + "".join(
    ch if ch.isalnum() or ch == "_" else "_" for ch in alias
).upper()
env = {item.get("name"): item for item in pod["spec"]["containers"][0].get("env", [])}
entry = env.get(expected_env)
if not entry:
    raise SystemExit(f"missing secret env var {expected_env}")
ref = entry.get("valueFrom", {}).get("secretKeyRef", {})
if ref.get("name") != secret_name or ref.get("key") != secret_key:
    raise SystemExit(f"secretKeyRef mismatch: {ref}")
PY
  then
    ok "${name} snippet runner receives ${alias} through the declared Secret keyRef"
  else
    fail "${name} snippet runner secret env contract mismatch"
    exit 1
  fi
}

assert_status_contract() {
  local name=$1 expected_json=$2
  local status_json
  status_json=$(kctl get workflowrecipe "$name" -n "$RECIPE_NS" -o json)
  if STATUS_JSON="$status_json" EXPECTED_JSON="$expected_json" python3 - <<'PY'
import json
import os

doc = json.loads(os.environ["STATUS_JSON"])
expected = json.loads(os.environ["EXPECTED_JSON"])
steps = {step.get("id"): step for step in doc.get("status", {}).get("steps", [])}
for step_id, executor in expected["executors"].items():
    step = steps.get(step_id)
    if not step:
        raise SystemExit(f"missing step status: {step_id}")
    if step.get("phase") != "completed":
        raise SystemExit(f"{step_id} phase mismatch: {step.get('phase')}")
    if step.get("executor") != executor:
        raise SystemExit(f"{step_id} executor mismatch: {step.get('executor')}")
    output = step.get("output", "")
    for needle in expected.get("outputContains", {}).get(step_id, []):
        if needle not in output:
            raise SystemExit(f"{step_id} output missing {needle!r}: {output}")
artifacts = {item.get("name"): item for item in doc.get("status", {}).get("artifacts", [])}
for artifact_name in expected.get("artifacts", []):
    artifact = artifacts.get(artifact_name)
    if not artifact:
        raise SystemExit(f"missing status artifact: {artifact_name}")
    if artifact.get("path") != f"/output/{artifact_name}":
        raise SystemExit(f"artifact path mismatch for {artifact_name}: {artifact}")
PY
  then
    ok "${name} WorkflowRecipe status proves expected executors, outputs, and artifacts"
  else
    fail "${name} status contract mismatch"
    kctl get workflowrecipe "$name" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

apply_and_expect_failed() {
  local name=$1 file=$2 pattern=$3 label=$4 timeout=${5:-180}
  cleanup_one "$name"
  kctl apply -f "$file" >/dev/null
  if wait_for_phase "$name" failed "$timeout"; then
    ok "${label} fails closed"
  else
    fail "${label} did not fail closed"
    kctl get workflowrecipe "$name" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
  local doc
  doc=$(kctl get workflowrecipe "$name" -n "$RECIPE_NS" -o json 2>/dev/null || true)
  if DOC_JSON="$doc" PATTERN="$pattern" python3 - <<'PY'
import json
import os
import re

doc = json.loads(os.environ["DOC_JSON"])
haystack = json.dumps(doc.get("status", {}))
if not re.search(os.environ["PATTERN"], haystack, re.IGNORECASE):
    raise SystemExit(haystack)
PY
  then
    ok "${label} failure message/status matches expected guard"
  else
    fail "${label} failure message/status mismatch"
    kctl get workflowrecipe "$name" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

apply_and_expect_rejected() {
  local file=$1 pattern=$2 label=$3 output
  output=$(mktemp)
  if kctl apply -f "$file" >"$output" 2>&1; then
    fail "CRD accepted ${label}"
    cat "$output"
    rm -f "$output"
    exit 1
  fi
  if grep -Eqi "$pattern" "$output"; then
    ok "CRD rejects ${label}"
  else
    fail "CRD rejection for ${label} did not match expected message"
    cat "$output"
    rm -f "$output"
    exit 1
  fi
  rm -f "$output"
}

assert_failed_status_matches() {
  local name=$1 pattern=$2 label=$3
  local doc
  doc=$(kctl get workflowrecipe "$name" -n "$RECIPE_NS" -o json 2>/dev/null || true)
  if DOC_JSON="$doc" PATTERN="$pattern" python3 - <<'PY'
import json
import os
import re

doc = json.loads(os.environ["DOC_JSON"])
haystack = json.dumps(doc.get("status", {}))
if not re.search(os.environ["PATTERN"], haystack, re.IGNORECASE):
    raise SystemExit(haystack)
PY
  then
    ok "${label} failure message/status matches expected guard"
  else
    fail "${label} failure message/status mismatch"
    kctl get workflowrecipe "$name" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

kctl cluster-info >/dev/null
kctl get ns "$SANDBOX_NS" >/dev/null
kctl get ns "$MCP_SERVER_NS" >/dev/null
kctl get crd workflowrecipes.clerum.io >/dev/null
kctl get deploy workflow-recipes -n "$CONTROL_NS" >/dev/null
ok "snippet runtime prerequisites available"

cleanup_all

apply_recipe "$DIRECT_NAME" "$DIRECT_FILE"
assert_snippet_runner_contract "$DIRECT_NAME"
assert_coordinator_snippet_contract "$DIRECT_NAME"
assert_no_mcp_host "$DIRECT_NAME"
if wait_for_phase "$DIRECT_NAME" completed 420; then
  ok "direct DB snippet workflow completed"
else
  fail "direct DB snippet workflow did not complete"
  exit 1
fi
assert_artifact_reader_exists "$DIRECT_NAME"
assert_status_contract "$DIRECT_NAME" '{
  "executors": {"query-mongo":"snippet","query-postgres":"snippet"},
  "outputContains": {"query-mongo":["dao-alpha","mongo","insertedCount"],"query-postgres":["dao-alpha","postgres","insertedCount","mongoRows"]},
  "artifacts": ["direct-db-mongo.json","direct-db-summary.md"]
}'

cleanup_one "$API_MONGO_PG_NAME"
create_api_mongo_pg_secret
kctl apply -f "$API_MONGO_PG_FILE" >/dev/null
ok "WorkflowRecipe '${API_MONGO_PG_NAME}' applied in ${RECIPE_NS}"
if kctl get workflowrecipe "$API_MONGO_PG_NAME" -n "$RECIPE_NS" -o yaml \
  | grep -Eq "e2e-vendor-api-key-value|e2e-postgres-password"; then
  fail "${API_MONGO_PG_NAME} leaked Secret values into the WorkflowRecipe CRD"
  exit 1
fi
ok "${API_MONGO_PG_NAME} WorkflowRecipe stores only Secret references, not API key or DB password values"
assert_snippet_runner_contract "$API_MONGO_PG_NAME"
assert_coordinator_snippet_contract "$API_MONGO_PG_NAME"
assert_no_mcp_host "$API_MONGO_PG_NAME"
assert_snippet_secret_env_contract \
  "$API_MONGO_PG_NAME" \
  "vendor_api_key" \
  "$API_MONGO_PG_SECRET_NAME" \
  "apiKey"
assert_snippet_secret_env_contract \
  "$API_MONGO_PG_NAME" \
  "pg_password" \
  "$API_MONGO_PG_SECRET_NAME" \
  "pgPassword"
assert_public_http_egress_policy \
  "$API_MONGO_PG_NAME" \
  "workflow-snippet-runner" \
  "${API_MONGO_PG_NAME}-snippet-runner-egress"
if wait_for_phase "$API_MONGO_PG_NAME" completed 480; then
  ok "public API -> MongoDB -> PostgreSQL snippet workflow completed"
else
  fail "public API -> MongoDB -> PostgreSQL snippet workflow did not complete"
  kctl logs "${API_MONGO_PG_NAME}-snippet-runner" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
  exit 1
fi
assert_artifact_reader_exists "$API_MONGO_PG_NAME"
if kctl get workflowrecipe "$API_MONGO_PG_NAME" -n "$RECIPE_NS" -o json \
  | grep -Eq "e2e-vendor-api-key-value|e2e-postgres-password"; then
  fail "${API_MONGO_PG_NAME} leaked Secret values into WorkflowRecipe status"
  exit 1
fi
ok "${API_MONGO_PG_NAME} status/artifacts metadata does not expose API key or DB password values"
assert_status_contract "$API_MONGO_PG_NAME" '{
  "executors": {"fetch-api":"snippet","load-mongo":"snippet","copy-postgres":"snippet","emit-report":"snippet"},
  "outputContains": {
    "fetch-api":["api.ipify.org","ipify","apiKeyResolved"],
    "load-mongo":["mongoRows","ipify"],
    "copy-postgres":["postgres","copied"],
    "emit-report":["reportReady","postgresRows"]
  },
  "artifacts": ["api-ip.json","api-to-mongo.json","mongo-to-postgres.json","api-mongo-postgres-summary.md"]
}'

apply_recipe "$HTTP_NAME" "$HTTP_FILE"
assert_snippet_runner_contract "$HTTP_NAME"
assert_coordinator_snippet_contract "$HTTP_NAME"
assert_no_mcp_host "$HTTP_NAME"
assert_public_http_egress_policy "$HTTP_NAME" "workflow-snippet-runner" "${HTTP_NAME}-snippet-runner-egress"
if wait_for_phase "$HTTP_NAME" completed 300; then
  ok "public HTTP snippet workflow completed"
else
  fail "public HTTP snippet workflow did not complete"
  kctl logs "${HTTP_NAME}-snippet-runner" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
  exit 1
fi
assert_status_contract "$HTTP_NAME" '{
  "executors": {"call-public-api":"snippet"},
  "outputContains": {"call-public-api":["api.ipify.org","ipify","observedIp"]},
  "artifacts": ["http-egress-result.json"]
}'

apply_recipe "$MANUAL_MCP_NAME" "$MANUAL_MCP_FILE"
if wait_for_labeled_pod_ready "$MCP_SERVER_NS" "clerum.io/recipe=${MANUAL_MCP_NAME},clerum.io/workload=mock-tools" 240; then
  ok "manual MCP snippet transport workload is ready"
else
  fail "manual MCP snippet transport workload did not become ready"
  exit 1
fi
assert_snippet_runner_contract "$MANUAL_MCP_NAME"
assert_coordinator_snippet_contract "$MANUAL_MCP_NAME"
assert_no_mcp_host "$MANUAL_MCP_NAME"
if wait_for_phase "$MANUAL_MCP_NAME" completed 360; then
  ok "manual MCP snippet workflow completed"
else
  fail "manual MCP snippet workflow did not complete"
  exit 1
fi
assert_status_contract "$MANUAL_MCP_NAME" '{
  "executors": {"call-mcp":"snippet"},
  "outputContains": {"call-mcp":["mcpDataUsed","mock-tools","add","record","recall","context-write-ok","42"]},
  "artifacts": ["manual-mcp-result.json"]
}'

apply_recipe "$MANUAL_MCP_TIMEOUT_NAME" "$MANUAL_MCP_TIMEOUT_FILE"
if wait_for_labeled_pod_ready "$MCP_SERVER_NS" "clerum.io/recipe=${MANUAL_MCP_TIMEOUT_NAME},clerum.io/workload=mock-tools" 240; then
  ok "manual MCP timeout snippet transport workload is ready"
else
  fail "manual MCP timeout snippet transport workload did not become ready"
  exit 1
fi
assert_snippet_runner_contract "$MANUAL_MCP_TIMEOUT_NAME"
assert_coordinator_snippet_contract "$MANUAL_MCP_TIMEOUT_NAME"
assert_no_mcp_host "$MANUAL_MCP_TIMEOUT_NAME"
if wait_for_phase "$MANUAL_MCP_TIMEOUT_NAME" failed 180; then
  ok "manual MCP snippet timeout fails boundedly"
else
  fail "manual MCP snippet timeout did not fail boundedly"
  kctl logs "${MANUAL_MCP_TIMEOUT_NAME}-snippet-runner" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
  kctl get workflowrecipe "$MANUAL_MCP_TIMEOUT_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
  exit 1
fi
assert_failed_status_matches "$MANUAL_MCP_TIMEOUT_NAME" "timeout|timed out|aborted|step-timeout" "manual MCP snippet timeout"

apply_recipe "$HYBRID_NAME" "$HYBRID_FILE"
if wait_for_labeled_pod_ready "$MCP_SERVER_NS" "clerum.io/recipe=${HYBRID_NAME},clerum.io/workload=mock-tools" 240; then
  ok "hybrid snippet MCP workload is ready"
else
  fail "hybrid snippet MCP workload did not become ready"
  exit 1
fi

HYBRID_ADMIN_TOKEN=$(require_admin_auth)
HYBRID_RUN_ID=$(trigger_workflow_as_admin "$HYBRID_NAME" "$HYBRID_ADMIN_TOKEN")
ok "hybrid snippet workflow triggered through admin onDemand run ${HYBRID_RUN_ID:0:8}"
if HYBRID_CHILD_NAME=$(wait_for_child_recipe_by_run_id "$HYBRID_RUN_ID" 180); then
  ok "hybrid snippet child WorkflowRecipe '${HYBRID_CHILD_NAME}' created for run ${HYBRID_RUN_ID:0:8}"
else
  fail "hybrid snippet child WorkflowRecipe was not created for run ${HYBRID_RUN_ID}"
  exit 1
fi
if wait_for_named_pod_ready "$SANDBOX_NS" "${HYBRID_CHILD_NAME}-mcp-host" 240; then
  ok "hybrid snippet workflow created mcp-host broker pod"
else
  fail "hybrid snippet workflow did not create ready mcp-host broker pod"
  exit 1
fi
assert_snippet_runner_contract "$HYBRID_CHILD_NAME"
assert_coordinator_snippet_contract "$HYBRID_CHILD_NAME"
if wait_for_phase "$HYBRID_CHILD_NAME" completed 420; then
  ok "hybrid snippet workflow completed"
else
  fail "hybrid snippet workflow did not complete"
  exit 1
fi
assert_status_contract "$HYBRID_CHILD_NAME" '{
  "executors": {"prepare":"snippet","agentic-review":"agentic","finalize":"snippet"},
  "outputContains": {"prepare":["prepared"],"agentic-review":["42"],"finalize":["prepared","42"]},
  "artifacts": ["hybrid-prepare.json","hybrid-agentic-summary.md"]
}'

cleanup_one "$SECRET_REF_NAME"
create_secret_ref_secret
kctl apply -f "$SECRET_REF_FILE" >/dev/null
ok "WorkflowRecipe '${SECRET_REF_NAME}' applied in ${RECIPE_NS}"
if kctl get workflowrecipe "$SECRET_REF_NAME" -n "$RECIPE_NS" -o yaml | grep -Fq "e2e-secret-token-value"; then
  fail "${SECRET_REF_NAME} leaked the Secret value into the WorkflowRecipe CRD"
  exit 1
fi
ok "${SECRET_REF_NAME} WorkflowRecipe stores only secretRef metadata, not Secret values"
assert_snippet_runner_contract "$SECRET_REF_NAME"
assert_coordinator_snippet_contract "$SECRET_REF_NAME"
assert_no_mcp_host "$SECRET_REF_NAME"
assert_snippet_secret_env_contract \
  "$SECRET_REF_NAME" \
  "vendor_api_key" \
  "$SECRET_REF_SECRET_NAME" \
  "apiKey"
if wait_for_phase "$SECRET_REF_NAME" completed 300; then
  ok "snippet secretRef workflow completed"
else
  fail "snippet secretRef workflow did not complete"
  kctl logs "${SECRET_REF_NAME}-snippet-runner" -n "$SANDBOX_NS" --tail=120 2>/dev/null || true
  exit 1
fi
assert_status_contract "$SECRET_REF_NAME" '{
  "executors": {"read-secret":"snippet"},
  "outputContains": {"read-secret":["secretRef","tokenPresent","tokenLength","tokenPrefix","e2e-"]},
  "artifacts": ["secret-ref-result.json"]
}'

apply_and_expect_failed \
  "$NEG_PLATFORM_NAME" \
  "$NEG_PLATFORM_FILE" \
  "cannot reference platform-managed secret" \
  "snippet platform-managed credential reference"

apply_and_expect_failed \
  "$NEG_MISSING_SECRET_NAME" \
  "$NEG_MISSING_SECRET_FILE" \
  "snippet secret .* was not found" \
  "snippet missing Kubernetes Secret reference"

apply_and_expect_failed \
  "$NEG_HTTP_EGRESS_NAME" \
  "$NEG_HTTP_EGRESS_FILE" \
  "HTTP host is not allowed" \
  "snippet HTTP call to undeclared host"

apply_and_expect_rejected \
  "$NEG_HTTP_ADMISSION_FILE" \
  "snippet HTTP .*allowedHosts must be declared in spec.runtimeEgress.http.allowedHosts" \
  "snippet HTTP host absent from runtimeEgress"

apply_and_expect_rejected \
  "$NEG_MCP_WILDCARD_FILE" \
  "snippet mcp allowedTools.include must not contain wildcards" \
  "snippet MCP wildcard allowedTools"

apply_and_expect_failed \
  "$NEG_UNDECLARED_POSTGRES_NAME" \
  "$NEG_UNDECLARED_POSTGRES_FILE" \
  "references undeclared postgres workload" \
  "snippet undeclared PostgreSQL workload"

apply_and_expect_failed \
  "$NEG_UNSAFE_ARTIFACT_NAME" \
  "$NEG_UNSAFE_ARTIFACT_FILE" \
  "unsafe artifact filename" \
  "snippet unsafe artifact filename"

print_results
