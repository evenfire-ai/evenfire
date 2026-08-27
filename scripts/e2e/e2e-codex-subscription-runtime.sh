#!/usr/bin/env bash
# Codex subscription runtime acceptance harness. Two load-bearing phases:
#
# Phase A — hermetic transport path (host-side, no cluster writes):
#   Runs codex-llm-proxy/test/runtimePath.hermetic.e2e.test.ts, which drives
#   authorize (mocked control-api redeem keyed by the recipe-level grant
#   identity) → the REAL proxy runtime listener → the REAL fixture ChatGPT
#   upstream (tests/e2e/fixtures/codex-subscription/test-upstream/server.mjs,
#   spawned over TLS on loopback) → finalize, asserting the success receipt,
#   usage, and the fail-closed `no_grant` denial for an unassigned recipe.
#   No live ChatGPT OAuth is involved anywhere.
#
# Phase B — in-cluster projection path (branch-owned local profile only):
#   Seeds the published allowlist ConfigMap with a CONNECTED test grant
#   (multi-connection annotation) offering gpt-5.3-codex, binds the e2e Host
#   to that grant via spec.model.connectionRef (never `unassigned`, never an
#   invented `deployment-default`), stamps the WorkflowRecipe with the
#   `clerum.io/codex-connection-ref` grant annotation, and asserts HCC
#   projected `llm:codex:execute` plus the Codex proxy egress NetworkPolicy.
#   These assertions are load-bearing: with the grant removed or unassigned,
#   HCC fails closed and the scope is not emitted. The prior ConfigMap is
#   restored on exit.
#
# Remaining documented gap: the in-cluster authorize → proxy → upstream →
# finalize hop is NOT driven here, because redemption requires live
# control-api grant/credential rows (created only through the real OAuth
# connect flow) and the proxy origin policy freezes https://chatgpt.com. That
# transport hop is certified hermetically by Phase A against the same fixture
# upstream this script deploys in-cluster. Do not weaken the origin policy or
# invent live OAuth to close this gap.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../deploy/scripts/lib/clerum-minikube-context.sh
source "${ROOT}/deploy/scripts/lib/clerum-minikube-context.sh"

if [[ -z "${KUBECONTEXT:-}" ]]; then
  echo "codex_runtime: missing KUBECONTEXT" >&2
  exit 2
fi
export CONTEXT="$KUBECONTEXT"
if ! is_clerum_minikube_context; then
  echo "codex_runtime: refusing non-local context ${KUBECONTEXT}" >&2
  exit 2
fi

KUBECTL=(kubectl --context "$KUBECONTEXT")
HOST_NS="${HOST_NS:-mcp-host}"
RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
CONTROL_NS="${CONTROL_NS:-control-plane}"
ALLOWLIST_CM="clerum-llm-allowed-models"
RUN_ID="$(date +%H%M%S)-$$"
HOST_NAME="e2e-codex-host-${RUN_ID}"
RECIPE_NAME="e2e-codex-recipe-${RUN_ID}"
UPSTREAM_NAME="e2e-codex-up-${RUN_ID}"
GRANT_KEY="e2e-team-plus-${RUN_ID}"
WORKDIR="$(mktemp -d)"
CLEANED=0
ALLOWLIST_BACKED_UP=0

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  "${KUBECTL[@]}" delete host "$HOST_NAME" -n "$HOST_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  "${KUBECTL[@]}" delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  "${KUBECTL[@]}" delete deploy,svc,cm,secret -n "$CONTROL_NS" -l "e2e.clerum.io/run=${RUN_ID}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # Restore the published allowlist ConfigMap exactly as found (or remove the
  # seeded one when none existed) so the branch profile keeps its state.
  if [[ "$ALLOWLIST_BACKED_UP" -eq 1 ]]; then
    if [[ -s "${WORKDIR}/allowlist-backup.json" ]]; then
      "${KUBECTL[@]}" -n "$HOST_NS" delete configmap "$ALLOWLIST_CM" --ignore-not-found >/dev/null 2>&1 || true
      "${KUBECTL[@]}" -n "$HOST_NS" create -f "${WORKDIR}/allowlist-backup.json" >/dev/null 2>&1 || true
    else
      "${KUBECTL[@]}" -n "$HOST_NS" delete configmap "$ALLOWLIST_CM" --ignore-not-found >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

