#!/usr/bin/env bash

# Safety helpers shared by disruptive HCC fault-injection fixtures.

profile_env_value() {
  local key=$1 file=$2
  awk -v key="$key" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "$file"
}

require_branch_owned_hcc_gate() {
  local marker_namespace="${1:-control-plane}"
  local actual_worktree_id actual_head actual_cluster_fingerprint actual_gate
  local worktree_dirty expected_short_head expected_branch profile_env
  local pre_gate_state_root cluster_fingerprint_file expected_cluster_fingerprint

  is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" ||
    die "fault injection requires a generated branch-scoped context, got '${E2E_KUBECONTEXT}'"

  HCC_BRANCH_GATE_REPO_ROOT="$(git -C "${SCRIPT_DIR}/../.." rev-parse --show-toplevel)"
  worktree_dirty="$(
    git -C "$HCC_BRANCH_GATE_REPO_ROOT" status --porcelain --untracked-files=normal
  )"
  [ -z "$worktree_dirty" ] ||
    die "worktree has uncommitted changes; commit and re-sync before runtime proof"
  HCC_BRANCH_GATE_EXPECTED_WORKTREE_ID="$(
    printf '%s' "$HCC_BRANCH_GATE_REPO_ROOT" | shasum | awk '{print $1}'
  )"
  HCC_BRANCH_GATE_EXPECTED_HEAD="$(git -C "$HCC_BRANCH_GATE_REPO_ROOT" rev-parse HEAD)"
  expected_short_head="$(git -C "$HCC_BRANCH_GATE_REPO_ROOT" rev-parse --short=8 HEAD)"
  expected_branch="$(git -C "$HCC_BRANCH_GATE_REPO_ROOT" branch --show-current)"
  [ -n "$expected_branch" ] ||
    die "branch-owned runtime proof requires a named branch, not detached HEAD"
  [ "${MINIKUBE_PROFILE:-}" = "$E2E_KUBECONTEXT" ] ||
    die "MINIKUBE_PROFILE must explicitly select context ${E2E_KUBECONTEXT}, got ${MINIKUBE_PROFILE:-missing}"

  profile_env="${E2E_BRANCH_PROFILE_ENV:-${HOME}/.cache/clerum/minikube-profiles/${E2E_KUBECONTEXT}/profile.env}"
  [ -r "$profile_env" ] ||
    die "branch-profile helper evidence is missing at ${profile_env}; run a state-writing branch-profile helper action from this worktree"
  [ "$(profile_env_value PROFILE "$profile_env")" = "$E2E_KUBECONTEXT" ] ||
    die "branch-profile helper output does not select context ${E2E_KUBECONTEXT}"
  [ "$(profile_env_value REPO_DIR "$profile_env")" = "$HCC_BRANCH_GATE_REPO_ROOT" ] ||
    die "branch-profile helper output belongs to a different worktree"
  [ "$(profile_env_value BRANCH "$profile_env")" = "$expected_branch" ] ||
    die "branch-profile helper output belongs to a different branch"
  [ "$(profile_env_value SHA_SHORT "$profile_env")" = "$expected_short_head" ] ||
    die "branch-profile helper output belongs to a different HEAD"
  [ "$(profile_env_value DIRTY "$profile_env")" = false ] ||
    die "branch-profile helper recorded a dirty worktree; refresh it after committing"

  pre_gate_state_root="${E2E_PRE_GATE_STATE_ROOT:-${TMPDIR:-/tmp}/clerum-pre-gate-sync}"
  cluster_fingerprint_file="${pre_gate_state_root}/${HCC_BRANCH_GATE_EXPECTED_WORKTREE_ID}/cluster.sha"
  [ -r "$cluster_fingerprint_file" ] ||
    die "pre-gate fingerprint evidence is missing at ${cluster_fingerprint_file}"
  expected_cluster_fingerprint="$(sed -n '1p' "$cluster_fingerprint_file")"
  [[ "$expected_cluster_fingerprint" =~ ^[0-9a-f]{40}$ ]] ||
    die "pre-gate fingerprint evidence is malformed"
  [ -n "${E2E_EXPECTED_PRE_GATE_GATE:-}" ] ||
    die "E2E_EXPECTED_PRE_GATE_GATE must name the gate recorded by the branch-owned pre-gate sync"

  HCC_BRANCH_GATE_SYNC_MARKER="$(
    kctl get configmap clerum-pre-gate-sync-state -n "$marker_namespace" -o json 2>/dev/null
  )" || die "cluster has no readable pre-gate sync marker"
  actual_worktree_id="$(jq -r '.data.worktreeId // ""' <<<"$HCC_BRANCH_GATE_SYNC_MARKER")"
  actual_head="$(jq -r '.data.gitHead // ""' <<<"$HCC_BRANCH_GATE_SYNC_MARKER")"
  actual_cluster_fingerprint="$(
    jq -r '.data.clusterFingerprint // ""' <<<"$HCC_BRANCH_GATE_SYNC_MARKER"
  )"
  actual_gate="$(jq -r '.data.gate // ""' <<<"$HCC_BRANCH_GATE_SYNC_MARKER")"

  [ "$actual_worktree_id" = "$HCC_BRANCH_GATE_EXPECTED_WORKTREE_ID" ] ||
    die "cluster ownership marker does not match this worktree; run minikube-pre-gate-sync first"
  [ "$actual_head" = "$HCC_BRANCH_GATE_EXPECTED_HEAD" ] ||
    die "cluster HEAD marker ${actual_head:-missing} does not match ${HCC_BRANCH_GATE_EXPECTED_HEAD}"
  [ "$actual_cluster_fingerprint" = "$expected_cluster_fingerprint" ] ||
    die "cluster fingerprint marker does not match this worktree's last pre-gate sync"
  [ "$actual_gate" = "$E2E_EXPECTED_PRE_GATE_GATE" ] ||
    die "cluster gate marker ${actual_gate:-missing} does not match expected ${E2E_EXPECTED_PRE_GATE_GATE}"
}

