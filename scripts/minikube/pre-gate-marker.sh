#!/usr/bin/env bash

# Shared, side-effect-free provenance helpers for the Minikube pre-gate marker.
# This file performs no Kubernetes, Docker, or network operation.

pre_gate_marker_fingerprint_dir() {
  local project_dir="$1"
  local dir="$2"

  if [[ ! -d "${project_dir}/${dir}" ]]; then
    echo "missing"
    return 0
  fi

  local digest
  if ! digest="$(
    set -o pipefail
    find "${project_dir}/${dir}" \
      -type f \
      ! -path '*/node_modules/*' \
      ! -path '*/dist/*' \
      ! -path '*/.next/*' \
      ! -path '*/playwright-report/*' \
      ! -path '*/test-results/*' \
      ! -path '*/coverage/*' \
      -exec shasum {} + 2>/dev/null | sort | shasum | awk '{print $1}'
  )"; then
    return 1
  fi
  [[ "${digest}" =~ ^[0-9a-f]{40}$ ]] || return 1

  printf '%s\n' "${digest}"
}

pre_gate_marker_fingerprint_dirs() {
  local project_dir="$1"
  shift
  (( $# > 0 )) || return 1

  local dir digest
  if ! digest="$(
    set -o pipefail
    for dir in "$@"; do
      pre_gate_marker_fingerprint_dir "${project_dir}" "${dir}" || exit 1
    done | shasum | awk '{print $1}'
  )"; then
    return 1
  fi
  [[ "${digest}" =~ ^[0-9a-f]{40}$ ]] || return 1

  printf '%s\n' "${digest}"
}

pre_gate_marker_cluster_fingerprint() {
  local project_dir="$1"
  pre_gate_marker_fingerprint_dirs "${project_dir}" \
    control-api \
    external-rest-api \
    rpc-proxy \
    mcp-host \
    host-context-controller \
    packages/workflow-runtime-core \
    packages/network-policy-core \
    workflow-recipes \
    packages/workflow-sdk \
    tests/e2e/fixtures/custom-workflow-coordinator \
    channel-reader \
    workflow-approval-request-reader \
    control-ui \
    deploy \
    charts \
    scripts/minikube
}

pre_gate_marker_infra_fingerprint() {
  local project_dir="$1"
  pre_gate_marker_fingerprint_dirs "${project_dir}" \
    deploy \
    charts \
    scripts/minikube
}
