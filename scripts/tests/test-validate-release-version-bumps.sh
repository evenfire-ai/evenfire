#!/usr/bin/env bash
# validate-release-version-bumps.mjs on real merges in a throwaway repository, its
# service list against the roots the pre-commit hook bumps, and its required CI step.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TESTS_RUN=0
TESTS_FAILED=0
pass() { TESTS_RUN=$((TESTS_RUN + 1)); }
fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "FAIL: $1" >&2
}

git_q() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

write_package() { # <root> <version>
  mkdir -p "$1"
  printf '{ "name": "%s", "version": "%s" }\n' "$(basename "$1")" "$2" >"$1/package.json"
}

commit_all() { # <message>
  git_q add -A
  git_q commit -q -m "$1"
}

expect_run() { # <name> <want-exit> <want-output> <args...>
  local name="$1" want_exit="$2" want_output="$3" exit_code=0 output
  shift 3
  output="$(node scripts/release/validate-release-version-bumps.mjs "$@" 2>&1)" || exit_code=$?
  if [ "$exit_code" -ne "$want_exit" ]; then
    fail "$name: exit $exit_code, want $want_exit: $output"
  elif ! printf '%s' "$output" | grep -qF -- "$want_output"; then
    fail "$name: output lacks '$want_output': $output"
  else
    pass
  fi
}

mkdir -p "$WORK/repo/scripts/release"
cd "$WORK/repo"
git_q init -q -b dev
cp "$REPO_ROOT/scripts/release/validate-release-version-bumps.mjs" scripts/release/
for root in control-api control-ui workflow-recipes; do write_package "$root" 0.1.1; done
mkdir -p control-api/src control-ui/app workflow-recipes/tests/e2e
echo one >control-api/src/config.ts
echo one >control-ui/app/page.tsx
echo one >control-api/README.md
echo one >workflow-recipes/tests/e2e/flow.ts
commit_all 'base'

# Two branches reach the same next version with different code; the merge is clean.
git_q checkout -q -b feature
echo feature >control-api/src/config.ts
write_package control-api 0.1.2
commit_all 'feature'
git_q checkout -q dev
echo other >control-api/src/other.ts
write_package control-api 0.1.2
commit_all 'dev moves too'
dev_tip="$(git rev-parse HEAD)"
git_q merge -q --no-edit feature
[ "$(git rev-parse HEAD^1)" = "$dev_tip" ] || { echo "FAIL: fixture merge is not a merge commit" >&2; exit 1; }
git_q tag collision

expect_run 'a clean version collision fails with --all-services' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.2' --previous HEAD^1 --all-services
# The push leg's mode covers only the release packages, so it stays green on the same merge.
expect_run 'the default mode does not check the other services' 0 'are valid' --previous HEAD^1

# The same merge with a version of its own passes.
write_package control-api 0.1.3
commit_all 'bump'
expect_run 'a version above the base passes' 0 'are valid' --previous "$dev_tip" --all-services

# Directories that differ per service, and files that are not shipped code.
checkpoint="$(git rev-parse HEAD)"
echo two >control-ui/app/page.tsx
commit_all 'ui change'
expect_run 'a UI service without src/ is covered' 1 \
  'control-ui code changed but control-ui/package.json stayed at 0.1.1' --previous "$checkpoint" --all-services

checkpoint="$(git rev-parse HEAD)"
echo two >control-api/README.md
echo two >workflow-recipes/tests/e2e/flow.ts
commit_all 'not shipped code'
expect_run 'files outside the shipped code need no bump' 0 'are valid' --previous "$checkpoint" --all-services

# Fail loud: a service without a package.json cannot pass as unchanged.
checkpoint="$(git rev-parse HEAD)"
mv control-api/package.json control-api/package.json.moved
echo three >control-api/src/config.ts
commit_all 'code without a package'
expect_run 'a missing package.json fails instead of passing' 1 'control-api/package.json' --previous "$checkpoint" --all-services

new_fixture() { # <dir> <root...>: a repository with the validator and these packages at 0.1.9
  local dir="$WORK/$1" root
  shift
  mkdir -p "$dir/scripts/release"
  cd "$dir"
  git_q init -q -b dev
  cp "$REPO_ROOT/scripts/release/validate-release-version-bumps.mjs" scripts/release/
  for root in "$@"; do
    write_package "$root" 0.1.9
    mkdir -p "$root/src"
    echo one >"$root/src/code.ts"
  done
  commit_all 'base'
}

