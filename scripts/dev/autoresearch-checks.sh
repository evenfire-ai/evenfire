#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${REPO_ROOT}" ]]; then
  printf 'ERROR: autoresearch checks must run inside a Git checkout\n' >&2
  exit 2
fi
cd "${REPO_ROOT}"

# AutoResearch maps a non-zero checks command to its tests_pass hard gate.
# Keep the parity result explicit in the captured packet output as well.
if make test-service-matrix; then
  printf 'AUTORESEARCH_GATE service_matrix_parity=pass\n'
else
  status=$?
  printf 'AUTORESEARCH_GATE service_matrix_parity=fail status=%s\n' "${status}" >&2
  exit "${status}"
fi
