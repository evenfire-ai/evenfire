#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 5 ]]; then
  echo "Usage: $(basename "$0") <context> <namespace> <service> <local-port> <remote-port>" >&2
  exit 2
fi

context="$1"
namespace="$2"
service="$3"
local_port="$4"
remote_port="$5"
retry_seconds="${LOCAL_UI_PORT_FORWARD_RETRY_SECONDS:-1}"
max_attempts="${LOCAL_UI_PORT_FORWARD_MAX_ATTEMPTS:-30}"
attempt=0
child_pid=""
stopping=false
ready_pod_error=""

ready_pod_for_service() {
  local error_file output status
  ready_pod_error=""
  error_file="$(mktemp "${TMPDIR:-/tmp}/clerum-port-forward.XXXXXX")"
  output="$(
    kubectl --context="${context}" -n "${namespace}" get endpoints "${service}" \
      -o jsonpath='{range .subsets[*].addresses[*]}{.targetRef.name}{"\n"}{end}' \
      2>"${error_file}"
  )" || status=$?
  status="${status:-0}"
  if [[ "${status}" -ne 0 ]]; then
    ready_pod_error="$(cat "${error_file}")"
    rm -f "${error_file}"
    return 1
  fi
  rm -f "${error_file}"
  awk 'NF && $0 !~ /^Warning:/ { print; exit }' <<<"${output}"
}

stop() {
  stopping=true
  if [[ -n "${child_pid}" ]]; then
    kill "${child_pid}" 2>/dev/null || true
  fi
}

trap stop INT TERM

while true; do
  attempt=$((attempt + 1))
  status=0
  pod=""

  if ! pod="$(ready_pod_for_service)"; then
    if [[ -n "${ready_pod_error}" ]]; then
      echo "Failed to resolve ready endpoint pod for ${namespace}/${service}: ${ready_pod_error}" >&2
    else
      echo "Failed to resolve ready endpoint pod for ${namespace}/${service}" >&2
    fi
    status=1
  elif [[ -z "${pod}" ]]; then
    echo "No ready endpoint pod for ${namespace}/${service}; retrying in ${retry_seconds}s" >&2
    status=1
  else
    echo "Starting ${namespace}/${service} port-forward on 127.0.0.1:${local_port} via pod/${pod} (attempt ${attempt})"
    kubectl --context="${context}" -n "${namespace}" port-forward \
      --address=127.0.0.1 "pod/${pod}" "${local_port}:${remote_port}" &
    child_pid=$!
    wait "${child_pid}" || status=$?
    child_pid=""
  fi

  if [[ "${stopping}" == "true" ]]; then
    exit 0
  fi

  if (( max_attempts > 0 && attempt >= max_attempts )); then
    echo "${namespace}/${service} port-forward failed after ${attempt} attempts" >&2
    if (( status == 0 )); then
      status=1
    fi
    exit "${status}"
  fi

  if [[ -n "${pod}" ]]; then
    echo "${namespace}/${service} port-forward stopped; retrying in ${retry_seconds}s" >&2
  fi
  sleep "${retry_seconds}"
done
