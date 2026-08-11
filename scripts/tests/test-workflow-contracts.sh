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

assert_terminal_mutation_rejected() {
  local label=$1 root=$2
  if ruby "$REPO_ROOT/scripts/ci/validate-workflow-contracts.rb" --root "$root" \
      >"$TEST_ROOT/terminal.out" 2>&1; then
    fail "$label"
  elif grep -q 'terminal truth table expected' "$TEST_ROOT/terminal.out"; then
    pass "$label"
  else
    sed -n '1,120p' "$TEST_ROOT/terminal.out" >&2
    fail "$label reports the terminal truth-table violation"
  fi
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

formatter_root="$TEST_ROOT/formatter-terminal"
copy_workflows "$formatter_root"
perl -0pi -e 's/\[ "\$PRETTIER_RESULT" = success \]/printf "prettier=%%s\\n" "\$PRETTIER_RESULT"/' \
  "$formatter_root/.github/workflows/prettier-source-preflight.yml"
assert_terminal_mutation_rejected \
  'formatter terminal comparison mutation is rejected' \
  "$formatter_root"

provenance_root="$TEST_ROOT/provenance-terminal"
copy_workflows "$provenance_root"
perl -0pi -e 's/\[ "\$PROVENANCE_RESULT" = success \]/printf "provenance=%%s\\n" "\$PROVENANCE_RESULT"/' \
  "$provenance_root/.github/workflows/exact-ci-provenance.yml"
assert_terminal_mutation_rejected \
  'exact-provenance terminal comparison mutation is rejected' \
  "$provenance_root"

push_root="$TEST_ROOT/push-terminal"
copy_workflows "$push_root"
perl -0pi -e 's/\[ "\$DIFF_RESULT" = success \] && \[ "\$PROVENANCE_RESULT" = skipped \]/printf "push=%%s,%%s\\n" "\$DIFF_RESULT" "\$PROVENANCE_RESULT"/' \
  "$push_root/.github/workflows/build-publish.yml"
assert_terminal_mutation_rejected \
  'push publication terminal comparison mutation is rejected' \
  "$push_root"

dispatch_root="$TEST_ROOT/dispatch-terminal"
copy_workflows "$dispatch_root"
perl -0pi -e 's/\[ "\$PROVENANCE_RESULT" = success \]/printf "dispatch=%%s,%%s\\n" "\$DIFF_RESULT" "\$PROVENANCE_RESULT"/' \
  "$dispatch_root/.github/workflows/build-publish.yml"
assert_terminal_mutation_rejected \
  'workflow-dispatch terminal comparison mutation is rejected' \
  "$dispatch_root"

exit "$FAIL"
