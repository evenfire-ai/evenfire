#!/usr/bin/env bash
# Restart decision for Deployments that read deploy-managed tokens as env vars
# (sourced by apply-inter-service-tokens.sh and
# apply-workflow-approval-bot-secret.sh).
#
# Pods read these tokens only at startup, so a Deployment must restart after a
# value it reads changes. Kubernetes does not record which token values a pod
# loaded (image digests and deployment.kubernetes.io/revision change only with
# the image or spec), so each consumer Deployment carries a stamp: a metadata
# annotation holding the sha256 of the values its pods were last restarted
# onto. The stamp is written only after a successful `rollout restart`.
#
#   stamp present and equal to the values this run writes  -> no restart
#   stamp present and different                             -> restart, then stamp
#   stamp missing (first run, or the Deployment was recreated):
#     a value it reads changed in this run                  -> restart, then stamp
#     nothing it reads changed in this run                  -> stamp only; the pods
#       already run these values (every earlier deploy restarted every consumer,
#       and a Deployment created since reads the current Secret at creation)
#   FORCE_CONSUMER_RESTART=true                             -> restart, then stamp
#
# A failed read, restart or stamp write is retried, then recorded as pending
# and the walk continues. A pending consumer keeps its old stamp, so the next
# run restarts it without any manual step; the calling script exits non-zero so
# the failure is visible in the job. A stamp write never rolls pods (it is
# metadata, not the pod template).
#
# Callers define `kctl` (kubectl with the explicit context) and `log`, and
# initialise TOKEN_RESTART_PENDING=() before the first call.

TOKEN_STAMP_ATTEMPTS="${TOKEN_STAMP_ATTEMPTS:-3}"
TOKEN_STAMP_RETRY_SECONDS="${TOKEN_STAMP_RETRY_SECONDS:-2}"

# Prints the sha256 (hex) of the given "KEY=value" lines. Values reach openssl
# through a pipe from the printf builtin, never through argv.
token_stamp_of() {
  local digest
  digest="$(printf '%s\n' "$@" | openssl dgst -sha256 | awk '{print $NF}')" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

# Runs a command up to TOKEN_STAMP_ATTEMPTS times; prints the last attempt's
# stdout. Used for kubectl reads and writes, whose transient API errors would
# otherwise fail the deploy.
token_stamp_retry() {
  local attempt out
  for ((attempt = 1; attempt <= TOKEN_STAMP_ATTEMPTS; attempt++)); do
    if out="$("$@")"; then
      printf '%s' "$out"
      return 0
    fi
    if [ "$attempt" -lt "$TOKEN_STAMP_ATTEMPTS" ]; then
      sleep "$TOKEN_STAMP_RETRY_SECONDS"
    fi
  done
  return 1
}

# Reads the stamp of an existing Deployment. Prints "absent" when the
# Deployment does not exist, "none" when it has no stamp, else the stamp.
# Returns 1 when the Deployment cannot be read.
token_stamp_read() {
  local annotation="$1" ns="$2" dep="$3" out escaped
  escaped="${annotation//./\\.}"
  out="$(token_stamp_retry kctl -n "$ns" get deploy "$dep" --ignore-not-found \
    -o "jsonpath={.metadata.name}{\"|\"}{.metadata.annotations.${escaped}}")" || return 1
  if [ -z "$out" ]; then
    printf 'absent'
  elif [ "${out#*|}" = "" ]; then
    printf 'none'
  else
    printf '%s' "${out#*|}"
  fi
}

# reconcile_token_consumer <annotation> <namespace> <deployment> <changed-in-run> <desired-stamp>
reconcile_token_consumer() {
  local annotation="$1" ns="$2" dep="$3" changed="$4" desired="$5" current reason
  if ! current="$(token_stamp_read "$annotation" "$ns" "$dep")"; then
    log "ERROR: cannot read deployment $ns/$dep; its restart is pending"
    TOKEN_RESTART_PENDING+=("$ns/$dep")
    return 0
  fi
  if [ "$current" = "absent" ]; then
    log "Skipping rollout of $ns/$dep: not deployed yet"
    return 0
  fi
  if [ "${FORCE_CONSUMER_RESTART:-}" = "true" ]; then
    reason="FORCE_CONSUMER_RESTART=true"
  elif [ "$current" = "none" ]; then
    if [ "$changed" != "true" ]; then
      if token_stamp_retry kctl -n "$ns" annotate deploy "$dep" --overwrite "$annotation=$desired" >/dev/null; then
        log "Recording token stamp on $ns/$dep: tokens unchanged, no restart"
      else
        log "ERROR: cannot write the token stamp on $ns/$dep; it will restart on the next run"
        TOKEN_RESTART_PENDING+=("$ns/$dep")
      fi
      return 0
    fi
    reason="no stamp and tokens changed"
  elif [ "$current" != "$desired" ]; then
    reason="tokens differ from the stamp"
  else
    log "Skipping rollout of $ns/$dep: tokens unchanged"
    return 0
  fi
  log "Rolling deployment $ns/$dep to pick up fresh Secret values ($reason)"
  if ! token_stamp_retry kctl -n "$ns" rollout restart deploy "$dep" >/dev/null; then
    log "ERROR: rollout restart of $ns/$dep failed; its restart is pending"
    TOKEN_RESTART_PENDING+=("$ns/$dep")
    return 0
  fi
  if ! token_stamp_retry kctl -n "$ns" annotate deploy "$dep" --overwrite "$annotation=$desired" >/dev/null; then
    log "ERROR: $ns/$dep restarted but its token stamp was not written; it will restart again on the next run"
    TOKEN_RESTART_PENDING+=("$ns/$dep")
  fi
  return 0
}

# Fails the calling script when any restart is pending, naming each Deployment
# and both ways to recover now. Without any action the next run retries them.
token_stamp_fail_if_pending() {
  local context="$1" item
  [ "${#TOKEN_RESTART_PENDING[@]}" -eq 0 ] && return 0
  log "ERROR: Secrets are written but these restarts are pending: ${TOKEN_RESTART_PENDING[*]}"
  log "They keep their old token stamp, so the next run of this script restarts them automatically."
  log "To recover now, restart each one:"
  for item in "${TOKEN_RESTART_PENDING[@]}"; do
    log "  kubectl --context ${context:-<current>} -n ${item%%/*} rollout restart deploy ${item#*/}"
  done
  log "or re-run this script with FORCE_CONSUMER_RESTART=true (restarts every consumer)."
  return 1
}
