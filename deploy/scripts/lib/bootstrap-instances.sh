#!/usr/bin/env bash
# Shared instance bootstrap policy. Callers authorize the Kubernetes context
# and, for local profiles, hold the appropriate mutation lease.

read_bootstrap_context() (
  set -o pipefail
  local context="${1:?Kubernetes context is required}"
  local resource="${2:?Context declaration is required}"
  local response

  if ! response="$(kubectl --context "$context" get -f - --ignore-not-found -o json <<<"$resource")"; then
    printf '[bootstrap-instances] ERROR: cannot inspect an existing Context\n' >&2
    return 1
  fi
  [ -n "$response" ] || return 0

  # A manifest-based kubectl get returns a v1 List, even for one object.
  # Accept the previously supported single-object form too, but never treat
  # an invalid, ambiguous, or differently identified response as absence.
  if ! printf '%s\n%s\n' "$response" "$resource" | jq -s -e -c '
    if length != 2 then error("unexpected Context response count")
    else .[0] as $response | .[1] as $desired |
      (if ($response | type) != "object" then error("invalid Context response")
       elif $response.kind == "List" then
         if $response.apiVersion != "v1" or ($response.items | type) != "array" then
           error("invalid Context List")
         elif ($response.items | length) == 1 then $response.items[0]
         else error("unexpected Context List cardinality") end
       else $response end) as $observed |
      if ($observed | type) != "object" then error("invalid Context item")
      elif $observed.apiVersion != $desired.apiVersion or $observed.kind != $desired.kind or
           $observed.metadata.name != $desired.metadata.name or
           ($observed.metadata.namespace // "") != ($desired.metadata.namespace // "") then
        error("Context identity mismatch")
      else $observed end
    end
  '; then
    printf '[bootstrap-instances] ERROR: cannot validate Context response\n' >&2
    return 1
  fi
)

apply_bootstrap_instances() (
  set -o pipefail
  local context="${1:?Kubernetes context is required}"
  local instances="${2:?instances manifest or directory is required}"
  local seed="${3:-}"
  local resources seed_resources='[]' plan resource existing initial migration
  local base_apply seed_apply base_count seed_count

  if ! command -v jq >/dev/null 2>&1; then
    printf '[bootstrap-instances] ERROR: jq is required\n' >&2
    return 1
  fi

  if ! resources="$(kubectl --context "$context" create --dry-run=client -f "$instances" -o json | jq -s -c '
    [ .[] | if .kind == "List" then .items[] else . end ]
    | if length == 0 then error("no instance resources") else . end
  ')"; then
    printf '[bootstrap-instances] ERROR: cannot render instances from %s\n' "$instances" >&2
    return 1
  fi

  if [ -n "$seed" ]; then
    if ! seed_resources="$(kubectl --context "$context" create --dry-run=client -f "$seed" -o json | jq -s -c '
      [ .[] | if .kind == "List" then .items[] else . end ]
      | if length == 0 then error("no seed resources") else . end
    ')"; then
      printf '[bootstrap-instances] ERROR: cannot render seed instances from %s\n' "$seed" >&2
      return 1
    fi

  fi

  # Protect only mcp-server/context1's connector selection. Keep the base and
  # seed apply order; the seed supplies context1's initial value if it exists.
  if ! plan="$(printf '%s\n%s\n' "$resources" "$seed_resources" | jq -s -c '
    def is_target:
      .kind == "Context" and ((.apiVersion // "") | startswith("clerum.io/")) and
      .metadata.namespace == "mcp-server" and .metadata.name == "context1";
    def applyable:
      if is_target then .spec = ((.spec // {}) | del(.mcpServers)) else . end;
    def apply_list:
      {apiVersion:"v1", kind:"List", items:[.[] | applyable]};
    .[0] as $base | .[1] as $seed
    | [ $base[] | select(is_target) ] as $base_target
    | [ $seed[] | select(is_target) ] as $seed_target
    | if ($base_target | length) > 1 or ($seed_target | length) > 1 then
        error("ambiguous context1 declarations")
      else
        {target: ($seed_target[0] // $base_target[0] // null),
         base: ($base | apply_list), seed: ($seed | apply_list)}
      end
  ')" ||
     ! resource="$(jq -c '.target // empty' <<<"$plan")" ||
     ! base_apply="$(jq -c '.base' <<<"$plan")" ||
     ! seed_apply="$(jq -c '.seed' <<<"$plan")" ||
     ! base_count="$(jq '.items | length' <<<"$base_apply")" ||
     ! seed_count="$(jq '.items | length' <<<"$seed_apply")"; then
    printf '[bootstrap-instances] ERROR: cannot classify instance declarations\n' >&2
    return 1
  fi

  # Transfer only the connector list from client-side apply to Control UI.
  # Keep the rest of the previous apply baseline so normal field updates and
  # removals continue to work.
  if [ -n "$resource" ]; then
    if ! existing="$(read_bootstrap_context "$context" "$resource")"; then
      return 1
    fi
    if [ -z "$existing" ]; then
      # A preexisting last-applied annotation is rewritten by kubectl create,
      # claiming the initial connectors. Let the first apply establish it instead.
      # Exclusive create fails if another writer wins the existence race.
      if ! initial="$(jq -c 'del(.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"])' <<<"$resource")"; then
        printf '[bootstrap-instances] ERROR: cannot prepare initial context1\n' >&2
        return 1
      fi
      kubectl --context "$context" create -f - <<<"$initial" || return 1
    else
      # An older deployment may have claimed mcpServers in last-applied. Remove
      # only that field from the old baseline, with identity and value tests so
      # a concurrent deploy cannot overwrite a newer baseline. A UI connector
      # update does not change this annotation and remains untouched.
      if ! migration="$(jq -c '
        . as $live |
        ($live.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] // null) as $old |
        if $old == null then empty
        elif ($old | type) != "string" then error("invalid last-applied annotation")
        else ($old | fromjson) as $previous |
          if ($previous | type) != "object" or $previous.apiVersion != $live.apiVersion or
             $previous.kind != $live.kind or $previous.metadata.name != $live.metadata.name or
             (($previous.metadata.namespace // $live.metadata.namespace) != $live.metadata.namespace) or
             (($previous.spec // {}) | type) != "object" then
            error("invalid last-applied Context")
          elif (($previous.spec // {}) | has("mcpServers")) then
            if ($live.metadata.uid | type) != "string" or $live.metadata.uid == "" then
              error("missing Context UID")
            else
              [ {op:"test",path:"/metadata/uid",value:$live.metadata.uid},
                {op:"test",path:"/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration",value:$old},
                {op:"replace",path:"/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration",
                 value:($previous | del(.spec.mcpServers) | tojson)} ]
            end
          else empty end
        end
      ' <<<"$existing" 2>/dev/null)"; then
        printf '[bootstrap-instances] ERROR: invalid context1 last-applied configuration\n' >&2
        return 1
      fi
      if [ -n "$migration" ]; then
        kubectl --context "$context" -n mcp-server patch contexts.clerum.io context1 \
          --type=json --patch-file=/dev/stdin -o name <<<"$migration" || return 1
      fi
    fi
  fi

  # Keep each resource as its own JSON document. A v1/List forces kubectl's
  # client-side validation, which rejects the intentionally omitted required
  # mcpServers field before the server can validate the merged Context.
  if [ "$base_count" -gt 0 ]; then
    jq -c '.items[]' <<<"$base_apply" | kubectl --context "$context" apply -f - || return 1
  fi
  if [ "$seed_count" -gt 0 ]; then
    jq -c '.items[]' <<<"$seed_apply" | kubectl --context "$context" apply -f - || return 1
  fi
)
