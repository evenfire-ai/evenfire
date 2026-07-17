#!/usr/bin/env bash
# Delete + recreate the research-summary-workflow recipe in minikube for
# end-to-end manual validation of the agentic workflow path:
#
#   CRD apply → WRC deploys workload+services → coordinator connects →
#   mcp-host executes step with web-search MCP → LLM streams → PDF output
#
# Model/timeout choices mirror the Control UI's "Agentic Workflow (PDF Report)"
# template shipped from `control-ui/components/RecipeEditor.tsx`. Per project
# convention for E2E tests (user directive 2026-04-23), agentic-flow recipes
# must use at minimum `glm-4.7` — a faster model would mask real-world
# latency characteristics (tool-use loops, LLM inference, streaming).
#
# Usage:
#   ./scripts/minikube/recreate-research-recipe.sh
#
#   # with a non-default context / namespace
#   CTX=clerum-test NS=sandbox-recipes ./scripts/minikube/recreate-research-recipe.sh

set -euo pipefail
umask 077

CTX="${CTX:-clerum-test}"
NS="${NS:-sandbox-recipes}"
RECIPE="${RECIPE:-research-summary-workflow}"

echo "[step] cleaning up previous incarnation ($CTX / $NS / $RECIPE)"
kubectl --context "$CTX" -n "$NS" delete workflowrecipe "$RECIPE" \
  --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
# Sweep orphan workload resources from the MCP namespace. Pre-Phase-8
# recipes left these behind when the CRD was deleted cross-namespace.
kubectl --context "$CTX" -n mcp-server get svc,deploy \
  -l "clerum.io/recipe=$RECIPE" -o name 2>/dev/null \
  | xargs -r kubectl --context "$CTX" -n mcp-server delete \
      --ignore-not-found=true --wait=false >/dev/null 2>&1 || true

sleep 5

echo "[step] applying recipe (model: glm-4.7, research-step timeout: 600s)"
cat <<YAML | kubectl --context "$CTX" apply -f -
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE}
  namespace: ${NS}
spec:
  # Agent model/timeout values mirror the Control UI template. NOT downgraded
  # for test convenience: per user directive (2026-04-23), E2E tests must
  # exercise the same LLM path as production (glm-4.7 minimum) so that
  # latency, streaming, and tool-use behavior match reality.
  agent:
    provider: zai
    model: glm-4.7
  triggers:
    onDemand:
      allowedActors: [user, autonomous]
  mcpServers:
    - id: web-search
  steps:
    - id: research
      instruction: |
        Research the following topic thoroughly using the web-search search
        tool: {{inputs.topic}}. Use DuckDuckGo search to find relevant results,
        collect key facts, recent developments, and important context.
      mcpServers: [web-search]
      allowedTools:
        include: [web-search__search]
      timeoutSeconds: 600
    - id: summarize
      instruction: |
        Using the following research results:

        {{research:output}}

        Produce a structured summary with: executive overview, key findings,
        timeline of events, and recommended next steps. Use markdown headings.
      dependsOn: [research]
      timeoutSeconds: 600
    - id: generate-report
      instruction: |
        You MUST call the clerum__generate_pdf tool to create the final report.

        filename: "research-summary.pdf"
        title: "Research Summary: {{inputs.topic}}"
        body:
        {{summarize:output}}
      allowedTools:
        include: [clerum__generate_pdf]
      dependsOn: [summarize]
      timeoutSeconds: 600
  output:
    name: research-summary
    destination: pvc
    format: pdf
    storageSize: 64Mi
  workloads:
    - id: web-search
      type: deployment
      image: ghcr.io/aas-ee/open-web-search:latest
      port: 3000
      transport:
        type: streamableHttp
      env:
        - { name: DEFAULT_SEARCH_ENGINE, value: duckduckgo }
        - { name: ALLOWED_SEARCH_ENGINES, value: duckduckgo }
        - { name: ENABLE_CORS, value: "true" }
      egressBindings:
        - { egressClass: public-web }
  inputContract:
    properties:
      topic:
        type: string
        default: "latest advances in multi-agent AI systems"
YAML

sleep 20

echo ""
echo "[step] post-apply state"
echo "--- CRD phase ---"
kubectl --context "$CTX" -n "$NS" get workflowrecipe "$RECIPE" \
  -o jsonpath='{.status.phase} / wfExec={.status.workflowExecution.phase}{"\n"}'

echo "--- workload resources in mcp-server ---"
kubectl --context "$CTX" -n mcp-server get deploy,svc \
  -l "clerum.io/recipe=$RECIPE" 2>&1 || true

echo "--- pods in $NS ---"
kubectl --context "$CTX" -n "$NS" get pods 2>&1 | grep -E "^NAME|$RECIPE" || true

echo ""
echo "[done] recipe recreated. Monitor progress with:"
echo "  kubectl --context $CTX -n $NS get workflowrecipe $RECIPE -w"
echo "  kubectl --context $CTX -n $NS logs ${RECIPE}-coordinator -f"
