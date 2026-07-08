#!/usr/bin/env bash
# Upgrades example-dev from standalone mongodb-server McpServer to the full
# WorkflowRecipe stack: StatefulSet (PVC) + MCP Server + bindings.
#
# Idempotent: safe to re-run.
set -eo pipefail
umask 077

KCTX="${KUBECONTEXT:-gke_${GCP_PROJECT}_us-central1-a_example-dev}"
REGISTRY="us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum"
DB_SRC="mongodb/mongodb-community-server:7.0-ubi8"
DB_TARGET="$REGISTRY/mongodb-community-server:7.0-ubi8"
MCP_SRC="mongodb/mongodb-mcp-server:latest"
MCP_TARGET="$REGISTRY/mongodb-mcp-server:latest"
MCP_NS="mcp-server"
SANDBOX_NS="sandbox-recipes"
WORKFLOW_RECIPE_NS="$SANDBOX_NS"
CONTEXT_NAME="context1"
RECIPE_NAME="mongodb-mcp-stack"
OLD_MCPSERVER="mongodb-server"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RECIPE_YAML="$REPO_ROOT/workflow-recipes/samples/mongodb-mcp-stack.yaml"

log() { echo "[mongo-stack] $*" >&2; }

# ── 1. Mirror MongoDB community-server image ───────────────────────────
if gcloud artifacts docker images list "$REGISTRY" \
    --filter="package~mongodb-community-server" --format="value(package)" 2>/dev/null \
    | grep -q mongodb-community-server; then
  log "DB image already in AR — skipping mirror"
else
  log "Pulling $DB_SRC (amd64)"
  docker pull --platform=linux/amd64 "$DB_SRC"
  docker tag "$DB_SRC" "$DB_TARGET"
  gcloud auth configure-docker us-central1-docker.pkg.dev --quiet >/dev/null 2>&1 || true
  log "Pushing $DB_TARGET"
  docker push "$DB_TARGET"
fi

# ── 2. Mirror MCP image (no-op if prior setup-mongodb-mcp-dev.sh ran) ──
if gcloud artifacts docker images list "$REGISTRY" \
    --filter="package~mongodb-mcp-server" --format="value(package)" 2>/dev/null \
    | grep -q mongodb-mcp-server; then
  log "MCP image already in AR"
else
  log "Pulling $MCP_SRC"
  docker pull --platform=linux/amd64 "$MCP_SRC"
  docker tag "$MCP_SRC" "$MCP_TARGET"
  docker push "$MCP_TARGET"
fi

# ── 3. Delete standalone mongodb-server McpServer (conflicts with recipe) ─
if kubectl --context "$KCTX" -n "$MCP_NS" get mcpserver "$OLD_MCPSERVER" >/dev/null 2>&1; then
  log "Deleting standalone $OLD_MCPSERVER McpServer"
  kubectl --context "$KCTX" -n "$MCP_NS" delete mcpserver "$OLD_MCPSERVER" --ignore-not-found
else
  log "No standalone $OLD_MCPSERVER to clean"
fi

# ── 4. Apply WorkflowRecipe with AR image overrides + FQDN fix ─────────
# WRC in example-dev does not resolve {{mongodb:host}} — use explicit FQDN.
# (See CLAUDE.md > Known Issues: "use DNS FQDN instead of {{mongodb:clusterIP}}")
# Delete+recreate because WRC marks failed recipes as non-deployable and
# does not retry on spec change.
if kubectl --context "$KCTX" -n "$WORKFLOW_RECIPE_NS" get workflowrecipe "$RECIPE_NAME" >/dev/null 2>&1; then
  PHASE=$(kubectl --context "$KCTX" -n "$WORKFLOW_RECIPE_NS" get workflowrecipe "$RECIPE_NAME" -o jsonpath='{.status.phase}')
  if [[ "$PHASE" == "failed" ]]; then
    log "Recipe in failed phase — deleting to force reconcile"
    kubectl --context "$KCTX" -n "$WORKFLOW_RECIPE_NS" delete workflowrecipe "$RECIPE_NAME" --ignore-not-found --timeout=30s
    sleep 3
  fi
fi

log "Applying WorkflowRecipe $RECIPE_NAME with AR images + FQDN override"
sed \
  -e "s|image: $DB_SRC|image: $DB_TARGET|" \
  -e "s|image: $MCP_SRC|image: $MCP_TARGET|" \
  -e 's|mongodb://{{mongodb:host}}:{{mongodb:port}}/clerum|mongodb://mongodb.sandbox-recipes.svc.cluster.local:27017/clerum|' \
  "$RECIPE_YAML" | kubectl --context "$KCTX" apply -f -

# ── 4b. Patch security context on mongodb workload ────────────────────
# mongodb-community-server runs as UID 999; needs fsGroup to chown PVC
# and add-back capabilities for journal/chown operations.
log "Patching mongodb workload security context (UID 999 + fsGroup)"
kubectl --context "$KCTX" -n "$WORKFLOW_RECIPE_NS" patch workflowrecipe "$RECIPE_NAME" --type=json \
  -p='[{"op":"add","path":"/spec/workloads/0/security","value":{"runAsUser":999,"runAsGroup":999,"fsGroup":999,"addCapabilities":["CHOWN","FOWNER","DAC_OVERRIDE"]}}]' \
  2>&1 | tail -2 || log "WARN: security patch failed (may already be set)"

