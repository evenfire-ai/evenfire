#!/usr/bin/env bash
# RED acceptance harness for Codex subscription runtime integration.
# GREEN is captured after Tasks 15–20. This script must fail on missing
# scope/path, not on an ambiguous Kubernetes context.
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
RUN_ID="$(date +%H%M%S)-$$"
HOST_NAME="e2e-codex-host-${RUN_ID}"
RECIPE_NAME="e2e-codex-recipe-${RUN_ID}"
UPSTREAM_NAME="e2e-codex-up-${RUN_ID}"
WORKDIR="$(mktemp -d)"
CLEANED=0

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  "${KUBECTL[@]}" delete host "$HOST_NAME" -n "$HOST_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  "${KUBECTL[@]}" delete workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  "${KUBECTL[@]}" delete deploy,svc,cm,secret -n "$CONTROL_NS" -l "e2e.clerum.io/run=${RUN_ID}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

if ! "${KUBECTL[@]}" get ns "$CONTROL_NS" >/dev/null 2>&1; then
  echo "codex_runtime: workload_missing" >&2
  exit 3
fi

WORKTREE_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
echo "codex_runtime: worktree=${ROOT} head=${WORKTREE_HEAD} context=${KUBECONTEXT}"

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
---
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${RECIPE_NS}
  labels:
    e2e.clerum.io/suite: codex-subscription
    e2e.clerum.io/run: "${RUN_ID}"
spec:
  workloads: []
  agent:
    model: gpt-5.3-codex
    provider: codex-subscription
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
  echo "codex_runtime: scope_missing (HCC did not emit llm:codex:execute)" >&2
  exit 1
fi

proxy_np="$("${KUBECTL[@]}" get networkpolicy -n "$HOST_NS" -l "clerum.io/host=${HOST_NAME}" -o name 2>/dev/null || true)"
if [[ "$proxy_np" != *codex* ]]; then
  echo "codex_runtime: policy_missing (HCC did not create Codex proxy egress)" >&2
  exit 1
fi

echo "codex_runtime: integration assertions passed"
