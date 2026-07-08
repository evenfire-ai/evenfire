#!/usr/bin/env bash
# Pod and broker assertions for custom coordinator SDK E2E.

custom_coordinator_assert_no_env_vars() {
  local pod_name=$1
  shift
  local env_names
  env_names=$(kubectl get pod "$pod_name" -n "$SANDBOX_NS" -o jsonpath='{.spec.containers[0].env[*].name}' 2>/dev/null || true)
  for env_name in "$@"; do
    if printf "%s\n" "$env_names" | tr ' ' '\n' | grep -Fxq "$env_name"; then
      fail "${pod_name} received forbidden env var ${env_name}"
      exit 1
    fi
  done
}

custom_coordinator_assert_no_broker_env() {
  local pod_name=$1
  custom_coordinator_assert_no_env_vars "$pod_name" \
    MCP_HOST_RUNTIME_ACCESS_TOKEN \
    MCP_HOST_RUNTIME_REFRESH_TOKEN \
    MCP_HOST_GATEWAY_URL \
    MCP_HOST_WORKFLOW_CONTROL_TOKEN \
    MCP_HOST_TOKEN \
    CLERUM_MCPHOST_URL
  ok "custom coordinator has no mcp-host credentials or channel env"
}

custom_coordinator_assert_pod_image() {
  local pod_name=$1
  local image
  image=$(kubectl get pod "$pod_name" -n "$SANDBOX_NS" -o jsonpath='{.spec.containers[0].image}' 2>/dev/null || true)
  if [ "$image" = "clerum/workflow-custom-sdk-e2e:test" ]; then
    ok "coordinator pod uses spec.coordinatorImage"
  else
    fail "coordinator pod image mismatch: ${image:-<empty>}"
    exit 1
  fi
}

