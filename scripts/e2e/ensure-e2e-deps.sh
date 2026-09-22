#!/usr/bin/env bash
# Install tests/e2e dependencies with `npm ci` when they are missing or were
# installed from a different lockfile.
#
# Checking only for node_modules/.bin/vitest keeps a node_modules installed
# before a lockfile change, so a newly added dependency (a `file:` link to a
# contract package, say) fails later as a missing import. After a successful
# `npm ci` this copies the lockfile into node_modules; any difference from the
# current lockfile triggers a fresh `npm ci`, which replaces node_modules.
#
# Usage: ensure-e2e-deps.sh <e2e-dir>

set -euo pipefail

E2E_DIR="${1:?usage: ensure-e2e-deps.sh <e2e-dir>}"
LOCKFILE="${E2E_DIR}/package-lock.json"
INSTALLED_LOCKFILE="${E2E_DIR}/node_modules/.installed-package-lock.json"

[[ -f "${LOCKFILE}" ]] || { echo "[e2e-deps] ERROR: missing ${LOCKFILE}" >&2; exit 1; }

if [[ -x "${E2E_DIR}/node_modules/.bin/vitest" ]] && cmp -s "${LOCKFILE}" "${INSTALLED_LOCKFILE}"; then
  exit 0
fi

echo "[e2e-deps] Installing ${E2E_DIR} dependencies with npm ci"
(cd "${E2E_DIR}" && npm ci --no-audit --no-fund)
cp "${LOCKFILE}" "${INSTALLED_LOCKFILE}"
