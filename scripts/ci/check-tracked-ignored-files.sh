#!/usr/bin/env bash
#
# CI guard: fail if a tracked file matches a pattern in the repository's own
# .gitignore files. A .gitignore cannot stop `git add -f`, so a private file
# (a session handoff, a local note, run evidence) can be committed under an
# ignored directory without any warning. This check lists every tracked file
# that the committed .gitignore files exclude and fails on any that is not in
# the allowlist below.
#
# Only the .gitignore files in the tree count. A developer's global
# core.excludesFile and .git/info/exclude are ignored, so a local run gives
# the same verdict as CI.
#
# Every allowlist entry must still be tracked and still be ignored; an entry
# that is neither fails the check, so the list cannot go stale.
#
# Exit 0 when every tracked-and-ignored file is allowlisted, 1 otherwise.

set -euo pipefail

# Tracked on purpose although an ignore rule covers them. One path per line.
ALLOWED=(
  # Development-only minikube Secrets applied from a fresh clone by
  # scripts/minikube/setup.sh, scripts/minikube/full-setup.sh and the Makefile.
  # deploy/.gitignore ignores overlays/*/secrets/ for every other overlay.
  'deploy/overlays/minikube/secrets/inter-service-tokens.yaml'
  'deploy/overlays/minikube/secrets/llm-api-keys.yaml'
  'deploy/overlays/minikube/secrets/search-api-keys.yaml'
  # Keeps the Playwright output directory in the tree; **/test-results/ ignores it.
  'tests/e2e/test-results/.gitignore'
)

cd "$(git rev-parse --show-toplevel)"

is_allowed() { # <path>
  local entry
  for entry in "${ALLOWED[@]}"; do
    if [ "$entry" = "$1" ]; then return 0; fi
  done
  return 1
}

contains() { # <path> <list...>
  local needle="$1" item
  shift
  for item in "$@"; do
    if [ "$item" = "$needle" ]; then return 0; fi
  done
  return 1
}

tracked_count="$(git ls-files -z | tr -cd '\0' | wc -c | tr -d ' ')"
if [ "$tracked_count" -eq 0 ]; then
  echo "::error::No tracked files found; the check has nothing to inspect."
  exit 1
fi

# --exclude-per-directory reads only the .gitignore files in the tree;
# core.excludesFile=/dev/null drops the developer's global ignore file.
# The listing goes to a file first so that a git failure stops the check
# instead of reading as an empty list.
listing="$(mktemp)"
trap 'rm -f "$listing"' EXIT
git -c core.excludesFile=/dev/null ls-files -z --cached --ignored --exclude-per-directory=.gitignore >"$listing"
ignored=()
while IFS= read -r -d '' path; do
  ignored+=("$path")
done <"$listing"

fail=0
unexpected=()
for path in ${ignored[@]+"${ignored[@]}"}; do
  if ! is_allowed "$path"; then unexpected+=("$path"); fi
done
if [ "${#unexpected[@]}" -gt 0 ]; then
  echo "::error::Tracked files that a .gitignore excludes (remove them with git rm, or allowlist them in scripts/ci/check-tracked-ignored-files.sh with the reason):"
  printf '%s\n' "${unexpected[@]}"
  fail=1
fi

stale=()
for entry in "${ALLOWED[@]}"; do
  if ! contains "$entry" ${ignored[@]+"${ignored[@]}"}; then stale+=("$entry"); fi
done
if [ "${#stale[@]}" -gt 0 ]; then
  echo "::error::Allowlist entries that are no longer both tracked and ignored (remove them from scripts/ci/check-tracked-ignored-files.sh):"
  printf '%s\n' "${stale[@]}"
  fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "Checked ${tracked_count} tracked files: ${#ignored[@]} match a .gitignore, all allowlisted."
