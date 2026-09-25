#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-info}"
HOST="${HOST:-127.0.0.1}"
CACHE_ROOT="${CACHE_ROOT:-${HOME}/.cache/clerum/minikube-profiles}"
MINIKUBE_MEMORY="${MINIKUBE_MEMORY:-10240}"
MINIKUBE_CPUS="${MINIKUBE_CPUS:-6}"
MINIKUBE_CNI="${MINIKUBE_CNI:-calico}"
MINIKUBE_DRIVER="${MINIKUBE_DRIVER:-docker}"
CONFIRM_DELETE="${CONFIRM_DELETE:-}"
CONFIRM_PROFILE="${CONFIRM_PROFILE:-}"
ARGS="${ARGS:-}"
BRANCH_PROFILE_PROFILE="${BRANCH_PROFILE_PROFILE:-}"
MINIKUBE_PROFILE_SELECTION="${MINIKUBE_PROFILE:-}"
KUBECTL_REQUEST_TIMEOUT="${BRANCH_PROFILE_KUBECTL_REQUEST_TIMEOUT:-10s}"
MINIKUBE_STATUS_TIMEOUT_SECONDS="${BRANCH_PROFILE_MINIKUBE_STATUS_TIMEOUT_SECONDS:-60}"
MINIKUBE_START_TIMEOUT_SECONDS="${BRANCH_PROFILE_MINIKUBE_START_TIMEOUT_SECONDS:-900}"
MINIKUBE_STOP_TIMEOUT_SECONDS="${BRANCH_PROFILE_MINIKUBE_STOP_TIMEOUT_SECONDS:-180}"
MINIKUBE_DELETE_TIMEOUT_SECONDS="${BRANCH_PROFILE_MINIKUBE_DELETE_TIMEOUT_SECONDS:-300}"
EXPLICIT_PROFILE=""

PROFILE_EXISTS=false
PROFILE_SCHEMA_VERSION=2
PROFILE_STATE=prospective-v2
STATE_LOCK_DIR=""
STATE_TEMP_PROFILE=""
STATE_TEMP_PORTS=""
STATE_NEW_CACHE_DIR=false
PORT_FORWARD_OWNER_LOADED=false

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local missing=()
  local bin
  for bin in "$@"; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      missing+=("${bin}")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    printf 'ERROR: missing required command(s): %s\n' "${missing[*]}" >&2
    exit 1
  fi
}

validate_seconds() {
  local name="$1" value="$2" maximum="$3"
  [[ "${value}" =~ ^[1-9][0-9]*$ && "${value}" -le "${maximum}" ]] ||
    die "${name} must be an integer from 1 to ${maximum}"
}

run_bounded() {
  local label="$1" timeout_seconds="$2"
  shift 2
  [[ -f "${DEADLINE_RUNNER}" && -r "${DEADLINE_RUNNER}" && ! -L "${DEADLINE_RUNNER}" ]] ||
    die "bounded process runner is unavailable: ${DEADLINE_RUNNER}"
  node "${DEADLINE_RUNNER}" \
    --timeout-seconds "${timeout_seconds}" \
    --heartbeat-seconds 20 --kill-grace-seconds 5 \
    --label "branch-profile-${label}" -- "$@"
}

record_value() {
  local payload="$1" key="$2"
  awk -F= -v wanted="${key}" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' \
    <<<"${payload}"
}

file_value() {
  local file="$1" key="$2"
  awk -F= -v wanted="${key}" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' \
    "${file}" 2>/dev/null || true
}

validate_host() {
  case "${HOST}" in
    127.0.0.1|localhost) URL_HOST="${HOST}" ;;
    ::1|\[::1\])
      HOST=::1
      URL_HOST='[::1]'
      ;;
    *) die "HOST must be a loopback address, got: ${HOST}" ;;
  esac
}

