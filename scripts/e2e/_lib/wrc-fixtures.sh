#!/usr/bin/env bash
# Run-owned WRC fixtures. The caller must first enter the branch mutation lease.
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../minikube" && pwd)/port-forward-owner.sh"

wrc_fixture_init() {
  wrc_require_networkpolicy_lease || return 1
  command -v jq >/dev/null || return 1
  E2E_RUN_ID="${E2E_RUN_ID:-$(openssl rand -hex 6)}"
  # Reject lossy normalization: two supplied IDs must never alias after trimming.
  [[ "$E2E_RUN_ID" =~ ^[a-z0-9]{1,12}$ ]] || {
    echo 'E2E_RUN_ID must contain 1–12 lowercase letters or digits' >&2; return 1;
  }
  export E2E_RUN_ID
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
  mkdir -p "$root/.local-notes/infra/runs"
  WRC_FIXTURE_DIR="$(mktemp -d "$root/.local-notes/infra/runs/wrc-${E2E_RUN_ID}-XXXXXX")"
  chmod 700 "$WRC_FIXTURE_DIR"
  WRC_FIXTURE_LEDGER="$WRC_FIXTURE_DIR/owned.jsonl"
  (umask 077; : > "$WRC_FIXTURE_LEDGER")
  jq -n --arg run "$E2E_RUN_ID" --arg profile "$MINIKUBE_PROFILE" \
    --arg context "$E2E_KUBECONTEXT" --arg worktree "$root" \
    '{run:$run,profile:$profile,context:$context,worktree:$worktree}' > "$WRC_FIXTURE_DIR/binding.json"
  WRC_PORT_FORWARD_PID=""
  log "WRC fixtures E2E_RUN_ID=${E2E_RUN_ID}; evidence=${WRC_FIXTURE_DIR}"
}

wrc_record_owned() {
  jq -ce '{apiVersion,kind,metadata:{name:.metadata.name,namespace:.metadata.namespace,
    uid:.metadata.uid,labels:(.metadata.labels // {})}} |
    select(.metadata.uid != null and .metadata.uid != "")' >> "$WRC_FIXTURE_LEDGER"
}

wrc_create_owned() {
  local created
  # create, never apply: a collision cannot change or enroll another run's object.
  created="$(jq --arg run "$E2E_RUN_ID" '.metadata.labels["e2e.clerum.io/run"]=$run' |
    kctl create --request-timeout=30s -f - -o json)" || return 1
  printf '%s\n' "$created" | wrc_record_owned
}

wrc_delete_owned() {
  local ns=$1 kind=$2 name=$3 wait_for_delete=${4:-true} owned current uid api_path
  [[ "$wait_for_delete" == true || "$wait_for_delete" == false ]] || return 1
  [[ "$ns" =~ ^[a-z0-9][a-z0-9.-]*$ && "$name" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || return 1
  owned="$(jq -sc --arg ns "$ns" --arg kind "$kind" --arg name "$name" '
    [.[] | select(.metadata.namespace==$ns and (.kind|ascii_downcase)==($kind|ascii_downcase)
      and .metadata.name==$name)] | last // empty' "$WRC_FIXTURE_LEDGER")" || return 1
  [[ -n "$owned" ]] || { echo "Refusing unowned delete: $ns/$kind/$name" >&2; return 1; }
  current="$(kctl get "$kind" "$name" -n "$ns" --ignore-not-found --request-timeout=30s -o json)" || return 1
  [[ -n "$current" ]] || return 0
  uid="$(jq -r '.metadata.uid' <<< "$owned")"
  # UID is the immutable ownership identity. Additional controller labels are
  # allowed, but every label recorded at enrollment must still match.
  jq -e --argjson owned "$owned" '.metadata.uid==$owned.metadata.uid and
    ((.metadata.labels // {}) | contains($owned.metadata.labels))' <<< "$current" >/dev/null || {
      echo "Ownership changed: $ns/$kind/$name" >&2; return 1;
    }
  # Use the native DELETE body to enforce UID atomically at the API server;
  # GET followed by a name-only delete could race Kubernetes GC/recreation.
  case "$(printf '%s' "$kind" | tr '[:upper:]' '[:lower:]')" in
    workflowrecipe) api_path="/apis/clerum.io/v1alpha1/namespaces/$ns/workflowrecipes/$name" ;;
    networkpolicy) api_path="/apis/networking.k8s.io/v1/namespaces/$ns/networkpolicies/$name" ;;
    deployment) api_path="/apis/apps/v1/namespaces/$ns/deployments/$name" ;;
    pod|service|configmap|secret) api_path="/api/v1/namespaces/$ns/$(printf '%s' "$kind" | tr '[:upper:]' '[:lower:]')s/$name" ;;
    *) echo "Unsupported owned resource kind: $kind" >&2; return 1 ;;
  esac
  jq -n --arg uid "$uid" '{apiVersion:"v1",kind:"DeleteOptions",
    preconditions:{uid:$uid},propagationPolicy:"Background"}' > "$WRC_FIXTURE_DIR/delete-options.json" || return 1
  kctl delete --raw "$api_path" --request-timeout=30s -f "$WRC_FIXTURE_DIR/delete-options.json" >/dev/null || return 1
  [[ "$wait_for_delete" == true ]] || return 0
  kctl wait --for=delete "$kind/$name" -n "$ns" --request-timeout=30s --timeout="${TIMEOUT_DELETE:-90}s" >/dev/null || return 1
  current="$(kctl get "$kind" "$name" -n "$ns" --ignore-not-found --request-timeout=30s -o name)" || return 1
  [[ -z "$current" ]]
}

