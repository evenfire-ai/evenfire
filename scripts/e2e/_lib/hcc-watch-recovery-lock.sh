#!/usr/bin/env bash

# Exclusive ownership for the disruptive HCC watch-recovery gate. The
# ConfigMap is a persistent semaphore: resourceVersion-backed replace makes
# acquisition and release compare-and-swap operations without delete races.

build_active_hcc_watch_gate_lock() {
  local existing=${1:-} repo_root worktree_id git_head started_at
  repo_root="$(git -C "${SCRIPT_DIR}/../.." rev-parse --show-toplevel)"
  worktree_id="$(printf '%s' "$repo_root" | shasum | awk '{print $1}')"
  git_head="$(git -C "$repo_root" rev-parse HEAD)"
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if [ -n "$existing" ]; then
    jq -c --arg holder "$RUN_ID" --arg startedAt "$started_at" \
      --arg context "$E2E_KUBECONTEXT" --arg gitHead "$git_head" \
      --arg worktreeId "$worktree_id" '
        .metadata.labels["e2e.clerum.io/coordination"] = "hcc-watch-recovery" |
        .data = {state:"active",holder:$holder,startedAt:$startedAt,
          context:$context,gitHead:$gitHead,worktreeId:$worktreeId}
      ' <<<"$existing"
    return
  fi

  jq -cn --arg name "$HCC_GATE_LOCK_NAME" --arg namespace "$HCC_NS" \
    --arg holder "$RUN_ID" --arg startedAt "$started_at" \
    --arg context "$E2E_KUBECONTEXT" --arg gitHead "$git_head" \
    --arg worktreeId "$worktree_id" '
      {apiVersion:"v1",kind:"ConfigMap",
       metadata:{name:$name,namespace:$namespace,
         labels:{"e2e.clerum.io/coordination":"hcc-watch-recovery"}},
       data:{state:"active",holder:$holder,startedAt:$startedAt,
         context:$context,gitHead:$gitHead,worktreeId:$worktreeId}}
    '
}

acquire_hcc_watch_gate_lock() {
  local desired existing holder state result

  HCC_GATE_LOCK_NAME="${HCC_GATE_LOCK_NAME:-$(truncate_rfc1123 "e2e-hcc-watch-lock-${HCC_DEPLOY}")}"
  desired="$(build_active_hcc_watch_gate_lock)"
  if result="$(kctl create -f - -o json <<<"$desired" 2>/dev/null)"; then
    :
  else
    existing="$(kctl get configmap "$HCC_GATE_LOCK_NAME" -n "$HCC_NS" -o json 2>/dev/null)" || {
      echo "Could not create or read HCC gate lock ${HCC_NS}/${HCC_GATE_LOCK_NAME}." >&2
      return 1
    }
    holder="$(jq -r '.data.holder // ""' <<<"$existing")"
    state="$(jq -r '.data.state // "unknown"' <<<"$existing")"
    if [ "$state" != released ] || [ -n "$holder" ]; then
      echo "Refusing concurrent HCC fault injection: ${HCC_NS}/${HCC_GATE_LOCK_NAME} state=${state}, holder=${holder:-unknown}, startedAt=$(jq -r '.data.startedAt // "unknown"' <<<"$existing"), gitHead=$(jq -r '.data.gitHead // "unknown"' <<<"$existing")." >&2
      return 1
    fi
    desired="$(build_active_hcc_watch_gate_lock "$existing")"
    result="$(kctl replace -f - -o json <<<"$desired" 2>/dev/null)" || {
      echo "HCC gate lock changed while acquiring it; refusing fault injection." >&2
      return 1
    }
  fi

  HCC_GATE_LOCK_UID="$(jq -r '.metadata.uid // ""' <<<"$result")"
  HCC_GATE_LOCK_ACQUIRED=1
  [ -n "$HCC_GATE_LOCK_UID" ] || {
    echo "Acquired HCC gate lock has no UID; retaining it fail-closed." >&2
    return 1
  }
}

release_hcc_watch_gate_lock() {
  local existing holder uid released result released_at

  [ "$HCC_GATE_LOCK_ACQUIRED" = 1 ] || return 0
  [ -n "$HCC_GATE_LOCK_UID" ] || {
    echo "Refusing to release HCC gate lock without a verified acquisition UID." >&2
    return 1
  }
  existing="$(kctl get configmap "$HCC_GATE_LOCK_NAME" -n "$HCC_NS" -o json 2>/dev/null)" || return 1
  holder="$(jq -r '.data.holder // ""' <<<"$existing")"
  uid="$(jq -r '.metadata.uid // ""' <<<"$existing")"
  if [ "$holder" != "$RUN_ID" ] || [ -z "$uid" ] || [ "$uid" != "$HCC_GATE_LOCK_UID" ]; then
    echo "Refusing to release HCC gate lock owned by holder=${holder:-unknown}, uid=${uid:-unknown}." >&2
    return 1
  fi

  released_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  released="$(jq -c --arg releasedAt "$released_at" --arg lastHolder "$RUN_ID" '
    .data.state = "released" | .data.holder = "" |
    .data.releasedAt = $releasedAt | .data.lastHolder = $lastHolder
  ' <<<"$existing")"
  result="$(kctl replace -f - -o json <<<"$released" 2>/dev/null)" || return 1
  [ "$(jq -r '.metadata.uid // ""' <<<"$result")" = "$HCC_GATE_LOCK_UID" ] &&
    [ "$(jq -r '.data.state // ""' <<<"$result")" = released ] &&
    [ -z "$(jq -r '.data.holder // ""' <<<"$result")" ] || return 1
  HCC_GATE_LOCK_ACQUIRED=0
}

print_hcc_watch_gate_lock_instructions() {
  local existing observed_holder observed_uid observed_state
  existing="$(kctl get configmap "$HCC_GATE_LOCK_NAME" -n "$HCC_NS" -o json 2>/dev/null || true)"
  observed_holder="$(jq -r '.data.holder // "unknown"' <<<"${existing:-{}}")"
  observed_uid="$(jq -r '.metadata.uid // "unknown"' <<<"${existing:-{}}")"
  observed_state="$(jq -r '.data.state // "unknown"' <<<"${existing:-{}}")"
  cat >&2 <<EOF
HCC fault-injection lock could not be safely finalized (cause=${HCC_GATE_FINALIZATION_FAILURE:-unknown}).
Context: ${E2E_KUBECONTEXT}
Lock: ${HCC_NS}/${HCC_GATE_LOCK_NAME}
Expected owner: holder=${RUN_ID}, uid=${HCC_GATE_LOCK_UID:-unknown}
Observed: state=${observed_state}, holder=${observed_holder}, uid=${observed_uid}
Inspect with:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get configmap ${HCC_GATE_LOCK_NAME} -o yaml
Do not remove or replace the lock until HCC health, fixture cleanup, and absence of another gate are verified.
EOF
}

finalize_hcc_watch_gate_lock() {
  local cleanup_failed=$1 restore_ok=$2
  HCC_GATE_FINALIZATION_FAILURE=""
  if [ "$cleanup_failed" != 0 ]; then
    HCC_GATE_FINALIZATION_FAILURE=fixture_cleanup_failed
  elif [ "$restore_ok" != 1 ]; then
    HCC_GATE_FINALIZATION_FAILURE=hcc_restore_failed
  elif release_hcc_watch_gate_lock; then
    return 0
  else
    HCC_GATE_FINALIZATION_FAILURE=lock_finalization_failed
  fi
  [ "$HCC_GATE_LOCK_ACQUIRED" = 0 ] || print_hcc_watch_gate_lock_instructions
  return 1
}
