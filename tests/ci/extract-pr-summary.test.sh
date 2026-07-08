#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUT="$ROOT/.github/scripts/extract-pr-summary.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASS=0
FAIL=0

assert_eq() {
  local name=$1 expected=$2 actual=$3
  if [[ "$expected" == "$actual" ]]; then
    echo -e "${GREEN}✓${NC} $name"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}✗${NC} $name"
    echo "  expected: $(printf '%q' "$expected")"
    echo "  actual:   $(printf '%q' "$actual")"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local name=$1 needle=$2 haystack=$3
  if [[ "$haystack" == *"$needle"* ]]; then
    echo -e "${GREEN}✓${NC} $name"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}✗${NC} $name"
    echo "  expected to contain: $(printf '%q' "$needle")"
    echo "  actual:              $(printf '%q' "$haystack")"
    FAIL=$((FAIL + 1))
  fi
}

# ── Test: extracts Summary section ───────────────────────────────────
out=$(< "$FIXTURES/pr-body-with-summary.md" "$SUT")
assert_contains "extracts summary content" "Detects 3× consecutive 401s" "$out"
assert_contains "extracts summary content" "auth-expired" "$out"

# ── Test: stops at next ## heading ───────────────────────────────────
out=$(< "$FIXTURES/pr-body-with-summary.md" "$SUT")
if [[ "$out" == *"Test plan"* ]] || [[ "$out" == *"[x]"* ]]; then
  echo -e "${RED}✗${NC} stops at next heading"
  FAIL=$((FAIL + 1))
else
  echo -e "${GREEN}✓${NC} stops at next heading"
  PASS=$((PASS + 1))
fi

# ── Test: missing summary returns empty ──────────────────────────────
out=$(< "$FIXTURES/pr-body-no-summary.md" "$SUT")
assert_eq "empty when no summary section" "" "$out"

# ── Test: multiple ## Summary takes the first ────────────────────────
out=$(< "$FIXTURES/pr-body-multiple-summaries.md" "$SUT")
assert_contains "takes first of multiple summaries" "First summary content" "$out"
if [[ "$out" == *"Second summary content"* ]]; then
  echo -e "${RED}✗${NC} ignores subsequent summary"
  FAIL=$((FAIL + 1))
else
  echo -e "${GREEN}✓${NC} ignores subsequent summary"
  PASS=$((PASS + 1))
fi

# ── Test: preserves HTML metachars verbatim (caller escapes) ─────────
out=$(< "$FIXTURES/pr-body-html-chars.md" "$SUT")
assert_contains "preserves <iframe> verbatim" "<iframe>" "$out"
assert_contains "preserves & verbatim" "&" "$out"

# ── Test: 1500-char cap with ellipsis ────────────────────────────────
out=$(< "$FIXTURES/pr-body-very-long.md" "$SUT")
len=${#out}
# Note: bash ${#var} counts bytes, not characters. The "…" ellipsis is a
# 3-byte UTF-8 sequence, so a capped output is 1500 + 3 = 1503 bytes.
if (( len <= 1503 )); then
  echo -e "${GREEN}✓${NC} caps output at 1500 + ellipsis (got $len chars)"
  PASS=$((PASS + 1))
else
  echo -e "${RED}✗${NC} cap exceeded — got $len chars"
  FAIL=$((FAIL + 1))
fi
assert_contains "appends ellipsis when truncated" "…" "$out"

echo
echo "── Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] || exit 1
