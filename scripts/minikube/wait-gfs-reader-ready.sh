#!/usr/bin/env bash
# Development harness only. HCC's gfsReconciler owns the gfsc-reader
# Deployment template and strips the restartedAt annotation that
# `kubectl rollout restart` adds, so a generation-based
# `kubectl rollout status deployment/gfsc-reader` chases flapping revisions
# ("Waiting for deployment spec update to be observed") until it times out.
# Judge readiness directly instead: the desired replica count is Ready and no
# live, non-terminating reader pod is unready. A CrashLoopBackOff pod whose
# credential was just restored converges through kubelet retries; this wait
# observes that recovery instead of the template generation HCC keeps moving.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
GFS_NS="${GFS_NS:-gfs}"
DEPLOY="${GFS_READER_DEPLOYMENT:-gfsc-reader}"
SELECTOR="${GFS_READER_SELECTOR:-app=gfs-controller,clerum.io/gfsc-role=reader}"
TIMEOUT_SECONDS="${GFS_READER_WAIT_TIMEOUT_SECONDS:-600}"
POLL_SECONDS="${GFS_READER_WAIT_POLL_SECONDS:-5}"

kc() { kubectl --context="$CONTEXT" "$@"; }
log() { printf '[wait-gfs-reader-ready] %s\n' "$*" >&2; }

if ! TIMEOUT_SECONDS="$(python3 - "$TIMEOUT_SECONDS" <<'PY'
import re
import sys

raw = sys.argv[1]
if not re.fullmatch(r"[1-9][0-9]{0,4}", raw):
    raise SystemExit("timeout must be a positive integer")
value = int(raw)
if value > 86400:
    raise SystemExit("timeout exceeds the one-day limit")
print(value)
PY
)"; then
  log 'refusing an invalid readiness timeout'
  exit 2
fi

deadline=$((SECONDS + TIMEOUT_SECONDS))
while :; do
  if ! desired="$(kc -n "$GFS_NS" get deployment "$DEPLOY" \
    -o jsonpath='{.spec.replicas}' 2>&1)"; then
    log "unable to read desired replicas for ${GFS_NS}/${DEPLOY}: ${desired}"
    exit 1
  fi
  if [ -z "$desired" ] || ! [[ "$desired" =~ ^[0-9]+$ ]]; then
    log "desired replicas for ${GFS_NS}/${DEPLOY} is not numeric"
    exit 1
  fi
  if ! ready="$(kc -n "$GFS_NS" get deployment "$DEPLOY" \
    -o jsonpath='{.status.readyReplicas}' 2>&1)"; then
    log "unable to read Ready replicas for ${GFS_NS}/${DEPLOY}: ${ready}"
    exit 1
  fi
  ready="${ready:-0}"
  if ! [[ "$ready" =~ ^[0-9]+$ ]]; then
    log "Ready replicas for ${GFS_NS}/${DEPLOY} is not numeric"
    exit 1
  fi
  if [ "$desired" -gt 0 ] && [ "$ready" -ge "$desired" ]; then
    pod_rows=""
    unready=""
    if ! pod_rows="$(kc -n "$GFS_NS" get pods -l "$SELECTOR" -o \
      'jsonpath={range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}' \
      2>&1)"; then
      log "unable to inspect reader pods for ${GFS_NS}/${DEPLOY}: ${pod_rows}"
      exit 1
    fi
    unready="$(awk -F'|' 'NF && $2 == "" && $1 != "True" { n++ } END { print n+0 }' <<<"$pod_rows")"
    if [ "${unready:-0}" -eq 0 ]; then
      log "${GFS_NS}/${DEPLOY} is Ready (${ready}/${desired}) with no live unready reader pod"
      exit 0
    fi
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    log "timed out after ${TIMEOUT_SECONDS}s waiting for ${GFS_NS}/${DEPLOY} readiness (ready=${ready:-0}/${desired:-unknown})"
    exit 1
  fi
  sleep "$POLL_SECONDS"
done
