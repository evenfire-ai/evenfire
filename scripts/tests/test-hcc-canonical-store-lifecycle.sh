#!/usr/bin/env bash
# Hermetic wrapper/selection/ownership contracts, not runtime or browser proof.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
GATE="$ROOT/scripts/e2e/e2e-hcc-canonical-store-lifecycle.sh"
SCRATCH="$(mktemp -d /private/tmp/evf-cs-contract.XXXXXXXX)"
trap 'rm -rf -- "$SCRATCH"' EXIT
bash -n "$GATE" "$0"
node --check "$ROOT/scripts/e2e/_lib/canonical-store-api.mjs"
node --check "$ROOT/scripts/e2e/_lib/canonical-store-runtime-probe.cjs"
node --check "$ROOT/scripts/e2e/_lib/canonical-store-lifecycle.mjs"
bash "$GATE" --help > "$SCRATCH/help"
# A no-input or reused binding must stop BEFORE package/runtime/auth commands.
mkdir "$SCRATCH/bin"
for program in node kubectl curl; do
  cat > "$SCRATCH/bin/$program" <<'STUB'
#!/usr/bin/env bash
printf 'Unexpected operation\n' >> "$CONTRACT_TOUCHED"
exit 91
STUB
  chmod 700 "$SCRATCH/bin/$program"
done
export CONTRACT_TOUCHED="$SCRATCH/touched"
run_rejected() {
  if env PATH="$SCRATCH/bin:$PATH" E2E_CANONICAL_ACTIVE_LANE=api \
    E2E_CANONICAL_HOST_REF="$1" E2E_CANONICAL_HOST_UID="$2" E2E_CANONICAL_PVC_UID="$3" E2E_CANONICAL_RUN_ID="$4" \
    E2E_CANONICAL_UI_HOST_REF=ui-host E2E_CANONICAL_UI_HOST_UID=ui-uid E2E_CANONICAL_UI_PVC_UID=ui-pvc E2E_CANONICAL_UI_RUN_ID=30000000-0000-4000-8000-000000000002 \
    bash "$GATE" > "$SCRATCH/rejection" 2>&1; then echo 'Unsafe binding was accepted' >&2; exit 1; fi
  [ ! -e "$CONTRACT_TOUCHED" ] || { echo 'Invalid binding reached an operation' >&2; exit 1; }
}
run_rejected '' '' '' ''
run_rejected ui-host api-uid api-pvc 30000000-0000-4000-8000-000000000001
run_rejected api-host ui-uid api-pvc 30000000-0000-4000-8000-000000000001
run_rejected api-host api-uid ui-pvc 30000000-0000-4000-8000-000000000001
run_rejected api-host api-uid api-pvc 30000000-0000-4000-8000-000000000002
# API/UI and lifecycle evidence predicates are behavioral, with falsifiers.
node --test "$ROOT/scripts/tests/canonical-store-lifecycle-contract.test.mjs"
python3 - "$ROOT" <<'CHECK'
import sys
from pathlib import Path
root=Path(sys.argv[1])
source=(root/'Makefile').read_text(encoding='utf-8')
start=source.index('minikube-t2-hcc-canonical-store-lifecycle:')
end=source.find('\n.PHONY:',start+1)
block=source[start:end if end>=0 else len(source)]
for required in ['T2_REQUIRE_PLAYWRIGHT=true','T2_PLAYWRIGHT_COMMAND=', '--playwright',
                 'T2_HEALTHCHECK_COMMAND=', 'E2E_EXPECTED_PRE_GATE_GATE=minikube-t2',
                 'MINIKUBE_PROFILE', 'CONTROL_API_REAL_PG_CONTEXT', '1800', '300']:
    assert required in block, 'Canonical Make integration missing '+required
print('Canonical Make selection/required Playwright/deadline contract: PASS')
CHECK
python3 "$ROOT/tools/e2e_static_audit.py" \
  "$ROOT/desktop-app/test/e2e-playwright/canonical-store-lifecycle.spec.ts" \
  "$ROOT/desktop-app/test/e2e-playwright/canonicalStoreJourney.ts"
printf 'Canonical lifecycle shell contracts: PASS (hermetic only)\n'
