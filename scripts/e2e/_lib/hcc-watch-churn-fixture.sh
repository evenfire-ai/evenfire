#!/usr/bin/env bash
# Helpers for the HCC watch-churn readiness gate: a self-flapping Kubernetes API
# TCP proxy that periodically resets long-lived (watch) connections, a synthetic
# clerum-dev-scale CR fleet, and a non-destructive HCC redirect/restore.
#
# The proxy runs the HCC image (already loaded in the node), needs no privileges,
# and — unlike scale_proxy in the recovery gate — cuts connections on its own
# clock, so it reproduces GKE's sustained `Premature close` regime rather than a
# single manual outage. NetworkPolicy forces HCC's ONLY apiserver egress through
# it, so the cuts hit exactly the HCC watches and nothing else.
#
# Variables (PROXY_NAME, HCC_NS, HCC_DEPLOY, HCC_IMAGE, MCP_NS, HOST_NS,
# FLEET_PREFIX, FLEET_SECRET, RUN_ID, PROXY_EGRESS_NP, HCC_PROXY_NP, and the
# *_CREATED flags) are owned by the sourcing gate; this file only defines helpers.

# shellcheck disable=SC2034
CHURN_PROXY_PORT=8443

create_hcc_churn_proxy() {
  # $1 = churn period ms (cut cadence), $2 = min connection age ms before a cut.
  local churn_period_ms=$1 churn_min_age_ms=$2
  PROXY_CREATED=1
  kctl apply -f - >/dev/null <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${PROXY_NAME}
  namespace: ${HCC_NS}
  labels: {e2e.clerum.io/suite: hcc-watch-churn}
spec:
  replicas: 1
  selector: {matchLabels: {app: ${PROXY_NAME}}}
  template:
    metadata: {labels: {app: ${PROXY_NAME}, e2e.clerum.io/suite: hcc-watch-churn}}
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 1
      containers:
      - name: proxy
        image: ${HCC_IMAGE}
        imagePullPolicy: IfNotPresent
        env:
        - {name: CHURN_PERIOD_MS, value: "${churn_period_ms}"}
        - {name: CHURN_MIN_AGE_MS, value: "${churn_min_age_ms}"}
        command: [node, -e]
        args:
        # A relay to kubernetes.default.svc:443 that tracks every live upstream
        # socket with its birth timestamp, and every CHURN_PERIOD_MS destroys the
        # ones older than CHURN_MIN_AGE_MS. Short requests (LIST/GET/POST, ms)
        # complete untouched; long-lived watches (>min age) are reset — exactly
        # GKE's balancer idle-timeout behaviour. The listener never dies, so HCC
        # reconnects, re-LISTs, and bumps its watch generation on every cut.
        - >-
          const net=require('net');
          const period=Number(process.env.CHURN_PERIOD_MS);
          const minAge=Number(process.env.CHURN_MIN_AGE_MS);
          const live=new Set();
          net.createServer(c=>{
            const born=Date.now();
            const u=net.connect(443,'kubernetes.default.svc');
            const rec={c,u,born};live.add(rec);
            const close=()=>{live.delete(rec);c.destroy();u.destroy()};
            c.on('error',close);u.on('error',close);c.on('close',close);u.on('close',close);
            c.pipe(u);u.pipe(c);
          }).listen(${CHURN_PROXY_PORT},'0.0.0.0');
          setInterval(()=>{const now=Date.now();
            for(const r of [...live]){ if(now-r.born>=minAge){ r.c.destroy();r.u.destroy();live.delete(r);} }
          },period);
        readinessProbe: {tcpSocket: {port: ${CHURN_PROXY_PORT}}, periodSeconds: 1}
        resources:
          requests: {cpu: 10m, memory: 24Mi}
          limits: {cpu: 100m, memory: 64Mi}
        securityContext:
          allowPrivilegeEscalation: false
          capabilities: {drop: [ALL]}
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
          runAsGroup: 1000
          seccompProfile: {type: RuntimeDefault}
---
apiVersion: v1
kind: Service
metadata:
  name: ${PROXY_NAME}
  namespace: ${HCC_NS}
  labels: {e2e.clerum.io/suite: hcc-watch-churn}
spec:
  selector: {app: ${PROXY_NAME}}
  ports: [{name: tls, port: 443, targetPort: ${CHURN_PROXY_PORT}, protocol: TCP}]
EOF

  # Clone the control-plane API egress policy for the proxy, and restrict proxy
  # ingress to the HCC pod only (identical isolation to the recovery gate).
  kctl get networkpolicy allow-k8s-api-egress-control-plane -n "$HCC_NS" -o json |
    jq --arg name "$PROXY_EGRESS_NP" --arg app "$PROXY_NAME" '
      del(.metadata.creationTimestamp, .metadata.generation, .metadata.resourceVersion,
          .metadata.uid, .metadata.managedFields) |
      .metadata.name = $name |
      .metadata.labels = {"e2e.clerum.io/suite": "hcc-watch-churn"} |
      .spec.podSelector = {matchLabels: {app: $app}} |
      .spec.policyTypes = ["Ingress", "Egress"] |
      .spec.ingress = [{from: [{podSelector: {matchLabels: {app: "host-context-controller"}}}],
                        ports: [{port: '"${CHURN_PROXY_PORT}"', protocol: "TCP"}]}]' |
    kctl apply -f - >/dev/null

  kctl apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${HCC_PROXY_NP}
  namespace: ${HCC_NS}
  labels: {e2e.clerum.io/suite: hcc-watch-churn}
spec:
  podSelector: {matchLabels: {app: host-context-controller}}
  policyTypes: [Egress]
  egress:
  - to: [{podSelector: {matchLabels: {app: ${PROXY_NAME}}}}]
    ports:
    - {port: 443, protocol: TCP}
    - {port: ${CHURN_PROXY_PORT}, protocol: TCP}
EOF
  kctl rollout status deployment "$PROXY_NAME" -n "$HCC_NS" --timeout=90s >/dev/null ||
    die "churn proxy did not become ready"
}

