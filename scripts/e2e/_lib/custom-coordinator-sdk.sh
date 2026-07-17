#!/usr/bin/env bash
# Entry point for custom coordinator SDK E2E helpers.

CUSTOM_COORDINATOR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/e2e/_lib/custom-coordinator-sdk-runtime.sh
source "${CUSTOM_COORDINATOR_LIB_DIR}/custom-coordinator-sdk-runtime.sh"
# shellcheck source=scripts/e2e/_lib/custom-coordinator-sdk-pod.sh
source "${CUSTOM_COORDINATOR_LIB_DIR}/custom-coordinator-sdk-pod.sh"
# shellcheck source=scripts/e2e/_lib/custom-coordinator-sdk-contract.sh
source "${CUSTOM_COORDINATOR_LIB_DIR}/custom-coordinator-sdk-contract.sh"
# shellcheck source=scripts/e2e/_lib/custom-coordinator-sdk-artifact.sh
source "${CUSTOM_COORDINATOR_LIB_DIR}/custom-coordinator-sdk-artifact.sh"