normalize_cache_root() {
  [[ -n "${CACHE_ROOT}" && "${CACHE_ROOT}" != / ]] || die 'CACHE_ROOT must be a scoped directory'
  [[ "${CACHE_ROOT}" != *$'\n'* && "${CACHE_ROOT}" != *$'\r'* && "${CACHE_ROOT}" != *$'\t'* ]] ||
    die 'CACHE_ROOT contains a control character'
  if [[ "${CACHE_ROOT}" != /* ]]; then
    CACHE_ROOT="${REPO_DIR}/${CACHE_ROOT}"
  fi
  CACHE_ROOT="${CACHE_ROOT%/}"
  if [[ -d "${CACHE_ROOT}" ]]; then
    [[ ! -L "${CACHE_ROOT}" ]] || die "CACHE_ROOT must not be a symlink: ${CACHE_ROOT}"
    CACHE_ROOT="$(cd -- "${CACHE_ROOT}" && pwd -P)"
  elif [[ -e "${CACHE_ROOT}" || -L "${CACHE_ROOT}" ]]; then
    die "CACHE_ROOT is not a directory: ${CACHE_ROOT}"
  fi
}

validate_profile_name() {
  [[ ${#PROFILE} -le 63 && "${PROFILE}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] ||
    die "resolver returned an unsafe profile name: ${PROFILE}"
  case "${PROFILE}" in
    *gke*|*prod*|*staging*|clerum-test|default|minikube)
      die "resolver returned a shared or protected profile: ${PROFILE}" ;;
  esac
}

set_profile_paths() {
  CACHE_DIR="${CACHE_ROOT}/${PROFILE}"
  PIDS_DIR="${CACHE_DIR}/pids"
  LOGS_DIR="${CACHE_DIR}/logs"
  SHIMS_DIR="${CACHE_DIR}/scripts/minikube"
  DEPLOY_SHIM_DIR="${CACHE_DIR}/deploy"
  SHIM_ENV="${CACHE_DIR}/shims.env"
  PROFILE_ENV="${CACHE_DIR}/profile.env"
  PORTS_ENV="${CACHE_DIR}/ports.env"
}

assign_generated_ports() {
  local hash_hex
  hash_hex="$(printf '%s' "${PROFILE}" | shasum | awk '{print substr($1,1,8)}' | tr '[:lower:]' '[:upper:]')"
  [[ "${hash_hex}" =~ ^[0-9A-F]{8}$ ]] || die 'unable to derive the stable port allocation'
  PORT_BASE=$((20000 + (16#${hash_hex} % 19000)))
  CONTROL_UI_PORT=$((PORT_BASE + 0))
  PROFILE_UI_PORT=$((PORT_BASE + 1))
  MCP_HOST_PORT=$((PORT_BASE + 80))
  REGISTRY_API_PORT=$((PORT_BASE + 85))
  CONTROL_API_PORT=$((PORT_BASE + 90))
  EXTERNAL_REST_API_PORT=$((PORT_BASE + 91))
  MEMBER_REGISTRATION_SERVICE_PORT=$((PORT_BASE + 92))
  RPC_PROXY_PORT=$((PORT_BASE + 94))
  WORKFLOW_APPROVAL_READER_PORT=$((PORT_BASE + 98))
  CONTROL_UI_URL="http://${URL_HOST}:${CONTROL_UI_PORT}"
  PROFILE_UI_URL="http://${URL_HOST}:${PROFILE_UI_PORT}"
  PROFILE_UI_BASE_URL="${PROFILE_UI_URL}"
  CONTROL_API_URL="http://${URL_HOST}:${CONTROL_API_PORT}"
  EXTERNAL_REST_API_URL="http://${URL_HOST}:${EXTERNAL_REST_API_PORT}"
  MEMBER_REGISTRATION_SERVICE_URL="http://${URL_HOST}:${MEMBER_REGISTRATION_SERVICE_PORT}"
  RPC_PROXY_URL="http://${URL_HOST}:${RPC_PROXY_PORT}"
  REGISTRY_API_URL="http://${URL_HOST}:${REGISTRY_API_PORT}"
  WORKFLOW_APPROVAL_READER_URL="http://${URL_HOST}:${WORKFLOW_APPROVAL_READER_PORT}"
  MCP_HOST_URL="http://${URL_HOST}:${MCP_HOST_PORT}"
}

load_validated_ports() {
  local expected actual key offset url_key port_key expected_url
  local -a port_specs=(
    CONTROL_UI_PORT:0
    PROFILE_UI_PORT:1
    MCP_HOST_PORT:80
    REGISTRY_API_PORT:85
    CONTROL_API_PORT:90
    EXTERNAL_REST_API_PORT:91
    MEMBER_REGISTRATION_SERVICE_PORT:92
    RPC_PROXY_PORT:94
    WORKFLOW_APPROVAL_READER_PORT:98
  )
  local -a url_specs=(
    CONTROL_UI_URL:CONTROL_UI_PORT
    PROFILE_UI_URL:PROFILE_UI_PORT
    PROFILE_UI_BASE_URL:PROFILE_UI_PORT
    CONTROL_API_URL:CONTROL_API_PORT
    EXTERNAL_REST_API_URL:EXTERNAL_REST_API_PORT
    MEMBER_REGISTRATION_SERVICE_URL:MEMBER_REGISTRATION_SERVICE_PORT
    RPC_PROXY_URL:RPC_PROXY_PORT
    REGISTRY_API_URL:REGISTRY_API_PORT
    WORKFLOW_APPROVAL_READER_URL:WORKFLOW_APPROVAL_READER_PORT
    MCP_HOST_URL:MCP_HOST_PORT
  )

  PORT_BASE="$(file_value "${PORTS_ENV}" PORT_BASE)"
  [[ "${PORT_BASE}" =~ ^[0-9]+$ && "${PORT_BASE}" -ge 20000 && "${PORT_BASE}" -le 38999 ]] ||
    die "PROFILE_PORTS_INVALID: invalid PORT_BASE in ${PORTS_ENV}"

  for expected in "${port_specs[@]}"; do
    key="${expected%%:*}"
    offset="${expected#*:}"
    actual="$(file_value "${PORTS_ENV}" "${key}")"
    [[ "${actual}" =~ ^[0-9]+$ && "${actual}" -eq $((PORT_BASE + offset)) ]] ||
      die "PROFILE_PORTS_INVALID: ${key} does not match PORT_BASE in ${PORTS_ENV}"
    printf -v "${key}" '%s' "${actual}"
  done

  for expected in "${url_specs[@]}"; do
    url_key="${expected%%:*}"
    port_key="${expected#*:}"
    expected_url="http://${URL_HOST}:${!port_key}"
    actual="$(file_value "${PORTS_ENV}" "${url_key}")"
    [[ "${actual}" == "${expected_url}" || "${actual}" == "${expected_url}/" ]] ||
      die "PROFILE_PORTS_INVALID: ${url_key} does not match ${port_key} and HOST in ${PORTS_ENV}"
    printf -v "${url_key}" '%s' "${actual}"
  done
}

apply_resolution() {
  local payload="$1" resolved_repo resolved_branch resolved_profile_env resolved_ports_env
  PROFILE_SCHEMA_VERSION="$(record_value "${payload}" PROFILE_SCHEMA_VERSION)"
  WORKTREE_ID="$(record_value "${payload}" WORKTREE_ID)"
  OWNER_ID="$(record_value "${payload}" OWNER_ID)"
  CREATED_HEAD="$(record_value "${payload}" CREATED_HEAD)"
  PROFILE="$(record_value "${payload}" PROFILE)"
  resolved_repo="$(record_value "${payload}" REPO_DIR)"
  resolved_branch="$(record_value "${payload}" BRANCH)"
  resolved_profile_env="$(record_value "${payload}" PROFILE_ENV)"
  resolved_ports_env="$(record_value "${payload}" PORTS_ENV)"

  [[ "${PROFILE_SCHEMA_VERSION}" == 1 || "${PROFILE_SCHEMA_VERSION}" == 2 ]] ||
    die 'resolver omitted a supported profile schema'
  [[ "${WORKTREE_ID}" =~ ^[0-9a-f]{40}$ && "${OWNER_ID}" =~ ^[0-9a-f]{40}$ ]] ||
    die 'resolver returned malformed owner identity'
  [[ "${resolved_repo}" == "${REPO_DIR}" && "${resolved_branch}" == "${BRANCH}" ]] ||
    die 'resolver returned ownership for another worktree or branch'
  validate_profile_name
  set_profile_paths
  [[ -d "${CACHE_DIR}" && ! -L "${CACHE_DIR}" ]] ||
    die "resolver selected an unsafe profile directory: ${CACHE_DIR}"
  [[ "${resolved_profile_env}" == "${PROFILE_ENV}" && "${resolved_ports_env}" == "${PORTS_ENV}" ]] ||
    die 'resolver returned profile state outside the selected profile directory'
  PROFILE_EXISTS=true
  PROFILE_STATE="existing-v${PROFILE_SCHEMA_VERSION}"
  load_validated_ports
}

resolve_profile() {
  local output status=0 identity_output
  local -a resolve_args=(
    resolve
    --repo-dir "${REPO_DIR}"
    --branch "${BRANCH}"
    --profile-root "${CACHE_ROOT}"
  )
  if [[ -n "${EXPLICIT_PROFILE}" ]]; then
    resolve_args+=(--profile "${EXPLICIT_PROFILE}")
  fi

  output="$("${PROFILE_OWNER_SCRIPT}" "${resolve_args[@]}" 2>&1)" || status=$?
  if (( status == 0 )); then
    apply_resolution "${output}"
    return 0
  fi
  if [[ -n "${EXPLICIT_PROFILE}" || ${status} -ne 3 || "${output}" != *PROFILE_NOT_FOUND:* ]]; then
    printf '%s\n' "${output}" >&2
    die 'profile ownership resolution failed closed'
  fi

  identity_output="$("${PROFILE_OWNER_SCRIPT}" identity \
    --repo-dir "${REPO_DIR}" --branch "${BRANCH}" --created-head "${HEAD}")" ||
    die 'unable to derive the stable schema-v2 profile identity'
  PROFILE_SCHEMA_VERSION="$(record_value "${identity_output}" PROFILE_SCHEMA_VERSION)"
  WORKTREE_ID="$(record_value "${identity_output}" WORKTREE_ID)"
  OWNER_ID="$(record_value "${identity_output}" OWNER_ID)"
  CREATED_HEAD="$(record_value "${identity_output}" CREATED_HEAD)"
  PROFILE="$(record_value "${identity_output}" PROFILE)"
  [[ "${PROFILE_SCHEMA_VERSION}" == 2 && "${CREATED_HEAD}" == "${HEAD}" ]] ||
    die 'stable identity output is incomplete'
  [[ "${WORKTREE_ID}" =~ ^[0-9a-f]{40}$ && "${OWNER_ID}" =~ ^[0-9a-f]{40}$ ]] ||
    die 'stable identity output is malformed'
  validate_profile_name
  set_profile_paths
  if [[ -e "${CACHE_DIR}" || -L "${CACHE_DIR}" ]]; then
    die "stable profile path already exists but was not safely resolvable: ${CACHE_DIR}"
  fi
  assign_generated_ports
}

render_ports() {
  local destination="$1"
  cat >"${destination}" <<EOF_PORTS
PORT_BASE=${PORT_BASE}
CONTROL_UI_PORT=${CONTROL_UI_PORT}
PROFILE_UI_PORT=${PROFILE_UI_PORT}
CONTROL_API_PORT=${CONTROL_API_PORT}
EXTERNAL_REST_API_PORT=${EXTERNAL_REST_API_PORT}
MEMBER_REGISTRATION_SERVICE_PORT=${MEMBER_REGISTRATION_SERVICE_PORT}
RPC_PROXY_PORT=${RPC_PROXY_PORT}
REGISTRY_API_PORT=${REGISTRY_API_PORT}
WORKFLOW_APPROVAL_READER_PORT=${WORKFLOW_APPROVAL_READER_PORT}
MCP_HOST_PORT=${MCP_HOST_PORT}
CONTROL_UI_URL=${CONTROL_UI_URL}
PROFILE_UI_URL=${PROFILE_UI_URL}
PROFILE_UI_BASE_URL=${PROFILE_UI_BASE_URL}
CONTROL_API_URL=${CONTROL_API_URL}
EXTERNAL_REST_API_URL=${EXTERNAL_REST_API_URL}
MEMBER_REGISTRATION_SERVICE_URL=${MEMBER_REGISTRATION_SERVICE_URL}
RPC_PROXY_URL=${RPC_PROXY_URL}
REGISTRY_API_URL=${REGISTRY_API_URL}
WORKFLOW_APPROVAL_READER_URL=${WORKFLOW_APPROVAL_READER_URL}
MCP_HOST_URL=${MCP_HOST_URL}
EOF_PORTS
}

render_profile_v2() {
  local destination="$1" created_head="$2" compatibility_sha="$3"
  {
    printf 'PROFILE_SCHEMA_VERSION=2\n'
    printf 'WORKTREE_ID=%s\n' "${WORKTREE_ID}"
    printf 'OWNER_ID=%s\n' "${OWNER_ID}"
    printf 'CREATED_HEAD=%s\n' "${created_head}"
    printf 'PROFILE=%s\n' "${PROFILE}"
    printf 'REPO_DIR=%s\n' "${REPO_DIR}"
    printf 'BRANCH=%s\n' "${BRANCH}"
    [[ -z "${compatibility_sha}" ]] || printf 'SHA_SHORT=%s\n' "${compatibility_sha}"
    [[ "${DIRTY}" != false ]] || printf 'DIRTY=false\n'
    printf 'UPDATED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"${destination}"
}

validate_profile_pair() {
  local profile_env="$1" ports_env="$2" output
  if ! output="$("${PROFILE_OWNER_SCRIPT}" validate \
    --repo-dir "${REPO_DIR}" --branch "${BRANCH}" --profile "${PROFILE}" \
    --profile-env "${profile_env}" --ports-env "${ports_env}" 2>&1)"; then
    printf '%s\n' "${output}" >&2
    return 1
  fi
}

full_created_head() {
  local historical="${CREATED_HEAD}" full
  if [[ "${historical}" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "${historical}"
    return 0
  fi
  [[ "${historical}" =~ ^[0-9a-f]{7,40}$ ]] || return 1
  full="$(git -C "${REPO_DIR}" rev-parse "${historical}^{commit}" 2>/dev/null || true)"
  [[ "${full}" =~ ^[0-9a-f]{40}$ && "${full}" == "${historical}"* ]] || return 1
  printf '%s\n' "${full}"
}

cleanup_state_write() {
  if [[ -n "${STATE_TEMP_PROFILE}" && "${STATE_TEMP_PROFILE}" == "${CACHE_DIR}"/.profile.env.* ]]; then
    rm -f -- "${STATE_TEMP_PROFILE}"
  fi
  if [[ -n "${STATE_TEMP_PORTS}" && "${STATE_TEMP_PORTS}" == "${CACHE_DIR}"/.ports.env.* ]]; then
    rm -f -- "${STATE_TEMP_PORTS}"
  fi
  STATE_TEMP_PROFILE=""
  STATE_TEMP_PORTS=""
  if [[ "${STATE_NEW_CACHE_DIR}" == true && -d "${CACHE_DIR}" && ! -L "${CACHE_DIR}" ]]; then
    rmdir -- "${CACHE_DIR}" 2>/dev/null || true
  fi
  STATE_NEW_CACHE_DIR=false
  if [[ -n "${STATE_LOCK_DIR}" && "${STATE_LOCK_DIR}" == "${CACHE_ROOT}"/.branch-profile-*.lock ]]; then
    rmdir -- "${STATE_LOCK_DIR}" 2>/dev/null || true
  fi
  STATE_LOCK_DIR=""
}

persist_state() {
  local created_head compatibility_sha prior_exit_trap
  # A caller such as cmd_pf_health may already own an EXIT cleanup trap. The
  # state publication needs a temporary trap for its atomic metadata lock, but
  # must restore the caller's lifecycle cleanup before returning.
  prior_exit_trap="$(trap -p EXIT)"
  created_head="$(full_created_head)" ||
    die "cannot expand historical CREATED_HEAD=${CREATED_HEAD}; refusing schema-v2 migration"
  compatibility_sha="${created_head:0:8}"
  if [[ "${PROFILE_EXISTS}" == true ]]; then
    local persisted_sha
    persisted_sha="$(file_value "${PROFILE_ENV}" SHA_SHORT)"
    if [[ -n "${persisted_sha}" ]]; then
      persisted_sha="$(printf '%s' "${persisted_sha}" | tr '[:upper:]' '[:lower:]')"
      [[ "${persisted_sha}" =~ ^[0-9a-f]{7,40}$ && "${created_head}" == "${persisted_sha}"* ]] ||
        die 'persisted SHA_SHORT is not compatible with historical CREATED_HEAD'
      compatibility_sha="${persisted_sha}"
    fi
  fi

  mkdir -p -- "${CACHE_ROOT}"
  [[ -d "${CACHE_ROOT}" && ! -L "${CACHE_ROOT}" ]] || die "unsafe profile root: ${CACHE_ROOT}"
  CACHE_ROOT="$(cd -- "${CACHE_ROOT}" && pwd -P)"
  set_profile_paths
  STATE_LOCK_DIR="${CACHE_ROOT}/.branch-profile-${OWNER_ID}.lock"
  mkdir -- "${STATE_LOCK_DIR}" 2>/dev/null ||
    die "profile state is busy; lock already exists: ${STATE_LOCK_DIR}"
  trap cleanup_state_write EXIT

  if [[ "${PROFILE_EXISTS}" == true ]]; then
    [[ -d "${CACHE_DIR}" && ! -L "${CACHE_DIR}" ]] || die "unsafe profile directory: ${CACHE_DIR}"
    [[ -f "${PORTS_ENV}" && ! -L "${PORTS_ENV}" ]] || die "PROFILE_PORTS_MISSING: ${PORTS_ENV}"
    [[ ! -L "${PIDS_DIR}" && ! -L "${LOGS_DIR}" ]] ||
      die 'profile runtime directories must not be symlinks'
  else
    [[ ! -e "${CACHE_DIR}" && ! -L "${CACHE_DIR}" ]] ||
      die "profile state appeared concurrently; rerun resolution: ${CACHE_DIR}"
    mkdir -- "${CACHE_DIR}"
    STATE_NEW_CACHE_DIR=true
  fi

  STATE_TEMP_PROFILE="$(mktemp "${CACHE_DIR}/.profile.env.XXXXXX")"
  render_profile_v2 "${STATE_TEMP_PROFILE}" "${created_head}" "${compatibility_sha}"
  if [[ "${PROFILE_EXISTS}" == true ]]; then
    case "${PROFILE_STATE}" in
      existing-v1|existing-v2) ;;
      *) die "refusing metadata replacement from unexpected state: ${PROFILE_STATE}" ;;
    esac
    validate_profile_pair "${PROFILE_ENV}" "${PORTS_ENV}" ||
      die 'persisted profile state changed or failed ownership validation before migration'
    validate_profile_pair "${STATE_TEMP_PROFILE}" "${PORTS_ENV}" ||
      die 'schema-v2 metadata candidate failed public ownership validation'
    # Existing validated v1/v2 metadata is migrated/refreshed by atomic rename.
    # ports.env remains immutable.
    mv -f -- "${STATE_TEMP_PROFILE}" "${PROFILE_ENV}"
    STATE_TEMP_PROFILE=""
  else
    STATE_TEMP_PORTS="$(mktemp "${CACHE_DIR}/.ports.env.XXXXXX")"
    render_ports "${STATE_TEMP_PORTS}"
    validate_profile_pair "${STATE_TEMP_PROFILE}" "${STATE_TEMP_PORTS}" ||
      die 'new profile state failed public ownership validation'
    [[ ! -e "${PORTS_ENV}" && ! -L "${PORTS_ENV}" &&
       ! -e "${PROFILE_ENV}" && ! -L "${PROFILE_ENV}" ]] ||
      die "refusing to replace concurrently published new profile state: ${CACHE_DIR}"
    ln -- "${STATE_TEMP_PORTS}" "${PORTS_ENV}" ||
      die "unable to install ports.env exactly once: ${PORTS_ENV}"
    if ! ln -- "${STATE_TEMP_PROFILE}" "${PROFILE_ENV}"; then
      if [[ -f "${PORTS_ENV}" && "${PORTS_ENV}" -ef "${STATE_TEMP_PORTS}" ]]; then
        rm -f -- "${PORTS_ENV}"
      fi
      die "unable to publish profile.env without replacing a concurrent owner: ${PROFILE_ENV}"
    fi
    rm -f -- "${STATE_TEMP_PORTS}"
    STATE_TEMP_PORTS=""
    rm -f -- "${STATE_TEMP_PROFILE}"
    STATE_TEMP_PROFILE=""
  fi
  validate_profile_pair "${PROFILE_ENV}" "${PORTS_ENV}" ||
    die 'persisted profile state failed final public ownership validation'
  load_validated_ports
  [[ ! -L "${PIDS_DIR}" && ! -L "${LOGS_DIR}" ]] ||
    die 'profile runtime directories must not be symlinks'
  mkdir -p -- "${PIDS_DIR}" "${LOGS_DIR}"
  [[ -d "${PIDS_DIR}" && ! -L "${PIDS_DIR}" &&
     -d "${LOGS_DIR}" && ! -L "${LOGS_DIR}" ]] ||
    die 'profile runtime directories could not be created safely'

  PROFILE_EXISTS=true
  PROFILE_SCHEMA_VERSION=2
  PROFILE_STATE=existing-v2
  CREATED_HEAD="${created_head}"
  STATE_NEW_CACHE_DIR=false
  cleanup_state_write
  if [[ -n "${prior_exit_trap}" ]]; then
    eval "${prior_exit_trap}"
  else
    trap - EXIT
  fi
}

resolve_explicit_profile_override() {
  if [[ -n "${BRANCH_PROFILE_PROFILE}" && -n "${MINIKUBE_PROFILE_SELECTION}" &&
        "${BRANCH_PROFILE_PROFILE}" != "${MINIKUBE_PROFILE_SELECTION}" ]]; then
    die "explicit profile selectors disagree (BRANCH_PROFILE_PROFILE=${BRANCH_PROFILE_PROFILE}, MINIKUBE_PROFILE=${MINIKUBE_PROFILE_SELECTION})"
  fi
  EXPLICIT_PROFILE="${BRANCH_PROFILE_PROFILE:-${MINIKUBE_PROFILE_SELECTION}}"
}

init_profile() {
  local invocation_dir repository_root
  require_command git awk shasum
  invocation_dir="$(pwd -P)"
  repository_root="$(git -C "${invocation_dir}" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "${repository_root}" && -d "${repository_root}" ]] ||
    die "unable to resolve the active Git worktree root from ${invocation_dir}"
  REPO_DIR="$(cd -- "${repository_root}" && pwd -P)"
  BRANCH="$(git -C "${REPO_DIR}" branch --show-current 2>/dev/null || true)"
  HEAD="$(git -C "${REPO_DIR}" rev-parse HEAD 2>/dev/null || true)"
  [[ "${HEAD}" =~ ^[0-9a-f]{40}$ ]] || die "unable to resolve a full git HEAD in ${REPO_DIR}"
  [[ -n "${BRANCH}" ]] || die 'branch profiles require a named branch; detached HEAD is unsupported'
  SHA_SHORT="${HEAD:0:8}"
  DIRTY=false
  if [[ -n "$(git -C "${REPO_DIR}" status --porcelain 2>/dev/null || true)" ]]; then
    DIRTY=true
  fi

  validate_host
  [[ "${KUBECTL_REQUEST_TIMEOUT}" =~ ^[1-9][0-9]*(ms|s|m)$ ]] ||
    die "invalid BRANCH_PROFILE_KUBECTL_REQUEST_TIMEOUT: ${KUBECTL_REQUEST_TIMEOUT}"
  normalize_cache_root
  PROFILE_OWNER_SCRIPT="${REPO_DIR}/scripts/minikube/profile-owner.sh"
  PORT_FORWARD_OWNER_SCRIPT="${REPO_DIR}/scripts/minikube/port-forward-owner.sh"
  DOCKER_CLI_ENV_SCRIPT="${REPO_DIR}/scripts/minikube/docker-cli-env.sh"
  DEADLINE_RUNNER="${REPO_DIR}/scripts/minikube/run-with-deadline.mjs"
  [[ -f "${PROFILE_OWNER_SCRIPT}" && -x "${PROFILE_OWNER_SCRIPT}" && ! -L "${PROFILE_OWNER_SCRIPT}" ]] ||
    die "public profile resolver is unavailable: ${PROFILE_OWNER_SCRIPT}"
  validate_seconds BRANCH_PROFILE_MINIKUBE_STATUS_TIMEOUT_SECONDS \
    "${MINIKUBE_STATUS_TIMEOUT_SECONDS}" 300
  validate_seconds BRANCH_PROFILE_MINIKUBE_START_TIMEOUT_SECONDS \
    "${MINIKUBE_START_TIMEOUT_SECONDS}" 3600
  validate_seconds BRANCH_PROFILE_MINIKUBE_STOP_TIMEOUT_SECONDS \
    "${MINIKUBE_STOP_TIMEOUT_SECONDS}" 600
  validate_seconds BRANCH_PROFILE_MINIKUBE_DELETE_TIMEOUT_SECONDS \
    "${MINIKUBE_DELETE_TIMEOUT_SECONDS}" 900
  resolve_explicit_profile_override
  resolve_profile
}

require_profile_confirmation() {
  local action="$1"
  if [[ "${CONFIRM_PROFILE}" != "${PROFILE}" ]]; then
    printf 'ERROR: refusing %s. Re-run with CONFIRM_PROFILE=%s\n' "${action}" "${PROFILE}" >&2
    exit 1
  fi
}

print_summary() {
  printf 'repo: %s\n' "${REPO_DIR}"
  printf 'branch: %s\n' "${BRANCH}"
  printf 'sha: %s\n' "${SHA_SHORT}"
  printf 'dirty: %s\n' "${DIRTY}"
  printf 'profile: %s\n' "${PROFILE}"
  printf 'profile_state: %s\n' "${PROFILE_STATE}"
  printf 'profile_schema: %s\n' "${PROFILE_SCHEMA_VERSION}"
  printf 'created_head: %s\n' "${CREATED_HEAD}"
  printf 'cache_dir: %s\n' "${CACHE_DIR}"
  printf 'port_base: %s\n' "${PORT_BASE}"
  printf '\nports:\n'
  printf '  control-ui:                  %s\n' "${CONTROL_UI_PORT}"
  printf '  profile-ui:                  %s\n' "${PROFILE_UI_PORT}"
  printf '  control-api:                 %s\n' "${CONTROL_API_PORT}"
  printf '  external-rest-api:           %s\n' "${EXTERNAL_REST_API_PORT}"
  printf '  member-registration-service: %s\n' "${MEMBER_REGISTRATION_SERVICE_PORT}"
  printf '  rpc-proxy:                   %s\n' "${RPC_PROXY_PORT}"
  printf '  registry-api:                %s\n' "${REGISTRY_API_PORT}"
  printf '  workflow-approval-reader:    %s\n' "${WORKFLOW_APPROVAL_READER_PORT}"
  printf '  mcp-host:                    %s\n' "${MCP_HOST_PORT}"
}

check_docker_ready() {
  [[ -f "${DOCKER_CLI_ENV_SCRIPT}" && -x "${DOCKER_CLI_ENV_SCRIPT}" && ! -L "${DOCKER_CLI_ENV_SCRIPT}" ]] ||
    die "bounded Docker probe is unavailable: ${DOCKER_CLI_ENV_SCRIPT}"
  "${DOCKER_CLI_ENV_SCRIPT}" --check-info ||
    die 'Docker daemon is not reachable through the isolated bounded probe'
}

check_port_free() {
  local name="$1"
  local port="$2"
  if (echo >"/dev/tcp/${HOST}/${port}") >/dev/null 2>&1; then
    printf 'ERROR: %s port %s is already listening on %s\n' "${name}" "${port}" "${HOST}" >&2
    return 1
  fi
}

check_all_ports_free() {
  check_port_free control-ui "${CONTROL_UI_PORT}"
  check_port_free profile-ui "${PROFILE_UI_PORT}"
  check_port_free control-api "${CONTROL_API_PORT}"
  check_port_free external-rest-api "${EXTERNAL_REST_API_PORT}"
  check_port_free member-registration-service "${MEMBER_REGISTRATION_SERVICE_PORT}"
  check_port_free rpc-proxy "${RPC_PROXY_PORT}"
  check_port_free registry-api "${REGISTRY_API_PORT}"
  check_port_free workflow-approval-reader "${WORKFLOW_APPROVAL_READER_PORT}"
  check_port_free mcp-host "${MCP_HOST_PORT}"
}

cluster_reachable() {
  kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" \
    cluster-info >/dev/null 2>&1
}

require_existing_profile() {
  [[ "${PROFILE_EXISTS}" == true ]] ||
    die "${ACTION} requires persisted, validated profile state; run branch-profile-preflight or branch-profile-start first"
}

load_port_forward_owner() {
  [[ "${PORT_FORWARD_OWNER_LOADED}" == true ]] && return 0
  if [[ ! -f "${PORT_FORWARD_OWNER_SCRIPT}" || ! -r "${PORT_FORWARD_OWNER_SCRIPT}" || -L "${PORT_FORWARD_OWNER_SCRIPT}" ]]; then
    die "PORT_FORWARD_OWNER_UNAVAILABLE: refusing PID mutation without ${PORT_FORWARD_OWNER_SCRIPT}"
  fi

  # Public helper API (loaded only for PF actions): write a bound pidfile,
  # validate its live owner, and stop only the process proven by that record.
  # shellcheck source=/dev/null
  . "${PORT_FORWARD_OWNER_SCRIPT}"
  local function_name
  for function_name in \
    pf_owner_record_process \
    pf_owner_cleanup_record \
    pf_owner_read_record \
    pf_owner_record_matches \
    pf_owner_process_state \
    pf_owner_process_start \
    pf_owner_process_command \
    pf_owner_command_matches \
    pf_owner_abort_child \
    pf_owner_pause; do
    declare -F "${function_name}" >/dev/null ||
      die "PORT_FORWARD_OWNER_API_INVALID: missing ${function_name} in ${PORT_FORWARD_OWNER_SCRIPT}"
  done
  [[ "${HOST}" == 127.0.0.1 ]] ||
    die 'PORT_FORWARD_OWNER_BINDING_INVALID: PF ownership records require HOST=127.0.0.1'
  PORT_FORWARD_OWNER_LOADED=true
}

probe_service() {
  local namespace="$1" service="$2" output
  if ! output="$(kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" \
    -n "${namespace}" get svc "${service}" --ignore-not-found -o name)"; then
    printf 'ERROR: unable to inspect service %s/%s\n' \
      "${namespace}" "${service}" >&2
    return 1
  fi
  [[ -n "${output}" ]] || return 3
}

select_mcp_service() {
  local status=0
  probe_service mcp-host chatllm || status=$?
  if (( status == 0 )); then
    printf 'chatllm\n'
    return 0
  fi
  (( status == 3 )) || return "${status}"
  status=0
  probe_service mcp-host mcp-host || status=$?
  if (( status == 0 )); then
    printf 'mcp-host\n'
    return 0
  fi
  (( status == 3 )) || return "${status}"
  return 3
}

stop_own_pf() {
  local name="$1" namespace="$2" service="$3" local_port="$4" remote_port="$5"
  local pidfile="${PIDS_DIR}/${name}.pid" comm
  [[ -e "${pidfile}" || -L "${pidfile}" ]] || return 0
  if pf_owner_cleanup_record "${pidfile}" "${PROFILE}" "${PROFILE}" "${REPO_DIR}" \
    "${namespace}" "${service}" "${local_port}" "${remote_port}"; then
    return 0
  fi
  # PID reuse: the live process is not this lane's kubectl. Do not signal it.
  # Drop only the stale record so the next forward records a separate PID.
  if pf_owner_read_record "${pidfile}"; then
    comm="$(ps -p "${PF_OWNER_RECORD_PID}" -o comm= 2>/dev/null || true)"
    case "${comm}" in
      kubectl | */kubectl) ;;
      *)
        printf 'retiring reused port-forward record without signalling pid=%s\n' \
          "${PF_OWNER_RECORD_PID}"
        pf_owner_remove_dead_record "${pidfile}" || return 1
        return 0
        ;;
    esac
  fi
  printf 'ERROR: refusing to stop unverified port-forward record: %s\n' "${pidfile}" >&2
  return 1
}

