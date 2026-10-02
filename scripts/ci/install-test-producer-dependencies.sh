#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE="${1:-}"

if [[ -z "${SERVICE}" || "${SERVICE}" == /* || "${SERVICE}" == *'..'* ]]; then
  echo 'usage: install-test-producer-dependencies.sh <repository service directory>' >&2
  exit 2
fi
if [[ ! -f "${ROOT_DIR}/${SERVICE}/package.json" ]]; then
  echo "unknown repository service directory: ${SERVICE}" >&2
  exit 2
fi

contains_executable_reference() {
  local needle="$1"
  local source_file
  while IFS= read -r -d '' source_file; do
    if grep -F -- "${needle}" "${source_file}" | grep -Eqv '^[[:space:]]*(//|/\*|\*)'; then
      return 0
    fi
  done < <(
    find "${ROOT_DIR}/${SERVICE}" \
      \( -path '*/node_modules/*' -o -path '*/dist/*' \) -prune -o \
      -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print0
  )
  return 1
}

producers=()

add_producer() {
  local producer="$1"
  local existing
  [[ "${producer}" == "${SERVICE}" ]] && return
  for existing in "${producers[@]:-}"; do
    [[ "${existing}" == "${producer}" ]] && return
  done
  producers+=("${producer}")
}

# Producer-backed tests are the canonical dependency declaration. Discover the
# sibling package that owns each real fixture/tool instead of maintaining a
# second service matrix in the workflow.
contains_executable_reference 'control-api/test/fixtures/' && add_producer control-api
contains_executable_reference 'rpc-proxy/node_modules/.bin/tsx' && add_producer rpc-proxy
contains_executable_reference 'workflow-recipes/src/' && add_producer workflow-recipes

if [[ "${#producers[@]}" -eq 0 ]]; then
  exit 0
fi

if [[ "${CI_TEST_PRODUCER_INSTALL_DRY_RUN:-0}" == '1' ]]; then
  printf '%s\n' "${producers[@]}"
  exit 0
fi

for producer in "${producers[@]}"; do
  echo "Installing producer-backed test dependencies: ${producer}"
  npm --prefix "${ROOT_DIR}/${producer}" ci
done
