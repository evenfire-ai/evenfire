#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rollback="$(sed -n '/^gcp-prod-rollback:/,/^\.PHONY: gcp-prod-gfs-candidate-reapply/p' "$ROOT/Makefile")"
reapply="$(sed -n '/^gcp-prod-gfs-candidate-reapply:/,/^\.PHONY:/p' "$ROOT/Makefile")"
verify="$(cat "$ROOT/deploy/scripts/verify-gfs-hcc-phase.sh")"

bash -n "$ROOT/deploy/scripts/verify-gfs-hcc-phase.sh"
[[ "$rollback" == *'GFS_HCC_PRE_CUTOVER_REVISION'* ]] || { echo 'FAIL: exact HCC revision is not required' >&2; exit 1; }
[[ "$rollback" == *'--to-revision="$$revision"'* ]] || { echo 'FAIL: exact HCC revision is not targeted' >&2; exit 1; }
[[ "$rollback" == *'--phase writer-compat'* ]] || { echo 'FAIL: compatibility phase is not verified' >&2; exit 1; }
[[ "$rollback" != *'|| true'* ]] || { echo 'FAIL: rollback swallows errors' >&2; exit 1; }
[[ "$rollback" != *'rollout undo deploy --all'* ]] || { echo 'FAIL: HCC remains in bulk undo' >&2; exit 1; }
[[ "$rollback" == *'DB isolation is NOT active'* ]] || { echo 'FAIL: compatibility is mislabeled as isolation' >&2; exit 1; }
[[ "$reapply" == *'gcp-prod-deploy-all CONFIRM=yes'* ]] || { echo 'FAIL: reapply bypasses canonical deploy' >&2; exit 1; }
[[ "$reapply" == *'--phase candidate'* ]] || { echo 'FAIL: restored candidate is not verified' >&2; exit 1; }
[[ "$verify" == *'writer-compat|candidate'* ]] || { echo 'FAIL: verifier does not constrain phases' >&2; exit 1; }
[[ "$verify" == *'gfs_dsn_authenticates_as'* ]] || { echo 'FAIL: verifier does not prove database users' >&2; exit 1; }
[[ "$verify" == *'phase cannot be verified'* ]] || { echo 'FAIL: unavailable probes do not fail closed' >&2; exit 1; }

echo 'PASS: GFS HCC rollback contract is exact, fail-fast, and phase-aware'
