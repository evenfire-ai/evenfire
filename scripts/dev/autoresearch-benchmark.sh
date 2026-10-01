#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--" || $# -lt 2 ]]; then
  printf 'Usage: autoresearch-benchmark.sh -- BENCHMARK [ARG...]\n' >&2
  exit 2
fi

SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${REPO_ROOT}" ]]; then
  printf 'ERROR: autoresearch benchmark must run inside a Git checkout\n' >&2
  exit 2
fi
cd "${REPO_ROOT}"

# The measurement intake is deliberately run before the candidate benchmark.
# It refuses stale/missing origin/dev ancestry, detached default measurements,
# and merge conflicts without fetching or changing repository state.
if bash "${SCRIPT_ROOT}/scripts/dev/repo-intake-packet.sh" --measure -- true; then
  printf 'AUTORESEARCH_GATE branch_freshness=pass\n'
else
  status=$?
  printf 'AUTORESEARCH_GATE branch_freshness=fail status=%s\n' "${status}" >&2
  exit "${status}"
fi

shift
exec "$@"
