#!/usr/bin/env bash
# ======================================================================
# DEPRECATED — thin wrapper around scripts/e2e/seed-e2e-data.sh
#
# This path is retained so existing callers (docs, CI gates, muscle memory)
# keep working. All real logic now lives in the cluster-agnostic seed at
# scripts/e2e/seed-e2e-data.sh (uses admin API only, no SQL bypass).
#
# Migration notes:
# - Legacy env TEST_ADMIN_PASSWORD → ADMIN_PASSWORD (both honored here)
# - Legacy env TEST_USER_EMAIL     → E2E_DEV_LOGIN_EMAIL (both honored)
# - Default context pinned to clerum-test; set CONTEXT explicitly for another
#   non-prod target.
# - Default email unified with desktop-app/test/e2e/helpers.ts (test@clerum.io)
# ======================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck source=scripts/e2e/load-dotenv.sh
source "${REPO_ROOT}/scripts/e2e/load-dotenv.sh"
dotenv_load_canonical_root "${REPO_ROOT}"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "${REPO_ROOT}/scripts/e2e/admin-credentials.sh"
: "${E2E_DEV_LOGIN_EMAIL:=${TEST_USER_EMAIL:-${DEV_EMAIL:-test@clerum.io}}}"
: "${CONTEXT:=clerum-test}"

LOCAL_ADMIN_PASSWORD_FALLBACK=""
case "$CONTEXT" in
  clerum-test|clerum-codex-*|clerum-cursor-*|clerum-detached-*)
    LOCAL_ADMIN_PASSWORD_FALLBACK="$(printf '%s%s' 'changeme123' '!')"
    ;;
esac
ADMIN_PASSWORD="$(e2e_resolve_admin_password "${REPO_ROOT}" "${LOCAL_ADMIN_PASSWORD_FALLBACK}" || true)"

case "$CONTEXT" in
  clerum-test|clerum-codex-*|clerum-cursor-*|clerum-detached-*)
    : "${ALLOWED_CONTEXTS:=$CONTEXT}"
    ;;
esac

# ADMIN_EMAIL passes through when the caller sets it (minikube minimal profile
# points it at admin@evenfire.local); unset/empty lets seed-e2e-data.sh keep
# its own admin@clerum.io default for the e2e lane and direct callers.
export ADMIN_PASSWORD E2E_DEV_LOGIN_EMAIL CONTEXT ALLOWED_CONTEXTS ADMIN_EMAIL

bash "${REPO_ROOT}/scripts/e2e/seed-e2e-data.sh" "$@"

# Stateless-agents lane: seed the dedicated stateless Host (chatllm-stateless)
# and associate it to the E2E user. Runs AFTER the base seed because the base
# seed's PUT /admin/users/:id/agents is a full-set replace; the stateless seed
# re-adds itself as a union. Idempotent. Never touches the chatllm seeding.
#
# chatllm-stateless backs the 6-script stateless E2E lane (Makefile:819-844).
# It is fixture surface, not part of a clean install.
#
# Default is e2e (opposite of full-setup.sh's `minimal` default): this script
# is invoked directly by `make e2e-desktop-app` and several scripts/e2e/*.sh
# callers that never set SEED_PROFILE — defaulting to `minimal` here would
# silently break all of them.
if [ "${SEED_PROFILE:-e2e}" = "e2e" ]; then
  bash "${REPO_ROOT}/scripts/e2e/seed-stateless-host.sh"
fi
