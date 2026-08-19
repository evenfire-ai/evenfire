#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — CRD Field Injection Prevention
# ═══════════════════════════════════════════════════════════════════════
# Verifies that developer-supplied CRDs cannot influence platform-controlled
# deployment behavior. Creates McpServer CRDs with dangerous fields and
# asserts the resulting Deployments have platform-safe values.
#
# Prerequisites:
#   minikube running, HCC deployed with sanitizeCrdSpec().
#   Set KUBECONTEXT to target a branch-scoped minikube profile.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

MCP_NS="mcp-server"
E2E_RESOURCE_NAMES=(
  e2e-sec-pullpolicy
  e2e-sec-rootuid
  e2e-sec-caps-forbidden
  e2e-sec-caps-safe
  e2e-sec-envvars
  e2e-sec-uid70
)

cleanup_e2e_resources() {
  kctl delete mcpserver -n "$MCP_NS" -l "clerum.io/e2e-security=true" --ignore-not-found 2>/dev/null || true
  kctl delete deployment,service -n "$MCP_NS" "${E2E_RESOURCE_NAMES[@]}" \
    --ignore-not-found --wait=true --timeout=60s 2>/dev/null || true
}

ensure_e2e_resources_absent() {
  wait_for_named_resources_deleted "$MCP_NS" mcpserver "$TIMEOUT_DELETE" "${E2E_RESOURCE_NAMES[@]}" &&
    wait_for_named_resources_deleted "$MCP_NS" deployment "$TIMEOUT_DELETE" "${E2E_RESOURCE_NAMES[@]}" &&
    wait_for_named_resources_deleted "$MCP_NS" service "$TIMEOUT_DELETE" "${E2E_RESOURCE_NAMES[@]}"
}

assert_mcpserver_absent() {
  local name=$1
  local output
  if output=$(kctl get mcpserver "$name" -n "$MCP_NS" 2>&1); then
    fail "McpServer ${name} exists — rejected spec leaked past admission"
    return
  fi
  echo "$output" | grep -Eqi "notfound|not found" &&
    ok "McpServer ${name} does not exist (correctly rejected)" ||
    fail "Could not verify McpServer ${name} absence: ${output}"
}

header "E2E: CRD Field Injection Prevention"
require_safe_kube_context || exit 1

# ─── Cleanup from previous runs ──────────────────────────────────────
cleanup_e2e_resources
ensure_e2e_resources_absent ||
  fail "Stale e2e-sec resources remain after cleanup; refusing stale-positive E2E run"
# shellcheck disable=SC2154 # e2e-lib.sh owns the shared result counters.
[ "$e2e_fail" -gt 0 ] && exit 1

# ═══ Test 1: imagePullPolicy override prevention ═════════════════════
header "Test 1: imagePullPolicy override"

cat <<EOF | kctl apply -f -
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: e2e-sec-pullpolicy
  namespace: $MCP_NS
  labels:
    clerum.io/e2e-security: "true"
spec:
  image: clerum/mock-mcp-server:test
  imagePullPolicy: Always
  contextRef: context1
  transport:
    type: streamableHttp
    port: 3000
    url: http://e2e-sec-pullpolicy.mcp-server.svc:3000/mcp
EOF

if wait_for_deployment "$MCP_NS" e2e-sec-pullpolicy "$TIMEOUT_POD"; then
  ok "imagePullPolicy fixture rendered a ready Deployment"
else
  fail "imagePullPolicy fixture did not render a ready Deployment"
fi

PULL_POLICY=$(kctl get deployment e2e-sec-pullpolicy -n "$MCP_NS" \
  -o jsonpath='{.spec.template.spec.containers[0].imagePullPolicy}' 2>/dev/null || echo "NOT_FOUND")

[ "$PULL_POLICY" = "IfNotPresent" ] && ok "imagePullPolicy forced to IfNotPresent (CRD said Always)" \
  || fail "imagePullPolicy is '$PULL_POLICY' — platform override FAILED"

# ═══ Test 2: root UID prevention (CRD admission) ════════════════════
header "Test 2: Root UID prevention (CRD schema validation)"

# The CRD OpenAPI schema has minimum: 1 for runAsUser.
# K8s should REJECT the CRD at admission — it never reaches HCC.
APPLY_RESULT=$(cat <<EOF | kctl apply -f - 2>&1; echo "EXIT:$?"
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: e2e-sec-rootuid
  namespace: $MCP_NS
  labels:
    clerum.io/e2e-security: "true"
spec:
  image: clerum/mock-mcp-server:test
  contextRef: context1
  transport:
    type: streamableHttp
    port: 3000
    url: http://e2e-sec-rootuid.mcp-server.svc:3000/mcp
  security:
    runAsUser: 0
    runAsGroup: 0
    fsGroup: 0
EOF
)

