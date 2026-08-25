#!/usr/bin/env bash
# Isolate local Minikube image operations from ambient Docker credentials.
# Source this file, call docker_cli_env_prepare with `probe`, `pull`, or `build`,
# and install a caller-owned EXIT trap that invokes docker_cli_env_cleanup.

if [[ -n "${DOCKER_CLI_ENV_LOADED:-}" ]]; then
  return 0
fi
DOCKER_CLI_ENV_LOADED=true

DOCKER_CLI_ENV_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DOCKER_CLI_DEADLINE_RUNNER="${DOCKER_CLI_ENV_DIR}/run-with-deadline.mjs"
DOCKER_CLI_TASK_CONFIG=""
DOCKER_CLI_AUTH_CONFIG=""
DOCKER_CLI_PINNED_HOST=""
DOCKER_CLI_ENDPOINT_SOURCE=""
DOCKER_CLI_ORIGINAL_EXPECTED_MINIKUBE_IP_SET="${DOCKER_CLI_EXPECTED_MINIKUBE_IP+x}"
DOCKER_CLI_ORIGINAL_EXPECTED_MINIKUBE_IP="${DOCKER_CLI_EXPECTED_MINIKUBE_IP-}"
DOCKER_CLI_EXPECTED_MINIKUBE_IP="${DOCKER_CLI_EXPECTED_MINIKUBE_IP:-}"
DOCKER_CLI_ORIGINAL_EXPECTED_MINIKUBE_ENDPOINT_SET="${DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT+x}"
DOCKER_CLI_ORIGINAL_EXPECTED_MINIKUBE_ENDPOINT="${DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT-}"
DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT="${DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT:-}"
DOCKER_CLI_ORIGINAL_CONFIG_SET="${DOCKER_CONFIG+x}"
DOCKER_CLI_ORIGINAL_CONFIG="${DOCKER_CONFIG-}"
DOCKER_CLI_ORIGINAL_AUTH_SET="${DOCKER_AUTH_CONFIG+x}"
DOCKER_CLI_ORIGINAL_AUTH="${DOCKER_AUTH_CONFIG-}"
DOCKER_CLI_ORIGINAL_CONTEXT_SET="${DOCKER_CONTEXT+x}"
DOCKER_CLI_ORIGINAL_CONTEXT="${DOCKER_CONTEXT-}"
DOCKER_CLI_ORIGINAL_HOST_SET="${DOCKER_HOST+x}"
DOCKER_CLI_ORIGINAL_HOST="${DOCKER_HOST-}"
DOCKER_CLI_ORIGINAL_TLS_SET="${DOCKER_TLS+x}"
DOCKER_CLI_ORIGINAL_TLS="${DOCKER_TLS-}"
DOCKER_CLI_ORIGINAL_TLS_VERIFY_SET="${DOCKER_TLS_VERIFY+x}"
DOCKER_CLI_ORIGINAL_TLS_VERIFY="${DOCKER_TLS_VERIFY-}"
DOCKER_CLI_ORIGINAL_CERT_PATH_SET="${DOCKER_CERT_PATH+x}"
DOCKER_CLI_ORIGINAL_CERT_PATH="${DOCKER_CERT_PATH-}"
DOCKER_CLI_ORIGINAL_API_VERSION_SET="${DOCKER_API_VERSION+x}"
DOCKER_CLI_ORIGINAL_API_VERSION="${DOCKER_API_VERSION-}"
DOCKER_CLI_ORIGINAL_CUSTOM_HEADERS_SET="${DOCKER_CUSTOM_HEADERS+x}"
DOCKER_CLI_ORIGINAL_CUSTOM_HEADERS="${DOCKER_CUSTOM_HEADERS-}"
DOCKER_CLI_ORIGINAL_MINIKUBE_ACTIVE_SET="${MINIKUBE_ACTIVE_DOCKERD+x}"
DOCKER_CLI_ORIGINAL_MINIKUBE_ACTIVE="${MINIKUBE_ACTIVE_DOCKERD-}"

MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS:-30}"
MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS:-600}"
MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS:-1800}"
MINIKUBE_DOCKER_HEARTBEAT_SECONDS="${MINIKUBE_DOCKER_HEARTBEAT_SECONDS:-20}"
MINIKUBE_DOCKER_KILL_GRACE_SECONDS="${MINIKUBE_DOCKER_KILL_GRACE_SECONDS:-5}"
MINIKUBE_DOCKER_START_PROBE_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_START_PROBE_TIMEOUT_SECONDS:-5}"
MINIKUBE_DOCKER_START_TIMEOUT_SECONDS="${MINIKUBE_DOCKER_START_TIMEOUT_SECONDS:-60}"
MINIKUBE_DOCKER_START_POLL_SECONDS="${MINIKUBE_DOCKER_START_POLL_SECONDS:-2}"

docker_cli_env_error() {
  printf '%s\n' "$*" >&2
}

docker_cli_env_validate_seconds() {
  local name="$1" value="$2" maximum="$3"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]] || (( value > maximum )); then
    docker_cli_env_error "DOCKER_DEADLINE_INVALID: ${name} must be an integer from 1 to ${maximum}"
    return 2
  fi
}

docker_cli_env_validate_deadlines() {
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" 300 || return $?
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS "$MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS" 3600 || return $?
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS "$MINIKUBE_DOCKER_BUILD_TIMEOUT_SECONDS" 7200 || return $?
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_HEARTBEAT_SECONDS "$MINIKUBE_DOCKER_HEARTBEAT_SECONDS" 300 || return $?
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_KILL_GRACE_SECONDS "$MINIKUBE_DOCKER_KILL_GRACE_SECONDS" 30 || return $?
}

docker_cli_env_validate_startup_deadlines() {
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_START_PROBE_TIMEOUT_SECONDS \
    "$MINIKUBE_DOCKER_START_PROBE_TIMEOUT_SECONDS" 60 || return $?
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_START_TIMEOUT_SECONDS \
    "$MINIKUBE_DOCKER_START_TIMEOUT_SECONDS" 600 || return $?
  docker_cli_env_validate_seconds MINIKUBE_DOCKER_START_POLL_SECONDS \
    "$MINIKUBE_DOCKER_START_POLL_SECONDS" 30 || return $?
}

docker_cli_env_validate_local_endpoint() {
  local endpoint="$1" port=""
  case "$endpoint" in
    unix:///*)
      # Unix sockets always terminate on this machine. Require an absolute,
      # single-line path so a malformed context cannot be reinterpreted by the
      # Docker CLI after it is pinned into DOCKER_HOST.
      [[ "$endpoint" != *$'\n'* && "$endpoint" != *$'\r'* \
        && "$endpoint" != *'?'* && "$endpoint" != *'#'* \
        && "$endpoint" != "unix:///" ]] || {
        docker_cli_env_error "DOCKER_ENDPOINT_UNSAFE: the resolved Unix endpoint is malformed"
        return 1
      }
      ;;
    tcp://*)
      if [[ "$endpoint" =~ ^tcp://(localhost|127\.0\.0\.1):([1-9][0-9]*)$ ]]; then
        port="${BASH_REMATCH[2]}"
      elif [[ "$endpoint" =~ ^tcp://\[::1\]:([1-9][0-9]*)$ ]]; then
        port="${BASH_REMATCH[1]}"
      else
        docker_cli_env_error "DOCKER_ENDPOINT_UNSAFE: refusing a non-loopback or malformed TCP endpoint"
        return 1
      fi
      if ! [[ "$port" =~ ^[1-9][0-9]*$ ]] || (( port > 65535 )); then
        docker_cli_env_error "DOCKER_ENDPOINT_UNSAFE: the resolved loopback endpoint has an invalid port"
        return 1
      fi
      ;;
    npipe:////./pipe/docker_engine)
      [[ "${OS:-}" == Windows_NT ]] || {
        docker_cli_env_error "DOCKER_ENDPOINT_UNSAFE: a Windows named pipe is not local on this host"
        return 1
      }
      ;;
    *)
      docker_cli_env_error "DOCKER_ENDPOINT_UNSAFE: refusing a remote or ambiguous Docker endpoint"
      return 1
      ;;
  esac
}

docker_cli_env_validate_minikube_endpoint() {
  local endpoint="$1" expected_ip="${2:-}" octet
  local -a octets=()
  if [[ -n "${DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT:-}" ]]; then
    [[ "$endpoint" == "$DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT" ]] || {
      docker_cli_env_error "DOCKER_ENDPOINT_MISMATCH: Docker endpoint is not owned by the selected Minikube profile"
      return 1
    }
    if docker_cli_env_validate_local_endpoint "$endpoint" >/dev/null 2>&1; then
      return 0
    fi
    [[ -n "$expected_ip" ]] || {
      docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the expected Minikube IP is unavailable for a non-loopback endpoint"
      return 1
    }
  fi
  IFS=. read -r -a octets <<<"$expected_ip"
  [[ "${#octets[@]}" -eq 4 ]] || {
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the expected Minikube IP is invalid"
    return 1
  }
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && (( 10#$octet <= 255 )) || {
      docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the expected Minikube IP is invalid"
      return 1
    }
  done
  if [[ -n "${DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT:-}" ]]; then
    case "$endpoint" in
      "tcp://${expected_ip}:2375"|"tcp://${expected_ip}:2376")
        return 0
        ;;
      *)
        docker_cli_env_error "DOCKER_ENDPOINT_UNSAFE: the selected Minikube Docker endpoint is not local"
        return 1
        ;;
    esac
  fi
  case "$endpoint" in
    "tcp://${expected_ip}:2375"|"tcp://${expected_ip}:2376")
      return 0
      ;;
    *)
      docker_cli_env_error "DOCKER_ENDPOINT_MISMATCH: Docker endpoint is not owned by the selected Minikube profile"
      return 1
      ;;
  esac
}

