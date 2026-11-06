#!/usr/bin/env bash
# validate-release-version-bumps.mjs on real merges in a throwaway repository.
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

cd "$WORK"
git_q init -q -b dev
mkdir -p scripts/release
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

printf 'validate-release-version-bumps: %d checks, %d failed\n' "$TESTS_RUN" "$TESTS_FAILED"
[ "$TESTS_RUN" -eq 6 ] || { echo "FAIL: expected 6 checks, ran $TESTS_RUN" >&2; exit 1; }
[ "$TESTS_FAILED" -eq 0 ]
