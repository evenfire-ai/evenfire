#!/usr/bin/env bash
# Packet-level proof that this cluster enforces NetworkPolicy egress deny.
#
# Creates a throwaway namespace with one Deployment-owned pod and one bare pod
# (WorkflowRecipe coordinator / snippet-runner pods are bare pods, which the
# Amazon VPC CNI documents as less reliably enforced). Both must resolve DNS
# before a deny-all egress policy, and both must FAIL after it. Deletes the
# namespace on exit. Exit 0 = enforced; 1 = not enforced; 2 = inconclusive.
#
# Required env: CONTEXT. Optional: PROBE_NS (default evenfire-np-probe).
set -uo pipefail

: "${CONTEXT:?set CONTEXT}"
NS="${PROBE_NS:-evenfire-np-probe}"
IMAGE="busybox:1.36"
k() { kubectl --context "$CONTEXT" "$@"; }
say() { printf 'np-deny-probe: %s\n' "$*" >&2; }

if k get namespace "$NS" >/dev/null 2>&1; then
  say "namespace $NS already exists; refusing to reuse it"
  exit 2
fi
cleanup() { k delete namespace "$NS" --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

k create namespace "$NS" >/dev/null || { say "cannot create namespace"; exit 2; }

pod_spec() {
  cat <<EOF
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: probe
          image: ${IMAGE}
          command: ["sleep", "3600"]
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
EOF
}

{
  cat <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: owned
  namespace: ${NS}
spec:
  replicas: 1
  selector:
    matchLabels: {app: np-probe, shape: owned}
  template:
    metadata:
      labels: {app: np-probe, shape: owned}
    spec:
EOF
  pod_spec
  cat <<EOF
---
apiVersion: v1
kind: Pod
metadata:
  name: bare
  namespace: ${NS}
  labels: {app: np-probe, shape: bare}
spec:
EOF
  pod_spec | sed 's/^    //'
} | k apply -f - >/dev/null || { say "cannot create probe workloads"; exit 2; }

k -n "$NS" rollout status deployment/owned --timeout=180s >/dev/null || { say "owned probe pod not ready"; exit 2; }
k -n "$NS" wait --for=condition=Ready pod/bare --timeout=180s >/dev/null || { say "bare probe pod not ready"; exit 2; }
owned_pod="$(k -n "$NS" get pods -l shape=owned -o jsonpath='{.items[0].metadata.name}')"

lookup() {
  k -n "$NS" exec "$1" -- timeout 8 nslookup kubernetes.default.svc.cluster.local >/dev/null 2>&1
}

for p in "$owned_pod" bare; do
  # VPC CNI strict mode starts pods default-deny until reconciliation; retry.
  ok=false
  for _ in 1 2 3 4 5 6; do
    if lookup "$p"; then ok=true; break; fi
    sleep 5
  done
  if [ "$ok" != true ]; then
    say "$p cannot resolve DNS before any policy exists; probe is inconclusive"
    exit 2
  fi
done
say "baseline OK: both pods resolve DNS without a policy"

k -n "$NS" apply -f - >/dev/null <<EOF || { say "cannot create deny policy"; exit 2; }
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-egress
  namespace: ${NS}
spec:
  podSelector: {}
  policyTypes: ["Egress"]
EOF

result=0
for p in "$owned_pod" bare; do
  denied=false
  for _ in 1 2 3 4 5 6; do
    if ! lookup "$p"; then denied=true; break; fi
    sleep 10
  done
  if [ "$denied" = true ]; then
    say "PASS  $p: egress denied after policy"
  else
    say "FAIL  $p: egress still allowed 60s after a deny-all policy"
    result=1
  fi
done

if [ "$result" -eq 0 ]; then
  say "NetworkPolicy egress deny is enforced for owned and bare pods"
else
  say "NetworkPolicy is NOT enforced; do not install Evenfire on this cluster"
fi
exit "$result"