custom_coordinator_assert_pod_labels() {
  local pod_name=$1
  local labels_json
  labels_json=$(kubectl get pod "$pod_name" -n "$SANDBOX_NS" -o jsonpath='{.metadata.labels}' 2>/dev/null || true)
  if LABELS_JSON="$labels_json" RECIPE_NAME="$RECIPE_NAME" python3 - <<'PY'
import json
import os

labels = json.loads(os.environ["LABELS_JSON"] or "{}")
expected = {
    "clerum.io/recipe": os.environ["RECIPE_NAME"],
    "clerum.io/component": "workflow-coordinator",
    "clerum.io/coordinator-tier": "custom",
    "clerum.io/managed-by": "wrc",
}
for key, value in expected.items():
    if labels.get(key) != value:
        raise SystemExit(f"{key} mismatch: {labels!r}")
PY
  then
    ok "actual custom coordinator pod labels match NetworkPolicy selectors"
  else
    fail "custom coordinator pod labels do not match NetworkPolicy selectors"
    kubectl get pod "$pod_name" -n "$SANDBOX_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

custom_coordinator_assert_no_mcp_host() {
  if kubectl get pod "${RECIPE_NAME}-mcp-host" -n "$SANDBOX_NS" >/dev/null 2>&1; then
    fail "id-only custom workflow created mcp-host pod"
    exit 1
  fi
  ok "id-only custom workflow skipped mcp-host pod"
}

custom_coordinator_assert_no_mcp_runtime_secret() {
  if kubectl get secret "wf-${RECIPE_NAME}-mcp-host-runtime-tokens" -n "$SANDBOX_NS" >/dev/null 2>&1; then
    fail "id-only custom workflow minted mcp-host runtime token Secret"
    exit 1
  fi
  ok "id-only custom workflow did not mint mcp-host runtime token Secret"
}

custom_coordinator_assert_pod_hardening() {
  local pod_name=$1
  local pod_json
  pod_json=$(kubectl get pod "$pod_name" -n "$SANDBOX_NS" -o json)
  if POD_JSON="$pod_json" RECIPE_NAME="$RECIPE_NAME" OUTPUT_OWNER_RECIPE_NAME="${CUSTOM_OUTPUT_OWNER_NAME:-$RECIPE_NAME}" python3 - <<'PY'
import json
import os

pod = json.loads(os.environ["POD_JSON"])
recipe_name = os.environ["RECIPE_NAME"]
output_owner = os.environ["OUTPUT_OWNER_RECIPE_NAME"]
spec = pod["spec"]
if spec.get("enableServiceLinks") is not False:
    raise SystemExit("enableServiceLinks not false")
for field in ("hostNetwork", "hostPID", "hostIPC"):
    if spec.get(field) not in (False, None):
        raise SystemExit(f"{field} enabled")
if spec.get("activeDeadlineSeconds") != 3300:
    raise SystemExit("activeDeadlineSeconds mismatch")
container = spec["containers"][0]
env = {item.get("name"): item for item in container.get("env", [])}
if "WRC_TOKEN" in env or "MCP_HOST_TOKEN" in env:
    raise SystemExit("runtime tokens must not be delivered through direct env values")
if env.get("WRC_TOKEN_FILE", {}).get("value") != "/var/run/clerum/workflow-tokens/wrc-token":
    raise SystemExit("WRC_TOKEN_FILE env missing")
resources = container.get("resources", {})
if resources.get("requests", {}).get("ephemeral-storage") != "64Mi":
    raise SystemExit("ephemeral-storage request mismatch")
if resources.get("limits", {}).get("ephemeral-storage") != "256Mi":
    raise SystemExit("ephemeral-storage limit mismatch")
mount = next((m for m in container.get("volumeMounts", []) if m.get("mountPath") == "/output"), None)
if not mount:
    raise SystemExit("output mount missing")
workflow_run_id = env.get("CLERUM_WORKFLOW_RUN_ID", {}).get("value")
expected_output_subpaths = {f"workflow-output/{output_owner}"}
if workflow_run_id:
    expected_output_subpaths.add(f"workflow-output/{output_owner}/{workflow_run_id}")
if mount.get("subPath") not in expected_output_subpaths:
    raise SystemExit(f"dedicated output mount subPath mismatch: {mount.get('subPath')!r}")
token_mount = next((m for m in container.get("volumeMounts", []) if m.get("name") == "workflow-tokens"), None)
if not token_mount:
    raise SystemExit("workflow token mount missing")
if token_mount.get("mountPath") != "/var/run/clerum/workflow-tokens" or token_mount.get("readOnly") is not True:
    raise SystemExit("workflow token mount must be read-only at the canonical path")
if "subPath" in token_mount:
    raise SystemExit("workflow token mount must not use subPath")
token_vol = next((v for v in spec.get("volumes", []) if v.get("name") == "workflow-tokens"), None)
if not token_vol or token_vol.get("secret", {}).get("secretName") != f"wf-{recipe_name}-coordinator-token":
    raise SystemExit("workflow token Secret volume mismatch")
if token_vol.get("secret", {}).get("defaultMode") != 0o440:
    raise SystemExit("workflow token Secret volume defaultMode mismatch")
vol = next((v for v in spec.get("volumes", []) if v.get("name") == "recipe-output"), None)
expected_claim = f"{output_owner}-workflow-output"
if not vol or vol.get("persistentVolumeClaim", {}).get("claimName") != expected_claim:
    raise SystemExit("parent workflow output PVC claim mismatch")
labels = pod.get("metadata", {}).get("labels", {})
if labels.get("clerum.io/workflow-output-claim") != expected_claim:
    raise SystemExit("workflow output claim label mismatch")
terms = spec.get("affinity", {}).get("podAffinity", {}).get("requiredDuringSchedulingIgnoredDuringExecution", [])
if not terms:
    raise SystemExit("workflow output anchor podAffinity missing")
expressions = terms[0].get("labelSelector", {}).get("matchExpressions", [])
if {"key": "clerum.io/workflow-output-claim", "operator": "In", "values": [expected_claim]} not in expressions:
    raise SystemExit("workflow output claim podAffinity selector mismatch")
if {"key": "clerum.io/component", "operator": "In", "values": ["workflow-output-anchor"]} not in expressions:
    raise SystemExit("workflow output anchor podAffinity selector mismatch")
if terms[0].get("topologyKey") != "kubernetes.io/hostname":
    raise SystemExit("workflow output anchor topologyKey mismatch")
tmp = next((v for v in spec.get("volumes", []) if v.get("name") == "tmp"), None)
if tmp.get("emptyDir", {}).get("sizeLimit") != "64Mi":
    raise SystemExit("tmp sizeLimit mismatch")
PY
  then
  ok "custom coordinator pod hardening and dedicated /output mount are enforced"
  else
    fail "custom coordinator pod hardening did not match policy"
    kubectl get pod "$pod_name" -n "$SANDBOX_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

custom_coordinator_assert_network_boundaries() {
  local image="clerum/workflow-custom-sdk-e2e:test"
  kubectl delete pod "$NETWORK_PROBE_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl wait --for=delete "pod/${NETWORK_PROBE_POD}" -n "$SANDBOX_NS" --timeout=60s >/dev/null 2>&1 || true

  cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${NETWORK_PROBE_POD}
  namespace: ${SANDBOX_NS}
  labels:
    clerum.io/recipe: ${RECIPE_NAME}
    clerum.io/component: workflow-coordinator
    clerum.io/managed-by: e2e
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
    - name: probe
      image: ${image}
      imagePullPolicy: IfNotPresent
      command:
        - sh
        - -c
        - |
          node <<'NODE'
          const net = require('node:net')

          function probe(host, port, timeoutMs = 2500) {
            return new Promise(resolve => {
              const socket = net.createConnection({ host, port, family: 4 })
              let settled = false
              const done = status => {
                if (settled) return
                settled = true
                socket.destroy()
                resolve(status)
              }
              socket.setTimeout(timeoutMs)
              socket.once('connect', () => done('connected'))
              socket.once('timeout', () => done('timeout'))
              socket.once('error', err => done('error:' + (err.code || err.message)))
            })
          }

          ;(async () => {
            const recipe = process.env.RECIPE_NAME
            const sandbox = process.env.SANDBOX_NS
            const targets = [
              {
                name: 'wrc',
                host: 'workflow-recipes.control-plane.svc.cluster.local',
                port: 8082,
                expect: 'connected',
              },
              {
                name: 'publicGitHub',
                host: 'api.github.com',
                port: 443,
                expect: 'connected',
              },
              {
                name: 'approvalGateway',
                host: 'nginx-workflow-approval-gateway.control-plane.svc.cluster.local',
                port: 8092,
                expect: 'blocked',
              },
              {
                name: 'kubernetesApi',
                host: 'kubernetes.default.svc.cluster.local',
                port: 443,
                expect: 'blocked',
              },
              {
                name: 'linkLocalMetadata',
                host: '169.254.169.254',
                port: 80,
                expect: 'blocked',
              },
              {
                name: 'hccGateway',
                host: 'host-context-controller-api-gateway.control-plane.svc.cluster.local',
                port: 8081,
                expect: 'blocked',
              },
              {
                name: 'recipeMcpHost',
                host: recipe + '-mcp-host.' + sandbox + '.svc.cluster.local',
                port: 8080,
                expect: 'blocked',
              },
            ]
            const results = {}
            for (const target of targets) {
              results[target.name] = await probe(target.host, target.port)
            }
            console.log(JSON.stringify(results, null, 2))

            const connected = name => results[name] === 'connected'
            if (!connected('wrc')) {
              throw new Error('expected WRC to be reachable, got ' + results.wrc)
            }
            if (!connected('publicGitHub')) {
              throw new Error(
                'expected declared public HTTP egress to api.github.com, got ' +
                  results.publicGitHub
              )
            }
            for (const target of targets.filter(item => item.expect === 'blocked')) {
              if (connected(target.name)) {
                throw new Error(target.name + ' unexpectedly reachable')
              }
            }
          })().catch(err => {
            console.error(err)
            process.exit(1)
          })
          NODE
      env:
        - name: RECIPE_NAME
          value: ${RECIPE_NAME}
        - name: SANDBOX_NS
          value: ${SANDBOX_NS}
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: 16Mi
YAML

  if kubectl wait --for=jsonpath='{.status.phase}'=Succeeded "pod/${NETWORK_PROBE_POD}" -n "$SANDBOX_NS" --timeout=90s >/dev/null; then
    ok "pure custom coordinator network policy allows WRC/public HTTP and blocks approval gateway, Kubernetes API, link-local metadata, HCC, and recipe mcp-host"
  else
    fail "pure custom coordinator network boundary probe failed"
    kubectl logs "$NETWORK_PROBE_POD" -n "$SANDBOX_NS" 2>/dev/null || true
    kubectl describe pod "$NETWORK_PROBE_POD" -n "$SANDBOX_NS" 2>/dev/null || true
    exit 1
  fi
  kubectl delete pod "$NETWORK_PROBE_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
