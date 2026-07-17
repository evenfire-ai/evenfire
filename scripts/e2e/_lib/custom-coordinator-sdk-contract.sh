#!/usr/bin/env bash
# PVC, token, config, and status assertions for custom coordinator SDK E2E.

custom_coordinator_assert_pvc_storage() {
  local pvc_request
  pvc_request=$(kubectl get pvc "$CUSTOM_OUTPUT_PVC" -n "$SANDBOX_NS" -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null || true)
  if [ "$pvc_request" = "128Mi" ]; then
    ok "custom workflow output PVC uses recipe storageSize"
  else
    fail "custom workflow output PVC storage mismatch: ${pvc_request:-<empty>}"
    exit 1
  fi
}

custom_coordinator_assert_reduced_token() {
  local secret_json
  secret_json=$(kubectl get secret "wf-${RECIPE_NAME}-coordinator-token" -n "$SANDBOX_NS" -o json)
  if SECRET_JSON="$secret_json" python3 - <<'PY'
import base64
import json
import os

doc = json.loads(os.environ["SECRET_JSON"])
data = doc.get("data", {})
if "mcp-host-token" in data:
    raise SystemExit("unexpected mcp-host-token")
token = base64.b64decode(data["wrc-token"]).decode()
payload = token.split(".")[1]
payload += "=" * (-len(payload) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload.encode()))
scopes = set(claims.get("scopes", []))
expected = {"model_injection_request", "status_write", "status_read", "signal_read", "health_read"}
if scopes != expected:
    raise SystemExit(f"scope mismatch: {sorted(scopes)!r}")
for forbidden in ("configure_model", "trigger_write"):
    if forbidden in scopes:
        raise SystemExit(f"forbidden scope present: {forbidden}")
if claims.get("sub") != "custom-coordinator":
    raise SystemExit(f"subject mismatch: {claims.get('sub')!r}")
PY
  then
    ok "custom coordinator token has only reduced WRC scopes"
  else
    fail "custom coordinator token Secret did not match reduced-scope policy"
    exit 1
  fi
}

custom_coordinator_assert_config_map_contract() {
  local config_json
  config_json=$(kubectl get configmap "${RECIPE_NAME}-workflow-config" -n "$SANDBOX_NS" -o jsonpath='{.data.config\.json}' 2>/dev/null || true)
  if CONFIG_JSON="$config_json" python3 - <<'PY'
import json
import os

doc = json.loads(os.environ["CONFIG_JSON"])
if doc.get("coordinatorImage") != "clerum/workflow-custom-sdk-e2e:test":
    raise SystemExit("coordinatorImage missing")
allowed_hosts = doc.get("runtimeEgress", {}).get("http", {}).get("allowedHosts", [])
if allowed_hosts != ["api.github.com"]:
    raise SystemExit(f"runtimeEgress HTTP allowlist mismatch: {allowed_hosts!r}")
if "inputContract" not in doc:
    raise SystemExit("inputContract missing")
workloads = {item.get("id"): item for item in doc.get("workloads", [])}
business_api = workloads.get("business-api")
if not business_api:
    raise SystemExit("business-api workload missing")
if business_api.get("transport"):
    raise SystemExit("business-api must not be a transport workload")
if business_api.get("port") != 3001 or not str(business_api.get("host", "")).endswith(".sandbox-recipes.svc.cluster.local"):
    raise SystemExit(f"business-api workload binding mismatch: {business_api!r}")
steps = doc.get("steps", [])
if [step.get("id") for step in steps] != ["prepare", "transform", "emit"]:
    raise SystemExit(f"step order mismatch: {steps!r}")
for step in steps:
    if "run" in step or "instruction" in step:
        raise SystemExit(f"custom id-only step gained executable field: {step!r}")
if steps[1].get("dependsOn") != ["prepare"] or steps[2].get("dependsOn") != ["transform"]:
    raise SystemExit("dependency chain missing")
PY
  then
    ok "workflow config includes coordinatorImage, runtimeEgress, inputContract, and id-only steps"
  else
    fail "workflow config did not match custom coordinator contract"
    kubectl get configmap "${RECIPE_NAME}-workflow-config" -n "$SANDBOX_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}

custom_coordinator_assert_status_contract() {
  local status_json
  status_json=$(kubectl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o json)
  if STATUS_JSON="$status_json" python3 - <<'PY'
import json
import os

doc = json.loads(os.environ["STATUS_JSON"])
status = doc.get("status", {})
steps = status.get("steps", [])
actual = [(step.get("id"), step.get("phase"), step.get("executor")) for step in steps]
expected = [
    ("prepare", "completed", "custom"),
    ("transform", "completed", "custom"),
    ("emit", "completed", "custom"),
]
if actual != expected:
    raise SystemExit(f"step status mismatch: {actual!r}")
artifacts = status.get("artifacts", [])
artifact = next((a for a in artifacts if a.get("name") == "custom-sdk-result.json"), None)
if not artifact:
    raise SystemExit("custom artifact missing")
if artifact.get("path") != "/output/custom-sdk-result.json" or artifact.get("format") != "json":
    raise SystemExit(f"artifact metadata mismatch: {artifact!r}")
unsafe = [a for a in artifacts if "unsafe" in str(a.get("name")) or not str(a.get("path", "")).startswith("/output/")]
if unsafe:
    raise SystemExit(f"unsafe artifact metadata was persisted: {unsafe!r}")
PY
  then
    ok "WorkflowRecipe status records custom executor steps and artifact metadata"
  else
    fail "WorkflowRecipe status did not match custom coordinator contract"
    kubectl get workflowrecipe "$RECIPE_NAME" -n "$RECIPE_NS" -o yaml 2>/dev/null || true
    exit 1
  fi
}
