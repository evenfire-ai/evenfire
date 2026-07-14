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

exec bash "${REPO_ROOT}/scripts/e2e/seed-e2e-data.sh" "$@"
