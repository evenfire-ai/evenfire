#!/usr/bin/env bash

set -euo pipefail

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
PORTS_ENV="${CLERUM_PROFILE_PORTS_ENV:-${HOME}/.cache/clerum/minikube-profiles/${PROFILE}/ports.env}"

profile_value() {
  local key="$1"
  local file="$2"
  awk -F= -v expected_key="${key}" \
    '$1 == expected_key { sub(/^[^=]*=/, ""); print; exit }' "${file}"
}

resolve_auth_proxy_base_url() {
  local value=''
  local port=''
  if [[ -f "${PORTS_ENV}" ]]; then
    value="$(profile_value AUTH_PROXY_BASE_URL "${PORTS_ENV}")"
    [[ -n "${value}" ]] || value="$(profile_value AUTH_PROXY_URL "${PORTS_ENV}")"
    port="$(profile_value AUTH_PROXY_PORT "${PORTS_ENV}")"
  elif [[ "${PROFILE}" =~ ^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]]; then
    echo "ERROR: missing branch-scoped port cache for minikube profile: ${PROFILE}" >&2
    echo "Expected ${PORTS_ENV}" >&2
    return 1
  fi

  value="${value:-${AUTH_PROXY_BASE_URL:-}}"
  if [[ -z "${value}" && -n "${port}" ]]; then
    value="http://127.0.0.1:${port}"
  fi
  value="${value:-http://127.0.0.1:8096}"
  value="${value%/}"
  if [[ ! "${value}" =~ ^http://127\.0\.0\.1:[0-9]{2,5}$ ]]; then
    echo "ERROR: invalid local auth-proxy base URL: ${value}" >&2
    return 1
  fi
  printf '%s\n' "${value}"
}

callback_base_url="$(resolve_auth_proxy_base_url)"
if [[ "${1:-}" == '--print-url' ]]; then
  printf '%s\n' "${callback_base_url}"
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "Unknown argument: $1" >&2
  exit 1
fi

KC=(kubectl --context="${PROFILE}")

patch_config() {
  local namespace="$1"
  local configmap="$2"
  local deployment="$3"
  local key="$4"
  local current
  current="$("${KC[@]}" -n "${namespace}" get configmap "${configmap}" \
    -o "jsonpath={.data.${key}}")"
  if [[ "${current%/}" == "${callback_base_url}" ]]; then
    return 0
  fi
  "${KC[@]}" -n "${namespace}" patch configmap "${configmap}" --type merge \
    --patch "{\"data\":{\"${key}\":\"${callback_base_url}\"}}" >/dev/null
  "${KC[@]}" -n "${namespace}" rollout restart "deployment/${deployment}" >/dev/null
}

patch_config control-plane control-api-config control-api CONTROL_API_OAUTH_CALLBACK_BASE_URL
patch_config rpc-proxy rpc-proxy-config rpc-proxy RPC_PROXY_OAUTH_CALLBACK_BASE_URL

printf 'OAuth callback base synchronized to %s for %s\n' "${callback_base_url}" "${PROFILE}"