docker_cli_env_endpoint_from_minikube_env() {
  local env_script="$1" endpoint_line endpoint count
  endpoint_line="$(printf '%s\n' "$env_script" | awk '$1 == "export" && $2 ~ /^DOCKER_HOST=/ { print $2 }')"
  count="$(printf '%s\n' "$endpoint_line" | awk 'NF { count++ } END { print count + 0 }')"
  [[ "$count" == 1 ]] || {
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: minikube docker-env did not expose exactly one DOCKER_HOST"
    return 1
  }
  endpoint="${endpoint_line#DOCKER_HOST=}"
  endpoint="${endpoint%;}"
  endpoint="${endpoint#\"}"
  endpoint="${endpoint%\"}"
  endpoint="${endpoint#\'}"
  endpoint="${endpoint%\'}"
  [[ -n "$endpoint" ]] || {
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: minikube docker-env returned an empty DOCKER_HOST"
    return 1
  }
  printf '%s\n' "$endpoint"
}

docker_cli_env_resolve_context_endpoint() {
  local record="" status=0 context_host="" skip_tls="" tls_material=""

  # Context inspection is metadata-only and happens before DOCKER_CONFIG is
  # replaced. DOCKER_AUTH_CONFIG and custom headers are excluded even here so
  # endpoint discovery cannot consult registry auth or carry ambient headers.
  record="$({
    unset DOCKER_AUTH_CONFIG DOCKER_CUSTOM_HEADERS
    node "$DOCKER_CLI_DEADLINE_RUNNER" \
      --timeout-seconds "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" \
      --heartbeat-seconds "$MINIKUBE_DOCKER_HEARTBEAT_SECONDS" \
      --kill-grace-seconds "$MINIKUBE_DOCKER_KILL_GRACE_SECONDS" \
      --label docker-endpoint-resolve -- \
      docker context inspect \
        --format '{{.Endpoints.docker.Host}}{{"\t"}}{{.Endpoints.docker.SkipTLSVerify}}{{"\t"}}{{json .TLSMaterial}}'
  })" || status=$?
  if [[ "$status" -ne 0 ]]; then
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: could not resolve the active Docker context"
    return "$status"
  fi
  if [[ -z "$record" || "$record" == *$'\n'* ]]; then
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the active Docker context did not resolve exactly one endpoint"
    return 1
  fi

  IFS=$'\t' read -r context_host skip_tls tls_material <<<"$record"
  [[ -n "$context_host" && -n "$skip_tls" && -n "$tls_material" ]] || {
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the active Docker context metadata is incomplete"
    return 1
  }
  case "$skip_tls" in
    true|false) ;;
    *)
      docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the active Docker context TLS metadata is invalid"
      return 1
      ;;
  esac

  docker_cli_env_validate_local_endpoint "$context_host" || return $?
  if [[ "$context_host" == tcp://* ]] \
    && { [[ "$skip_tls" == true ]] || [[ "$tls_material" != '{}' && "$tls_material" != null ]]; }; then
    docker_cli_env_error "DOCKER_ENDPOINT_UNSAFE: a config-only loopback TLS context cannot be isolated safely"
    return 1
  fi

  DOCKER_CLI_PINNED_HOST="$context_host"
  DOCKER_CLI_ENDPOINT_SOURCE=context
}

docker_cli_env_resolve_endpoint() {
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    if [[ -n "${DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT:-}" || -n "${DOCKER_CLI_EXPECTED_MINIKUBE_IP:-}" ]]; then
      docker_cli_env_validate_minikube_endpoint "$DOCKER_HOST" "${DOCKER_CLI_EXPECTED_MINIKUBE_IP:-}" || return $?
      DOCKER_CLI_PINNED_HOST="$DOCKER_HOST"
      DOCKER_CLI_ENDPOINT_SOURCE=minikube
      return 0
    fi
    docker_cli_env_validate_local_endpoint "$DOCKER_HOST" || return $?
    DOCKER_CLI_PINNED_HOST="$DOCKER_HOST"
    DOCKER_CLI_ENDPOINT_SOURCE=explicit_host
    return 0
  fi
  if [[ -n "${DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT:-}" ]]; then
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the selected Minikube Docker endpoint is not present"
    return 1
  fi
  docker_cli_env_resolve_context_endpoint
}

docker_cli_env_apply_pinned_endpoint() {
  [[ -n "$DOCKER_CLI_PINNED_HOST" ]] || {
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: no approved local Docker endpoint was resolved"
    return 1
  }

  # DOCKER_HOST intentionally wins after this point. Clearing DOCKER_CONTEXT
  # removes both its documented precedence and any dependency on context files
  # that are absent from the isolated task/private configs.
  export DOCKER_HOST="$DOCKER_CLI_PINNED_HOST"
  unset DOCKER_CONTEXT 2>/dev/null || true
  if [[ "$DOCKER_CLI_ENDPOINT_SOURCE" == context ]]; then
    # Context-derived local/rootless Unix endpoints do not use ambient TLS.
    # Loopback context endpoints with TLS were rejected during resolution.
    unset DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH 2>/dev/null || true
  fi
}

docker_cli_env_find_buildx() {
  local explicit="${MINIKUBE_DOCKER_BUILDX_PLUGIN:-}"
  local candidate
  if [[ -n "$explicit" ]]; then
    if [[ ! -f "$explicit" || ! -x "$explicit" ]]; then
      docker_cli_env_error "DOCKER_BUILDX_REQUIRED: the explicitly configured buildx plugin is not executable"
      return 1
    fi
    printf '%s\n' "$explicit"
    return 0
  fi

  # Docker Desktop and the official Linux packages install buildx in one of
  # these CLI-owned locations. User Docker config directories are deliberately
  # excluded because they sit beside ambient auth and credential-helper state.
  for candidate in \
    /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx \
    /usr/local/lib/docker/cli-plugins/docker-buildx \
    /opt/homebrew/lib/docker/cli-plugins/docker-buildx \
    /usr/libexec/docker/cli-plugins/docker-buildx \
    /usr/lib/docker/cli-plugins/docker-buildx; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

docker_cli_run_with_config() {
  local config="$1" label="$2" timeout_seconds="$3"
  shift 3
  if [[ "$DOCKER_CLI_ENDPOINT_SOURCE" == minikube ]]; then
    [[ -n "${DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT:-}" || -n "${DOCKER_CLI_EXPECTED_MINIKUBE_IP:-}" ]] || {
      docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the Minikube endpoint has no expected profile identity"
      return 1
    }
    docker_cli_env_validate_minikube_endpoint "${DOCKER_HOST:-}" "${DOCKER_CLI_EXPECTED_MINIKUBE_IP:-}" || return $?
  else
    docker_cli_env_validate_local_endpoint "${DOCKER_HOST:-}" || return $?
  fi
  (
    # This override intentionally belongs only to the child operation.
    # shellcheck disable=SC2030
    export DOCKER_CONFIG="$config"
    unset DOCKER_AUTH_CONFIG DOCKER_CONTEXT DOCKER_CUSTOM_HEADERS
    node "$DOCKER_CLI_DEADLINE_RUNNER" \
      --timeout-seconds "$timeout_seconds" \
      --heartbeat-seconds "$MINIKUBE_DOCKER_HEARTBEAT_SECONDS" \
      --kill-grace-seconds "$MINIKUBE_DOCKER_KILL_GRACE_SECONDS" \
      --label "$label" -- "$@"
  )
}

docker_cli_env_verify_pinned_endpoint() {
  local effective_host="" status=0
  effective_host="$(
    docker_cli_run_with_config "$DOCKER_CLI_TASK_CONFIG" docker-endpoint-verify \
      "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" \
      docker context inspect --format '{{.Endpoints.docker.Host}}' default
  )" || status=$?
  if [[ "$status" -ne 0 ]]; then
    docker_cli_env_error "DOCKER_ENDPOINT_REQUIRED: the isolated Docker config could not verify its endpoint"
    return "$status"
  fi
  if [[ "$effective_host" != "$DOCKER_CLI_PINNED_HOST" ]]; then
    docker_cli_env_error "DOCKER_ENDPOINT_MISMATCH: the isolated Docker config selected a different endpoint"
    return 1
  fi
}

docker_cli_run_public() {
  local label="$1" timeout_seconds="$2"
  shift 2
  if [[ -z "$DOCKER_CLI_TASK_CONFIG" || ! -d "$DOCKER_CLI_TASK_CONFIG" ]]; then
    docker_cli_env_error "DOCKER_CONFIG_REQUIRED: docker_cli_env_prepare must run before Docker operations"
    return 1
  fi
  docker_cli_run_with_config "$DOCKER_CLI_TASK_CONFIG" "$label" "$timeout_seconds" "$@"
}

docker_cli_env_require_auth_config() {
  local requested="${MINIKUBE_DOCKER_AUTH_CONFIG:-}"
  if [[ -z "$requested" ]]; then
    docker_cli_env_error "REGISTRY_AUTH_REQUIRED: set MINIKUBE_DOCKER_AUTH_CONFIG to an explicit Docker config directory"
    return 1
  fi
  if [[ ! -d "$requested" || ! -f "$requested/config.json" || ! -r "$requested/config.json" ]]; then
    docker_cli_env_error "REGISTRY_AUTH_REQUIRED: the explicit Docker config directory is not readable"
    return 1
  fi
  DOCKER_CLI_AUTH_CONFIG="$(cd -- "$requested" && pwd -P)" || {
    docker_cli_env_error "REGISTRY_AUTH_REQUIRED: the explicit Docker config directory cannot be resolved"
    return 1
  }
}

docker_cli_run_private() {
  local label="$1" timeout_seconds="$2"
  shift 2
  docker_cli_env_require_auth_config || return $?
  docker_cli_run_with_config "$DOCKER_CLI_AUTH_CONFIG" "$label" "$timeout_seconds" "$@"
}

docker_cli_env_prepare() {
  local mode="${1:-build}"
  local temp_root old_umask buildx_path="" buildx_status=0
  if [[ -n "$DOCKER_CLI_TASK_CONFIG" && -d "$DOCKER_CLI_TASK_CONFIG" ]]; then
    return 0
  fi
  case "$mode" in
    probe|pull|build) ;;
    *)
      docker_cli_env_error "DOCKER_MODE_REQUIRED: mode must be probe, pull, or build"
      return 2
      ;;
  esac

  command -v node >/dev/null 2>&1 || {
    docker_cli_env_error "DOCKER_DEADLINE_REQUIRED: node is required for bounded Docker operations"
    return 1
  }
  command -v docker >/dev/null 2>&1 || {
    docker_cli_env_error "DOCKER_CLI_REQUIRED: docker is not installed"
    return 1
  }
  [[ -f "$DOCKER_CLI_DEADLINE_RUNNER" ]] || {
    docker_cli_env_error "DOCKER_DEADLINE_REQUIRED: the deadline runner is missing"
    return 1
  }
  if [[ "$mode" == pull || "$mode" == build ]]; then
    docker_cli_env_validate_deadlines || return $?
  else
    docker_cli_env_validate_seconds MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS \
      "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" 300 || return $?
    docker_cli_env_validate_seconds MINIKUBE_DOCKER_HEARTBEAT_SECONDS \
      "$MINIKUBE_DOCKER_HEARTBEAT_SECONDS" 300 || return $?
    docker_cli_env_validate_seconds MINIKUBE_DOCKER_KILL_GRACE_SECONDS \
      "$MINIKUBE_DOCKER_KILL_GRACE_SECONDS" 30 || return $?
  fi

  # Resolve while the caller's context metadata is still available, then pin
  # the approved local endpoint before replacing the Docker configuration.
  docker_cli_env_resolve_endpoint || return $?

  temp_root="${TMPDIR:-/tmp}"
  [[ -d "$temp_root" ]] || {
    docker_cli_env_error "DOCKER_CONFIG_REQUIRED: the temporary directory is unavailable"
    return 1
  }
  old_umask="$(umask)"
  umask 077
  DOCKER_CLI_TASK_CONFIG="$(mktemp -d "${temp_root%/}/evenfire-minikube-docker.XXXXXX")" || {
    umask "$old_umask"
    docker_cli_env_error "DOCKER_CONFIG_REQUIRED: could not create the isolated Docker config"
    return 1
  }
  mkdir -p "$DOCKER_CLI_TASK_CONFIG/cli-plugins"
  printf '{}\n' >"$DOCKER_CLI_TASK_CONFIG/config.json"
  chmod 700 "$DOCKER_CLI_TASK_CONFIG" "$DOCKER_CLI_TASK_CONFIG/cli-plugins"
  chmod 600 "$DOCKER_CLI_TASK_CONFIG/config.json"
  umask "$old_umask"

  docker_cli_env_apply_pinned_endpoint || return $?
  # The task config must also become the caller's active config.
  # shellcheck disable=SC2031
  export DOCKER_CONFIG="$DOCKER_CLI_TASK_CONFIG"
  unset DOCKER_AUTH_CONFIG 2>/dev/null || true
  docker_cli_env_verify_pinned_endpoint || return $?

  if [[ "$mode" != build ]]; then
    return 0
  fi

  if [[ -n "${MINIKUBE_DOCKER_BUILDX_PLUGIN:-}" ]]; then
    buildx_path="$(docker_cli_env_find_buildx)" || return $?
    ln -s "$buildx_path" "$DOCKER_CLI_TASK_CONFIG/cli-plugins/docker-buildx"
  elif buildx_path="$(docker_cli_env_find_buildx)"; then
    ln -s "$buildx_path" "$DOCKER_CLI_TASK_CONFIG/cli-plugins/docker-buildx"
  fi

  # A system-integrated plugin may work even when no explicit file candidate
  # was found. Validate through the isolated config and never download a plugin.
  docker_cli_run_public buildx-version "$MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS" \
    docker buildx version >/dev/null 2>&1 || buildx_status=$?
  if [[ "$buildx_status" -ne 0 ]]; then
    docker_cli_env_error "DOCKER_BUILDX_REQUIRED: no usable installed buildx plugin was found"
    return "$buildx_status"
  fi
}