echo "$APPLY_RESULT" | grep -q "Invalid value\|EXIT:1" \
  && ok "CRD admission rejected runAsUser:0 (minimum: 1 enforced by schema)" \
  || fail "CRD with runAsUser:0 was ACCEPTED — schema validation BROKEN"

# Verify the CRD was NOT created
assert_mcpserver_absent e2e-sec-rootuid

# ═══ Test 3: Linux capabilities admission + rendering ═══════════════
header "Test 3: Linux capabilities admission + rendering"

APPLY_RESULT=$(cat <<EOF | kctl apply -f - 2>&1; echo "EXIT:$?"
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: e2e-sec-caps-forbidden
  namespace: $MCP_NS
  labels:
    clerum.io/e2e-security: "true"
spec:
  image: clerum/mock-mcp-server:test
  contextRef: context1
  transport:
    type: streamableHttp
    port: 3000
    url: http://e2e-sec-caps-forbidden.mcp-server.svc:3000/mcp
  security:
    runAsUser: 1000
    addCapabilities:
      - SETUID
      - SETGID
      - SYS_CHROOT
      - KILL
      - AUDIT_WRITE
      - SYS_ADMIN
EOF
)

APPLY_EXIT=$(printf "%s\n" "$APPLY_RESULT" | sed -n 's/^EXIT://p' | tail -1)
APPLY_OUTPUT=$(printf "%s\n" "$APPLY_RESULT" | sed '/^EXIT:/d')
if [ "$APPLY_EXIT" != "0" ] &&
  echo "$APPLY_OUTPUT" | grep -Eq "Unsupported value.*(SETUID|SETGID|SYS_CHROOT|KILL|AUDIT_WRITE|SYS_ADMIN)|(SETUID|SETGID|SYS_CHROOT|KILL|AUDIT_WRITE|SYS_ADMIN).*Unsupported value|Invalid value.*(SETUID|SETGID|SYS_CHROOT|KILL|AUDIT_WRITE|SYS_ADMIN)|(SETUID|SETGID|SYS_CHROOT|KILL|AUDIT_WRITE|SYS_ADMIN).*Invalid value"; then
  ok "CRD admission rejected forbidden Linux capabilities for the expected enum reason"
else
  fail "McpServer with forbidden Linux capabilities was not rejected for the expected reason: ${APPLY_OUTPUT}"
fi

assert_mcpserver_absent e2e-sec-caps-forbidden

cat <<EOF | kctl apply -f -
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: e2e-sec-caps-safe
  namespace: $MCP_NS
  labels:
    clerum.io/e2e-security: "true"
spec:
  image: clerum/mock-mcp-server:test
  contextRef: context1
  transport:
    type: streamableHttp
    port: 3000
    url: http://e2e-sec-caps-safe.mcp-server.svc:3000/mcp
  security:
    runAsUser: 1000
    addCapabilities:
      - CHOWN
      - FOWNER
EOF

wait_for_deployment "$MCP_NS" e2e-sec-caps-safe "$TIMEOUT_POD" \
  && ok "Safe-capability McpServer rendered a Deployment" \
  || fail "Safe-capability McpServer did not render a ready Deployment"

