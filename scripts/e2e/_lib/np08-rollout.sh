#!/usr/bin/env bash
# Rollout settle gate for the NP-08 deployed journey.
#
# The fixture Context patch makes HCC reconcile the Host deployment, and a
# runtime-token rotation changes the pod template (the
# clerum.io/runtime-token-revision annotation), which rolls the mcp-host pod.
# A journey exec started in the old pod dies with it (observed exit 137 in the
# 2026-10-20 T2 run on 33a324d30). The journey must therefore start only once
# the deployment has completed any rollout the fixtures triggered and its
# template has stopped changing. Snapshots are compared in-process only; the
# token revision value is never printed.

np08_rollout_snapshot() {
  local namespace="$1"
  local deployment="$2"
  local deploy_tsv rs_names
  deploy_tsv="$(kctl -n "${namespace}" get deployment "${deployment}" -o json 2>/dev/null |
    jq -r '[.metadata.generation // -1, .status.observedGeneration // -1,
      .status.readyReplicas // 0, .status.updatedReplicas // 0,
      ((.spec.template.metadata.annotations // {})["clerum.io/runtime-token-revision"] // "none")]
      | @tsv' 2>/dev/null)" || return 1
  rs_names="$(kctl -n "${namespace}" get replicaset -o json 2>/dev/null |
    jq -r '[.items[]? | select((.spec.replicas // 0) > 0) | .metadata.name]
      | sort | if length == 0 then "none" else join(",") end' 2>/dev/null)" || return 1
  [[ -n "${deploy_tsv}" && -n "${rs_names}" ]] || return 1
  printf '%s\t%s' "${deploy_tsv}" "${rs_names}"
}

np08_rollout_complete() {
  local snapshot="$1"
  local generation observed ready updated revision rs_names
  IFS=$'\t' read -r generation observed ready updated revision rs_names <<<"${snapshot}"
  [[ -n "${generation}" && "${generation}" != '-1' ]] || return 1
  [[ "${generation}" == "${observed}" ]] || return 1
  [[ "${ready}" =~ ^[0-9]+$ && "${ready}" -ge 1 ]] || return 1
  [[ "${updated}" == "${ready}" ]] || return 1
  [[ -n "${revision}" ]] || return 1
  [[ -n "${rs_names}" && "${rs_names}" != 'none' && "${rs_names}" != *,* ]] || return 1
  return 0
}

# np08_wait_rollout_settled <namespace> <deployment> <timeout-seconds>
#   <stable-polls> <poll-seconds>
# Returns 0 only after <stable-polls> consecutive identical complete
# snapshots; 1 on timeout. A failed read counts as not settled.
np08_wait_rollout_settled() {
  local namespace="$1"
  local deployment="$2"
  local timeout_seconds="$3"
  local stable_needed="$4"
  local poll_seconds="$5"
  local deadline now snapshot previous='' stable=0
  deadline=$(( $(date +%s) + timeout_seconds ))
  while :; do
    if snapshot="$(np08_rollout_snapshot "${namespace}" "${deployment}")" &&
      np08_rollout_complete "${snapshot}"; then
      if [[ "${snapshot}" == "${previous}" ]]; then
        stable=$((stable + 1))
      else
        stable=1
        previous="${snapshot}"
      fi
      [[ "${stable}" -ge "${stable_needed}" ]] && return 0
    else
      stable=0
      previous=''
    fi
    now="$(date +%s)"
    [[ "${now}" -lt "${deadline}" ]] || return 1
    sleep "${poll_seconds}"
  done
}
