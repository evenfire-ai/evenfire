#!/usr/bin/env bash
# Restart decision for Deployments that read deploy-managed tokens as env vars
# (sourced by apply-inter-service-tokens.sh and
# apply-workflow-approval-bot-secret.sh; lib/restart-jwt-key-consumers.sh
# sources it for TOKEN_STAMP_ANNOTATION and TOKEN_STAMP_PENDING_VALUE).
#
# Pods read these tokens only at startup, so a Deployment must restart after a
# value it reads changes. Kubernetes does not record which token values a pod
# loaded (image digests and deployment.kubernetes.io/revision change only with
# the image or spec), so each consumer Deployment carries a stamp: a metadata
# annotation holding the sha256 of the values its pods run. A sha256 stamp is
# written after a successful `rollout restart`, or, without a restart, on a
# consumer that has no stamp and whose values did not change in this run.
# "Changed in this run" means the Secret held another value (or none) before
# this run wrote it.
#
#   a value it reads changed in this run         -> marked restart-pending before
#                                                   any Secret write, then restart
#                                                   and stamp
#   no stamp, and only the other end of one of   -> marked restart-pending before
#   its service tokens changed in this run          any Secret write, then restart
#                                                   and stamp
#   stamp equal to the values this run writes    -> no restart
#   (also when only the other end of one of its
#   service tokens changed)
#   stamp different, or restart-pending          -> restart, then stamp
#   no stamp, nothing it reads changed           -> stamp only; its pods already
#                                                   run these values (a Deployment
#                                                   created since read the current
#                                                   Secret at creation)
#   FORCE_CONSUMER_RESTART=true                  -> restart, then stamp
#
# The pre-write mark makes the obligation durable whatever the consumer's stamp:
# a failed restart, a run that dies half-way, or an out-of-band edit that this
# run reverts (a pod started since may run the edited value; the stamp records
# what this script restarted, not what a pod loaded) leaves a stamp that differs
# from the written values, so the next run restarts the consumer without any
# manual step. If the run stops after some marks and before writing any Secret
# (a later mark, read or list fails), the marked consumers restart once on the
# next run although no value changed: an extra restart, never a missed one.
#
# A failed read, restart or stamp write is retried, then recorded as pending and
# the walk continues; the calling script exits non-zero so the failure is
# visible in the job. A Secret read that still fails stops the calling script
# before it marks or writes anything (read_secret_key). A stamp write never
# rolls pods (it is metadata, not the pod template). Not covered: a Deployment created between the caller's
# pre-write read and the Secret patch whose restart then also fails (it may
# start on the old value and has no mark); closing it needs the creator to
# stamp what it creates.
#
# Callers define `kctl` (kubectl with the explicit context) and `log`, and
# initialise TOKEN_RESTART_PENDING=() before the first call.

TOKEN_STAMP_ATTEMPTS="${TOKEN_STAMP_ATTEMPTS:-3}"
TOKEN_STAMP_RETRY_SECONDS="${TOKEN_STAMP_RETRY_SECONDS:-2}"
# Stamp value that records a restart obligation. It never equals a sha256, so
# the consumer restarts on the run that writes it or, if that fails or the run
# dies, on the next one.
TOKEN_STAMP_PENDING_VALUE="restart-pending"
# Annotation of apply-inter-service-tokens.sh's stamp on each of its consumers.
# lib/restart-jwt-key-consumers.sh writes TOKEN_STAMP_PENDING_VALUE under it to
# hand a key-consumer restart that stayed pending to that script.
# shellcheck disable=SC2034 # read by apply-inter-service-tokens.sh and restart-jwt-key-consumers.sh
TOKEN_STAMP_ANNOTATION="clerum.io/inter-service-tokens-sha256"

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

