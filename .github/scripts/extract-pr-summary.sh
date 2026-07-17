#!/usr/bin/env bash
# Reads a PR body on stdin, prints the contents of the first `## Summary`
# section (text between `## Summary` and the next `##` heading, or EOF).
# Exits 0 always; missing summary → empty stdout.
set -euo pipefail

# awk extracts the FIRST `## Summary` block. Stops at next `##` heading or EOF.
body="$(awk '
  BEGIN { in_block = 0; printed = 0 }
  /^## Summary[[:space:]]*$/ { if (!printed) { in_block = 1; next } }
  in_block && /^##[[:space:]]/ { in_block = 0; printed = 1 }
  in_block { print }
')"

# Trim leading/trailing blank lines (portable, no tac).
body="$(printf '%s\n' "$body" | awk '
  /./ { if (!seen) { seen=1; first=NR }; lines[++n]=$0; last=n }
  END { for (i=1; i<=last; i++) print lines[i] }
')"

# Hard cap at 1500 chars; append … if truncated.
if (( ${#body} > 1500 )); then
  body="${body:0:1500}…"
fi

printf '%s' "$body"