create_hcc_api_proxy() {
  # shellcheck disable=SC2034 # Read by the parent gate's EXIT cleanup.
  PROXY_CREATED=1
  kctl apply -f - >/dev/null <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${PROXY_NAME}
  namespace: ${HCC_NS}
  labels: {e2e.clerum.io/suite: hcc-watch-recovery}
spec:
  replicas: 1
  selector: {matchLabels: {app: ${PROXY_NAME}}}
  template:
    metadata: {labels: {app: ${PROXY_NAME}, e2e.clerum.io/suite: hcc-watch-recovery}}
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 1
      containers:
      - name: proxy
        image: ${HCC_IMAGE}
        imagePullPolicy: IfNotPresent
        command: [node, -e]
        args:
        - >-
          const net=require('net');
          net.createServer(c=>{const u=net.connect(443,'kubernetes.default.svc');
          const close=()=>{c.destroy();u.destroy()};c.on('error',close);u.on('error',close);
          c.pipe(u);u.pipe(c)}).listen(8443,'0.0.0.0');
        readinessProbe: {tcpSocket: {port: 8443}, periodSeconds: 1}
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
  labels: {e2e.clerum.io/suite: hcc-watch-recovery}
spec:
  selector: {app: ${PROXY_NAME}}
  ports: [{name: tls, port: 443, targetPort: 8443, protocol: TCP}]
EOF

  kctl get networkpolicy allow-k8s-api-egress-control-plane -n "$HCC_NS" -o json |
    jq --arg name "$PROXY_EGRESS_NP" --arg app "$PROXY_NAME" '
      del(.metadata.creationTimestamp, .metadata.generation, .metadata.resourceVersion,
          .metadata.uid, .metadata.managedFields) |
      .metadata.name = $name |
      .metadata.labels = {"e2e.clerum.io/suite": "hcc-watch-recovery"} |
      .spec.podSelector = {matchLabels: {app: $app}} |
      .spec.policyTypes = ["Ingress", "Egress"] |
      .spec.ingress = [{from: [{podSelector: {matchLabels: {app: "host-context-controller"}}}],
                        ports: [{port: 8443, protocol: "TCP"}]}]' |
    kctl apply -f - >/dev/null

  kctl apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${HCC_PROXY_NP}
  namespace: ${HCC_NS}
  labels: {e2e.clerum.io/suite: hcc-watch-recovery}
spec:
  podSelector: {matchLabels: {app: host-context-controller}}
  policyTypes: [Egress]
  egress:
  - to: [{podSelector: {matchLabels: {app: ${PROXY_NAME}}}}]
    ports:
    - {port: 443, protocol: TCP}
    - {port: 8443, protocol: TCP}
EOF
  kctl rollout status deployment "$PROXY_NAME" -n "$HCC_NS" --timeout=90s >/dev/null ||
    die "Kubernetes API proxy did not become ready"
}