# Versions are ordered numerically: 0.1.10 is above 0.1.9, a lower one reissues numbers.
new_fixture order control-api rpc-proxy
checkpoint="$(git rev-parse HEAD)"
echo two >control-api/src/code.ts
write_package control-api 0.1.10
commit_all 'bump past nine'
expect_run 'a version above the base passes in numeric order' 0 'are valid' --previous "$checkpoint" --all-services

checkpoint="$(git rev-parse HEAD)"
echo three >control-api/src/code.ts
write_package control-api 0.1.9
commit_all 'code and a lower version'
expect_run 'a version below the base fails' 1 \
  'control-api/package.json went down from 0.1.10 to 0.1.9' --previous "$checkpoint" --all-services

checkpoint="$(git rev-parse HEAD)"
write_package rpc-proxy 0.1.8
commit_all 'only a lower version'
expect_run 'a lower version with no code change fails' 1 \
  'rpc-proxy/package.json went down from 0.1.9 to 0.1.8' --previous "$checkpoint" --all-services
# The push leg's mode compares for equality only: it has no branch left to fix.
checkpoint="$(git rev-parse HEAD)"
echo two >rpc-proxy/src/code.ts
write_package rpc-proxy 0.1.7
commit_all 'code and a lower version on a release package'
expect_run 'the default mode does not order versions' 0 'are valid' --previous "$checkpoint"

# Test files beside the code need no bump; the code beside them does.
new_fixture tests-beside control-api control-ui workflow-recipes
mkdir -p control-ui/components/__tests__/fixtures
echo one >control-ui/components/__tests__/fixtures/card.ts
commit_all 'a fixture'
checkpoint="$(git rev-parse HEAD)"
echo two >control-api/src/code.test.ts
echo two >control-api/src/code.spec.tsx
echo two >control-ui/components/__tests__/fixtures/card.ts
echo two >workflow-recipes/src/run.testFixtures.ts
commit_all 'test files only'
expect_run 'test files under a service directory need no bump' 0 'are valid' --previous "$checkpoint" --all-services
# Witness: the same directory's code still fails, so the run above read these paths.
echo two >control-api/src/code.ts
commit_all 'the code beside them'
expect_run 'code beside those test files still needs a bump' 1 \
  'control-api code changed but control-api/package.json stayed at 0.1.9' --previous "$checkpoint" --all-services

# Pinned by behavior: a change in each directory of each service must fail, naming that
# service only. This table is separate from the validator's list on purpose.
SERVICES='channel-reader src
control-api src
control-ui app components lib
external-rest-api src
host-context-controller src
mcp-host src
mcp-proxy src
mcp-servers/doc-generator src
mcp-servers/web-search src
profile-ui app lib
rpc-proxy src
stdio-bridge src
workflow-recipes src'

# Roots the hook bumps that the check leaves out, each for the reason given.
#   mcp-servers: the root package of airtable, mongodb and playwright, which wrap upstream images.
#   packages/workflow-sdk: a prerelease version this check cannot order.
#   tests/**, workflow-recipes/tests/e2e: test code.
EXCLUDED_ROOTS='mcp-servers
packages/workflow-sdk
tests/e2e
tests/e2e/fixtures
tests/e2e/fixtures/mock-mcp-server
tests/e2e/fixtures/mock-secrets-server
tests/e2e/fixtures/mock-stdio-mcp-server
tests/e2e/playwright
workflow-recipes/tests/e2e'

# Every root the hook bumps is in one of the two lists, and neither names anything else.
hook_roots="$(node --input-type=module -e \
  "const { packageRoots } = await import(process.argv[1]); console.log(packageRoots.join('\\n'))" \
  "$REPO_ROOT/scripts/prettier/paths.mjs")"
listed_roots="$( { printf '%s\n' "$SERVICES" | cut -d' ' -f1; printf '%s\n' "$EXCLUDED_ROOTS"; } | LC_ALL=C sort)"
if [ -n "$hook_roots" ] && [ "$(printf '%s\n' "$hook_roots" | LC_ALL=C sort)" = "$listed_roots" ]; then
  pass
else
  fail "the hook's packageRoots differ from this test's lists; add the root to SERVICES and the validator, or to EXCLUDED_ROOTS with a reason: $(diff <(printf '%s\n' "$hook_roots" | LC_ALL=C sort) <(printf '%s\n' "$listed_roots") || true)"
fi

