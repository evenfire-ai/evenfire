#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FAIL=0

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }

if [ ! -x "$REPO_ROOT/node_modules/.bin/prettier" ]; then
  printf 'Prettier is not installed at the repository root. Run npm ci first.\n' >&2
  exit 1
fi

new_repo() {
  local fixture
  fixture="$(mktemp -d "$TEST_ROOT/fixture.XXXXXX")"
  mkdir -p \
    "$fixture/control-api/src" \
    "$fixture/.github/workflows" \
    "$fixture/deploy/base" \
    "$fixture/deploy/overlays/minikube/patches" \
    "$fixture/gfs-controller/src" \
    "$fixture/not-selected" \
    "$fixture/scripts/prettier"
  cp "$REPO_ROOT"/scripts/prettier/*.mjs "$fixture/scripts/prettier/"
  cp "$REPO_ROOT/prettier.config.cjs" "$fixture/"
  printf '%s\n' \
    '{"private":true,"scripts":{"format:diff":"node scripts/prettier/run-on-diff.mjs"}}' \
    > "$fixture/package.json"
  printf 'node_modules\n' > "$fixture/.gitignore"
  printf 'node_modules\ncontrol-api/src/ignored file.ts\n' > "$fixture/.prettierignore"
  ln -s "$REPO_ROOT/node_modules" "$fixture/node_modules"
  (
    cd "$fixture" || exit 1
    git init -q -b main
    git config user.email test@evenfire.local
    git config user.name 'Evenfire Test'
    git add -A
    git commit -qm 'initial fixture'
  )
  printf '%s\n' "$fixture"
}

commit_all() {
  local fixture=$1 message=$2
  (cd "$fixture" && git add -A && git commit -qm "$message")
}

sha_of() {
  git -C "$1" rev-parse HEAD
}

expect_diff_success() {
  local label=$1 fixture=$2 base=$3 head=$4 mode=$5 output
  output="$TEST_ROOT/output.txt"
  if (cd "$fixture" && npm run format:diff --silent -- \
      --base "$base" --head "$head" --mode "$mode" >"$output" 2>&1); then
    pass "$label"
  else
    sed -n '1,120p' "$output" >&2
    fail "$label"
  fi
}

expect_diff_failure() {
  local label=$1 fixture=$2 base=$3 head=$4 mode=$5 output
  output="$TEST_ROOT/output.txt"
  if (cd "$fixture" && npm run format:diff --silent -- \
      --base "$base" --head "$head" --mode "$mode" >"$output" 2>&1); then
    fail "$label"
  else
    pass "$label"
  fi
}

# Added files: a formatted file passes and an unformatted file fails.
fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf 'export const added = 1\n' > "$fixture/control-api/src/added.ts"
commit_all "$fixture" 'add formatted file'
head="$(sha_of "$fixture")"
expect_diff_success 'formatted added file passes' "$fixture" "$base" "$head" direct

fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf 'export const added={answer:42}\n' > "$fixture/control-api/src/added.ts"
commit_all "$fixture" 'add unformatted file'
head="$(sha_of "$fixture")"
expect_diff_failure 'unformatted added file fails' "$fixture" "$base" "$head" direct

# Modified files receive the same whole-file check.
fixture="$(new_repo)"
printf 'export const modified = 1\n' > "$fixture/control-api/src/modified.ts"
commit_all "$fixture" 'seed modified file'
base="$(sha_of "$fixture")"
printf 'export const modified = 2\n' > "$fixture/control-api/src/modified.ts"
commit_all "$fixture" 'format modified file'
head="$(sha_of "$fixture")"
expect_diff_success 'formatted modified file passes' "$fixture" "$base" "$head" direct

fixture="$(new_repo)"
printf 'export const modified = 1\n' > "$fixture/control-api/src/modified.ts"
commit_all "$fixture" 'seed modified file'
base="$(sha_of "$fixture")"
printf 'export const modified={answer:42}\n' > "$fixture/control-api/src/modified.ts"
commit_all "$fixture" 'misformat modified file'
head="$(sha_of "$fixture")"
expect_diff_failure 'unformatted modified file fails' "$fixture" "$base" "$head" direct

# Exact copies and renames of legacy-unformatted content must check the new path.
fixture="$(new_repo)"
printf 'export const legacy={answer:42}\n' > "$fixture/control-api/src/legacy.ts"
commit_all "$fixture" 'seed legacy source'
base="$(sha_of "$fixture")"
cp "$fixture/control-api/src/legacy.ts" "$fixture/control-api/src/copied.ts"
commit_all "$fixture" 'copy legacy source'
head="$(sha_of "$fixture")"
expect_diff_failure 'copied eligible file is checked' "$fixture" "$base" "$head" direct

fixture="$(new_repo)"
printf 'export const legacy={answer:42}\n' > "$fixture/control-api/src/legacy.ts"
commit_all "$fixture" 'seed legacy source'
base="$(sha_of "$fixture")"
git -C "$fixture" mv control-api/src/legacy.ts 'control-api/src/renamed file.ts'
commit_all "$fixture" 'rename legacy source'
head="$(sha_of "$fixture")"
expect_diff_failure 'renamed eligible path with spaces is checked' "$fixture" "$base" "$head" direct

# Deletions and files outside the selected type/scope filters are excluded.
fixture="$(new_repo)"
printf 'export const removed={answer:42}\n' > "$fixture/control-api/src/removed.ts"
commit_all "$fixture" 'seed deleted source'
base="$(sha_of "$fixture")"
rm "$fixture/control-api/src/removed.ts"
commit_all "$fixture" 'delete source'
head="$(sha_of "$fixture")"
expect_diff_success 'deleted file is excluded' "$fixture" "$base" "$head" direct

fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf '{not-json\n' > "$fixture/control-api/package-lock.json"
printf 'export const ignored={answer:42}\n' > "$fixture/control-api/src/ignored file.ts"
printf 'not prettier content\n' > "$fixture/control-api/src/unsupported.txt"
printf 'export const outside={answer:42}\n' > "$fixture/not-selected/outside.ts"
commit_all "$fixture" 'add excluded candidates'
head="$(sha_of "$fixture")"
expect_diff_success \
  'lockfiles, ignored files, unsupported extensions, and outside roots are excluded' \
  "$fixture" "$base" "$head" direct

fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf 'not prettier content\n' > "$fixture/not-selected/only.txt"
commit_all "$fixture" 'add no eligible files'
head="$(sha_of "$fixture")"
expect_diff_success 'an incoming range with no eligible files succeeds' "$fixture" "$base" "$head" direct

# CI-only service and deploy YAML roots do not alter the staged/repository roots.
fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf 'export const gfs={answer:42}\n' > "$fixture/gfs-controller/src/index.ts"
commit_all "$fixture" 'add CI-only service source'
head="$(sha_of "$fixture")"
expect_diff_failure 'CI-only service root is checked' "$fixture" "$base" "$head" direct

fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf 'name: test\non: [push]\njobs: {check: {runs-on: ubuntu-latest}}\n' \
  > "$fixture/.github/workflows/test.yml"
commit_all "$fixture" 'add workflow yaml'
head="$(sha_of "$fixture")"
expect_diff_failure 'GitHub workflow YAML is checked in CI scope' "$fixture" "$base" "$head" direct

fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf '{apiVersion: v1, kind: ConfigMap}\n' > "$fixture/deploy/base/plain.yaml"
commit_all "$fixture" 'add deploy yaml'
head="$(sha_of "$fixture")"
expect_diff_failure 'plain deploy YAML is checked' "$fixture" "$base" "$head" direct

fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf '{generated: content}\n' \
  > "$fixture/deploy/overlays/minikube/patches/k8s-api-ip.yaml"
commit_all "$fixture" 'add generated deploy output'
head="$(sha_of "$fixture")"
expect_diff_success 'generated deploy YAML output is explicitly excluded' \
  "$fixture" "$base" "$head" direct

# A moving PR base must not pull target-branch-only formatting debt into the check.
fixture="$(new_repo)"
printf 'export const legacy={answer:42}\n' > "$fixture/control-api/src/legacy-base.ts"
commit_all "$fixture" 'seed legacy formatting debt'
branch_point="$(sha_of "$fixture")"
git -C "$fixture" switch -qc feature
printf 'export const feature = 1\n' > "$fixture/control-api/src/feature.ts"
commit_all "$fixture" 'add feature file'
feature_head="$(sha_of "$fixture")"
git -C "$fixture" switch -q main
printf 'export const legacy = { answer: 42 }\n' > "$fixture/control-api/src/legacy-base.ts"
commit_all "$fixture" 'format legacy debt on advanced base'
advanced_base="$(sha_of "$fixture")"
git -C "$fixture" switch -q feature
expect_diff_success 'PR mode checks merge-base..head when the base advances' \
  "$fixture" "$advanced_base" "$feature_head" merge-base
expect_diff_failure 'two-dot PR mutation sees the legacy file moving backward' \
  "$fixture" "$advanced_base" "$feature_head" direct

# A push range spans every commit between the previous and new branch tips.
fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf 'export const early={answer:42}\n' > "$fixture/control-api/src/early.ts"
commit_all "$fixture" 'add unformatted file in first push commit'
last_commit_base="$(sha_of "$fixture")"
printf 'export const final = 1\n' > "$fixture/control-api/src/final.ts"
commit_all "$fixture" 'add different formatted file in final push commit'
head="$(sha_of "$fixture")"
expect_diff_failure 'direct push mode checks a multi-commit before..after range' \
  "$fixture" "$base" "$head" direct
expect_diff_success 'last-commit-only mutation misses earlier unformatted file' \
  "$fixture" "$last_commit_base" "$head" direct

# Bounded ranges fail closed when the lower endpoint is zero or unavailable.
fixture="$(new_repo)"
head="$(sha_of "$fixture")"
zero=0000000000000000000000000000000000000000
missing=1111111111111111111111111111111111111111
expect_diff_failure 'all-zero base fails closed' "$fixture" "$zero" "$head" direct
if grep -q 'bounded incoming diff' "$TEST_ROOT/output.txt"; then
  pass 'all-zero base explains the bounded-range refusal'
else
  fail 'all-zero base explains the bounded-range refusal'
fi
expect_diff_failure 'unavailable base fails closed' "$fixture" "$missing" "$head" direct
if grep -q 'unavailable' "$TEST_ROOT/output.txt"; then
  pass 'unavailable base explains how to recover'
else
  fail 'unavailable base explains how to recover'
fi

remote="$TEST_ROOT/unavailable-base.git"
git clone -q --bare "$fixture" "$remote"
git -C "$fixture" remote add origin "$remote"
if (cd "$fixture" && bash "$REPO_ROOT/scripts/ci/fetch-bounded-commits.sh" \
    "$missing" "$head" >"$TEST_ROOT/output.txt" 2>&1); then
  fail 'workflow fetch helper fails closed when the remote lacks the base'
elif grep -q 'Cannot determine a bounded incoming diff: base commit .* is unavailable' \
    "$TEST_ROOT/output.txt"; then
  pass 'workflow fetch helper names an unavailable bounded-range base'
else
  sed -n '1,120p' "$TEST_ROOT/output.txt" >&2
  fail 'workflow fetch helper names an unavailable bounded-range base'
fi

# A failed check is read-only: no file or index mutation is allowed.
fixture="$(new_repo)"
base="$(sha_of "$fixture")"
printf 'export const immutable={answer:42}\n' > "$fixture/control-api/src/immutable.ts"
commit_all "$fixture" 'add immutable failure'
head="$(sha_of "$fixture")"
before_status="$(git -C "$fixture" status --short)"
expect_diff_failure 'unformatted check fails before mutation audit' "$fixture" "$base" "$head" direct
after_status="$(git -C "$fixture" status --short)"
if [ "$before_status" = "$after_status" ] \
  && git -C "$fixture" diff --quiet \
  && git -C "$fixture" diff --cached --quiet; then
  pass 'diff checker leaves worktree and index unchanged'
else
  fail 'diff checker leaves worktree and index unchanged'
fi

# The legacy staged path still writes the whole file and restages it.
fixture="$(new_repo)"
printf 'export const staged = 1\n' > "$fixture/control-api/src/staged.ts"
commit_all "$fixture" 'seed staged formatter'
printf 'export const staged={value:1}\n' > "$fixture/control-api/src/staged.ts"
git -C "$fixture" add -- control-api/src/staged.ts
if (cd "$fixture" && node scripts/prettier/run-on-staged.mjs >/dev/null 2>&1) \
  && [ "$(git -C "$fixture" diff --name-only)" = '' ] \
  && [ "$(git -C "$fixture" diff --cached --name-only)" = 'control-api/src/staged.ts' ] \
  && grep -Fq 'export const staged = { value: 1 }' "$fixture/control-api/src/staged.ts"; then
  pass 'staged formatter still writes and restages exactly its eligible file'
else
  fail 'staged formatter still writes and restages exactly its eligible file'
fi

fixture="$(new_repo)"
printf 'export const ciOnly={value:1}\n' > "$fixture/gfs-controller/src/ci-only.ts"
git -C "$fixture" add -- gfs-controller/src/ci-only.ts
before_blob="$(git -C "$fixture" show :gfs-controller/src/ci-only.ts)"
if (cd "$fixture" && node scripts/prettier/run-on-staged.mjs >/dev/null 2>&1) \
  && [ "$(git -C "$fixture" show :gfs-controller/src/ci-only.ts)" = "$before_blob" ] \
  && grep -Fq 'export const ciOnly={value:1}' "$fixture/gfs-controller/src/ci-only.ts"; then
  pass 'CI-only roots do not expand the staged formatter scope'
else
  fail 'CI-only roots do not expand the staged formatter scope'
fi

exit "$FAIL"
