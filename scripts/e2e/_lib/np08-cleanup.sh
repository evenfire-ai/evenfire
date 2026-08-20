#!/usr/bin/env bash

# Fail-closed residual check for the NP-08 service-to-service E2E. The caller
# provides the existing `kctl` function and MCP_NS namespace; this helper never
# prints object names or Secret values.

np08_cleanup_check_residual() {
  local resource="$1"
  local label_selector="$2"
  local residual

  if ! residual="$(kctl -n "${MCP_NS}" get "${resource}" \
    -l "${label_selector}" -o name 2>/dev/null)"; then
    return 1
  fi
  [[ -z "${residual}" ]]
}

# Keep the original journey failure when cleanup succeeds. A cleanup failure
# upgrades an otherwise successful journey to a generic failure, but never
# turns an existing failure into success.
np08_cleanup_final_status() {
  local prior_status="$1"
  local cleanup_status="$2"

  if [[ "${cleanup_status}" -ne 0 ]]; then
    printf '1'
  else
    printf '%s' "${prior_status}"
  fi
}