# read_secret_key <namespace> <secret> <key>
# Prints the value of a plain string key of a Secret. Prints nothing when the
# Secret or the key does not exist (NotFound), or when the value is a legacy
# `replace-with-*` placeholder: callers treat those as absent and generate a
# value. Any other read error is retried (token_stamp_retry); if it persists,
# it is logged and the function returns 1, and the caller stops before writing
# any Secret: an unreadable value is neither absent (a new one would rotate the
# token) nor changed (it would restart its consumers).
read_secret_key() {
  local ns="$1" secret="$2" key="$3" encoded decoded
  if ! encoded="$(token_stamp_retry kctl -n "$ns" get secret "$secret" --ignore-not-found \
       -o "jsonpath={.data.$key}")"; then
    log "ERROR: cannot read Secret $ns/$secret; no Secret was written"
    return 1
  fi
  [ -n "$encoded" ] || return 0
  if ! decoded="$(printf '%s' "$encoded" | base64 --decode)"; then
    log "ERROR: Secret $ns/$secret holds a value that is not base64; no Secret was written"
    return 1
  fi
  case "$decoded" in
    replace-with-*) return 0 ;;
  esac
  printf '%s' "$decoded"
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

# token_stamp_mark_pending <annotation> <namespace> <deployment> <changed-in-run>
# Call before any Secret write. <changed-in-run> is "true" when a value the
# consumer reads changes in this run (the Secret before the run differs from
# what it writes), "peer" when only the other end of one of its service tokens
# changes (see apply-inter-service-tokens.sh), else "false".
# For "true" and an existing Deployment, writes the restart-pending stamp
# whatever stamp it had: its pods may run a value other than the one written (a
# reverted out-of-band edit loaded by a pod started since, or a half-applied
# earlier run), and a stamp records what this script restarted, not what a pod
# loaded. For "peer", writes it only on a Deployment without a stamp: the
# consumer does not read the other end, so its stamp decides; without a stamp,
# a changed other end is the only sign that its own Secret changed without a
# restart. A missing Deployment reads the new value when it is created. Returns
# 1 when the obligation cannot be recorded; the caller then exits before
# writing.
token_stamp_mark_pending() {
  local annotation="$1" ns="$2" dep="$3" changed="$4" current why
  case "$changed" in
    true) why="a value it reads changes" ;;
    peer) why="the other end of one of its service tokens changes and it has no stamp" ;;
    false) return 0 ;;
    *) log "ERROR: invalid changed-in-run value for $ns/$dep; no Secret was written"; return 1 ;;
  esac
  if ! current="$(token_stamp_read "$annotation" "$ns" "$dep")"; then
    log "ERROR: cannot read deployment $ns/$dep before writing Secrets; no Secret was written"
    return 1
  fi
  case "$current" in
    absent|"$TOKEN_STAMP_PENDING_VALUE") return 0 ;;
  esac
  if [ "$changed" = "peer" ] && [ "$current" != "none" ]; then
    return 0
  fi
  if ! token_stamp_retry kctl -n "$ns" annotate deploy "$dep" --overwrite \
       "$annotation=$TOKEN_STAMP_PENDING_VALUE" >/dev/null; then
    log "ERROR: cannot record the pending restart of $ns/$dep; no Secret was written"
    return 1
  fi
  log "Recorded pending restart on $ns/$dep before writing Secrets ($why)"
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
        log "ERROR: cannot write the token stamp on $ns/$dep; the next run records it"
        TOKEN_RESTART_PENDING+=("$ns/$dep")
      fi
      return 0
    fi
    reason="no stamp and tokens changed"
  elif [ "$current" = "$TOKEN_STAMP_PENDING_VALUE" ]; then
    reason="restart pending (recorded before a Secret write)"
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
  local context="$1" item target
  [ "${#TOKEN_RESTART_PENDING[@]}" -eq 0 ] && return 0
  log "ERROR: Secrets are written but these restarts are pending: ${TOKEN_RESTART_PENDING[*]}"
  log "They keep a stamp that differs from the written values (their old stamp or restart-pending), so the next run of this script restarts them automatically."
  log "To recover now, restart each one:"
  for item in "${TOKEN_RESTART_PENDING[@]}"; do
    target="${item#*/}"
    # A Deployment name cannot contain "=", so such an entry is a label selector.
    if [[ "$target" == *=* ]]; then
      log "  kubectl${context:+ --context $context} -n ${item%%/*} rollout restart deploy -l $target"
    else
      log "  kubectl${context:+ --context $context} -n ${item%%/*} rollout restart deploy $target"
    fi
  done
  log "or re-run this script with FORCE_CONSUMER_RESTART=true (restarts every consumer)."
  return 1
}
