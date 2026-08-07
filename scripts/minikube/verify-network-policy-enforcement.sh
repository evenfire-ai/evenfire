#!/usr/bin/env bash
# Prove Kubernetes NetworkPolicy enforcement before Layer 3B custom-image gates.
#
# This intentionally tests enforcement behavior, not only manifest presence:
# 1. a selected client can reach a selected server through explicit policies;
# 2. a denied client cannot reach the same server.
#
# Defaults are pinned to the local minikube profile used by this repo. By
# default this probes the Clerum runtime namespaces that must be packet-proven
# before activation. Set NS=<namespace> to preserve the old single-namespace
# mode, or NAMESPACES="a b c" to choose an explicit namespace set.

set -euo pipefail

CONTEXT="${CONTEXT:-${KUBECONTEXT:-clerum-test}}"
PROBE_IMAGE="${PROBE_IMAGE:-clerum/workflow-custom-sdk-e2e:test}"
# The kubectl context and the minikube profile are the same name throughout this
# repo (Makefile passes CONTEXT=$(MINIKUBE_PROFILE)); the split lets a caller
# fix it up if they ever diverge.
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-$CONTEXT}"

# The probe image is an E2E-ONLY FIXTURE: deploy/images.json marks it
# published:false + e2e_only:true, so the default `make minikube-setup`
# (IMAGE_SOURCE=ghcr, SEED_PROFILE=minimal) neither pulls nor builds it -- only
# `make minikube-setup-e2e` and `make minikube-build-custom-coordinator-fixture`
# do. Before pulling was the default, every setup built this ref, so this target
# worked on any cluster; it no longer does.
#
# Without this check all three probe pods sit in ErrImageNeverPull /
# ImagePullBackOff until the 90s Ready wait expires, and the run reports
# "waiting for server pod" plus a describe dump -- which reads as broken
# NetworkPolicy enforcement when the truth is that the image was never built.
#
# This target deliberately does NOT build it: a verification script that
# silently acquires images makes the thing it verifies depend on the act of
# verifying it. Say what is missing and which target supplies it, before
# anything is applied to the cluster.
require_probe_image() {
  local listing
  if ! command -v minikube >/dev/null 2>&1; then
    printf '[np-preflight] ERROR: minikube is not on PATH, so the probe image %s cannot be confirmed present in profile %s.\n' \
      "$PROBE_IMAGE" "$MINIKUBE_PROFILE" >&2
    exit 1
  fi
  # Not `|| true` and not 2>/dev/null: a daemon that cannot be listed is an
  # unknown, and an unknown here is a failure, never a pass.
  if ! listing="$(minikube -p "$MINIKUBE_PROFILE" image ls)"; then
    printf '[np-preflight] ERROR: could not list the images in minikube profile %s; cannot confirm %s is loaded.\n' \
      "$MINIKUBE_PROFILE" "$PROBE_IMAGE" >&2
    exit 1
  fi
  # minikube prints the docker.io-normalised spelling for a bare clerum/* ref;
  # accept both so a caller-supplied PROBE_IMAGE matches either way.
  if printf '%s\n' "$listing" | grep -Fxq "$PROBE_IMAGE" \
    || printf '%s\n' "$listing" | grep -Fxq "docker.io/${PROBE_IMAGE}"; then
    return 0
  fi
  printf '[np-preflight] ERROR: probe image %s is not loaded in minikube profile %s.\n' \
    "$PROBE_IMAGE" "$MINIKUBE_PROFILE" >&2
  printf '[np-preflight] It is an E2E-only fixture (published:false in deploy/images.json), so the default\n' >&2
  printf '[np-preflight] `make minikube-setup` never acquires it and every probe pod would fail to start.\n' >&2
  printf '[np-preflight] Build it first:  make minikube-build-custom-coordinator-fixture\n' >&2
  printf '[np-preflight] (`make minikube-setup-e2e` builds it too, and PROBE_IMAGE=<ref> selects an image this cluster already has.)\n' >&2
  exit 1
}
require_probe_image

