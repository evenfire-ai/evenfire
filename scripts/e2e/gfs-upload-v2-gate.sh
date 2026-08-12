#!/usr/bin/env bash
set -euo pipefail

# GFS Upload v2 gate. This wrapper is intentionally opt-in: the large-upload
# journeys must run only against a branch-owned, non-production dev host with
# profile-scoped random URLs. It never treats a shell/API run as UI evidence.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

: "${E2E_K8S_CONTEXT:?Set E2E_K8S_CONTEXT to the owned non-production context}"
: "${CONTROL_UI_BASE_URL:?Set CONTROL_UI_BASE_URL to the profile-owned random URL}"
: "${EXTERNAL_REST_API_BASE_URL:?Set EXTERNAL_REST_API_BASE_URL to the profile-owned random URL}"

case "$E2E_K8S_CONTEXT" in
  *prod*|*production*)
    echo "Refusing GFS Upload v2 E2E against production context: $E2E_K8S_CONTEXT" >&2
    exit 2
    ;;
esac

python3 tools/e2e_static_audit.py \
  control-ui/e2e/gfs-upload-v2.spec.ts \
  desktop-app/test/e2e-playwright/gfs-upload-v2.test.ts

run_ui="${GFS_UPLOAD_V2_RUN_UI:-0}"
run_desktop="${GFS_UPLOAD_V2_RUN_DESKTOP:-0}"
run_integration="${GFS_UPLOAD_V2_RUN_INTEGRATION:-0}"
# Negative journeys mutate HCC, restart the writer, and revoke only the seeded
# grant. Keep them explicit so a caller cannot turn an arbitrary context into
# a destructive default by selecting a UI lane alone.
run_negative="${GFS_UPLOAD_V2_NEGATIVE_E2E:-0}"

if [[ "$run_ui" == "1" ]]; then
  GFS_UPLOAD_V2_E2E=1 GFS_UPLOAD_V2_NEGATIVE_E2E="$run_negative" npm --prefix control-ui exec playwright test \
    --config=playwright.config.ts --project=large-upload e2e/gfs-upload-v2.spec.ts
fi

if [[ "$run_desktop" == "1" ]]; then
  GFS_UPLOAD_V2_E2E=1 GFS_UPLOAD_V2_NEGATIVE_E2E="$run_negative" npm --prefix desktop-app exec playwright test \
    --config=test/e2e-playwright/playwright.config.ts \
    --project=packaged-gfs-upload-v2 test/e2e-playwright/gfs-upload-v2.test.ts
fi

if [[ "$run_integration" == "1" ]]; then
  : "${CONTROL_API_REAL_PG_ADMIN_URL:?Set CONTROL_API_REAL_PG_ADMIN_URL for the real-Postgres integration lane}"
  real_pg_log="$(mktemp)"
  real_pg_normalized="$(mktemp)"
  trap 'rm -f "$real_pg_log" "$real_pg_normalized"' EXIT
  npm --prefix control-api test -- --run realPostgres 2>&1 | tee "$real_pg_log"
  sed $'s/\033\\[[0-9;]*m//g' "$real_pg_log" >"$real_pg_normalized"
  grep -Eq 'Test Files[[:space:]]+[1-9][0-9]* passed' "$real_pg_normalized" || {
    echo 'real-Postgres E2E lane executed zero passing test files' >&2
    exit 1
  }
  grep -Eq 'Tests[[:space:]]+[1-9][0-9]* passed' "$real_pg_normalized" || {
    echo 'real-Postgres E2E lane executed zero passing tests' >&2
    exit 1
  }
  # Runtime restart/chaos/load is caller-owned because it must be bound to the
  # exact branch profile and Cloudflare-backed dev hostname. Do not silently
  # substitute an older RED gate or report integration-only evidence as T2.
  : "${GFS_UPLOAD_V2_RUNTIME_GATE_COMMAND:?Set GFS_UPLOAD_V2_RUNTIME_GATE_COMMAND to the exact-head restart/chaos/load command}"
  bash -lc "$GFS_UPLOAD_V2_RUNTIME_GATE_COMMAND"
fi

if [[ "$run_ui$run_desktop$run_integration" == "000" ]]; then
  echo "No runtime lane selected. Static audit passed; set one or more GFS_UPLOAD_V2_RUN_* flags." >&2
  exit 2
fi
