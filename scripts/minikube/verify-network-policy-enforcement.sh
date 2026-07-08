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
