#!/usr/bin/env bash
# ======================================================================
# Local Build Preflight
# ======================================================================
#
# Runs local package build steps before cluster/image workflows so plain
# TypeScript/Next.js compilation errors fail fast with a direct package
# name instead of surfacing later inside Docker builds.
#
# Usage:
#   ./scripts/build-preflight.sh
# ======================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[BUILD-PREFLIGHT]${NC} $*"; }
ok()   { echo -e "${GREEN}  OK${NC} -- $*"; }
err()  { echo -e "${RED}  ERROR${NC} -- $*"; }

PACKAGES=(
  "packages/workflow-sdk"
  "host-context-controller"
  "workflow-recipes"
  "mcp-host"
  "mcp-proxy"
  "control-api"
  "external-rest-api"
  "rpc-proxy"
  "channel-reader"
  "stdio-bridge"
  "control-ui"
  "profile-ui"
  "mcp-servers/web-search"
  "mcp-servers/doc-generator"
  "tests/e2e/fixtures/mock-mcp-server"
  "tests/e2e/fixtures/mock-stdio-mcp-server"
)

FAILED_PACKAGES=()

ensure_dependencies() {
  local pkg=$1
  local pkg_dir=$2
  local needs_install=false

  if [ -d "${pkg_dir}/node_modules" ]; then
    if (cd "${pkg_dir}" && npm ls --depth=0 >/dev/null 2>&1); then
      return
    fi
    log "Detected invalid dependency tree for ${pkg}; reinstalling..."
    needs_install=true
  else
    needs_install=true
  fi

  if [ "${needs_install}" = true ]; then
    log "Installing dependencies for ${pkg}..."
    if [ -f "${pkg_dir}/package-lock.json" ]; then
      (cd "${pkg_dir}" && npm ci --no-audit --no-fund)
    else
      (cd "${pkg_dir}" && npm install --no-audit --no-fund)
    fi
  fi
}

echo -e "${BOLD}=== Local Build Preflight ===${NC}"

"${PROJECT_DIR}/scripts/validate-nginx-images.sh"
"${PROJECT_DIR}/scripts/validate-workflow-backend-compat-harness.sh"

for pkg in "${PACKAGES[@]}"; do
  pkg_dir="${PROJECT_DIR}/${pkg}"
  if [ ! -f "${pkg_dir}/package.json" ]; then
    err "Missing package.json for ${pkg}"
    FAILED_PACKAGES+=("${pkg}")
    continue
  fi

  ensure_dependencies "${pkg}" "${pkg_dir}"

  log "Building ${pkg}..."
  if (cd "${pkg_dir}" && npm run build --if-present); then
    ok "${pkg}"
  else
    err "Build failed for ${pkg}"
    FAILED_PACKAGES+=("${pkg}")
  fi
done

if [ "${#FAILED_PACKAGES[@]}" -gt 0 ]; then
  err "Build preflight failed: ${FAILED_PACKAGES[*]}"
  exit 1
fi

ok "Local build preflight passed"