wrc_capture_recipe_children() {
  local ns=$1 name=$2 uid=$3 target objects parent owned candidates='[]' selected
  owned="$(jq -sc --arg ns "$ns" --arg name "$name" --arg uid "$uid" '
    [.[] | select(.kind=="WorkflowRecipe" and .metadata.namespace==$ns
      and .metadata.name==$name and .metadata.uid==$uid)] | last // empty' "$WRC_FIXTURE_LEDGER")" || return 1
  [[ -n "$owned" ]] || return 1
  parent="$(kctl get workflowrecipe "$name" -n "$ns" --ignore-not-found --request-timeout=30s -o json)" || return 1
  # An absent parent cannot authorize new label-based discovery. Its previously
  # recorded children can still be deleted by their immutable UID on a retry.
  [[ -n "$parent" ]] || return 0
  jq -e --argjson owned "$owned" '.metadata.uid==$owned.metadata.uid and
    ((.metadata.labels // {}) | contains($owned.metadata.labels))' <<< "$parent" >/dev/null || {
      echo "Recipe ownership changed before child capture: $ns/$name" >&2; return 1;
    }
  for target in "$ns" sandbox-ui; do
    objects="$(kctl get deployment,service,configmap,networkpolicy -n "$target" --request-timeout=30s -o json)" || return 1
    # Cross-namespace UI resources cannot have recipe ownerReferences. WRC's
    # complete recipe namespace/name labels bind those to our collision-free CR.
    selected="$(jq -c --arg uid "$uid" --arg ns "$ns" --arg name "$name" '[.items[] |
      select(any(.metadata.ownerReferences[]?; .uid==$uid) or
        (.metadata.labels["clerum.io/recipe-namespace"]==$ns and
         .metadata.labels["clerum.io/recipe-name"]==$name) or
        (.metadata.namespace==$ns and
         .metadata.labels["clerum.io/managed-by"]=="workflow-recipes" and
         .metadata.labels["clerum.io/recipe"]==$name))
      | {apiVersion,kind,metadata:{name:.metadata.name,namespace:.metadata.namespace,
          uid:.metadata.uid,labels:(.metadata.labels // {})}}]' <<< "$objects")" || return 1
    candidates="$(jq -cn --argjson previous "$candidates" --argjson selected "$selected" '$previous + $selected')" || return 1
  done
  # Keep discovery provisional until the same parent is observed after the
  # inventory. Otherwise a replacement recipe could lend us its children's UIDs.
  parent="$(kctl get workflowrecipe "$name" -n "$ns" --ignore-not-found --request-timeout=30s -o json)" || return 1
  [[ -n "$parent" ]] && jq -e --argjson owned "$owned" '.metadata.uid==$owned.metadata.uid and
    ((.metadata.labels // {}) | contains($owned.metadata.labels))' <<< "$parent" >/dev/null || {
      echo "Recipe ownership changed during child capture: $ns/$name" >&2; return 1;
    }
  jq -c '.[]' <<< "$candidates" |
    while IFS= read -r object; do printf '%s\n' "$object" | wrc_record_owned || return 1; done
}

wrc_cleanup_owned() {
  local status=0 ns kind name uid parents records
  # Parse before process substitutions, so a truncated/corrupt ledger cannot
  # look like an empty successful cleanup.
  parents="$(jq -sc '[.[] | select(.kind=="WorkflowRecipe")]
    | unique_by([.metadata.namespace,.metadata.name])' "$WRC_FIXTURE_LEDGER")" || return 1
  # Capture generated resources before deleting recipes, including the UI
  # namespace where Kubernetes cannot garbage-collect a cross-namespace owner.
  while IFS=$'\t' read -r ns name uid; do
    [[ -n "$name" ]] || continue
    wrc_capture_recipe_children "$ns" "$name" "$uid" || return 1
  done < <(jq -r '.[] | [.metadata.namespace,.metadata.name,.metadata.uid]|@tsv' <<< "$parents")
  # Every parent must be removed before any child cleanup. A failed parent
  # ownership check or deletion must not be followed by destructive side effects.
  while IFS=$'\t' read -r ns name; do
    [[ -n "$name" ]] || continue
    wrc_delete_owned "$ns" WorkflowRecipe "$name" || return 1
  done < <(jq -r '.[] | [.metadata.namespace,.metadata.name]|@tsv' <<< "$parents")
  records="$(jq -sc 'map(select(.kind!="WorkflowRecipe"))
    | unique_by([.kind,.metadata.namespace,.metadata.name])' "$WRC_FIXTURE_LEDGER")" || return 1
  while IFS=$'\t' read -r ns kind name; do
    [[ -n "$name" ]] || continue
    wrc_delete_owned "$ns" "$kind" "$name" || status=1
  done < <(jq -r '.[] | [.metadata.namespace,.kind,.metadata.name]|@tsv' <<< "$records")
  return "$status"
}

wrc_assert_port_forward() {
  local actual_start command
  [[ -n "${WRC_PORT_FORWARD_PID:-}" ]] || return 1
  [[ "$(pf_owner_process_state "$WRC_PORT_FORWARD_PID")" == live ]] || return 1
  actual_start="$(pf_owner_process_start "$WRC_PORT_FORWARD_PID")" || return 1
  [[ "$actual_start" == "$WRC_PORT_FORWARD_START" ]] || return 1
  command="$(pf_owner_process_command "$WRC_PORT_FORWARD_PID")" || return 1
  [[ "$command" == "$WRC_PORT_FORWARD_COMMAND" ]] || return 1
  [[ "$(pf_owner_process_start "$WRC_PORT_FORWARD_PID")" == "$WRC_PORT_FORWARD_START" ]]
}

wrc_port_forward_reported_port() {
  local remote=$1 port
  pf_owner_validate_port "$remote" || return 1
  port="$(sed -nE "s/^Forwarding from 127\\.0\\.0\\.1:([0-9]+) -> ${remote}$/\\1/p" "$WRC_FIXTURE_DIR/port-forward.log")" || return 1
  # Reject absent, duplicated, IPv6-only and out-of-range bindings. The local
  # port comes exclusively from this child's output, never from a shared URL.
  pf_owner_validate_port "$port" || return 1
  printf '%s\n' "$port"
}

wrc_start_port_forward() {
  local ns=$1 service=$2 remote=$3 deadline=$((SECONDS + 30)) command
  [[ -z "${WRC_PORT_FORWARD_PID:-}" && -n "${E2E_KUBECONTEXT:-}" && -n "${MINIKUBE_PROFILE:-}" ]] || return 1
  pf_owner_validate_port "$remote" || return 1
  WRC_PORT_FORWARD_PORT=""
  WRC_PORT_FORWARD_COMMAND="${KUBECTL_BIN} --context=${E2E_KUBECONTEXT} -n ${ns} port-forward --address=127.0.0.1 svc/${service} :${remote}"
  "$KUBECTL_BIN" "--context=${E2E_KUBECONTEXT}" -n "$ns" port-forward \
    --address=127.0.0.1 "svc/${service}" ":${remote}" >"$WRC_FIXTURE_DIR/port-forward.log" 2>&1 &
  WRC_PORT_FORWARD_PID=$!
  WRC_PORT_FORWARD_START="$(pf_owner_process_start "$WRC_PORT_FORWARD_PID")" || return 1
  # Capture the exact binary path returned by ps, whose first token may be an
  # absolute path even when KUBECTL_BIN was resolved through PATH.
  while (( SECONDS < deadline )); do
    command="$(pf_owner_process_command "$WRC_PORT_FORWARD_PID")" || return 1
    if [[ "${command#* }" == "${WRC_PORT_FORWARD_COMMAND#* }" && "${command%% *}" == */kubectl || "$command" == "$WRC_PORT_FORWARD_COMMAND" ]]; then
      WRC_PORT_FORWARD_COMMAND="$command"
      if WRC_PORT_FORWARD_PORT="$(wrc_port_forward_reported_port "$remote")"; then
        pf_owner_write_record_atomic "$WRC_FIXTURE_DIR/port-forward.pid" "$WRC_PORT_FORWARD_PID" \
          "$WRC_PORT_FORWARD_START" "$MINIKUBE_PROFILE" "$E2E_KUBECONTEXT" "$(pwd -P)" \
          "$ns" "$service" "$WRC_PORT_FORWARD_PORT" "$remote" || return 1
        wrc_assert_port_forward
        return
      fi
    fi
    sleep 0.1
  done
  echo 'Owned port-forward did not report a dynamic local binding' >&2
  return 1
}

wrc_reap_port_forward() {
  local record="$WRC_FIXTURE_DIR/port-forward.pid"
  [[ "$(pf_owner_process_state "$WRC_PORT_FORWARD_PID")" == dead ]] || return 1
  # Startup can fail before publishing a record. If one exists, preserve it
  # unless both immutable process identity fields match this exact child.
  if [[ -e "$record" || -L "$record" ]]; then
    pf_owner_read_record "$record" || return 1
    [[ "$PF_OWNER_RECORD_PID" == "$WRC_PORT_FORWARD_PID" &&
       "$PF_OWNER_RECORD_START" == "$WRC_PORT_FORWARD_START" ]] || return 1
  fi
  pf_owner_reap_process "$WRC_PORT_FORWARD_PID"
  [[ "$(pf_owner_process_state "$WRC_PORT_FORWARD_PID")" == dead ]] || return 1
  pf_owner_remove_dead_record "$record" || return 1
  WRC_PORT_FORWARD_PID=""
}

wrc_stop_port_forward() {
  [[ -n "${WRC_PORT_FORWARD_PID:-}" ]] || return 0
  local index
  # A dead/reused process is a conflict, including during successful cleanup.
  wrc_assert_port_forward || { echo 'Port-forward ownership/liveness conflict' >&2; return 1; }
  pf_owner_signal_process "$WRC_PORT_FORWARD_PID" TERM || return 1
  for ((index=0; index<40; index++)); do
    if [[ "$(pf_owner_process_state "$WRC_PORT_FORWARD_PID")" == dead ]]; then
      wrc_reap_port_forward
      return
    fi
    if ! wrc_assert_port_forward; then
      # The child can exit between the state probe and ps, after our TERM.
      if [[ "$(pf_owner_process_state "$WRC_PORT_FORWARD_PID")" == dead ]]; then
        wrc_reap_port_forward
        return
      fi
      return 1
    fi
    sleep 0.1
  done
  echo 'Owned port-forward did not exit within bounded cleanup' >&2
  return 1
}
