#!/usr/bin/env bash
# Executes the revised platform E2E/security gates with mandatory minikube sync.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
KC="kubectl --context=${PROFILE}"

FROM_GATE=0
TO_GATE=10
EVIDENCE_DIR="${TMPDIR:-/tmp}/clerum-gates/$(date +%Y%m%d_%H%M%S)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)
      FROM_GATE="${2:?missing gate number}"
      shift 2
      ;;
    --to)
      TO_GATE="${2:?missing gate number}"
      shift 2
      ;;
    --evidence-dir)
      EVIDENCE_DIR="${2:?missing evidence dir}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

log() {
  printf '[gate-runner] %s\n' "$*"
}

run_pre_gate_sync() {
  "${PROJECT_DIR}/scripts/minikube/pre-gate-sync.sh" --gate "$1"
}

run_gate_0() {
  log "Gate 0 — cluster-free API hardening"
  npm --prefix "${PROJECT_DIR}/tests/e2e" install --no-audit --no-fund
  npm --prefix "${PROJECT_DIR}/tests/e2e" run test:rpc-proxy-e2e
  npm --prefix "${PROJECT_DIR}/tests/e2e" run test:external-rest-api-e2e
}

run_gate_1() {
  log "Gate 1 — bootstrap with Calico"
  (
    cd "${PROJECT_DIR}"
    make minikube-start
    make minikube-setup ARGS="--reset-db"
  )
  ${KC} get pods -n kube-system -l k8s-app=calico-node
}

run_gate_2() {
  log "Gate 2 — baseline evidence + seed"
  run_pre_gate_sync "Gate 2"
  mkdir -p "${EVIDENCE_DIR}/gate2"
  ${KC} get pods -A -o wide >"${EVIDENCE_DIR}/gate2/pods-wide.txt"
  ${KC} get networkpolicy -A >"${EVIDENCE_DIR}/gate2/networkpolicy.txt"
  ${KC} get svc kubernetes -o jsonpath='{.spec.clusterIP}' >"${EVIDENCE_DIR}/gate2/kubernetes-cluster-ip.txt"
  "${PROJECT_DIR}/scripts/minikube/pf-all-stack.sh"
  "${PROJECT_DIR}/scripts/minikube/seed-test-data.sh"
}

run_gate_3() {
  log "Gate 3 — functional happy path"
  run_pre_gate_sync "Gate 3"
  (
    cd "${PROJECT_DIR}"
    bash tests/e2e/e2e-approval-flow.sh
  )
  (
    cd "${PROJECT_DIR}/control-ui"
    npm test
  )
  (
    cd "${PROJECT_DIR}"
    make test-playwright-control-ui
  )
  (
    cd "${PROJECT_DIR}/desktop-app"
    npm test
    npm run build
    npm run test:e2e:all
  )
}

run_gate_4() {
  log "Gate 4 — cross-service integration + network"
  run_pre_gate_sync "Gate 4"
  (
    cd "${PROJECT_DIR}"
    make test-integration
  )
  (
    cd "${PROJECT_DIR}/workflow-recipes"
    npm test
    npm run test:e2e
  )
  (
    cd "${PROJECT_DIR}/tests/e2e"
    npx vitest run integration/network-policies.test.ts mcp-host/resilience.test.ts
  )
}

run_gate_5() {
  log "Gate 5 — existing CRD + registry hardening"
  run_pre_gate_sync "Gate 5"
  (
    cd "${PROJECT_DIR}"
    KUBECONTEXT="${PROFILE}" bash scripts/e2e/e2e-crd-field-injection.sh
    bash scripts/e2e/run-e2e-minikube-registry.sh
  )
}

run_gate_6() {
  log "Gate 6 — hostile WorkflowRecipe coverage"
  run_pre_gate_sync "Gate 6"
  (
    cd "${PROJECT_DIR}/workflow-recipes"
    npm test
    npm run test:e2e -- hostile-workflowrecipe.test.ts
  )
}

run_gate_7() {
  log "Gate 7 — remote MCP hardening"
  run_pre_gate_sync "Gate 7"
  (
    cd "${PROJECT_DIR}/control-ui"
    npm test
    npx playwright test e2e/registry-ssrf-attack.spec.ts
  )
}

run_gate_8() {
  log "Gate 8 — antagonistic LLM safety"
  run_pre_gate_sync "Gate 8"
  (
    cd "${PROJECT_DIR}/mcp-host"
    npm test
  )
  (
    cd "${PROJECT_DIR}/tests/e2e"
    npx vitest run mcp-host/native-tools.test.ts mcp-host/antagonistic-safety.test.ts
  )
}

run_gate_9() {
  log "Gate 9 — third-party escape probes"
  run_pre_gate_sync "Gate 9"
  (
    cd "${PROJECT_DIR}/workflow-recipes"
    npm run test:e2e -- escape-probes.test.ts
  )
  (
    cd "${PROJECT_DIR}/tests/e2e"
    npx vitest run integration/network-policies.test.ts
  )
  (
    cd "${PROJECT_DIR}"
    KUBECONTEXT="${PROFILE}" bash scripts/e2e/e2e-crd-field-injection.sh
  )
}

run_gate_10() {
  log "Gate 10 — admission bypass prevention"
  run_pre_gate_sync "Gate 10"
  (
    cd "${PROJECT_DIR}/workflow-recipes"
    npm run test:e2e -- admission.test.ts
  )
}

run_final_acceptance() {
  log "Final acceptance bundle"
  run_pre_gate_sync "Final acceptance"
  (
    cd "${PROJECT_DIR}"
    make test-unit-all
    make test-integration
    make test-e2e-all
    make test-playwright-control-ui
    cd desktop-app && npm run test:e2e:all
    make validate-all
  )
  "${PROJECT_DIR}/scripts/e2e/collect-cluster-evidence.sh" "${EVIDENCE_DIR}/final" >/dev/null
  log "Evidence written to ${EVIDENCE_DIR}"
}

for gate in $(seq "${FROM_GATE}" "${TO_GATE}"); do
  "run_gate_${gate}"
done

run_final_acceptance
