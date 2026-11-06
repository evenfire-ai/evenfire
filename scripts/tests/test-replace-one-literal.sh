#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/tests/lib/replace-one-literal.sh
. "$SCRIPT_DIR/lib/replace-one-literal.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cases=0
passed=0

assert_bytes() {
  local actual="$1" expected="$2"
  cmp -s -- "$actual" "$expected"
}

life_witness() {
  local actual="$WORK/life-witness" expected="$WORK/life-witness-expected"
  printf '%s' 'before OLD after' >"$actual"
  printf '%s' 'before NEW after' >"$expected"
  replace_one_literal "$actual" 'OLD' 'NEW'
  assert_bytes "$actual" "$expected"
}

assert_positive() {
  local name="$1" content="$2" from="$3" to="$4" expected="$5"
  local actual="$WORK/$name.actual" wanted="$WORK/$name.expected"
  cases=$((cases + 1))
  printf '%s' "$content" >"$actual"
  printf '%s' "$expected" >"$wanted"
  if replace_one_literal "$actual" "$from" "$to" &&
    assert_bytes "$actual" "$wanted"; then
    passed=$((passed + 1))
  else
    echo "FAIL: $name" >&2
    return 1
  fi
}

assert_negative() {
  local name="$1" content="$2" from="$3"
  local actual="$WORK/$name.actual" original="$WORK/$name.original" error="$WORK/$name.err" rc=0
  cases=$((cases + 1))
  printf '%s' "$content" >"$actual"
  cp -- "$actual" "$original"
  life_witness
  (
    replace_one_literal "$actual" "$from" 'NEW'
  ) >"$WORK/$name.out" 2>"$error" || rc=$?
  if [ "$rc" -eq 1 ] && assert_bytes "$actual" "$original" && [ -s "$error" ]; then
    passed=$((passed + 1))
  else
    echo "FAIL: $name (rc=$rc)" >&2
    return 1
  fi
}

run_suite() {
  local label="$1" newline=$'\n'
  cases=0
  passed=0
  assert_positive amp 'a OLD b' 'OLD' 'a & b\1' 'a a & b\1 b'
  assert_positive backslashes 'x a\b\q y' 'a\b\q' 'c\\d\\r' 'x c\\d\\r y'
  assert_positive glob-in-from 'x[a]*y' '[a]*' '[b]?' 'x[b]?y'
  assert_positive quotes 'say "double" here' '"double"' "'single' & \\" "say 'single' & \\ here"
  # shellcheck disable=SC2016  # the dollar signs are literal test data.
  assert_positive dollar 'value=$OLD' '$OLD' '${NEW}&' 'value=${NEW}&'
  assert_positive nl-in-from-and-to "a${newline}b" "$newline" "X${newline}Y" "aX${newline}Yb"
  assert_positive start 'OLD middle' 'OLD' 'NEW' 'NEW middle'
  assert_positive end 'middle OLD' 'OLD' 'NEW' 'middle NEW'
  assert_positive no-trailing-nl 'before OLD' 'OLD' 'NEW' 'before NEW'
  assert_positive trailing-nl "before OLD${newline}" 'OLD' 'NEW' "before NEW${newline}"
  assert_negative two-on-line 'a OLD b OLD c' 'OLD'
  assert_negative zero 'nothing here' 'OLD'
  assert_negative empty-from 'before OLD after' ''
  echo "PASS: $label $passed/$cases"
  [ "$passed" -eq "$cases" ]
}

if shopt -s patsub_replacement >/dev/null 2>&1; then
  run_suite patsub-on
  shopt -u patsub_replacement
  run_suite patsub-off
else
  run_suite bash-3.2
fi
