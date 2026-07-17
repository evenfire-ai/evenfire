#!/bin/bash
set -euo pipefail

PROFILE="clerum-test"

echo "=== Deleting minikube cluster: ${PROFILE} ==="
minikube delete --profile "${PROFILE}" 2>/dev/null || true

echo "=== Cluster deleted ==="
