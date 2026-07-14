#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUT="$ROOT/.github/scripts/enumerate-promoted-prs.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASS=0
FAIL=0

# ── Build a `gh` stub ────────────────────────────────────────────────
# Behavior:
#   gh pr view 999 --json commits --jq ...   → cat $GH_COMMITS_FIXTURE
#   gh pr view <N> --json title,author,body  → emit canned JSON for known PRs
#   gh pr view 404 ...                        → exit 1 (simulate missing PR)
#   gh pr view 999 (master PR detail)         → emit canned JSON

STUBDIR="$(mktemp -d)"
trap 'rm -rf "$STUBDIR"' EXIT

cat > "$STUBDIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
# Args: gh pr view <N> --json <fields> [--jq <expr>]
shift # drop "pr"
shift # drop "view"
PR_NUM="$1"
shift
# Find --json arg
FIELDS=""
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "--json" ]]; then
    j=$((i+1))
    FIELDS="${!j}"
  fi
done

case "$PR_NUM" in
  999)
    if [[ "$FIELDS" == *"commits"* ]]; then
      cat "$GH_COMMITS_FIXTURE"
    else
      echo '{"title":"chore(deploy): promote dev → master","author":{"login":"github-actions[bot]"},"body":""}'
    fi
    ;;
  218) echo '{"title":"fix(rpc-proxy): handle SSE 401","author":{"login":"joseramirezencinas"},"body":"## Summary\nDetects 3× 401s and emits auth-expired."}' ;;
  220) echo '{"title":"feat(desktop): MCP server list","author":{"login":"otherperson"},"body":"## Summary\nAdds visibility for connected MCP servers."}' ;;
  222) echo '{"title":"chore(ci): bump deploy timeout","author":{"login":"thirduser"},"body":"No summary section here."}' ;;
  225) echo '{"title":"refactor(conversation): split manager","author":{"login":"fourthuser"},"body":"## Summary\nExtracts ConversationManager evictor into its own module."}' ;;
  404) exit 1 ;;
  *)   echo "{}" ;;
esac
STUB
chmod +x "$STUBDIR/gh"

PATH="$STUBDIR:$PATH"
export PATH GH_COMMITS_FIXTURE="$FIXTURES/master-pr-commits-4-bundled.json"

assert_contains() {
  local name=$1 needle=$2 haystack=$3
  if [[ "$haystack" == *"$needle"* ]]; then
    echo -e "${GREEN}✓${NC} $name"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}✗${NC} $name"
    echo "  needle: $(printf '%q' "$needle")"
    echo "  in:     $(printf '%q' "$haystack")"
    FAIL=$((FAIL + 1))
  fi
}

assert_line_count() {
  local name=$1 expected=$2 text=$3
  local actual
  actual="$(printf '%s' "$text" | grep -c . || true)"
  if [[ "$expected" == "$actual" ]]; then
    echo -e "${GREEN}✓${NC} $name (expected $expected, got $actual lines)"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}✗${NC} $name (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Test: enumerates 4 bundled PRs ───────────────────────────────────
out=$("$SUT" 999)
assert_line_count "emits 4 records for 4 bundled PRs" 4 "$out"
assert_contains "includes #218 title"    "fix(rpc-proxy): handle SSE 401" "$out"
assert_contains "includes #218 author"   "joseramirezencinas"             "$out"
assert_contains "includes #218 summary"  "Detects 3× 401s"                "$out"
assert_contains "includes #220 title"    "feat(desktop): MCP server list" "$out"
assert_contains "includes #225 title"    "refactor(conversation)"         "$out"

# ── Test: PR without summary section omits summary field ─────────────
# #222 has no `## Summary` — the record should still be emitted with empty summary
assert_contains "includes #222 with empty summary" "chore(ci): bump deploy timeout" "$out"

# ── Test: empty commit list → empty stdout ───────────────────────────
GH_COMMITS_FIXTURE="$FIXTURES/master-pr-commits-empty.json" "$SUT" 999 > /tmp/enum-empty.out 2>/dev/null || true
out=$(cat /tmp/enum-empty.out)
assert_line_count "emits 0 records when no Merge pull request commits" 0 "$out"

# ── Test: 404 on a bundled PR doesn't kill the script ────────────────
# Create a fixture where one bundled PR is #404 (simulated missing)
cat > /tmp/commits-with-404.json <<'JSON'
{
  "commits": [
    { "messageHeadline": "Merge pull request #218 from your-org/feat/x" },
    { "messageHeadline": "Merge pull request #404 from your-org/deleted" },
    { "messageHeadline": "Merge pull request #220 from your-org/feat/y" }
  ]
}
JSON
GH_COMMITS_FIXTURE="/tmp/commits-with-404.json" out=$("$SUT" 999 2>/tmp/enum-404.err)
assert_line_count "skips 404'd PRs (2 records, not 3)" 2 "$out"
assert_contains "logs warning to stderr for 404" "404" "$(cat /tmp/enum-404.err)"

echo
echo "── Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] || exit 1
