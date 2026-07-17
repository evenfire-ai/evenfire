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

: "${ADMIN_PASSWORD:=${TEST_ADMIN_PASSWORD:-changeme123!}}"
: "${E2E_DEV_LOGIN_EMAIL:=${TEST_USER_EMAIL:-${DEV_EMAIL:-test@clerum.io}}}"
: "${CONTEXT:=clerum-test}"

case "$CONTEXT" in
  clerum-test|clerum-codex-*|clerum-cursor-*|clerum-detached-*)
    : "${ALLOWED_CONTEXTS:=$CONTEXT}"
    ;;
esac

export ADMIN_PASSWORD E2E_DEV_LOGIN_EMAIL CONTEXT ALLOWED_CONTEXTS

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