docker_cli_wait_for_info() {
  docker_cli_env_validate_startup_deadlines || return $?

  # The literal script is intentional: poll_seconds is positional data passed
  # to the child shell, while the outer deadline owns the whole process group.
  # shellcheck disable=SC2016
  docker_cli_run_public docker-info-startup-wait "$MINIKUBE_DOCKER_START_TIMEOUT_SECONDS" \
    bash -c '
      poll_seconds="$1"
      while ! docker info >/dev/null 2>&1; do
        sleep "$poll_seconds"
      done
    ' _ "$MINIKUBE_DOCKER_START_POLL_SECONDS"
}

docker_cli_env_cleanup() {
  local task_config="$DOCKER_CLI_TASK_CONFIG" cleanup_status=0
  DOCKER_CLI_TASK_CONFIG=""
  DOCKER_CLI_AUTH_CONFIG=""
  DOCKER_CLI_PINNED_HOST=""
  DOCKER_CLI_ENDPOINT_SOURCE=""

  if [[ -n "$task_config" ]]; then
    case "${task_config##*/}" in
      evenfire-minikube-docker.*)
        if [[ -d "$task_config" && ! -L "$task_config" ]]; then
          rm -rf -- "$task_config" || cleanup_status=$?
        fi
        ;;
      *)
        docker_cli_env_error "DOCKER_CONFIG_CLEANUP_REFUSED: unexpected task config path"
        cleanup_status=1
        ;;
    esac
  fi

  docker_cli_env_restore_variable DOCKER_CONFIG "$DOCKER_CLI_ORIGINAL_CONFIG_SET" "$DOCKER_CLI_ORIGINAL_CONFIG"
  docker_cli_env_restore_variable DOCKER_AUTH_CONFIG "$DOCKER_CLI_ORIGINAL_AUTH_SET" "$DOCKER_CLI_ORIGINAL_AUTH"
  docker_cli_env_restore_variable DOCKER_CONTEXT "$DOCKER_CLI_ORIGINAL_CONTEXT_SET" "$DOCKER_CLI_ORIGINAL_CONTEXT"
  docker_cli_env_restore_variable DOCKER_HOST "$DOCKER_CLI_ORIGINAL_HOST_SET" "$DOCKER_CLI_ORIGINAL_HOST"
  docker_cli_env_restore_variable DOCKER_TLS "$DOCKER_CLI_ORIGINAL_TLS_SET" "$DOCKER_CLI_ORIGINAL_TLS"
  docker_cli_env_restore_variable DOCKER_TLS_VERIFY "$DOCKER_CLI_ORIGINAL_TLS_VERIFY_SET" "$DOCKER_CLI_ORIGINAL_TLS_VERIFY"
  docker_cli_env_restore_variable DOCKER_CERT_PATH "$DOCKER_CLI_ORIGINAL_CERT_PATH_SET" "$DOCKER_CLI_ORIGINAL_CERT_PATH"
  docker_cli_env_restore_variable DOCKER_API_VERSION "$DOCKER_CLI_ORIGINAL_API_VERSION_SET" "$DOCKER_CLI_ORIGINAL_API_VERSION"
  docker_cli_env_restore_variable DOCKER_CUSTOM_HEADERS "$DOCKER_CLI_ORIGINAL_CUSTOM_HEADERS_SET" "$DOCKER_CLI_ORIGINAL_CUSTOM_HEADERS"
  docker_cli_env_restore_variable MINIKUBE_ACTIVE_DOCKERD "$DOCKER_CLI_ORIGINAL_MINIKUBE_ACTIVE_SET" "$DOCKER_CLI_ORIGINAL_MINIKUBE_ACTIVE"
  docker_cli_env_restore_variable DOCKER_CLI_EXPECTED_MINIKUBE_IP \
    "$DOCKER_CLI_ORIGINAL_EXPECTED_MINIKUBE_IP_SET" "$DOCKER_CLI_ORIGINAL_EXPECTED_MINIKUBE_IP"
  docker_cli_env_restore_variable DOCKER_CLI_EXPECTED_MINIKUBE_ENDPOINT \
    "$DOCKER_CLI_ORIGINAL_EXPECTED_MINIKUBE_ENDPOINT_SET" "$DOCKER_CLI_ORIGINAL_EXPECTED_MINIKUBE_ENDPOINT"
  return "$cleanup_status"
}

