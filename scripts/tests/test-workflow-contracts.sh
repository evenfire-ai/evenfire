#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
FAIL=0

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }

if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$REPO_ROOT"; then
  pass 'current workflow graph has compatible reusable contracts'
else
  fail 'current workflow graph has compatible reusable contracts'
fi

copy_workflows() {
  local target=$1
  mkdir -p "$target/.github"
  cp -R "$REPO_ROOT/.github/workflows" "$target/.github/"
}

mismatch_root="$TEST_ROOT/permission-mismatch"
copy_workflows "$mismatch_root"
perl -0pi -e 's/(name: Prettier \(incoming files\).*?permissions:\n)(\s+contents: read)/$1      actions: read\n$2/s' \
  "$mismatch_root/.github/workflows/prettier-source-preflight.yml"
if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$mismatch_root" \
    >"$TEST_ROOT/mismatch.out" 2>&1; then
  fail 'permission-ceiling mutation is rejected'
elif grep -Eq 'prettier-source-preflight.*actions permission|requests actions: read' \
    "$TEST_ROOT/mismatch.out"; then
  pass 'permission-ceiling mutation is rejected'
else
  sed -n '1,120p' "$TEST_ROOT/mismatch.out" >&2
  fail 'permission-ceiling mutation reports the incompatible permission'
fi

input_root="$TEST_ROOT/undeclared-input"
copy_workflows "$input_root"
perl -0pi -e 's/(mode: \$\{\{ github\.event_name == .+?\}\}\n)/$1      undeclared_input: rejected\n/' \
  "$input_root/.github/workflows/ci-public.yml"
if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$input_root" \
    >"$TEST_ROOT/input.out" 2>&1; then
  fail 'undeclared-input mutation is rejected'
elif grep -q 'supplies undeclared input undeclared_input' "$TEST_ROOT/input.out"; then
  pass 'undeclared-input mutation is rejected'
else
  sed -n '1,120p' "$TEST_ROOT/input.out" >&2
  fail 'undeclared-input mutation reports the contract violation'
fi

helper_root="$TEST_ROOT/missing-provenance-helper"
copy_workflows "$helper_root"
perl -0pi -e 's/\n      - name: Require successful CI push run for exact SHA.*?(?=\n  conclude:)//s' \
  "$helper_root/.github/workflows/exact-ci-provenance.yml"
if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$helper_root" \
    >"$TEST_ROOT/helper.out" 2>&1; then
  fail 'missing-provenance-helper mutation is rejected'
elif grep -q 'must invoke the trusted exact-SHA CI helper' "$TEST_ROOT/helper.out"; then
  pass 'missing-provenance-helper mutation is rejected'
else
  sed -n '1,120p' "$TEST_ROOT/helper.out" >&2
  fail 'missing-provenance-helper mutation reports the contract violation'
fi

exit "$FAIL"