port_forward_record_is_live() {
  local pidfile="$1" namespace="$2" service="$3" local_port="$4" remote_port="$5"
  local state actual_start command_line
  pf_owner_read_record "${pidfile}" || return 1
  pf_owner_record_matches "${PROFILE}" "${PROFILE}" "${REPO_DIR}" \
    "${namespace}" "${service}" "${local_port}" "${remote_port}" || return 1
  state="$(pf_owner_process_state "${PF_OWNER_RECORD_PID}")"
  [[ "${state}" == live ]] || return 1
  actual_start="$(pf_owner_process_start "${PF_OWNER_RECORD_PID}")" || return 1
  [[ "${actual_start}" == "${PF_OWNER_RECORD_START}" ]] || return 1
  command_line="$(pf_owner_process_command "${PF_OWNER_RECORD_PID}")" || return 1
  pf_owner_command_matches "${command_line}" "${PROFILE}" "${namespace}" \
    "${service}" "${local_port}" "${remote_port}" || return 1
  actual_start="$(pf_owner_process_start "${PF_OWNER_RECORD_PID}")" || return 1
  [[ "${actual_start}" == "${PF_OWNER_RECORD_START}" ]]
}

start_pf() {
  local name="$1"
  local namespace="$2"
  local service="$3"
  local local_port="$4"
  local remote_port="$5"
  local required="$6"
  local log_file="${LOGS_DIR}/${name}.log"
  local pid_file="${PIDS_DIR}/${name}.pid"
  local service_status=0 pid

  probe_service "${namespace}" "${service}" || service_status=$?
  if (( service_status == 3 )); then
    if [[ "${required}" == true ]]; then
      printf 'FAIL %-32s required service absent (%s/%s)\n' "${name}" "${namespace}" "${service}" >&2
      return 1
    fi
    printf 'SKIP %-32s optional service absent (%s/%s)\n' "${name}" "${namespace}" "${service}"
    return 0
  fi
  (( service_status == 0 )) || return "${service_status}"

  stop_own_pf "${name}" "${namespace}" "${service}" "${local_port}" "${remote_port}"
  check_port_free "${name}" "${local_port}"
  nohup kubectl "--context=${PROFILE}" -n "${namespace}" port-forward --address=127.0.0.1 "svc/${service}" "${local_port}:${remote_port}" >"${log_file}" 2>&1 </dev/null &
  pid=$!
  pf_owner_pause "${PF_STARTUP_DELAY:-0.2}"
  if ! pf_owner_record_process "${pid_file}" "${pid}" "${PROFILE}" "${PROFILE}" \
    "${REPO_DIR}" "${namespace}" "${service}" "${local_port}" "${remote_port}"; then
    printf 'ERROR: failed to record exact ownership for %s pid=%s\n' "${name}" "${pid}" >&2
    pf_owner_abort_child "${pid}" "${PROFILE}" "${namespace}" "${service}" \
      "${local_port}" "${remote_port}" || true
    return 1
  fi
  if ! port_forward_record_is_live "${pid_file}" "${namespace}" "${service}" \
    "${local_port}" "${remote_port}"; then
    pf_owner_cleanup_record "${pid_file}" "${PROFILE}" "${PROFILE}" "${REPO_DIR}" \
      "${namespace}" "${service}" "${local_port}" "${remote_port}" || true
    printf 'ERROR: %s port-forward did not remain live with verified ownership\n' "${name}" >&2
    return 1
  fi
  printf 'PF   %-32s pid=%s %s:%s -> %s/%s:%s\n' "${name}" "${pid}" "${HOST}" "${local_port}" "${namespace}" "${service}" "${remote_port}"
}

