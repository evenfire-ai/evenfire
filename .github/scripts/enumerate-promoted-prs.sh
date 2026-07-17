#!/usr/bin/env bash
# Enumerates dev PRs bundled in a master-merge PR.
# Args:
#   $1 = master PR number
# Output:
#   stdout: TAB-separated records, one per bundled PR
#           <number>\t<author>\t<title>\t<summary>
#   stderr: warnings (e.g. when a bundled PR's gh lookup fails)
# Behavior:
#   1. Fetch commits in master PR via gh pr view --json commits.
#   2. For each `Merge pull request #N from ...` commit headline, resolve N.
#   3. Look up each N's title/author/body via gh pr view.
#   4. Run extract-pr-summary.sh against the body; truncate to 200 chars.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: enumerate-promoted-prs.sh <master-pr-number>" >&2
  exit 2
fi

MASTER_PR="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACT="$SCRIPT_DIR/extract-pr-summary.sh"

# Fetch commits in the master PR. May be a fixture path in tests, real gh in CI.
commits_json="$(gh pr view "$MASTER_PR" --json commits)"

# Extract bundled PR numbers (preserve order, dedupe).
mapfile -t bundled_nums < <(
  printf '%s' "$commits_json" \
    | jq -r '.commits[].messageHeadline' \
    | sed -nE 's/^Merge pull request #([0-9]+) from .*/\1/p' \
    | awk '!seen[$0]++'
)

# Guard against empty array under `set -u` (no bundled PRs found).
if [[ ${#bundled_nums[@]} -eq 0 ]]; then
  exit 0
fi

# For each bundled PR, fetch title/author/body and emit a record.
for n in "${bundled_nums[@]}"; do
  if ! pr_json="$(gh pr view "$n" --json title,author,body 2>/dev/null)"; then
    echo "warn: gh pr view #$n failed (PR may be deleted/inaccessible) — skipping" >&2
    continue
  fi

  title="$(printf '%s' "$pr_json" | jq -r '.title // ""')"
  author="$(printf '%s' "$pr_json" | jq -r '.author.login // ""')"
  body="$(printf '%s' "$pr_json" | jq -r '.body // ""')"

  summary="$(printf '%s' "$body" | "$EXTRACT")"
  # Tighter cap for master message bullets.
  if (( ${#summary} > 200 )); then
    summary="${summary:0:200}…"
  fi

  # TAB-separated; sanitize embedded tabs/newlines/carriage-returns in the fields.
  title="${title//$'\t'/ }";   title="${title//$'\n'/ }";   title="${title//$'\r'/ }"
  author="${author//$'\t'/ }"; author="${author//$'\n'/ }"; author="${author//$'\r'/ }"
  summary="${summary//$'\t'/ }"; summary="${summary//$'\n'/ }"; summary="${summary//$'\r'/ }"

  printf '%s\t%s\t%s\t%s\n' "$n" "$author" "$title" "$summary"
done