if [ -z "${CLERUM_NP_SINGLE_NAMESPACE:-}" ]; then
  if [ -n "${NS:-}" ]; then
    NAMESPACES="${NAMESPACES:-$NS}"
  else
    NAMESPACES="${NAMESPACES:-mcp-server mcp-host rpc-proxy sandbox-recipes sandbox-ui}"
  fi

  for namespace in $NAMESPACES; do
    log_prefix="[np-preflight:${namespace}]"
    printf '%s starting namespace probe\n' "$log_prefix"
    CLERUM_NP_SINGLE_NAMESPACE=1 \
      NS="$namespace" \
      RUN_ID="${RUN_ID:-np-${namespace}-$(date +%s)-$$}" \
      CONTEXT="$CONTEXT" \
      PROBE_IMAGE="$PROBE_IMAGE" \
      "$0"
  done
  printf '[np-preflight] PASS: NetworkPolicy enforcement is active for namespaces: %s on %s\n' "$NAMESPACES" "$CONTEXT"
  exit 0
fi

NS="${NS:-sandbox-recipes}"
RUN_ID="${RUN_ID:-np-$(date +%s)-$$}"
RUN_ID="$(printf '%s' "$RUN_ID" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-32)"
SERVER_POD="${RUN_ID}-server"
ALLOWED_POD="${RUN_ID}-allowed"
DENIED_POD="${RUN_ID}-denied"
ALLOW_EGRESS_NP="${RUN_ID}-allow-egress"
ALLOW_INGRESS_NP="${RUN_ID}-allow-ingress"
DENY_EGRESS_NP="${RUN_ID}-deny-egress"

kc() {
  kubectl --context="$CONTEXT" "$@"
}

log() {
  printf '[np-preflight] %s\n' "$*"
}

cleanup() {
  kc -n "$NS" delete pod "$SERVER_POD" "$ALLOWED_POD" "$DENIED_POD" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kc -n "$NS" delete networkpolicy "$ALLOW_EGRESS_NP" "$ALLOW_INGRESS_NP" "$DENY_EGRESS_NP" \
    --ignore-not-found >/dev/null 2>&1 || true
}

dump_pod() {
  local pod=$1
  log "logs for ${pod}:"
  kc -n "$NS" logs "$pod" --all-containers=true 2>/dev/null || true
  log "describe ${pod}:"
  kc -n "$NS" describe pod "$pod" 2>/dev/null || true
}

trap cleanup EXIT

log "context=${CONTEXT} namespace=${NS} image=${PROBE_IMAGE}"
kc version --request-timeout=10s >/dev/null
kc get namespace "$NS" >/dev/null

if ! kc -n kube-system get pods -l k8s-app=calico-node --no-headers 2>/dev/null | grep -q 'Running'; then
  log "Calico daemonset pods were not detected as Running."
  log "For minikube, start with: minikube start -p ${CONTEXT} --cni=calico --driver=docker"
  exit 1
fi

cleanup

cat <<YAML | kc apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${SERVER_POD}
  namespace: ${NS}
  labels:
    clerum.io/np-preflight: ${RUN_ID}
    clerum.io/np-role: server
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: server
      image: ${PROBE_IMAGE}
      imagePullPolicy: IfNotPresent
      command:
        - node
        - -e
        - |
          const http = require('node:http')
          const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('np-preflight-ok')
          })
          server.listen(8080, '0.0.0.0')
      ports:
        - containerPort: 8080
          name: http
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
YAML

cat <<YAML | kc apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${ALLOW_INGRESS_NP}
  namespace: ${NS}
  labels:
    clerum.io/np-preflight: ${RUN_ID}
