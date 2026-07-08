#!/usr/bin/env bash
# Validate platform-owned NGINX runtime images stay above the CVE-2026-42945
# fixed baseline. User-authored arbitrary workload image tests are intentionally
# out of scope; this guard covers manifests, generated proxy defaults, deploy
# helpers, and E2E fixtures that install platform-owned NGINX surfaces.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FIXED_NGINX_IMAGE="nginx:1.30.1-alpine"
EGRESS_PROXY_IMAGE="clerum/nginx-egress-proxy:0.1.0"
FORBIDDEN_PLATFORM_NGINX_TAG='(latest|alpine|1\.([0-9]|[12][0-9])(\.[0-9]+)?([^[:alnum:].]|$)|1\.30([^[:alnum:].]|$)|1\.30\.0([^[:alnum:].]|$))'
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
  "control-ui/e2e/registry-install.spec.ts"
  "control-ui/components/__tests__/RegistryInstallModal.test.tsx"
  "control-ui/components/__tests__/RegistryCatalog.test.tsx"
  "scripts/minikube/build-images.sh"
  "scripts/bootstrap-cluster.sh"
  "scripts/e2e/e2e-wrc-hcc-contracts.sh"
  "docs/deploy/workflow-recipes-guide.md"
  "workflow-recipes/samples/simple-nginx.yaml"
  "workflow-recipes/src"
  "tests/e2e/integration/control-api-k8s.test.ts"
  "tests/e2e/playwright/control-ui/recipes.spec.ts"
  "workflow-recipes/tests/e2e"
  "workflow-recipes/tests/fixtures/workflow/invalid-scheduling-no-steps.yaml"
)

require_text() {
  local path="$1"
  local text="$2"
  if ! grep -Fq -- "$text" "$PROJECT_DIR/$path"; then
    echo "ERROR: expected '$text' in $path" >&2
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
require_text "nginx-egress-proxy/Dockerfile" "FROM nginx:1.30.1-alpine" || failed=1

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "OK -- platform NGINX images use fixed CVE-2026-42945 baseline"
