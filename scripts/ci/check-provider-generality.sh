#!/usr/bin/env bash
set -euo pipefail
# issue #299 Phase 2 — generality invariant (grep-gate).
#
# Provider names may live ONLY in the registry DATA module, the per-provider
# fetcher plugins, the vendored seed, fixtures, and tests. They must NEVER
# appear in the provider-blind pipeline: the pure core, the adapters, the
# reconcilers, the render/write path, or the admission validators.
#
# The forbidden-name set is DERIVED from the registry data module
# (packages/network-policy-core/providerRegistry.cjs → `providerNames`), the
# single source of truth. Adding a provider is a data row there and nothing
# else — this gate then covers the new name automatically, with zero edit here.
# (The generality invariant applied to the gate itself: no hardcoded per-
# provider list lives in this general layer.)
#
# Matching uses word boundaries (\b...\b): a substring match would false-positive
# on legitimate identifiers that merely CONTAIN a provider name (e.g.
# "legacyRawStatefulSet" contains "aws"). Word boundaries catch provider names
# as tokens — which is what "a provider name appears" means — and leave such
# identifiers alone.

# Run from the repo root regardless of caller CWD.
cd "$(dirname "$0")/../.."

# Derive the forbidden name set from the registry (single source of truth).
NAMES=$(node -e 'const r = require("./packages/network-policy-core/providerRegistry.cjs"); if (!Array.isArray(r.providerNames) || r.providerNames.length === 0) process.exit(3); process.stdout.write(r.providerNames.join("|"));') || {
  echo "FAIL: could not derive provider names from providerRegistry.cjs (module missing, broken, or empty providerNames)" >&2
  exit 1
}
if [ -z "${NAMES}" ]; then
  echo "FAIL: registry providerNames is empty — nothing to gate (zero-is-never-success)" >&2
  exit 1
fi

GATED_FILES=(
  packages/network-policy-core/index.cjs
  packages/network-policy-core/index.d.ts
  host-context-controller/src/networkPolicyReconciler.ts
  host-context-controller/src/externalEgressAccumulator.ts
  host-context-controller/src/config.ts
  workflow-recipes/src/reconciler/workflowRecipeReconciler.ts
  workflow-recipes/src/reconciler/externalEgressAccumulator.ts
  workflow-recipes/src/reconciler/fqdnResolver.ts
  workflow-recipes/src/reconciler/resourceBuilder.ts
  control-ui/lib/recipeValidator.ts
  control-ui/lib/egressModel.ts
  control-api/src/http/validateMcpServerSpec.ts
  control-api/src/services/providerNetblocks/providerNetblocksService.ts
  control-api/src/services/providerNetblocks/providerNetblocksConfigMap.ts
  control-api/src/services/providerNetblocks/providerNetblocksConfig.ts
  control-api/src/services/providerNetblocks/providerNetblocksCron.ts
  control-api/src/services/providerNetblocks/fetcherTypes.ts
)

# Gate only the files that exist yet — later milestones (M1 Task 12) add the
# providerNetblocks/* files. A missing file is neither a pass nor a failure here.
existing=()
for f in "${GATED_FILES[@]}"; do
  [ -f "$f" ] && existing+=("$f")
done

# zero-is-never-success: if none of the gated files were found we are almost
# certainly in the wrong directory — fail loudly rather than report a false OK.
if [ "${#existing[@]}" -eq 0 ]; then
  echo "FAIL: none of the gated files exist — is the working directory the repo root?" >&2
  exit 1
fi

# Distinguish grep rc=1 (no match → clean) from rc>=2 (I/O error / bad pattern
# from a registry name with a regex metachar). `|| true` collapsed rc>=2 into an
# empty `hits` and a false OK — a fail-open in a CI gate. Fail loud on rc>=2.
rc=0
hits=$(grep -niE "\\b(${NAMES})\\b" "${existing[@]}") || rc=$?
if [ "${rc}" -ge 2 ]; then
  echo "FAIL: grep exited ${rc} (I/O or pattern error) while scanning gated files — cannot certify provider-blindness" >&2
  exit 1
fi
if [ -n "${hits}" ]; then
  echo "FAIL: provider names (${NAMES}) leaked into provider-blind layers:" >&2
  echo "${hits}" >&2
  echo >&2
  echo "Provider names belong only in providerRegistry data, fetcher plugins," >&2
  echo "seeds, fixtures, and tests — never in the core/adapters/reconcilers/validators." >&2
  exit 1
fi

echo "OK: ${#existing[@]} gated files are provider-blind (forbidden set derived from registry: ${NAMES})"