check_health() {
  local name="$1"
  local namespace="$2"
  local service="$3"
  local pid_name="$4"
  local url="$5"
  local required="$6"
  local local_port="$7"
  local remote_port="$8"
  local pidfile="${PIDS_DIR}/${pid_name}.pid"
  local service_status=0

  probe_service "${namespace}" "${service}" || service_status=$?
  if (( service_status == 3 )); then
    if [[ "${required}" == true ]]; then
      printf 'FAIL %-32s required service absent (%s/%s)\n' "${name}" "${namespace}" "${service}" >&2
      return 1
    fi
    printf 'SKIP %-32s optional service absent (%s/%s)\n' "${name}" "${namespace}" "${service}"
    return 0
  fi
  (( service_status == 0 )) || return "${service_status}"

  if [[ ! -f "${pidfile}" || -L "${pidfile}" ]] ||
    ! port_forward_record_is_live "${pidfile}" "${namespace}" "${service}" \
      "${local_port}" "${remote_port}"; then
    printf 'FAIL %-32s missing or unverified forward (%s)\n' "${name}" "${pidfile}" >&2
    return 1
  fi

  if curl -sf -m 5 "${url}" >/dev/null 2>&1; then
    printf 'OK   %-32s %s\n' "${name}" "${url}"
  else
    printf 'FAIL %-32s %s\n' "${name}" "${url}" >&2
    return 1
  fi
}