verify_hcc_proxy_network_policy() {
  local proxy_dns="${PROXY_NAME}.${HCC_NS}.svc"
  local proxy_ip positive_probe negative_probe probe_status

  proxy_ip="$(kctl get service "$PROXY_NAME" -n "$HCC_NS" -o jsonpath='{.spec.clusterIP}')" ||
    die "could not resolve the proxy Service ClusterIP"
  [ -n "$proxy_ip" ] || die "proxy Service has no ClusterIP"

  positive_probe="$(cat <<'NODE'
const fs=require('fs'),https=require('https');
const root='/var/run/secrets/kubernetes.io/serviceaccount/';
const request=https.request({host:process.argv[1],port:443,path:'/version',servername:'kubernetes.default.svc',ca:fs.readFileSync(root+'ca.crt'),headers:{authorization:'Bearer '+fs.readFileSync(root+'token','utf8')}},response=>{response.resume();response.on('end',()=>process.exit(response.statusCode===200?0:2))});
request.setTimeout(5000,()=>request.destroy(new Error('timeout')));request.on('error',()=>process.exit(3));request.end();
NODE
)"
  kctl exec deployment/"$HCC_DEPLOY" -n "$HCC_NS" -c host-context-controller -- \
    node -e "$positive_probe" "$proxy_dns" >/dev/null ||
    die "HCC cannot reach the Kubernetes API through the isolated proxy"

  PROBE_CREATED=1
  kctl apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${PROBE_EGRESS_NP}
  namespace: ${HCC_NS}
  labels: {e2e.clerum.io/suite: hcc-watch-recovery}
spec:
  podSelector: {matchLabels: {app: ${PROBE_NAME}}}
  policyTypes: [Egress]
  egress:
  - to: [{podSelector: {matchLabels: {app: ${PROXY_NAME}}}}]
    ports:
    - {port: 443, protocol: TCP}
    - {port: 8443, protocol: TCP}
---
apiVersion: v1
kind: Pod
metadata:
  name: ${PROBE_NAME}
  namespace: ${HCC_NS}
  labels: {app: ${PROBE_NAME}, e2e.clerum.io/suite: hcc-watch-recovery}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  containers:
  - name: probe
    image: ${HCC_IMAGE}
    imagePullPolicy: IfNotPresent
    command: [node, -e, "setInterval(()=>{},60000)"]
    resources:
      requests: {cpu: 5m, memory: 16Mi}
      limits: {cpu: 50m, memory: 48Mi}
    securityContext:
      allowPrivilegeEscalation: false
      capabilities: {drop: [ALL]}
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 1000
      runAsGroup: 1000
      seccompProfile: {type: RuntimeDefault}
EOF
  kctl wait pod "$PROBE_NAME" -n "$HCC_NS" --for=condition=Ready --timeout=60s >/dev/null ||
    die "negative NetworkPolicy probe did not become ready"
  negative_probe="$(cat <<'NODE'