while read -r root dirs; do
  # The real tree has what the table says: a package with an orderable version, and each directory.
  version="$(node -p 'require(process.argv[1]).version' "$REPO_ROOT/$root/package.json")"
  if printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    pass
  else
    fail "$root/package.json has version '$version', which the check cannot order"
  fi
  for dir in $dirs; do
    if [ -n "$(git -C "$REPO_ROOT" ls-files -- "$root/$dir/" | head -n 1)" ]; then
      pass
    else
      fail "$root/$dir has no tracked files, so the check would never fire for it"
    fi
  done
done <<<"$SERVICES"

mkdir -p "$WORK/pin/scripts/release"
cd "$WORK/pin"
git_q init -q -b dev
cp "$REPO_ROOT/scripts/release/validate-release-version-bumps.mjs" scripts/release/
while read -r root dirs; do
  write_package "$root" 0.1.1
  for dir in $dirs; do
    mkdir -p "$root/$dir"
    echo one >"$root/$dir/shipped.ts"
  done
done <<<"$SERVICES"
commit_all 'base'
while read -r root dirs; do
  for dir in $dirs; do
    echo two >"$root/$dir/shipped.ts"
    commit_all "change $root/$dir"
    expect_run "$root/$dir is covered" 1 \
      "$root code changed but $root/package.json stayed at 0.1.1" --previous HEAD^ --all-services
    errors="$(node scripts/release/validate-release-version-bumps.mjs --previous HEAD^ --all-services 2>&1 | grep -c '::error::' || true)"
    if [ "$errors" -eq 1 ]; then pass; else fail "$root/$dir: $errors errors, want 1"; fi
    echo one >"$root/$dir/shipped.ts"
    commit_all "restore $root/$dir"
  done
done <<<"$SERVICES"

# The CI step: in the job the dev ruleset requires, with no filter that could skip it, and
# with history enough to read HEAD^1. Depth comes from the workflow, so the clone below proves it.
# shellcheck disable=SC2016 # Ruby source.
if depth="$(RUBYOPT=--disable=gems ruby -ryaml -e '
  doc = YAML.load_file(ARGV.fetch(0))
  # YAML 1.1 reads the bare key `on` as true.
  triggers = doc.fetch(true)
  abort("pull_request has a filter: #{triggers["pull_request"]}") unless triggers.key?("pull_request") && triggers["pull_request"].nil?
  holders = doc.fetch("jobs").select { |_, job| job.fetch("steps", []).any? { |s| s["run"].to_s.include?("--all-services") } }.keys
  abort("--all-services runs in #{holders}, want only repo-hygiene") unless holders == ["repo-hygiene"]
  job = doc["jobs"]["repo-hygiene"]
  # The ruleset requires this job by this exact name.
  abort("job name changed: #{job["name"]}") unless job["name"] == "Repo hygiene (no internal working artifacts)"
  abort("the job can be skipped: #{job.slice("if", "needs")}") if job.key?("if") || job.key?("needs")
  steps = job.fetch("steps")
  gate = steps.index { |s| s["run"].to_s.include?("--all-services") }
  node = steps.index { |s| s["uses"].to_s.start_with?("actions/setup-node@") }
  abort("setup-node must come before the check") unless node && node < gate
  wanted = "github.event_name == \x27pull_request\x27 && github.base_ref == \x27dev\x27"
  [gate, node].each { |i| abort("step #{i} runs on: #{steps[i]["if"]}") unless steps[i]["if"] == wanted }
  abort("the check must compare with the merge base") unless steps[gate]["run"].include?("--previous HEAD^1")
  puts steps.first.fetch("with").fetch("fetch-depth")
' "$REPO_ROOT/.github/workflows/ci-public.yml" 2>&1)"; then
  pass
  git_q -c advice.detachedHead=false clone -q --depth "$depth" --branch collision "file://$WORK/repo" "$WORK/shallow"
  cd "$WORK/shallow"
  expect_run "the job's fetch depth ($depth) is enough to read the merge base" 1 \
    'control-api code changed but control-api/package.json stayed at 0.1.2' --previous HEAD^1 --all-services
else
  fail "ci-public.yml: $depth"
fi

printf 'validate-release-version-bumps: %d checks, %d failed\n' "$TESTS_RUN" "$TESTS_FAILED"
[ "$TESTS_RUN" -eq 76 ] || { echo "FAIL: expected 76 checks, ran $TESTS_RUN" >&2; exit 1; }
[ "$TESTS_FAILED" -eq 0 ]
