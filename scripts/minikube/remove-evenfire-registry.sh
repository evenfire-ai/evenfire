#!/usr/bin/env bash
# Remove the optional local Registry workloads while retaining their data and
# connection material. The configured centralized Registry is independent.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PROFILE="${MINIKUBE_PROFILE:-}"
CONTEXT="${CONTROL_API_REAL_PG_CONTEXT:-}"
if [[ -z "${PROFILE}" || -z "${CONTEXT}" || "${PROFILE}" != "${CONTEXT}" ]]; then
  printf 'DEVELOPMENT_SCOPE_REQUIRED: select one owned profile and matching context\n' >&2
  exit 1
fi

# The public Make target owns the lease; direct unleased execution must fail
# before the first Kubernetes operation.
source "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh"

# Absence is the intended result, so repeated cleanup is idempotent. Never
# delete namespaces, PVCs, Secrets or ConfigMaps, or a registry in kube-system.
kubectl "--context=${CONTEXT}" --request-timeout=20s -n registry delete \
  deployment registry-api registry-minio registry-postgres registry-zot \
  --ignore-not-found --wait=true --timeout=90s
kubectl "--context=${CONTEXT}" --request-timeout=20s -n registry delete \
  service registry-api registry-minio registry-postgres registry-zot \
  --ignore-not-found --wait=true --timeout=90s

printf 'LOCAL_REGISTRY_REMOVAL=PASS\n'
