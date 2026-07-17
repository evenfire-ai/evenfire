#!/usr/bin/env bash
# Collects the evidence bundle required by the platform security gate plan.

set -euo pipefail

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
KC="kubectl --context=${PROFILE}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${1:-${TMPDIR:-/tmp}/clerum-gate-evidence/${STAMP}}"

mkdir -p "${OUT_DIR}"

${KC} get pods -A -o wide >"${OUT_DIR}/pods-wide.txt"
${KC} get networkpolicy -A -o yaml >"${OUT_DIR}/networkpolicy.yaml"
${KC} get svc kubernetes -o yaml >"${OUT_DIR}/kubernetes-service.yaml"
${KC} get networkpolicy -A >"${OUT_DIR}/networkpolicy-summary.txt"
${KC} get events -A --sort-by=.lastTimestamp >"${OUT_DIR}/events.txt" || true

printf '%s\n' "${OUT_DIR}"