docker_cli_env_restore_variable() {
  local name="$1" was_set="$2" value="$3"
  if [[ "$was_set" == x ]]; then
    printf -v "$name" '%s' "$value"
    export "${name?}"
  else
    unset "$name" 2>/dev/null || true
  fi
}

docker_cli_env_main_cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT HUP QUIT INT TERM
  docker_cli_env_cleanup || cleanup_status=$?
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status="$cleanup_status"
  fi
  exit "$status"
}

docker_cli_env_main() {
  if [[ "$#" -ne 1 ]]; then
    docker_cli_env_error "usage: ${0##*/} --check-info | --wait-for-info"
    return 2
  fi

  # Startup probes do not build images, so requiring buildx here would delay or
  # block Docker Desktop startup for an unrelated plugin. They still use the
  # same empty task-local config and process-group deadline runner.
  docker_cli_env_prepare probe || return $?
  docker_cli_env_validate_startup_deadlines || return $?
  case "$1" in
    --check-info)
      docker_cli_run_public docker-info-startup-probe \
        "$MINIKUBE_DOCKER_START_PROBE_TIMEOUT_SECONDS" docker info >/dev/null
      ;;
    --wait-for-info)
      docker_cli_wait_for_info
      ;;
    *)
      docker_cli_env_error "usage: ${0##*/} --check-info | --wait-for-info"
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  trap docker_cli_env_main_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 131' QUIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  docker_cli_env_main "$@"
fi