spec:
  podSelector:
    matchLabels:
      clerum.io/np-preflight: ${RUN_ID}
      clerum.io/np-role: server
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              clerum.io/np-preflight: ${RUN_ID}
              clerum.io/np-role: allowed
      ports:
        - protocol: TCP
          port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${ALLOW_EGRESS_NP}
  namespace: ${NS}
  labels:
    clerum.io/np-preflight: ${RUN_ID}
spec:
  podSelector:
    matchLabels:
      clerum.io/np-preflight: ${RUN_ID}
      clerum.io/np-role: allowed
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              clerum.io/np-preflight: ${RUN_ID}
              clerum.io/np-role: server
      ports:
        - protocol: TCP
          port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${DENY_EGRESS_NP}
  namespace: ${NS}
  labels:
    clerum.io/np-preflight: ${RUN_ID}
spec:
  podSelector:
    matchLabels:
      clerum.io/np-preflight: ${RUN_ID}
      clerum.io/np-role: denied
  policyTypes:
    - Egress
  egress: []
YAML

log "waiting for server pod"
if ! kc -n "$NS" wait --for=condition=Ready "pod/${SERVER_POD}" --timeout=90s >/dev/null; then
  dump_pod "$SERVER_POD"
  exit 1
fi
SERVER_IP="$(kc -n "$NS" get pod "$SERVER_POD" -o jsonpath='{.status.podIP}')"
if [ -z "$SERVER_IP" ]; then
  log "server pod has no Pod IP"
  dump_pod "$SERVER_POD"
  exit 1
fi
log "server pod IP=${SERVER_IP}"

cat <<YAML | kc apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${ALLOWED_POD}
  namespace: ${NS}
  labels:
    clerum.io/np-preflight: ${RUN_ID}
    clerum.io/np-role: allowed
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: client
      image: ${PROBE_IMAGE}
      imagePullPolicy: IfNotPresent
      command:
        - node
        - -e
        - |
          const net = require('node:net')
          const host = process.env.SERVER_IP
          const socket = net.createConnection({ host, port: 8080 })
          const fail = message => {
            console.error(message)
            socket.destroy()
            process.exit(1)
          }
          socket.setTimeout(5000)
          socket.once('connect', () => {
            console.log('allowed client reached server')
            socket.end()
            process.exit(0)
          })
          socket.once('timeout', () => fail('allowed client timed out'))
          socket.once('error', err => fail('allowed client error: ' + (err.code || err.message)))
      env:
        - name: SERVER_IP
          value: "${SERVER_IP}"
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
YAML

if ! kc -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/${ALLOWED_POD}" --timeout=90s >/dev/null; then
  dump_pod "$ALLOWED_POD"
  exit 1
fi
log "allowed path succeeded"

cat <<YAML | kc apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${DENIED_POD}
  namespace: ${NS}
  labels:
    clerum.io/np-preflight: ${RUN_ID}
    clerum.io/np-role: denied
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: client
      image: ${PROBE_IMAGE}
      imagePullPolicy: IfNotPresent
      command:
        - node
        - -e
        - |
          const net = require('node:net')
          const host = process.env.SERVER_IP
          const socket = net.createConnection({ host, port: 8080 })
          let settled = false
          const done = code => {
            if (settled) return
            settled = true
            socket.destroy()
            process.exit(code)
          }
          socket.setTimeout(5000)
          socket.once('connect', () => {
            console.error('denied client unexpectedly reached server')
            done(1)
          })
          socket.once('timeout', () => {
            console.log('denied client blocked by NetworkPolicy')
            done(0)
          })
          socket.once('error', err => {
            console.log('denied client blocked: ' + (err.code || err.message))
            done(0)
          })
      env:
        - name: SERVER_IP
          value: "${SERVER_IP}"
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
YAML

if ! kc -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/${DENIED_POD}" --timeout=90s >/dev/null; then
  dump_pod "$DENIED_POD"
  exit 1
fi
log "denied path blocked"
log "PASS: NetworkPolicy enforcement is active for ${NS} on ${CONTEXT}"