const net=require('net');const socket=net.connect(443,process.argv[1]);
const timeout=setTimeout(()=>{socket.destroy();process.exit(42)},4000);
socket.once('connect',()=>{clearTimeout(timeout);socket.destroy();process.exit(0)});
socket.once('error',()=>{clearTimeout(timeout);process.exit(43)});
NODE
)"
  if kctl exec "$PROBE_NAME" -n "$HCC_NS" -- \
    node -e "$negative_probe" "$proxy_ip" >/dev/null 2>&1; then
    die "proxy ingress is reachable from a non-HCC pod"
  else
    probe_status=$?
  fi
  [ "$probe_status" = 42 ] ||
    die "negative NetworkPolicy probe failed operationally (exit=${probe_status}), not by ingress timeout"
  kctl delete pod "$PROBE_NAME" -n "$HCC_NS" --wait=true --timeout=60s >/dev/null
  PROBE_CREATED=0
}

host_runtime_is_always_on() {
  local host=$1 lifecycle desired available rows ready
  lifecycle="$(kctl get host "$host" -n "$HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true)"
  desired="$(kctl get deployment "$host" -n "$HOST_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  available="$(kctl get deployment "$host" -n "$HOST_NS" -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)"
  rows="$(kctl get pods -n "$HOST_NS" -l "app=${host}" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>/dev/null || true)"
  ready="$(awk -F '\t' '$2 == "True" && $3 == "" { count++ } END { print count + 0 }' <<<"$rows")"
  [ "$lifecycle" = active ] && [ "$desired" = 1 ] && [ "$available" = 1 ] && [ "$ready" = 1 ]
}

deployment_identity() {
  local name=$1 deployment pod_rows pods
  deployment="$(kctl get deployment "$name" -n "$HOST_NS" \
    -o jsonpath='{.metadata.resourceVersion}{" "}{.metadata.generation}{" "}{.spec.replicas}{" "}{.status.availableReplicas}')"
  pod_rows="$(kctl get pods -n "$HOST_NS" -l "app=${name}" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.status.containerStatuses[0].restartCount}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>/dev/null || true)"
  pods="$(awk -F '\t' '$4 == "True" && $5 == "" { print $1 ":" $2 ":" $3 }' <<<"$pod_rows" | sort | paste -sd, -)"
  printf '%s | %s\n' "$deployment" "$pods"
}

apply_fixture_channel() {
  local host=$1
  jq -n --arg name "$FIXTURE_CHANNEL" --arg ns "$CHANNEL_NS" --arg host "$host" \
    '{apiVersion:"clerum.io/v1alpha1",kind:"CommunicationChannel",
      metadata:{name:$name,namespace:$ns,
        labels:{"e2e.clerum.io/suite":"hcc-watch-recovery"}},
      spec:{hostRef:$host,email:[{channelId:"INBOX",emails:["hcc-watch@example.test"]}]}}' |
    kctl apply -f - >/dev/null
}

