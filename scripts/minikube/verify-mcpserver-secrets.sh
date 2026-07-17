#!/usr/bin/env bash
#
# verify-mcpserver-secrets.sh — Verify that every McpServer in the target
# cluster has its referenced `spec.envSecret.name` Secret resolved.
#
# Exit codes:
#   0 — all McpServers with envSecret references resolved (or no McpServers)
#   1 — one or more McpServers reference missing Secrets
#   2 — usage error (bad flags, missing kubectl, unreachable cluster)
#
# Environment:
#   KUBE_CONTEXT — kubectl context to use (default: clerum-test)
#
# Usage:
#   scripts/minikube/verify-mcpserver-secrets.sh [--help]
#   KUBE_CONTEXT=gke_project_zone_cluster scripts/minikube/verify-mcpserver-secrets.sh
#
# This is the standalone equivalent of the `validate_mcpserver_secrets()`
# function embedded in `scripts/minikube/full-setup.sh`. Intended for CI
# jobs and ad-hoc smoke checks against minikube and GKE clusters alike.
#

umask 077
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: verify-mcpserver-secrets.sh [--help]

Verifies that every McpServer in the target Kubernetes cluster has its
`spec.envSecret.name` Secret present in the same namespace.

Options:
  --help, -h    Show this help message and exit.

Environment:
  KUBE_CONTEXT  kubectl context to use (default: clerum-test). Works for
                both minikube (clerum-test) and GKE
                (gke_<project>_<zone>_<cluster>) contexts.

Exit codes:
  0  All envSecret references resolved.
  1  One or more McpServers reference missing Secrets.
  2  Usage error (bad flags, missing kubectl, unreachable cluster).
EOF
}

# Parse flags
if [ "$#" -gt 0 ]; then
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

KUBE_CONTEXT="${KUBE_CONTEXT:-clerum-test}"

# Pre-flight: kubectl available?
if ! command -v kubectl >/dev/null 2>&1; then
  echo "ERROR: kubectl not found in PATH" >&2
  exit 2
fi

# Pre-flight: context reachable?
if ! kubectl --context="$KUBE_CONTEXT" version --request-timeout=5s >/dev/null 2>&1; then
  echo "ERROR: cannot reach cluster with context '$KUBE_CONTEXT'" >&2
  echo "Hint: check KUBE_CONTEXT env var or run 'kubectl config get-contexts'" >&2
  exit 2
fi

echo ">>> Verifying McpServer envSecret references (context: $KUBE_CONTEXT)..."

failed=0
checked=0

# Enumerate all McpServers in all namespaces: namespace<TAB>name<TAB>secretName.
# Rows whose spec.envSecret.name is unset produce an empty third column and
# are skipped. Pure kubectl jsonpath — no jq/yq required.
while IFS=$'\t' read -r ns name secret_name; do
  [ -z "${ns:-}" ] && continue
  [ -z "${secret_name:-}" ] && continue
  checked=$((checked + 1))
  if ! kubectl --context="$KUBE_CONTEXT" get secret "$secret_name" -n "$ns" >/dev/null 2>&1; then
    echo "  ✗ McpServer ${ns}/${name} references missing Secret: ${secret_name}"
    failed=$((failed + 1))
  else
    echo "  ✓ ${ns}/${name} → ${secret_name}"
  fi
done < <(kubectl --context="$KUBE_CONTEXT" get mcpservers -A \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.envSecret.name}{"\n"}{end}' \
  2>/dev/null || true)

if [ "$failed" -gt 0 ]; then
  echo ""
  echo "ERROR: $failed McpServer(s) reference missing Secrets (of $checked with envSecret)."
  echo "Hint: create the referenced Secret(s) in the listed namespace(s) before retrying."
  exit 1
fi

if [ "$checked" -eq 0 ]; then
  echo ">>> No McpServers with envSecret references found — nothing to verify."
else
  echo ">>> All $checked McpServer envSecret reference(s) resolved."
fi
exit 0
