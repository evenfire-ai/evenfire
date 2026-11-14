#!/usr/bin/env bash
# Shared instance bootstrap policy. Callers authorize the Kubernetes context
# and, for local profiles, hold the appropriate mutation lease.

apply_bootstrap_instances() (
  set -o pipefail
  local context="${1:?Kubernetes context is required}"
  local instances="${2:?instances manifest or directory is required}"
  local seed="${3:-}"
  local resources seed_resources contexts others other_count resource existing
  local -a missing=()

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

  if ! jq -e '
    [ .[] | select(.kind == "Context" and ((.apiVersion // "") | startswith("clerum.io/"))) |
      [((.apiVersion // "") | split("/")[0]), .kind, (.metadata.namespace // ""), .metadata.name] ]
    | group_by(.) | all(.[]; length == 1)
  ' <<<"$resources" >/dev/null; then
    printf '[bootstrap-instances] ERROR: ambiguous base Context declarations\n' >&2
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

    # A profile may supply a different initial Context declaration. Resolve it
    # before creation, but never use it to replace a Context that already exists.
    if ! resources="$(printf '%s\n%s\n' "$resources" "$seed_resources" | jq -s -c '
      def is_context:
        .kind == "Context" and ((.apiVersion // "") | startswith("clerum.io/"));
      def identity:
        [((.apiVersion // "") | split("/")[0]), .kind,
         (.metadata.namespace // ""), .metadata.name];
      def unique_contexts:
        [ .[] | select(is_context) | identity ] | group_by(.) | all(.[]; length == 1);
      .[0] as $base | .[1] as $seed
      | if (($base | unique_contexts) and ($seed | unique_contexts)) | not then
          error("ambiguous Context declarations")
        else
          [ $base[] | if is_context then . as $item |
              ([ $seed[] | select(is_context) | select(identity == ($item | identity)) ] | first) // $item
            else . end ]
          + [ $seed[] | if is_context then . as $item |
                select(all($base[]; (is_context | not) or (identity != ($item | identity))))
              else . end ]
        end
    ')"; then
      printf '[bootstrap-instances] ERROR: cannot compose instance declarations\n' >&2
      return 1
    fi
  fi

  if ! contexts="$(jq -c '.[] | select(.kind == "Context" and ((.apiVersion // "") | startswith("clerum.io/")))' <<<"$resources")" ||
     ! others="$(jq -c '{apiVersion:"v1", kind:"List", items:[.[] | select((.kind == "Context" and ((.apiVersion // "") | startswith("clerum.io/"))) | not)]}' <<<"$resources")" ||
     ! other_count="$(jq '.items | length' <<<"$others")"; then
    printf '[bootstrap-instances] ERROR: cannot classify instance declarations\n' >&2
    return 1
  fi

  # Validate every existing Context before creating or applying any instances.
  while IFS= read -r resource; do
    [ -n "$resource" ] || continue
    if ! existing="$(kubectl --context "$context" get -f - --ignore-not-found -o json <<<"$resource")"; then
      printf '[bootstrap-instances] ERROR: cannot inspect an existing Context\n' >&2
      return 1
    fi
    if [ -z "$existing" ]; then
      missing+=("$resource")
      continue
    fi

    if ! printf '%s\n%s\n' "$existing" "$resource" | jq -s -e '
      def managed:
        {apiVersion, kind,
         metadata: ((.metadata // {}) |
                    {name, namespace: (.namespace // ""), labels: (.labels // {}),
                     annotations: ((.annotations // {}) | del(.["kubectl.kubernetes.io/last-applied-configuration"]))}
                    + (if has("ownerReferences") then {ownerReferences} else {} end)
                    + (if has("finalizers") then {finalizers} else {} end)),
         spec: ((.spec // {}) | del(.mcpServers))};
      def contains_declared($live; $desired):
        if ($desired | type) == "object" then
          ($live | type) == "object" and
          all($desired | keys[]; . as $key |
            ($live | has($key)) and contains_declared($live[$key]; $desired[$key]))
        else $live == $desired end;
      .[0] as $live | .[1] as $desired
      | ($live.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] // null) as $saved
      | if $saved == null then contains_declared(($live | managed); ($desired | managed))
        else (($saved | fromjson | managed) == ($desired | managed)) end
    ' >/dev/null; then
      printf '[bootstrap-instances] ERROR: existing Context manifest changed or its last-applied configuration is invalid; use an explicit Context migration\n' >&2
      return 1
    fi
    printf '[bootstrap-instances] Preserving existing Context configuration\n' >&2
  done <<<"$contexts"

  if [ "${#missing[@]}" -gt 0 ]; then
    for resource in "${missing[@]}"; do
      # Exclusive create fails if another writer wins after the existence check.
      kubectl --context "$context" create --save-config -f - <<<"$resource" || return 1
    done
  fi

  if [ "$other_count" -gt 0 ]; then
    kubectl --context "$context" apply -f - <<<"$others" || return 1
  fi
)