# Stateful Hosts must retain runtime identity. Stateless Hosts intentionally
# wake during fail-closed recovery, so their stable invariant is eligibility,
# not pod identity.
snapshot_non_fixture_invariants() {
  local hosts_json rows row name stateless rejection_status rejection_reason generation pod_rows pod_uids
  local snapshot snapshots="" emitted=0
  hosts_json="$(kctl get hosts -n "$HOST_NS" \
    -l 'e2e.clerum.io/suite!=hcc-watch-recovery' -o json)" || return 1
  rows="$(jq -ce --arg source "$SOURCE_HOST" '
    if any(.items[]; .metadata.name == $source) then
      .items[] | {name:.metadata.name,stateless:(.spec.lifecycle.stateless // false),
        rejectionStatus:([.status.conditions[]? | select(.type == "StatelessEnableRejected")][0].status // null),
        rejectionReason:([.status.conditions[]? | select(.type == "StatelessEnableRejected")][0].reason // null)}
    else
      error("source Host missing from inventory")
    end' <<<"$hosts_json")" || return 1
  while IFS= read -r row; do
    name="$(jq -r '.name' <<<"$row")"
    [ "$name" != "$CONTROL_HOST" ] && [ "$name" != "$FIXTURE_HOST" ] &&
      [ "$name" != "$SIBLING_HOST" ] && [ "$name" != "$RECOVERY_HOST" ] || continue
    stateless="$(jq -r '.stateless' <<<"$row")"
    rejection_status="$(jq -r '.rejectionStatus // ""' <<<"$row")"
    rejection_reason="$(jq -r '.rejectionReason // ""' <<<"$row")"
    generation="" pod_uids=""
    if [ "$stateless" = false ]; then
      generation="$(kctl get deployment "$name" -n "$HOST_NS" \
        -o jsonpath='{.metadata.resourceVersion}{" "}{.metadata.generation}' 2>/dev/null)" || return 1
      pod_rows="$(kctl get pods -n "$HOST_NS" -l "clerum.io/host=${name}" \
        --field-selector=status.phase=Running \
        -o jsonpath='{range .items[*]}{.metadata.uid}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
        2>/dev/null)" || return 1
      pod_uids="$(awk -F '\t' '$2 == "" { print $1 }' <<<"$pod_rows" | sort | paste -sd, -)"
    fi
    snapshot="$(jq -cn --arg name "$name" --argjson stateless "$stateless" \
      --arg rejectionStatus "$rejection_status" --arg rejectionReason "$rejection_reason" \
      --arg generation "$generation" --arg podUids "$pod_uids" \
      '{name:$name,stateless:$stateless,rejectionStatus:$rejectionStatus,
        rejectionReason:$rejectionReason,statefulGeneration:$generation,statefulPodUids:$podUids}')" || return 1
    snapshots+="${snapshot}"$'\n'
    emitted=$((emitted + 1))
  done <<<"$rows"
  [ "$emitted" -gt 0 ] || return 1
  printf '%s' "$snapshots" | sort
}

delete_hcc_proxy_fixture() {
  local failed=0
  [ "$PROBE_CREATED" = 0 ] ||
    kctl delete pod "$PROBE_NAME" -n "$HCC_NS" --ignore-not-found \
      --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete networkpolicy "$PROXY_EGRESS_NP" "$HCC_PROXY_NP" "$PROBE_EGRESS_NP" -n "$HCC_NS" \
    --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete service "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found \
    --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  kctl delete deployment "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found \
    --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  [ "$failed" = 0 ]
}

restore_hcc_after_fault_injection() {
  local host_override port_override host_aliases desired ready

  kctl set env deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
    KUBERNETES_SERVICE_HOST- KUBERNETES_SERVICE_PORT- >/dev/null || return 1
  kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=merge \
    -p '{"spec":{"template":{"spec":{"hostAliases":null}}}}' >/dev/null || return 1
  kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null || return 1

  host_override="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].env[?(@.name=="KUBERNETES_SERVICE_HOST")].name}')"
  port_override="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].env[?(@.name=="KUBERNETES_SERVICE_PORT")].name}')"
  host_aliases="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.hostAliases}')"
  desired="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.replicas}')"
  ready="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.status.readyReplicas}')"
  [ -z "$host_override$port_override$host_aliases" ] && [ "$desired" = "$ready" ]
}

print_hcc_repair_instructions() {
  cat >&2 <<EOF
HCC restoration failed. Proxy resources were retained for repair.
Context: ${E2E_KUBECONTEXT}
Proxy: ${HCC_NS}/${PROXY_NAME}
Repair commands:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} set env deployment/${HCC_DEPLOY} KUBERNETES_SERVICE_HOST- KUBERNETES_SERVICE_PORT-
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} patch deployment/${HCC_DEPLOY} --type=merge -p '{"spec":{"template":{"spec":{"hostAliases":null}}}}'
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} rollout status deployment/${HCC_DEPLOY} --timeout=180s
After HCC is healthy, delete ${PROXY_NAME}, ${PROXY_EGRESS_NP}, ${HCC_PROXY_NP}, and ${PROBE_EGRESS_NP} in ${HCC_NS}.
EOF
}