# Kubectl JSONPath filter expressions serialize these string arrays as JSON-like
# values here, for example ["ALL"], unlike simple array paths that print [ALL].
CAPS=$(kctl get deployment e2e-sec-caps-safe -n "$MCP_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="mcp-server")].securityContext.capabilities.add}' 2>/dev/null || true)
DROP=$(kctl get deployment e2e-sec-caps-safe -n "$MCP_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="mcp-server")].securityContext.capabilities.drop}' 2>/dev/null || true)
APE=$(kctl get deployment e2e-sec-caps-safe -n "$MCP_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="mcp-server")].securityContext.allowPrivilegeEscalation}' 2>/dev/null || true)
[ -n "$APE" ] \
  || fail "Safe-capability mcp-server container securityContext was not found"

[ "$APE" = "false" ] && ok "Safe-capability container keeps allowPrivilegeEscalation=false" \
  || fail "Safe-capability container allowPrivilegeEscalation is '$APE'"
[ "$DROP" = '["ALL"]' ] && ok "Safe-capability container drops exactly ALL capabilities" \
  || fail "Safe-capability container drop set is '$DROP'"
[ "$CAPS" = '["CHOWN","FOWNER"]' ] && ok "Safe capabilities rendered exactly as CHOWN,FOWNER" \
  || fail "Safe-capability add set is '$CAPS'"

# ═══ Test 4: dangerous env var stripping ═════════════════════════════
header "Test 4: Dangerous env var stripping"

cat <<EOF | kctl apply -f -
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: e2e-sec-envvars
  namespace: $MCP_NS
  labels:
    clerum.io/e2e-security: "true"
spec:
  image: clerum/mock-mcp-server:test
  contextRef: context1
  transport:
    type: streamableHttp
    port: 3000
    url: http://e2e-sec-envvars.mcp-server.svc:3000/mcp
  env:
    - name: LD_PRELOAD
      value: /tmp/evil.so
    - name: PATH
      value: /tmp/evil
    - name: NODE_OPTIONS
      value: "--require /tmp/evil.js"
    - name: SAFE_CONFIG
      value: ok
    - name: DATABASE_URL
      value: postgres://safe
EOF

if wait_for_deployment "$MCP_NS" e2e-sec-envvars "$TIMEOUT_POD"; then
  ok "Dangerous-env fixture rendered a ready Deployment"
else
  fail "Dangerous-env fixture did not render a ready Deployment"
fi

ENV_JSON=$(kctl get deployment e2e-sec-envvars -n "$MCP_NS" \
  -o jsonpath='{.spec.template.spec.containers[0].env}' 2>/dev/null || echo "[]")

echo "$ENV_JSON" | grep -q "LD_PRELOAD" && fail "LD_PRELOAD NOT stripped" || ok "LD_PRELOAD stripped"
echo "$ENV_JSON" | grep -q '"PATH"' && fail "PATH NOT stripped" || ok "PATH stripped"
echo "$ENV_JSON" | grep -q "NODE_OPTIONS" && fail "NODE_OPTIONS NOT stripped" || ok "NODE_OPTIONS stripped"
echo "$ENV_JSON" | grep -q "SAFE_CONFIG" && ok "SAFE_CONFIG preserved" || fail "SAFE_CONFIG was stripped"
echo "$ENV_JSON" | grep -q "DATABASE_URL" && ok "DATABASE_URL preserved" || fail "DATABASE_URL was stripped"

# ═══ Test 5: legitimate non-root UID preserved ═══════════════════════
header "Test 5: Legitimate non-root UID preserved"

cat <<EOF | kctl apply -f -
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: e2e-sec-uid70
  namespace: $MCP_NS
  labels:
    clerum.io/e2e-security: "true"
spec:
  image: clerum/mock-mcp-server:test
  contextRef: context1
  transport:
    type: streamableHttp
    port: 3000
    url: http://e2e-sec-uid70.mcp-server.svc:3000/mcp
  security:
    runAsUser: 70
    runAsGroup: 70
    fsGroup: 70
    addCapabilities:
      - CHOWN
      - FOWNER
      - DAC_OVERRIDE
EOF

if wait_for_deployment "$MCP_NS" e2e-sec-uid70 "$TIMEOUT_POD"; then
  ok "Non-root UID fixture rendered a ready Deployment"
else
  fail "Non-root UID fixture did not render a ready Deployment"
fi

UID_70=$(kctl get deployment e2e-sec-uid70 -n "$MCP_NS" \
  -o jsonpath='{.spec.template.spec.securityContext.runAsUser}' 2>/dev/null || echo "NOT_FOUND")

[ "$UID_70" = "70" ] && ok "Non-root UID 70 preserved (postgres pattern)" \
  || fail "UID 70 was not preserved: got '$UID_70'"

# ═══ Cleanup ═════════════════════════════════════════════════════════
header "Cleanup"
cleanup_e2e_resources

ensure_e2e_resources_absent && ok "All e2e-sec resources cleaned up" || fail "e2e-sec resources remain"

# ═══ Summary ═════════════════════════════════════════════════════════
header "Summary"
# shellcheck disable=SC2154 # e2e-lib.sh owns the shared result counters.
echo -e "  ${GREEN}PASS${NC}: ${e2e_pass}  ${RED}FAIL${NC}: ${e2e_fail}  Total: ${e2e_total}"
[ "$e2e_fail" -gt 0 ] && exit 1 || exit 0
