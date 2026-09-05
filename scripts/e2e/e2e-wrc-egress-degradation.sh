#!/usr/bin/env bash
# Admission-only entry point. The Node runner owns the reversible lifecycle;
# this product E2E is not T2.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
# shellcheck source=e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck source=_lib/hcc-watch-recovery-fixture.sh
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"
die() { printf '[wrc-egress-degradation] %s\n' "$*" >&2; exit 1; }
RECOVER=false
if [[ "${1:-}" == --recover && "$#" -eq 1 ]]; then
  RECOVER=true
elif [[ "$#" -ne 0 ]]; then
  die 'usage: e2e-wrc-egress-degradation.sh [--recover]'
fi
[[ -n "$E2E_KUBECONTEXT" && "${MINIKUBE_PROFILE:-}" == "$E2E_KUBECONTEXT" ]] || die 'explicit matching branch profile/context required'
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || die 'non-branch context refused'
require_safe_kube_context
[[ "${T2_PROJECT_DIR:-}" == "$ROOT" && "${T2_CONTEXT:-}" == "$E2E_KUBECONTEXT" && "${T2_PROFILE:-}" == "$E2E_KUBECONTEXT" ]] || die 'inherited lease target differs from gate'
# No mutation or cleanup handler exists before the live lease is proved.
bash "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh"
export KUBECONTEXT="$E2E_KUBECONTEXT"
if [[ "$RECOVER" == true ]]; then
  exec node "${SCRIPT_DIR}/_lib/wrc-egress-gate.cjs" --recover
fi
[[ "${E2E_WRC_EGRESS_FAULT_INJECTION:-0}" == 1 ]] || die 'explicit fault-injection acknowledgement required'
# Bound every read made by the historical exact-head validator.
kctl() {
  node "${ROOT}/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds 20 --kill-grace-seconds 2 --heartbeat-seconds 20 \
    --label wrc-egress-admission -- kubectl --context="$E2E_KUBECONTEXT" --request-timeout=15s "$@"
}
require_branch_owned_hcc_gate "${WRC_NAMESPACE:-control-plane}"
# The old helper checks HEAD/fingerprint, but not image acquisition freshness.
manifest="${T2_IMAGE_MANIFEST:-${ROOT}/deploy/minikube/.image-manifest.json}"
[[ -r "$manifest" ]] || die 'image manifest missing'
manifest_stamp="$(jq -er '.generated | select(type == "string" and length > 0)' "$manifest")"
marker_stamp="$(jq -er '.data.imagesGeneratedAt | select(type == "string" and length > 0)' <<<"$HCC_BRANCH_GATE_SYNC_MARKER")"
[[ "$manifest_stamp" == "$marker_stamp" ]] || die 'image stamp differs from deployed marker'
exec node "${SCRIPT_DIR}/_lib/wrc-egress-gate.cjs"