cmd_info() {
  print_summary
  printf '\nnext local checks:\n'
  printf '  make -f scripts/minikube-profiles/branch.mk branch-profile-preflight\n'
  printf '  make -f scripts/minikube-profiles/branch.mk branch-profile-start\n'
  printf '  make -f scripts/minikube-profiles/branch.mk branch-profile-status\n'
}

cmd_resolve() {
  printf 'PROFILE=%s\n' "${PROFILE}"
  printf 'PROFILE_EXISTS=%s\n' "${PROFILE_EXISTS}"
  printf 'PROFILE_STATE=%s\n' "${PROFILE_STATE}"
  printf 'PROFILE_SCHEMA_VERSION=%s\n' "${PROFILE_SCHEMA_VERSION}"
  printf 'WORKTREE_ID=%s\n' "${WORKTREE_ID}"
  printf 'OWNER_ID=%s\n' "${OWNER_ID}"
  printf 'CREATED_HEAD=%s\n' "${CREATED_HEAD}"
  printf 'REPO_DIR=%s\n' "${REPO_DIR}"
  printf 'BRANCH=%s\n' "${BRANCH}"
  printf 'PROFILE_ENV=%s\n' "${PROFILE_ENV}"
  printf 'PORTS_ENV=%s\n' "${PORTS_ENV}"
}

