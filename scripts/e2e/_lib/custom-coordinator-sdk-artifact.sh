#!/usr/bin/env bash
# Artifact inspection for custom coordinator SDK E2E.

custom_coordinator_assert_artifact_written() {
  local image="clerum/workflow-custom-sdk-e2e:test"
  local output_subpath
  output_subpath=$(kubectl get pod "${RECIPE_NAME}-coordinator" -n "$SANDBOX_NS" \
    -o jsonpath='{.spec.containers[0].volumeMounts[?(@.mountPath=="/output")].subPath}' 2>/dev/null || true)
  if [[ -z "$output_subpath" ||
    "$output_subpath" = /* ||
    ! "$output_subpath" =~ ^workflow-output/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?$ ]]; then
    fail "could not derive coordinator output subPath for artifact inspection: ${output_subpath:-<empty>}"
    exit 1
  fi

  kubectl delete pod "$INSPECTOR_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl wait --for=delete "pod/${INSPECTOR_POD}" -n "$SANDBOX_NS" --timeout=60s >/dev/null 2>&1 || true

  cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${INSPECTOR_POD}
  namespace: ${SANDBOX_NS}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: inspector
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 300"]
      securityContext:
        allowPrivilegeEscalation: false
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: recipe-output
          mountPath: /output
          subPath: ${output_subpath}
  volumes:
    - name: recipe-output
      persistentVolumeClaim:
        claimName: ${CUSTOM_OUTPUT_PVC}
YAML

  if ! kubectl wait --for=condition=Ready "pod/${INSPECTOR_POD}" -n "$SANDBOX_NS" --timeout=120s >/dev/null; then
    fail "artifact inspector pod did not become ready"
    kubectl describe pod "$INSPECTOR_POD" -n "$SANDBOX_NS" 2>/dev/null || true
    exit 1
  fi

  local artifact
  artifact=$(kubectl exec "$INSPECTOR_POD" -n "$SANDBOX_NS" -- cat /output/custom-sdk-result.json 2>/dev/null || true)
  kubectl delete pod "$INSPECTOR_POD" -n "$SANDBOX_NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if ARTIFACT_JSON="$artifact" python3 - <<'PY'
import json
import os

doc = json.loads(os.environ["ARTIFACT_JSON"])
if doc.get("workflowName") != "e2e-custom-coordinator-sdk":
    raise SystemExit("workflowName mismatch")
if doc.get("orderedStepIds") != ["prepare", "transform", "emit"]:
    raise SystemExit("orderedStepIds mismatch")
if doc.get("previousOutputKeys") != ["prepare", "transform"]:
    raise SystemExit("dependency output flow mismatch")
probe = doc.get("forbiddenCapabilityProbe", {})
if probe.get("phantomStatus") != 422:
    raise SystemExit(f"phantom step probe mismatch: {probe!r}")
if probe.get("configureModelStatus") != 403 or probe.get("triggerStatus") != 403:
    raise SystemExit(f"forbidden WRC capability probe mismatch: {probe!r}")
decision = doc.get("businessDecision", {})
if decision.get("highRiskAccounts") != ["dao-alpha"]:
    raise SystemExit(f"high risk account mismatch: {decision!r}")
if decision.get("outstandingAmount") != 1880:
    raise SystemExit(f"outstanding amount mismatch: {decision!r}")
if decision.get("manualReviewRequired") is not True:
    raise SystemExit(f"manual review decision mismatch: {decision!r}")
public_http = decision.get("publicHttp", {})
if public_http.get("attempted") is not True or public_http.get("host") != "api.github.com":
    raise SystemExit(f"public HTTP egress probe mismatch: {public_http!r}")
if public_http.get("status") != 200:
    raise SystemExit(f"public HTTP status mismatch: {public_http!r}")
if public_http.get("repoFullName") != "octocat/Hello-World" or public_http.get("private") is not False:
    raise SystemExit(f"public HTTP GitHub payload mismatch: {public_http!r}")
declared_workload = decision.get("declaredWorkload", {})
if declared_workload.get("attempted") is not True or declared_workload.get("workloadId") != "business-api":
    raise SystemExit(f"declared workload probe mismatch: {declared_workload!r}")
if declared_workload.get("status") != 200 or declared_workload.get("bodyStatus") != "ok":
    raise SystemExit(f"declared workload response mismatch: {declared_workload!r}")
tools = set(declared_workload.get("tools") or [])
if not {"record", "recall"}.issubset(tools):
    raise SystemExit(f"declared workload tools mismatch: {declared_workload!r}")
if doc.get("unsafeArtifactAttempted") is not True:
    raise SystemExit("unsafe artifact negative path was not exercised")
PY
  then
    ok "custom coordinator wrote custom business artifact to dedicated workflow output PVC"
  else
    fail "custom coordinator artifact content mismatch"
    exit 1
  fi
}