# create_synthetic_fleet CONTEXTS MCPSERVERS HOSTS  — HCC must be scaled to 0 first.
create_synthetic_fleet() {
  local n_ctx=$1 n_mcp=$2 n_host=$3 i ctx applied
  FLEET_CREATED=1

  # LLM secret shared by all synthetic Hosts (label-scoped for cleanup).
  kctl create secret generic "$FLEET_SECRET" -n "$HOST_NS" \
    --from-literal=api-key=e2e-churn --dry-run=client -o yaml |
    kctl label --local -f - e2e.clerum.io/suite=hcc-watch-churn -o yaml |
    kctl apply -f - >/dev/null

  # Contexts (one stream).
  { for ((i = 1; i <= n_ctx; i++)); do
    ctx="$(printf '%s-ctx-%03d' "$FLEET_PREFIX" "$i")"
    cat <<EOF
---
apiVersion: clerum.io/v1alpha1
kind: Context
metadata: {name: ${ctx}, namespace: ${MCP_NS}, labels: {e2e.clerum.io/suite: hcc-watch-churn, e2e.clerum.io/run: "${RUN_ID}"}}
spec: {contextId: ${ctx}, description: "churn fleet context", mcpServers: []}
EOF
  done; } | kctl apply -f - >/dev/null

  # McpServers (one stream) — inventory + NetworkPolicies, no heavy pods.
  { for ((i = 1; i <= n_mcp; i++)); do
    ctx="$(printf '%s-ctx-%03d' "$FLEET_PREFIX" $(((i % n_ctx) + 1)))"
    cat <<EOF
---
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata: {name: $(printf '%s-mcp-%03d' "$FLEET_PREFIX" "$i"), namespace: ${MCP_NS}, labels: {e2e.clerum.io/suite: hcc-watch-churn, e2e.clerum.io/run: "${RUN_ID}"}}
spec:
  contextRef: ${ctx}
  description: "churn fleet mcp server"
  image: ${HCC_IMAGE}
  imagePullPolicy: Never
  transport: {type: streamableHttp, url: "http://127.0.0.1:3000/mcp", port: 3000}
EOF
  done; } | kctl apply -f - >/dev/null

  # Hosts (one stream) — these materialize Deployments; keep the count modest.
  { for ((i = 1; i <= n_host; i++)); do
    cat <<EOF
---
apiVersion: clerum.io/v1alpha1
kind: Host
metadata: {name: $(printf '%s-host-%02d' "$FLEET_PREFIX" "$i"), namespace: ${HOST_NS}, labels: {e2e.clerum.io/suite: hcc-watch-churn, e2e.clerum.io/run: "${RUN_ID}"}}
spec:
  host: $(printf '%s-host-%02d' "$FLEET_PREFIX" "$i")
  contextRef: $(printf '%s-ctx-%03d' "$FLEET_PREFIX" 1)
  secretRef: ${FLEET_SECRET}
  model: {provider: openai, name: e2e-churn}
EOF
  done; } | kctl apply -f - >/dev/null

  # Fail-loud count check: refuse to proceed on a partial fleet.
  applied="$(kctl get mcpserver -n "$MCP_NS" -l e2e.clerum.io/run="$RUN_ID" -o name | wc -l | tr -d ' ')"
  [ "$applied" = "$n_mcp" ] || die "synthetic fleet incomplete: applied ${applied}/${n_mcp} McpServers"
}

delete_synthetic_fleet() {
  local failed=0 kind
  for kind in mcpserver context host; do
    kctl delete "$kind" -A -l e2e.clerum.io/suite=hcc-watch-churn \
      --ignore-not-found --wait=true --timeout=180s >/dev/null 2>&1 || failed=1
  done
  kctl delete secret "$FLEET_SECRET" -n "$HOST_NS" --ignore-not-found >/dev/null 2>&1 || failed=1
  # HCC-managed runtime left behind by the fleet Hosts.
  kctl delete deployment,service,serviceaccount,role,rolebinding,secret,pvc,networkpolicy \
    -A -l "clerum.io/managed-by=host-context-controller" --ignore-not-found >/dev/null 2>&1 || true
  return "$failed"
}

# Non-destructive restore: undo the env overrides and hostAliases redirect.
restore_hcc_after_churn() {
  kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
    KUBERNETES_SERVICE_HOST- KUBERNETES_SERVICE_PORT- CONTEXT_MAPPER_K8S_API_CIDRS- >/dev/null || return 1
  kctl patch deployment/"$HCC_DEPLOY" -n "$HCC_NS" --type=merge \
    -p '{"spec":{"template":{"spec":{"hostAliases":null}}}}' >/dev/null || return 1
  [ -z "$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.hostAliases}')" ] || return 1
}