WORKTREE_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
echo "codex_runtime: worktree=${ROOT} head=${WORKTREE_HEAD} context=${KUBECONTEXT}"

# ─── Phase A: hermetic authorize → proxy → fixture upstream → finalize ──────
if [[ ! -d "${ROOT}/codex-llm-proxy/node_modules" ]]; then
  echo "codex_runtime: dependency_missing (run npm ci in codex-llm-proxy first)" >&2
  exit 2
fi
echo "codex_runtime: phase A (hermetic proxy transport) starting"
if ! (cd "${ROOT}/codex-llm-proxy" && npx vitest run test/runtimePath.hermetic.e2e.test.ts); then
  echo "codex_runtime: transport_failed (hermetic authorize→proxy→upstream→finalize)" >&2
  exit 1
fi
echo "codex_runtime: phase A passed"

# ─── Phase B: in-cluster grant projection ────────────────────────────────────
if ! "${KUBECTL[@]}" get ns "$CONTROL_NS" >/dev/null 2>&1; then
  echo "codex_runtime: workload_missing" >&2
  exit 3
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "${WORKDIR}/tls.key" \
  -out "${WORKDIR}/tls.crt" \
  -subj "/CN=${UPSTREAM_NAME}.control-plane.svc" >/dev/null 2>&1

"${KUBECTL[@]}" -n "$CONTROL_NS" create secret tls "${UPSTREAM_NAME}-tls" \
  --cert="${WORKDIR}/tls.crt" --key="${WORKDIR}/tls.key" >/dev/null
"${KUBECTL[@]}" -n "$CONTROL_NS" label secret "${UPSTREAM_NAME}-tls" \
  "e2e.clerum.io/suite=codex-subscription" "e2e.clerum.io/run=${RUN_ID}" >/dev/null

"${KUBECTL[@]}" -n "$CONTROL_NS" create configmap "${UPSTREAM_NAME}-source" \
  --from-file=server.mjs="${ROOT}/tests/e2e/fixtures/codex-subscription/test-upstream/server.mjs" >/dev/null
"${KUBECTL[@]}" -n "$CONTROL_NS" label configmap "${UPSTREAM_NAME}-source" \
  "e2e.clerum.io/suite=codex-subscription" "e2e.clerum.io/run=${RUN_ID}" >/dev/null

sed -e "s/\${UPSTREAM_NAME}/${UPSTREAM_NAME}/g" -e "s/\${RUN_ID}/${RUN_ID}/g" \
  "${ROOT}/tests/e2e/fixtures/codex-subscription/test-upstream/manifest.yaml" \
  | "${KUBECTL[@]}" apply -f - >/dev/null

# Snapshot the current published allowlist so cleanup restores it verbatim.
if "${KUBECTL[@]}" -n "$HOST_NS" get configmap "$ALLOWLIST_CM" >/dev/null 2>&1; then
  "${KUBECTL[@]}" -n "$HOST_NS" get configmap "$ALLOWLIST_CM" -o json \
    | python3 -c '
import json, sys
cm = json.load(sys.stdin)
meta = cm.get("metadata", {})
for key in ("resourceVersion", "uid", "creationTimestamp", "managedFields", "generation"):
    meta.pop(key, None)
print(json.dumps(cm))
' > "${WORKDIR}/allowlist-backup.json"
else
  : > "${WORKDIR}/allowlist-backup.json"
fi
ALLOWLIST_BACKED_UP=1

# Seed a CONNECTED test grant. The grant is CREATED here (published catalog),
# and the Host/recipe below only CHOOSE it — the same lock production follows.
"${KUBECTL[@]}" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${ALLOWLIST_CM}
  namespace: ${HOST_NS}
  annotations:
    clerum.io/codex-enabled: "true"
    clerum.io/catalog-revision: "1"
    clerum.io/connection-revision: "1"
    clerum.io/codex-connection-status: connected
    clerum.io/codex-connections: '{"${GRANT_KEY}":{"status":"connected","catalogRevision":1,"connectionRevision":1,"models":["gpt-5.3-codex"]}}'
