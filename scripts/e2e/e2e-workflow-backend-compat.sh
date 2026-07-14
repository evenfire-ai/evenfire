#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

suites=(
  workflow-backend-compat/http-mock-db.sh
  workflow-backend-compat/http-mongodb-stack.sh
  workflow-backend-compat/http-postgres.sh
  workflow-backend-compat/http-redis-cache.sh
  workflow-backend-compat/http-webhook-relay.sh
  workflow-backend-compat/stdio-postgres.sh
  workflow-backend-compat/stdio-multi-tool.sh
)

if [ "${1:-}" = "--cleanup" ]; then
  for suite in "${suites[@]}"; do
    "${SCRIPT_DIR}/${suite}" --cleanup-only || true
  done
  exit 0
fi

failed=()
for suite in "${suites[@]}"; do
  echo "==> ${suite}"
  if ! "${SCRIPT_DIR}/${suite}"; then
    failed+=("$suite")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'failed compatibility suites:\n'
  printf '  %s\n' "${failed[@]}"
  exit 1
fi

echo "workflow backend compatibility suites passed"
