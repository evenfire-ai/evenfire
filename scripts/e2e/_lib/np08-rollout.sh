#!/usr/bin/env bash
# Rollout settle gate for the NP-08 deployed journey.
#
# The fixture Context patch appends McpServer names, which makes HCC re-read the
# Context and re-reconcile the Host. That re-reconcile does NOT necessarily
# change the pod template: the runtime-token scope hash covers only the Host's
# workflow-control scopes, the channel-ingress flag, and whether an ENABLED
# `auth.type: oauth` mcp-server is in the Context
# (host-context-controller/src/hostReconciler.ts:1290-1327 calls
# resolveRuntimeControlScopes; k8sClient.ts:2529-2539 answers "does the Context
# front an oauth server"). The only scope-driven re-mint is
# `contract_changed` (hostReconciler.ts:1462-1508), and the GFS-only branch
# reuses the stored revision and scope hash verbatim
# (hostReconciler.ts:2111-2124). The NP-08 fixtures are a `bearer` and a no-auth
# server, so the scope hash cannot move and the token revision stays put. A gate
# that only waits for a complete Deployment would therefore certify the
# ALREADY-complete pre-patch state and a later Host roll would replace the pod
# under the journey exec (observed exit 137 in the 2026-10-20 T2 run on
# 33a324d30).
#
# The gate is therefore two steps the caller must run in order:
#   1. np08_wait_hcc_context_recorded — wait for HCC's recorded observation of
#      the Context change: the owned `context-allow` NetworkPolicy HCC writes per
#      (Context, McpServer) pair (networkPolicyReconciler.ts:946-952 labels it
#      with clerum.io/context, clerum.io/mcpserver, clerum.io/policy-type and
#      clerum.io/managed-by; k8sClient.ts:4745-4762 writes it from the Context
#      watch event before k8sClient.ts:4797 re-reconciles the Host).
#   2. np08_wait_rollout_settled — complete and unchanged for N polls, then the
#      caller re-reads np08_rollout_snapshot and requires the same snapshot.
# The snapshot compares only in-process values; the token revision is never
# printed.

# np08_rollout_snapshot <namespace> <deployment>
# Prints "<generation>\t<observedGeneration>\t<readyReplicas>\t<updatedReplicas>
# \t<runtime-token-revision>\t<owned-replicasets>", or returns non-zero when the
# read fails or the Deployment is not in the response.
# One combined request (N8), and the ReplicaSets are scoped to the Deployment's
# ownerReference so a second workload in the namespace cannot block the gate
# (R3-L6).
np08_rollout_snapshot() {
  local namespace="$1"
  local deployment="$2"
  local snapshot
  snapshot="$(kctl -n "${namespace}" get deploy,rs -o json 2>/dev/null |
    jq -r --arg deployment "${deployment}" '
      [.items[]? | select(.kind == "Deployment" and .metadata.name == $deployment)]
      as $deployments
      | if ($deployments | length) != 1 then empty
        else
          $deployments[0] as $deploy
          | [
              .items[]?
              | select(.kind == "ReplicaSet")
              | select((.metadata.ownerReferences // [])
                  | any(.kind == "Deployment" and .name == $deployment))
              | select((.spec.replicas // 0) > 0)
              | .metadata.name
            ] as $replicasets
          | [
              ($deploy.metadata.generation // -1),
              ($deploy.status.observedGeneration // -1),
              ($deploy.status.readyReplicas // 0),
              ($deploy.status.updatedReplicas // 0),
              ((($deploy.spec.template.metadata.annotations // {})
                | .["clerum.io/runtime-token-revision"]) // "none"),
              (if ($replicasets | length) == 0 then "none"
                else ($replicasets | sort | join(",")) end)
            ]
          | @tsv
        end' 2>/dev/null)" || return 1
  [[ -n "${snapshot}" ]] || return 1
  printf '%s' "${snapshot}"
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
# Returns 0 only after <stable-polls> consecutive identical complete snapshots;
# 1 on timeout. A failed read counts as not settled. On success
# NP08_ROLLOUT_CERTIFIED_SNAPSHOT holds the certified snapshot so the caller can
# require that it is still current before it runs an exec inside the pod.
np08_wait_rollout_settled() {
  local namespace="$1"
  local deployment="$2"
  local timeout_seconds="$3"
  local stable_needed="$4"
  local poll_seconds="$5"
  local deadline now snapshot previous='' stable=0
  NP08_ROLLOUT_CERTIFIED_SNAPSHOT=''
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
      if [[ "${stable}" -ge "${stable_needed}" ]]; then
        # shellcheck disable=SC2034 # read by the caller, never exported
        NP08_ROLLOUT_CERTIFIED_SNAPSHOT="${snapshot}"
        return 0
      fi
    else
      stable=0
      previous=''
    fi
    now="$(date +%s)"
    [[ "${now}" -lt "${deadline}" ]] || return 1
    sleep "${poll_seconds}"
  done
}

# np08_hcc_context_recorded <host-namespace> <context-id> <mcp-server-name>
# Returns 0 only when HCC's OWN record of the Context change exists: the
# `context-allow` NetworkPolicy HCC derives from the Context's mcpServers list,
# scoped to this Context and this McpServer, in the Host namespace. The
# managed-by and policy-type labels keep a same-named foreign policy from
# satisfying the gate. A failed read is not an observation.
np08_hcc_context_recorded() {
  local namespace="$1"
  local context_id="$2"
  local server_name="$3"
  local selector policies
  [[ -n "${namespace}" && -n "${context_id}" && -n "${server_name}" ]] || return 1
  # Only plain label values can be selected; anything else is a caller bug and
  # must fail instead of producing a selector that matches nothing.
  [[ "${context_id}" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  [[ "${server_name}" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  selector='clerum.io/managed-by=host-context-controller,clerum.io/policy-type=context-allow'
  selector="${selector},clerum.io/context=${context_id},clerum.io/mcpserver=${server_name}"
  policies="$(kctl -n "${namespace}" get networkpolicy -l "${selector}" -o json 2>/dev/null)" ||
    return 1
  printf '%s' "${policies}" |
    jq -e '(.items // []) | length > 0' >/dev/null 2>&1 || return 1
  return 0
}

# np08_wait_hcc_context_recorded <host-namespace> <context-id> <mcp-server-name>
#   <timeout-seconds> <poll-seconds>
# Returns 0 once HCC's record exists; 1 on timeout. Every appended server the
# fixture relies on needs its own record, so the caller waits per server.
np08_wait_hcc_context_recorded() {
  local namespace="$1"
  local context_id="$2"
  local server_name="$3"
  local timeout_seconds="$4"
  local poll_seconds="$5"
  local deadline now
  deadline=$(( $(date +%s) + timeout_seconds ))
  while :; do
    np08_hcc_context_recorded "${namespace}" "${context_id}" "${server_name}" && return 0
    now="$(date +%s)"
    [[ "${now}" -lt "${deadline}" ]] || return 1
    sleep "${poll_seconds}"
  done
}
