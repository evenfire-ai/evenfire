#!/usr/bin/env bash
# Validate platform-owned NGINX runtime images stay on the fixed security
# baseline: stable 1.30.6, which fixes CVE-2026-15176, CVE-2026-93479,
# CVE-2026-95101, CVE-2026-97629 and CVE-2026-97205 (and the older
# CVE-2026-42945). User-authored arbitrary workload image tests are
# intentionally out of scope; this guard covers manifests, generated proxy
# defaults, deploy helpers, shipped recipe samples, and E2E fixtures that
# install platform-owned NGINX surfaces.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FIXED_NGINX_IMAGE="nginx:1.30.6-alpine"
FIXED_NGINX_IMAGE_DIGEST="sha256:c59d1f8b1e0e42da75be973424cd72e23f7f8adfb54e982f4d1cd0216a5a5576"
EGRESS_PROXY_IMAGE="clerum/nginx-egress-proxy:0.1.0"
# Rejected tags: floating tags (latest, alpine, stable, mainline, 1, 1.30, 1.31),
# every release below 1.30 (incl. CVE-2026-42945, fixed in 1.30.1), stable
# 1.30.0-1.30.5 and mainline 1.31.0-1.31.6 (October 2026 CVEs, fixed in 1.30.6
# and 1.31.7). Each alternative ends at a non-alphanumeric, non-dot character so
# 1.30.50 or 1.31.60 are not mistaken for 1.30.5 or 1.31.6.
FORBIDDEN_PLATFORM_NGINX_TAG='(latest|alpine|stable|mainline|1([^[:alnum:].]|$)|1\.([0-9]|[12][0-9])(\.[0-9]+)?([^[:alnum:].]|$)|1\.3[01]([^[:alnum:].]|$)|1\.30\.[0-5]([^[:alnum:].]|$)|1\.31\.[0-6]([^[:alnum:].]|$))'
FORBIDDEN_PLATFORM_NGINX_REGEX="nginx:${FORBIDDEN_PLATFORM_NGINX_TAG}|nginxinc/nginx-unprivileged:${FORBIDDEN_PLATFORM_NGINX_TAG}"

scan_paths=(
  "deploy/base/control-plane"
  "deploy/base/profiles/profile-control-funnel.yaml"
  "deploy/overlays/gcp-dev"
  "deploy/overlays/gcp-prod"
  "deploy/overlays/minikube"
  "host-context-controller/src/config.ts"
  "host-context-controller/src/__tests__/reconciler.remote.test.ts"
  "host-context-controller/src/__tests__/reconciler.sanitize.test.ts"
  "control-api/src/routes/admin/registry.ts"
  "control-api/src/routes/admin/remoteMcp.ts"
  "nginx-egress-proxy/Dockerfile"
  "control-ui/e2e/registry-install.spec.ts"
  "control-ui/components/__tests__/RegistryInstallModal.test.tsx"
  "control-ui/components/__tests__/RegistryCatalog.test.tsx"
  "scripts/minikube/build-images.sh"
  "scripts/bootstrap-cluster.sh"
  "scripts/e2e"
  "docs/deploy/workflow-recipes-guide.md"
  "workflow-recipes/samples"
  "workflow-recipes/src"
  "tests/e2e/integration/control-api-k8s.test.ts"
  "tests/e2e/playwright/control-ui/recipes.spec.ts"
  "workflow-recipes/tests/e2e"
  "workflow-recipes/tests/fixtures/workflow/invalid-scheduling-no-steps.yaml"
)

# Keep only paths present in this checkout so the guard is portable across the
# public repo (base + minikube, no gcp overlays) and the infra-assembled tree
# (with gcp-dev/gcp-prod overlays). Missing paths are skipped, not errors — the
# base manifests the overlays inherit from are always scanned.
_present=()
for _p in "${scan_paths[@]}"; do
  [ -e "$PROJECT_DIR/$_p" ] && _present+=("$_p")
done
scan_paths=("${_present[@]}")

require_text() {
  local path="$1"
  local text="$2"
  if ! grep -Fq -- "$text" "$PROJECT_DIR/$path"; then
    echo "ERROR: expected '$text' in $path" >&2
    return 1
  fi
}

# The egress proxy Dockerfile must have exactly one FROM, equal to the fixed
# image pinned by its multi-arch index digest.
require_single_from() {
  local path="$1"
  local expected="$2"
  local from_lines
  from_lines="$(grep -E '^[[:space:]]*FROM[[:space:]]' "$PROJECT_DIR/$path" || true)"
  if [ "$from_lines" != "$expected" ]; then
    echo "ERROR: $path must have exactly one FROM line, '$expected'; found: ${from_lines:-<none>}" >&2
    return 1
  fi
}

scan_forbidden_nginx_refs() {
  cd "$PROJECT_DIR"
  if command -v rg >/dev/null 2>&1; then
    rg -n "$FORBIDDEN_PLATFORM_NGINX_REGEX" "${scan_paths[@]}"
  else
    grep -RInE "$FORBIDDEN_PLATFORM_NGINX_REGEX" "${scan_paths[@]}"
  fi
}

failed=0

if scan_forbidden_nginx_refs; then
  echo "ERROR: vulnerable or floating platform NGINX image reference found." >&2
  failed=1
else
  scan_status=$?
  if [ "$scan_status" -gt 1 ]; then
    echo "ERROR: platform NGINX image scan failed with status $scan_status." >&2
    failed=1
  fi
fi

require_text "deploy/base/control-plane/control-api-rpc-gateway.yaml" "$FIXED_NGINX_IMAGE" || failed=1
require_text "deploy/base/control-plane/host-context-controller-api-gateway.yaml" "$FIXED_NGINX_IMAGE" || failed=1
require_text "deploy/base/control-plane/nginx-workflow-approval-gateway.yaml" "$FIXED_NGINX_IMAGE" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "$FIXED_NGINX_IMAGE" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "allowPrivilegeEscalation: false" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "runAsNonRoot: true" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "runAsUser: 101" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "drop:" || failed=1
require_text "deploy/base/profiles/profile-control-funnel.yaml" "- ALL" || failed=1
require_text "deploy/base/control-plane/control-api.yaml" "$EGRESS_PROXY_IMAGE" || failed=1
require_text "deploy/base/control-plane/host-context-controller.yaml" "$EGRESS_PROXY_IMAGE" || failed=1
require_text "host-context-controller/src/config.ts" "$EGRESS_PROXY_IMAGE" || failed=1
require_text "control-api/src/routes/admin/registry.ts" "$EGRESS_PROXY_IMAGE" || failed=1
require_text "control-api/src/routes/admin/remoteMcp.ts" "$EGRESS_PROXY_IMAGE" || failed=1
require_single_from "nginx-egress-proxy/Dockerfile" "FROM ${FIXED_NGINX_IMAGE}@${FIXED_NGINX_IMAGE_DIGEST}" || failed=1

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "OK -- platform NGINX images use fixed ${FIXED_NGINX_IMAGE} security baseline"
