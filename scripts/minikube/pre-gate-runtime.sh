#!/usr/bin/env bash

# Runtime orchestration helpers for pre-gate-sync.sh. The caller provides
# strict shell mode, KC, PROFILE, PROJECT_DIR, GATE_NAME, and log().

DEFAULT_HOST_CRD_SCHEMA_PROBE_REF="mcp-host/chatllm"
HOST_CRD_SCHEMA_PROBE_REF="${HOST_CRD_SCHEMA_PROBE_REF:-${DEFAULT_HOST_CRD_SCHEMA_PROBE_REF}}"
export HOST_CRD_SCHEMA_PROBE_REF

preflight_host_lifecycle_probe() {
  if ! ${KC} get deployment host-context-controller -n control-plane >/dev/null 2>&1; then
    log "Skipping Host lifecycle probe preflight (fresh bootstrap: HCC is absent)"
    return 0
  fi
  if [[ ! "${HOST_CRD_SCHEMA_PROBE_REF}" =~ ^([a-z0-9]([-a-z0-9]*[a-z0-9])?)/([a-z0-9]([-a-z0-9.]*[a-z0-9])?)$ ]]; then
    log "ERROR: HOST_CRD_SCHEMA_PROBE_REF must be namespace/name, got '${HOST_CRD_SCHEMA_PROBE_REF}'"
    return 1
  fi
  local namespace="${HOST_CRD_SCHEMA_PROBE_REF%%/*}"
  local name="${HOST_CRD_SCHEMA_PROBE_REF#*/}"
  if ! ${KC} get host "${name}" -n "${namespace}" >/dev/null 2>&1; then
    log "ERROR: manifest-backed Host lifecycle probe ${HOST_CRD_SCHEMA_PROBE_REF} is absent; refusing to rebuild or mutate the profile"
    return 1
  fi
  log "Host lifecycle probe preflight passed: ${HOST_CRD_SCHEMA_PROBE_REF}"
}

rollout_if_present() {
  local namespace="$1" deployment="$2"
  if ${KC} get deployment "${deployment}" -n "${namespace}" >/dev/null 2>&1; then
    log "Waiting for rollout: ${namespace}/${deployment}"
    ${KC} rollout status "deployment/${deployment}" -n "${namespace}" --timeout=120s >/dev/null
  fi
}

rollout_restart_with_retry() {
  local namespace="$1" deployment="$2" attempt output
  for attempt in 1 2 3; do
    if output="$(${KC} rollout restart "deployment/${deployment}" -n "${namespace}" 2>&1)"; then
      [[ -n "${output}" ]] && printf '%s\n' "${output}"
      return 0
    fi
    if [[ "${output}" == *"within the past second"* && "${attempt}" != 3 ]]; then
      log "Retrying rollout restart for ${namespace}/${deployment} after recent restart"
      sleep 2
      continue
    fi
    printf '%s\n' "${output}" >&2
    return 1
  done
}

rollout_namespace_deployments() {
  local namespace="$1" names
  names="$(${KC} get deployment -n "${namespace}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  [[ -n "${names}" ]] || return 0
  while IFS= read -r deployment; do
    [[ -z "${deployment}" ]] || rollout_if_present "${namespace}" "${deployment}"
  done <<<"${names}"
}

# The workflow gateway mounts nginx.conf through a subPath, so a ConfigMap can
# be updated while a running pod continues serving the previous route table.
# The manifest-level test prevents omission in source; this runtime assertion
# prevents a stale or partially applied profile from being used for an SDK gate.
assert_workflow_gateway_prompt_bridge_finalization_route() {
  local deployment="nginx-workflow-approval-gateway"
  local namespace="control-plane"
  local expected_route='location ~ ^/api/v1/mcp-host/plugin-workload-sdk/invocations/[^/]+/finalize$'
  local candidate deletion ready nginx_config inspect_rc pod_count=0

  if ! ${KC} get deployment "${deployment}" -n "${namespace}" >/dev/null 2>&1; then
    log "ERROR: ${namespace}/${deployment} is absent; refusing Plugin Workload SDK gate"
    return 1
  fi

  # A rollout can leave an old pod in Running/Terminating briefly. Do not
  # inspect the first pod returned by the API: that made the previous guard
  # race a healthy new ReplicaSet and reject a valid deployment. Only inspect
  # Ready, non-terminating pods, and require the route in every active pod.
  while IFS= read -r candidate; do
    [[ -z "${candidate}" ]] && continue
    deletion="$(${KC} get pod "${candidate}" -n "${namespace}" \
      -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null || true)"
    [[ -n "${deletion}" ]] && continue
    ready="$(${KC} get pod "${candidate}" -n "${namespace}" \
      -o jsonpath='{.status.containerStatuses[?(@.name=="nginx")].ready}' 2>/dev/null || true)"
    [[ "${ready}" == "true" ]] || continue
    pod_count=$((pod_count + 1))

    # Consume the complete command before searching it. With the caller's
    # `set -o pipefail`, piping `kubectl exec ... nginx -T` into `grep -q`
    # lets grep close the pipe as soon as it finds the route. kubectl can then
    # exit on SIGPIPE (141), turning a present route into a false failure.
    # Keeping execution and content validation separate also preserves the
    # distinction between an unreachable pod and a genuinely stale config.
    if nginx_config="$(${KC} exec -n "${namespace}" "${candidate}" -c nginx -- nginx -T 2>&1)"; then
      :
    else
      inspect_rc=$?
      log "ERROR: could not inspect the active nginx configuration in ${namespace}/${candidate} (kubectl exec rc=${inspect_rc}); refusing gate"
      return 1
    fi
    if [[ "${nginx_config}" != *"${expected_route}"* ]]; then
      log "ERROR: active ${namespace}/${candidate} does not serve the SDK finalization route; refusing gate"
      return 1
    fi
  done < <(${KC} get pods -n "${namespace}" -l app="${deployment}" \
    --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)

  if [[ "${pod_count}" == "0" ]]; then
    log "ERROR: ${namespace}/${deployment} has no Ready non-terminating pod; refusing Plugin Workload SDK gate"
    return 1
  fi
  log "Workflow gateway serves the SDK promptBridge finalization route"
}

gate_needs_registry() {
  [[ "${GATE_NAME}" == *registry* || "${GATE_NAME}" == *marketplace* || "${GATE_NAME}" == *plugin-workload-sdk* ]]
}

ensure_evenfire_registry() {
  if ! gate_needs_registry; then
    log "Skipping evenfire-registry before ${GATE_NAME}; this gate does not require the sibling service"
    return 0
  fi
  log "Ensuring evenfire-registry and minikube registry egress policies before ${GATE_NAME}"
  (
    cd "${PROJECT_DIR}"
    if ${KC} -n registry get deployment registry-api >/dev/null 2>&1; then
      MINIKUBE_PROFILE="${PROFILE}" SKIP_BUILD=1 make minikube-deploy-evenfire-registry
    else
      MINIKUBE_PROFILE="${PROFILE}" make minikube-deploy-evenfire-registry
    fi
  )
}
