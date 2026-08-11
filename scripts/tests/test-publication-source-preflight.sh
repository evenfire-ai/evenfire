#!/usr/bin/env bash
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }

assert_fixed() {
  local label=$1 pattern=$2 file=$3
  if rg -Fq -- "$pattern" "$REPO_ROOT/$file"; then
    pass "$label"
  else
    fail "$label"
  fi
}

assert_fixed \
  'manual image publication selects exact-SHA CI provenance' \
  "mode: \${{ github.event_name == 'workflow_dispatch' && 'exact-ci' || 'direct' }}" \
  '.github/workflows/build-publish.yml'
assert_fixed \
  'manual image publication accepts provenance from dev only' \
  'allowed_branches: dev' \
  '.github/workflows/build-publish.yml'
assert_fixed \
  'image detection depends on source preflight' \
  'needs: preflight' \
  '.github/workflows/build-publish.yml'
assert_fixed \
  'release refs are peeled to commits' \
  '^{commit}' \
  '.github/workflows/release-images.yml'
assert_fixed \
  'release promotion requires source preflight' \
  'needs: [resolve-release-ref, preflight]' \
  '.github/workflows/release-images.yml'
assert_fixed \
  'release preflight always uses exact-SHA CI provenance' \
  'mode: exact-ci' \
  '.github/workflows/release-images.yml'
assert_fixed \
  'release provenance is restricted to main' \
  'allowed_branches: main' \
  '.github/workflows/release-images.yml'
assert_fixed \
  'release promotion checks out the verified commit' \
  'ref: ${{ needs.resolve-release-ref.outputs.sha }}' \
  '.github/workflows/release-images.yml'
assert_fixed \
  'release promotion passes the verified commit to the resolver' \
  'TAG_SHA: ${{ needs.resolve-release-ref.outputs.sha }}' \
  '.github/workflows/release-images.yml'
assert_fixed \
  'release promotion honors the verified commit input' \
  'TAG_SHA="${TAG_SHA:-$(git rev-parse --verify --end-of-options "$RELEASE_REF^{commit}")}"' \
  'scripts/release/promote-release-images.sh'
assert_fixed \
  'workflow fetches bounded commits through the diagnostic helper' \
  'bash scripts/ci/fetch-bounded-commits.sh "$BASE_SHA" "$HEAD_SHA"' \
  '.github/workflows/prettier-source-preflight.yml'
assert_fixed \
  'provenance checks the CI workflow by source file' \
  "CI_WORKFLOW_FILE = 'ci-public.yml'" \
  'scripts/ci/require-successful-ci-run.mjs'

for job in \
  repo-hygiene \
  test \
  control-api-migration \
  control-ui-build \
  registry-contract \
  shell-syntax \
  nginx-image-guard \
  cf-access-header-guard \
  dockerfile-ca-guard \
  deploy-manifest-check \
  leak-guards; do
  block="$(awk -v job="$job" '
    $0 == "  " job ":" { found = 1; next }
    found && /^  [A-Za-z0-9_-]+:/ { exit }
    found { print }
  ' "$REPO_ROOT/.github/workflows/ci-public.yml")"
  if printf '%s\n' "$block" | rg -q '^    needs: prettier$'; then
    pass "CI job $job depends on Prettier"
  else
    fail "CI job $job depends on Prettier"
  fi
done

if rg -q -- '--write' \
  "$REPO_ROOT/.github/workflows/prettier-source-preflight.yml" \
  "$REPO_ROOT/scripts/prettier/run-on-diff.mjs"; then
  fail 'CI preflight never invokes Prettier with --write'
else
  pass 'CI preflight never invokes Prettier with --write'
fi

exit "$FAIL"