data:
  codex-subscription: '[{"model":"gpt-5.3-codex"}]'
YAML

"${KUBECTL[@]}" apply -f - >/dev/null <<YAML
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: ${HOST_NAME}
  namespace: ${HOST_NS}
  labels:
    e2e.clerum.io/suite: codex-subscription
    e2e.clerum.io/run: "${RUN_ID}"
spec:
  host: ${HOST_NAME}
  contextRef: context1
  model:
    provider: codex-subscription
    name: gpt-5.3-codex
    connectionRef: ${GRANT_KEY}
---
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${RECIPE_NS}
  labels:
    e2e.clerum.io/suite: codex-subscription
    e2e.clerum.io/run: "${RUN_ID}"
  annotations:
    clerum.io/codex-connection-ref: ${GRANT_KEY}
spec:
  workloads: []
  agent:
    model: gpt-5.3-codex
    provider: codex-subscription
  triggers:
    onDemand: {}
  steps:
    - id: ping
      instruction: Say hello through Codex subscription
YAML

secret_name="host-${HOST_NAME}-mcp-host-runtime-tokens"
deadline=$((SECONDS + 90))
while (( SECONDS < deadline )); do
  if "${KUBECTL[@]}" get secret "$secret_name" -n "$HOST_NS" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! "${KUBECTL[@]}" get secret "$secret_name" -n "$HOST_NS" >/dev/null 2>&1; then
  echo "codex_runtime: scope_missing (runtime token secret was not issued)" >&2
  exit 1
fi

token_b64="$("${KUBECTL[@]}" get secret "$secret_name" -n "$HOST_NS" \
  -o jsonpath='{.data.mcp-host-workflow-control-token}')"
claims="$(python3 -c '
import base64, json, sys
raw = sys.argv[1].strip()
if not raw:
    print(json.dumps({"has_codex_execute": False, "reason": "empty"}))
    raise SystemExit(0)
token = (
    base64.b64decode(raw).decode("utf-8")
)
payload = token.split(".")[1]
payload += "=" * (-len(payload) % 4)
data = json.loads(base64.urlsafe_b64decode(payload))
scopes = data.get("scp") or data.get("scope") or []
if isinstance(scopes, str):
    scopes = scopes.split()
print(json.dumps({
    "has_codex_execute": "llm:codex:execute" in scopes,
    "scope_count": len(scopes),
    "aud": data.get("aud"),
    "typ": data.get("typ"),
}))
' "$token_b64")"

echo "codex_runtime: redacted_claims=${claims}"
if ! python3 -c 'import json,sys; raise SystemExit(0 if json.loads(sys.argv[1]).get("has_codex_execute") else 1)' "$claims"; then
  echo "codex_runtime: scope_missing (HCC did not emit llm:codex:execute for the connected grant)" >&2
  exit 1
fi

proxy_np="$("${KUBECTL[@]}" get networkpolicy -n "$HOST_NS" -l "clerum.io/host=${HOST_NAME}" -o name 2>/dev/null || true)"
if [[ "$proxy_np" != *codex* ]]; then
  echo "codex_runtime: policy_missing (HCC did not create Codex proxy egress)" >&2
  exit 1
fi

# Claim 1 identity round-trip: the recipe-level grant annotation must survive
# in the API server exactly as written, because control-api attests the grant
# by reading it back from the recipe named in hostRef.
recipe_grant="$("${KUBECTL[@]}" get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" \
  -o jsonpath='{.metadata.annotations.clerum\.io/codex-connection-ref}')"
if [[ "$recipe_grant" != "$GRANT_KEY" ]]; then
  echo "codex_runtime: grant_annotation_missing (recipe grant identity did not round-trip)" >&2
  exit 1
fi

echo "codex_runtime: integration assertions passed (grant=${GRANT_KEY})"
