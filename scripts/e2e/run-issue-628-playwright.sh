#!/usr/bin/env bash
# Run the Context persistence journey under an already-owned Minikube lease.
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"

if [[ "${E2E_DISABLE_CANONICAL_DOTENV:-}" != true ]]; then
  printf 'ISSUE628_ISOLATED_ENV_REQUIRED: disable the canonical dotenv for this local test\n' >&2
  exit 1
fi
if [[ "${E2E_REPORT_PATH:-}" != /* ]]; then
  printf 'ISSUE628_REPORT_PATH_REQUIRED: provide an absolute local report path\n' >&2
  exit 1
fi

bash "$ROOT/scripts/minikube/require-t2-mutation-lock.sh"
# shellcheck source=scripts/e2e/load-dotenv.sh
source "$ROOT/scripts/e2e/load-dotenv.sh"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "$ROOT/scripts/e2e/admin-credentials.sh"
if ! TEST_ADMIN_PASSWORD="$(e2e_resolve_admin_password "$ROOT")"; then
  printf 'ISSUE628_ADMIN_CREDENTIAL_REQUIRED: provide a local test credential\n' >&2
  exit 1
fi
export TEST_ADMIN_PASSWORD
export TEST_ADMIN_USERNAME="${TEST_ADMIN_USERNAME:-admin}"

profile_info="$(make -f scripts/minikube-profiles/branch.mk branch-profile-info)"
control_ui_port="$(printf '%s\n' "$profile_info" | awk '$1 == "control-ui:" { print $2; exit }')"
if [[ ! "$control_ui_port" =~ ^[0-9]+$ ]]; then
  printf 'ISSUE628_PROFILE_PORT_REQUIRED: the owned Control UI port is unavailable\n' >&2
  exit 1
fi
export E2E_CONTROL_UI_URL="http://127.0.0.1:$control_ui_port"

exec node "$ROOT/tests/e2e/playwright/node_modules/@playwright/test/cli.js" test \
  --config "$ROOT/tests/e2e/playwright/issue-628.config.ts" "$@"
