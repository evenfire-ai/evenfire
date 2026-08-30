#!/usr/bin/env bash
set -euo pipefail

codeql=${1:?usage: verify-security-and-quality-suite.sh <codeql-path>}
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
suite="$repo_root/.github/codeql/queries/evenfire-security-and-quality.qls"

resolved_queries=()
while IFS= read -r query_path; do
  resolved_queries+=("$query_path")
done < <("$codeql" resolve queries --format=json "$suite" | jq -r '.[]')

count_suffix() {
  local suffix=$1
  local path
  local count=0
  for path in "${resolved_queries[@]}"; do
    [[ $path == *"$suffix" ]] && ((count += 1))
  done
  printf '%s\n' "$count"
}

single_query_with_id() {
  local suffix=$1
  local expected_id=$2
  local path
  local count
  count=$(count_suffix "$suffix")
  [[ $count == 1 ]] || {
    echo "expected exactly one resolved query ending in $suffix; found $count" >&2
    return 1
  }
  for path in "${resolved_queries[@]}"; do
    [[ $path == *"$suffix" ]] || continue
    [[ $("$codeql" resolve metadata "$path" | jq -r '.id // empty') == "$expected_id" ]] || {
      echo "resolved query $path does not declare $expected_id" >&2
      return 1
    }
  done
}

while IFS= read -r excluded_id; do
  case "$excluded_id" in
    js/missing-rate-limiting)
      single_query_with_id "/.github/codeql/queries/EvenfireMissingRateLimiting.ql" "$excluded_id"
      ;;
    js/user-controlled-bypass)
      single_query_with_id "/.github/codeql/queries/EvenfireUserControlledBypass.ql" "$excluded_id"
      ;;
    *)
      echo "stock security query exclusion lacks an approved repository replacement: $excluded_id" >&2
      exit 1
      ;;
  esac
done < <(awk '
  /^- exclude:/ { awaiting_id = 1; next }
  awaiting_id && $1 == "id:" { print $2; awaiting_id = 0 }
' "$suite")

single_query_with_id "/Security/CWE-1427/SystemPromptInjection.ql" "js/system-prompt-injection"
single_query_with_id "/.github/codeql/queries/EvenfireMissingRateLimiting.ql" "js/missing-rate-limiting"
single_query_with_id "/.github/codeql/queries/EvenfireUserControlledBypass.ql" "js/user-controlled-bypass"