# ── 5. Wait for WRC + HCC to create StatefulSet + Deployment ───────────
log "Waiting 20s for WRC reconcile loop..."
sleep 20

# StatefulSet in sandbox-recipes
log "Waiting for StatefulSet mongodb (sandbox-recipes)..."
for i in {1..30}; do
  if kubectl --context "$KCTX" -n "$SANDBOX_NS" get statefulset mongodb >/dev/null 2>&1; then
    log "StatefulSet found after ${i}x3s"
    break
  fi
  sleep 3
done

if kubectl --context "$KCTX" -n "$SANDBOX_NS" get statefulset mongodb >/dev/null 2>&1; then
  kubectl --context "$KCTX" -n "$SANDBOX_NS" rollout status statefulset/mongodb --timeout=180s 2>&1 | tail -2 || true
else
  log "WARN: StatefulSet mongodb not created after 90s — check WRC logs"
  kubectl --context "$KCTX" -n control-plane logs -l app.kubernetes.io/name=workflow-recipes --tail=40 2>&1 | tail -40 || true
fi

# Find MCP Deployment — WRC may name it <recipe>-<workload> or just <workload>
log "Detecting MCP Deployment name..."
MCP_DEPLOY=""
for candidate in "mongodb-mcp-server" "${RECIPE_NAME}-mongodb-mcp-server" "mcp-${RECIPE_NAME}-mongodb-mcp-server"; do
  if kubectl --context "$KCTX" -n "$MCP_NS" get deployment "$candidate" >/dev/null 2>&1; then
    MCP_DEPLOY="$candidate"
    log "Found MCP Deployment: $MCP_DEPLOY"
    break
  fi
done

if [[ -z "$MCP_DEPLOY" ]]; then
  log "WARN: MCP Deployment not found. Listing deployments in $MCP_NS:"
  kubectl --context "$KCTX" -n "$MCP_NS" get deployments 2>&1 | tail -20
else
  kubectl --context "$KCTX" -n "$MCP_NS" rollout status deployment/"$MCP_DEPLOY" --timeout=180s 2>&1 | tail -2 || true
fi

# Find McpServer CRD name (for context1 allowlist)
MCP_CRD_NAME=""
for candidate in "mongodb-mcp-server" "${RECIPE_NAME}-mongodb-mcp-server" "mcp-${RECIPE_NAME}-mongodb-mcp-server"; do
  if kubectl --context "$KCTX" -n "$MCP_NS" get mcpserver "$candidate" >/dev/null 2>&1; then
    MCP_CRD_NAME="$candidate"
    log "Found McpServer CRD: $MCP_CRD_NAME"
    break
  fi
done

if [[ -z "$MCP_CRD_NAME" ]]; then
  log "WARN: McpServer CRD not found. Listing McpServers:"
  kubectl --context "$KCTX" -n "$MCP_NS" get mcpservers 2>&1 | tail -20
  exit 1
fi

# ── 6. Update context1 allowlist ───────────────────────────────────────
log "Reading current context1 allowlist..."
CURRENT=$(kubectl --context "$KCTX" -n "$MCP_NS" get context "$CONTEXT_NAME" -o jsonpath='{.spec.mcpServers}')
log "Current: $CURRENT"

# Build new list: keep everything except old mongodb-server, ensure new name present
NEW_LIST=$(echo "$CURRENT" | python3 -c "
import json, sys
arr = json.loads(sys.stdin.read() or '[]')
arr = [x for x in arr if x != '$OLD_MCPSERVER']
if '$MCP_CRD_NAME' not in arr:
    arr.append('$MCP_CRD_NAME')
print(json.dumps(arr))
")
log "New: $NEW_LIST"

kubectl --context "$KCTX" -n "$MCP_NS" patch context "$CONTEXT_NAME" --type=json \
  -p="[{\"op\":\"replace\",\"path\":\"/spec/mcpServers\",\"value\":$NEW_LIST}]"

# ── 7. Rollout chatllm ────────────────────────────────────────────────
log "Rolling chatllm for re-discovery"
kubectl --context "$KCTX" -n mcp-host rollout restart deployment/chatllm >/dev/null
kubectl --context "$KCTX" -n mcp-host rollout status deployment/chatllm --timeout=120s 2>&1 | tail -2

# ── 8. Validate chatllm discovery ──────────────────────────────────────
log "Validating chatllm discovery..."
sleep 8
POD=$(kubectl --context "$KCTX" -n mcp-host get pods -l app=chatllm \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
echo "--- chatllm MCP init summary ---"
kubectl --context "$KCTX" -n mcp-host logs "$POD" --tail=200 2>&1 \
  | grep -iE "Found [0-9]+ McpServer|Connecting to|Connected successfully|Added server|Connected to [0-9]+ MCP|Total tools available|error|failed" \
  | head -40
echo "--- end ---"

log "Done."