cmd_preflight() {
  require_command git minikube kubectl helm shasum
  check_docker_ready
  check_all_ports_free
  persist_state
  print_summary
  printf '\npreflight: OK\n'
  printf 'state written:\n'
  printf '  %s\n' "${PROFILE_ENV}"
  printf '  %s\n' "${PORTS_ENV}"
}

cmd_prepare_shims() {
  require_command git shasum perl
  persist_state
  mkdir -p "${CACHE_DIR}/scripts"
  rm -rf "${SHIMS_DIR}" "${DEPLOY_SHIM_DIR}"
  cp -R "${REPO_DIR}/scripts/minikube" "${SHIMS_DIR}"
  cp -R "${REPO_DIR}/deploy" "${DEPLOY_SHIM_DIR}"

  local file
  while IFS= read -r file; do
    perl -0pi -e 's#PROJECT_DIR="\$\(cd "\$SCRIPT_DIR/\.\./\.\." && pwd\)"#PROJECT_DIR="\${CLERUM_PROJECT_DIR:-\$(cd \"\$SCRIPT_DIR/../..\" && pwd)}"#g; s#PROJECT_DIR="\$\(cd "\$\{SCRIPT_DIR\}/\.\./\.\." && pwd\)"#PROJECT_DIR="\${CLERUM_PROJECT_DIR:-\$(cd \"\${SCRIPT_DIR}/../..\" && pwd)}"#g; s#PROFILE="clerum-test"#PROFILE="\${MINIKUBE_PROFILE:-clerum-test}"#g; s#--context=clerum-test#--context=\${PROFILE}#g' "${file}"
  done < <(find "${SHIMS_DIR}" -type f -name '*.sh' | sort)

  perl -0pi -e 's#OUTPUT="\$\{PROJECT_DIR\}/deploy/minikube/secrets/jwt-signing-keys.yaml"#OUTPUT="\${BRANCH_PROFILE_DEPLOY_DIR:-\${PROJECT_DIR}/deploy}/minikube/secrets/jwt-signing-keys.yaml"#g' "${SHIMS_DIR}/generate-keys.sh"
  perl -0pi -e 's#REPO_ROOT="\$\(cd "\$\{SCRIPT_DIR\}/\.\./\.\." && pwd\)"#REPO_ROOT="\${CLERUM_PROJECT_DIR:-\$(cd \"\${SCRIPT_DIR}/../..\" && pwd)}"#g' "${SHIMS_DIR}/seed-test-data.sh"
  perl -0pi -e 's#: "\$\{CONTEXT:=\$\(kubectl config current-context\)\}"#: "\${CONTEXT:=\${MINIKUBE_PROFILE:-\$(kubectl config current-context)}}"#g; s#export ADMIN_PASSWORD E2E_TEST_EMAIL E2E_TEST_PASSWORD CONTEXT#: "\${ALLOWED_CONTEXTS:=\${CONTEXT}}"\nexport ADMIN_PASSWORD E2E_TEST_EMAIL E2E_TEST_PASSWORD CONTEXT ALLOWED_CONTEXTS#g; s#export ADMIN_PASSWORD E2E_DEV_LOGIN_EMAIL CONTEXT#: "\${ALLOWED_CONTEXTS:=\${CONTEXT}}"\nexport ADMIN_PASSWORD E2E_DEV_LOGIN_EMAIL CONTEXT ALLOWED_CONTEXTS#g' "${SHIMS_DIR}/seed-test-data.sh"
  perl -0pi -e 's#MANIFEST_FILE="\$\{PROJECT_DIR\}/deploy/minikube/\.image-manifest.json"#MANIFEST_FILE="\${BRANCH_PROFILE_DEPLOY_DIR:-\${PROJECT_DIR}/deploy}/minikube/.image-manifest.json"#g' "${SHIMS_DIR}/build-images.sh"
  perl -0pi -e 's#BASE_MINIKUBE_KUSTOMIZE_DIR="\$\{PROJECT_DIR\}/deploy/overlays/minikube"#BASE_MINIKUBE_KUSTOMIZE_DIR="\${BRANCH_PROFILE_DEPLOY_DIR:-\${PROJECT_DIR}/deploy}/overlays/minikube"#g; s#LOCAL_MEMBER_REGISTRATION_KUSTOMIZE_DIR="\$\{PROJECT_DIR\}/deploy/overlays/minikube-local-member-registration"#LOCAL_MEMBER_REGISTRATION_KUSTOMIZE_DIR="\${BRANCH_PROFILE_DEPLOY_DIR:-\${PROJECT_DIR}/deploy}/overlays/minikube-local-member-registration"#g' "${SHIMS_DIR}/full-setup.sh"
  perl -0pi -e 's#CONTEXT="\$\{PROFILE\}" "\$\{PROJECT_DIR\}/deploy/scripts/minikube-detect-k8s-api-ip.sh"#CONTEXT="\${PROFILE}" OVERLAY_DIR="\${BRANCH_PROFILE_DEPLOY_DIR:-\${PROJECT_DIR}/deploy}/overlays/minikube" "\${PROJECT_DIR}/deploy/scripts/minikube-detect-k8s-api-ip.sh"#g; s#kubectl kustomize "\$\{PROJECT_DIR\}/deploy/overlays/minikube"#kubectl kustomize "\${BRANCH_PROFILE_DEPLOY_DIR:-\${PROJECT_DIR}/deploy}/overlays/minikube"#g' "${SHIMS_DIR}/full-setup.sh"

  chmod +x "${SHIMS_DIR}"/*.sh
  cat >"${SHIM_ENV}" <<EOF_SHIMS
PROFILE=${PROFILE}
CLERUM_PROJECT_DIR=${REPO_DIR}
BRANCH_PROFILE_DEPLOY_DIR=${DEPLOY_SHIM_DIR}
SHIMS_DIR=${SHIMS_DIR}
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF_SHIMS

  if grep -R 'PROFILE="clerum-test"\|--context=clerum-test' "${SHIMS_DIR}" >/dev/null 2>&1; then
    printf 'ERROR: local shims still contain hardcoded clerum-test references\n' >&2
    grep -R -n 'PROFILE="clerum-test"\|--context=clerum-test' "${SHIMS_DIR}" >&2 || true
    exit 1
  fi

  printf 'local shims prepared for profile: %s\n' "${PROFILE}"
  printf 'scripts: %s\n' "${SHIMS_DIR}"
  printf 'deploy copy: %s\n' "${DEPLOY_SHIM_DIR}"
  printf 'env: %s\n' "${SHIM_ENV}"
}

ensure_shims() {
  if [[ ! -x "${SHIMS_DIR}/full-setup.sh" || ! -x "${SHIMS_DIR}/build-images.sh" || ! -x "${SHIMS_DIR}/generate-keys.sh" ]]; then
    cmd_prepare_shims
  fi
}

cmd_start() {
  require_command git minikube kubectl helm shasum
  check_docker_ready
  check_all_ports_free
  persist_state
  local before_context after_context
  before_context="$(kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" \
    config current-context 2>/dev/null || true)"
  printf 'starting minikube profile: %s\n' "${PROFILE}"
  run_bounded minikube-start "${MINIKUBE_START_TIMEOUT_SECONDS}" minikube start \
    -p "${PROFILE}" \
    --keep-context \
    --memory="${MINIKUBE_MEMORY}" \
    --cpus="${MINIKUBE_CPUS}" \
    --cni="${MINIKUBE_CNI}" \
    --driver="${MINIKUBE_DRIVER}"
  after_context="$(kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" \
    config current-context 2>/dev/null || true)"
  if [[ "${before_context}" != "${after_context}" ]]; then
    printf 'ERROR: kubectl current-context changed from %s to %s\n' "${before_context}" "${after_context}" >&2
    exit 1
  fi
  run_bounded minikube-status "${MINIKUBE_STATUS_TIMEOUT_SECONDS}" \
    minikube -p "${PROFILE}" status
  kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" cluster-info
  kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" get nodes
}

cmd_status() {
  require_existing_profile
  printf 'profile: %s\n\n' "${PROFILE}"
  run_bounded minikube-status "${MINIKUBE_STATUS_TIMEOUT_SECONDS}" \
    minikube -p "${PROFILE}" status
  printf '\n'
  if cluster_reachable; then
    kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" get nodes
    printf '\n'
    kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" \
      get deploy -A 2>/dev/null || true
    printf '\n'
    kubectl "--context=${PROFILE}" "--request-timeout=${KUBECTL_REQUEST_TIMEOUT}" \
      get sts -A 2>/dev/null || true
  else
    printf 'cluster not reachable for context %s\n' "${PROFILE}"
  fi
}

cmd_pf() {
  require_command git kubectl curl shasum
  require_existing_profile
  load_port_forward_owner
  if ! cluster_reachable; then
    printf 'ERROR: cluster not reachable for context %s\n' "${PROFILE}" >&2
    exit 1
  fi
  persist_state

  start_pf control-ui control-plane control-ui "${CONTROL_UI_PORT}" 3000 true
  start_pf profile-ui profiles profile-ui "${PROFILE_UI_PORT}" 3001 false
  start_pf control-api control-plane control-api "${CONTROL_API_PORT}" 8090 true
  start_pf external-rest-api profiles external-rest-api "${EXTERNAL_REST_API_PORT}" 8091 true
  start_pf member-registration-service profiles member-registration-service "${MEMBER_REGISTRATION_SERVICE_PORT}" 8092 false
  start_pf rpc-proxy rpc-proxy rpc-proxy "${RPC_PROXY_PORT}" 8094 true
  start_pf registry-api registry registry-api "${REGISTRY_API_PORT}" 8085 false
  start_pf workflow-approval-reader channels workflow-approval-request-reader "${WORKFLOW_APPROVAL_READER_PORT}" 8098 false
  local mcp_service mcp_status=0
  mcp_service="$(select_mcp_service)" || mcp_status=$?
  if (( mcp_status == 3 )); then
    printf 'SKIP %-32s optional service absent (mcp-host/chatllm or mcp-host/mcp-host)\n' mcp-host
  elif (( mcp_status == 0 )); then
    start_pf mcp-host mcp-host "${mcp_service}" "${MCP_HOST_PORT}" 8080 false
  else
    return "${mcp_status}"
  fi
  printf '\nlogs: %s\n' "${LOGS_DIR}"
  printf 'pids: %s\n' "${PIDS_DIR}"
}

cmd_health() {
  require_existing_profile
  load_port_forward_owner
  if ! cluster_reachable; then
    printf 'ERROR: cluster not reachable for context %s\n' "${PROFILE}" >&2
    exit 1
  fi

  check_health control-ui control-plane control-ui control-ui "${CONTROL_UI_URL}" true "${CONTROL_UI_PORT}" 3000
  check_health profile-ui profiles profile-ui profile-ui "${PROFILE_UI_URL}" false "${PROFILE_UI_PORT}" 3001
  check_health control-api control-plane control-api control-api "${CONTROL_API_URL%/}/health" true "${CONTROL_API_PORT}" 8090
  check_health external-rest-api profiles external-rest-api external-rest-api "${EXTERNAL_REST_API_URL%/}/health" true "${EXTERNAL_REST_API_PORT}" 8091
  check_health member-registration-service profiles member-registration-service member-registration-service "${MEMBER_REGISTRATION_SERVICE_URL%/}/health" false "${MEMBER_REGISTRATION_SERVICE_PORT}" 8092
  check_health rpc-proxy rpc-proxy rpc-proxy rpc-proxy "${RPC_PROXY_URL%/}/health" true "${RPC_PROXY_PORT}" 8094
  check_health registry-api registry registry-api registry-api "${REGISTRY_API_URL%/}/health" false "${REGISTRY_API_PORT}" 8085
  check_health workflow-approval-reader channels workflow-approval-request-reader workflow-approval-reader "${WORKFLOW_APPROVAL_READER_URL%/}/health" false "${WORKFLOW_APPROVAL_READER_PORT}" 8098
  local mcp_service mcp_status=0
  mcp_service="$(select_mcp_service)" || mcp_status=$?
  if (( mcp_status == 3 )); then
    printf 'SKIP %-32s optional service absent (mcp-host/chatllm or mcp-host/mcp-host)\n' mcp-host
  elif (( mcp_status == 0 )); then
    check_health mcp-host mcp-host "${mcp_service}" mcp-host \
      "${MCP_HOST_URL%/}/v1/runtime/health" false "${MCP_HOST_PORT}" 8080
  else
    return "${mcp_status}"
  fi
}

cmd_pf_health() {
  trap cmd_stop_pf EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  cmd_pf
  sleep 2
  cmd_health
}

resolve_stop_pf_binding() {
  local name="$1" pidfile="$2"
  case "${name}" in
    control-ui)
      STOP_PF_NAMESPACE=control-plane
      STOP_PF_SERVICE=control-ui
      STOP_PF_LOCAL_PORT="${CONTROL_UI_PORT}"
      STOP_PF_REMOTE_PORT=3000
      ;;
    profile-ui)
      STOP_PF_NAMESPACE=profiles
      STOP_PF_SERVICE=profile-ui
      STOP_PF_LOCAL_PORT="${PROFILE_UI_PORT}"
      STOP_PF_REMOTE_PORT=3001
      ;;
    control-api)
      STOP_PF_NAMESPACE=control-plane
      STOP_PF_SERVICE=control-api
      STOP_PF_LOCAL_PORT="${CONTROL_API_PORT}"
      STOP_PF_REMOTE_PORT=8090
      ;;
    external-rest-api)
      STOP_PF_NAMESPACE=profiles
      STOP_PF_SERVICE=external-rest-api
      STOP_PF_LOCAL_PORT="${EXTERNAL_REST_API_PORT}"
      STOP_PF_REMOTE_PORT=8091
      ;;
    member-registration-service)
      STOP_PF_NAMESPACE=profiles
      STOP_PF_SERVICE=member-registration-service
      STOP_PF_LOCAL_PORT="${MEMBER_REGISTRATION_SERVICE_PORT}"
      STOP_PF_REMOTE_PORT=8092
      ;;
    rpc-proxy)
      STOP_PF_NAMESPACE=rpc-proxy
      STOP_PF_SERVICE=rpc-proxy
      STOP_PF_LOCAL_PORT="${RPC_PROXY_PORT}"
      STOP_PF_REMOTE_PORT=8094
      ;;
    registry-api)
      STOP_PF_NAMESPACE=registry
      STOP_PF_SERVICE=registry-api
      STOP_PF_LOCAL_PORT="${REGISTRY_API_PORT}"
      STOP_PF_REMOTE_PORT=8085
      ;;
    workflow-approval-reader)
      STOP_PF_NAMESPACE=channels
      STOP_PF_SERVICE=workflow-approval-request-reader
      STOP_PF_LOCAL_PORT="${WORKFLOW_APPROVAL_READER_PORT}"
      STOP_PF_REMOTE_PORT=8098
      ;;
    mcp-host)
      pf_owner_read_record "${pidfile}" || {
        printf 'ERROR: refusing MCP PID record without exact ownership fields: %s\n' "${pidfile}" >&2
        return 1
      }
      case "${PF_OWNER_RECORD_SERVICE}" in
        chatllm|mcp-host) STOP_PF_SERVICE="${PF_OWNER_RECORD_SERVICE}" ;;
        *)
          printf 'ERROR: refusing unknown MCP service binding in %s\n' "${pidfile}" >&2
          return 1
          ;;
      esac
      STOP_PF_NAMESPACE=mcp-host
      STOP_PF_LOCAL_PORT="${MCP_HOST_PORT}"
      STOP_PF_REMOTE_PORT=8080
      ;;
    *)
      printf 'ERROR: refusing unknown port-forward pidfile name: %s\n' "${name}" >&2
      return 1
      ;;
  esac
}

cmd_stop_pf() {
  require_existing_profile
  load_port_forward_owner
  [[ ! -L "${PIDS_DIR}" ]] ||
    die "refusing symlinked port-forward PID directory: ${PIDS_DIR}"
  if [[ ! -d "${PIDS_DIR}" ]]; then
    printf 'No runner pid dir found: %s\n' "${PIDS_DIR}"
    return 0
  fi
  shopt -s nullglob
  local pidfiles=("${PIDS_DIR}"/*.pid)
  if (( ${#pidfiles[@]} == 0 )); then
    printf 'No runner port-forwards found in %s\n' "${PIDS_DIR}"
    return 0
  fi
  local pidfile name
  # Validate the complete filename set before stopping anything. An unknown
  # record must not cause a partially applied cleanup.
  for pidfile in "${pidfiles[@]}"; do
    name="$(basename "${pidfile}" .pid)"
    resolve_stop_pf_binding "${name}" "${pidfile}" || return 1
  done
  for pidfile in "${pidfiles[@]}"; do
    name="$(basename "${pidfile}" .pid)"
    resolve_stop_pf_binding "${name}" "${pidfile}" || return 1
    stop_own_pf "${name}" "${STOP_PF_NAMESPACE}" "${STOP_PF_SERVICE}" \
      "${STOP_PF_LOCAL_PORT}" "${STOP_PF_REMOTE_PORT}" || return 1
    printf 'stopped or cleared verified %s record\n' "${name}"
  done
}

cmd_stop() {
  require_existing_profile
  printf 'stopping minikube profile: %s\n' "${PROFILE}"
  run_bounded minikube-stop "${MINIKUBE_STOP_TIMEOUT_SECONDS}" \
    minikube -p "${PROFILE}" stop
}

cmd_setup() {
  require_command git minikube kubectl helm shasum perl
  require_existing_profile
  require_profile_confirmation setup
  check_docker_ready
  persist_state
  ensure_shims
  local -a setup_args=()
  if [[ -n "${ARGS}" ]]; then
    read -r -a setup_args <<<"${ARGS}"
  fi
  printf 'running isolated setup for profile: %s\n' "${PROFILE}"
  printf 'using local script copy: %s\n' "${SHIMS_DIR}/full-setup.sh"
  MINIKUBE_PROFILE="${PROFILE}" \
  CLERUM_PROJECT_DIR="${REPO_DIR}" \
  BRANCH_PROFILE_DEPLOY_DIR="${DEPLOY_SHIM_DIR}" \
  "${SHIMS_DIR}/full-setup.sh" "${setup_args[@]}"
}

cmd_delete() {
  require_existing_profile
  if [[ "${CONFIRM_DELETE}" != "${PROFILE}" ]]; then
    printf 'ERROR: refusing delete. Re-run with CONFIRM_DELETE=%s\n' "${PROFILE}" >&2
    exit 1
  fi
  printf 'deleting minikube profile: %s\n' "${PROFILE}"
  run_bounded minikube-delete "${MINIKUBE_DELETE_TIMEOUT_SECONDS}" \
    minikube -p "${PROFILE}" delete
}

cmd_e2e_plan() {
  printf 'Profile: %s\n\n' "${PROFILE}"
  printf 'Profile UI browser E2E:\n'
  printf '  PROFILE_UI_BASE_URL="%s" \\\n' "${PROFILE_UI_BASE_URL}"
  printf '  CONTROL_API_BASE_URL="%s" \\\n' "${CONTROL_API_URL}"
  printf '  EXTERNAL_REST_API_BASE_URL="%s" \\\n' "${EXTERNAL_REST_API_URL}"
  printf '  KUBECONTEXT="%s" \\\n' "${PROFILE}"
  printf '  bash scripts/e2e/playwright-dev.sh telegram-approval-medium-verification.test.ts\n\n'
  printf 'Workflow triggers:\n'
  printf '  KUBECONTEXT="%s" \\\n' "${PROFILE}"
  printf '  K8S_CONTEXT="%s" \\\n' "${PROFILE}"
  printf '  E2E_CONTROL_API_URL="%s" \\\n' "${CONTROL_API_URL}"
  printf '  E2E_EXTERNAL_REST_API_URL="%s" \\\n' "${EXTERNAL_REST_API_URL}"
  printf '  bash scripts/e2e/e2e-workflow-triggers.sh\n\n'
  printf 'Workflow approvals:\n'
  printf '  KUBECONTEXT="%s" \\\n' "${PROFILE}"
  printf '  K8S_CONTEXT="%s" \\\n' "${PROFILE}"
  printf '  E2E_CONTROL_API_URL="%s" \\\n' "${CONTROL_API_URL}"
  printf '  E2E_EXTERNAL_REST_API_URL="%s" \\\n' "${EXTERNAL_REST_API_URL}"
  printf '  bash scripts/e2e/e2e-workflow-approvals.sh\n\n'
  printf 'This target only prints commands. Ask before running cluster-backed E2E.\n'
}

cmd_sync_plan() {
  printf 'Local shim setup is available for %s.\n\n' "${PROFILE}"
  printf 'Prepare shims:\n'
  printf '  make -f scripts/minikube-profiles/branch.mk branch-profile-prepare-shims\n\n'
  printf 'Run full setup only with explicit profile confirmation:\n'
  printf '  CONFIRM_PROFILE="%s" make -f scripts/minikube-profiles/branch.mk branch-profile-setup\n\n' "${PROFILE}"
  printf 'Incremental pre-gate sync remains disabled until minikube-deploy-all is shimmed end-to-end.\n'
}

init_profile

case "${ACTION}" in
  resolve) cmd_resolve ;;
  info) cmd_info ;;
  preflight) cmd_preflight ;;
  prepare-shims) cmd_prepare_shims ;;
  start) cmd_start ;;
  status) cmd_status ;;
  pf) cmd_pf ;;
  pf-health) cmd_pf_health ;;
  health) cmd_health ;;
  stop-pf) cmd_stop_pf ;;
  stop) cmd_stop ;;
  setup) cmd_setup ;;
  delete) cmd_delete ;;
  e2e-plan) cmd_e2e_plan ;;
  sync-plan) cmd_sync_plan ;;
  *)
    printf 'ERROR: unknown branch profile action: %s\n' "${ACTION}" >&2
    exit 1
    ;;
esac
