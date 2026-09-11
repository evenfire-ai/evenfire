#!/usr/bin/env bash
# Run the GFS real-Postgres T1 suites with an isolated PostgreSQL instance while
# validating the target branch-owned Minikube profile and restoring its GFS
# runtime roles on exit.
#
# This runner is deliberately separate from CI: CI supplies its own ephemeral
# Postgres DSN, while this gate starts a disposable local PostgreSQL container.
# It never mutates the shared control-postgres database used by the profile.
set -euo pipefail
set +x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
CONTEXT="${CONTEXT:-${MINIKUBE_PROFILE:-}}"
SYNC_CONFIGMAP="${CLERUM_PRE_GATE_SYNC_CONFIGMAP:-clerum-pre-gate-sync-state}"
CONTROL_NS="${CONTROL_NS:-control-plane}"
TIMEOUT="${TIMEOUT:-120}"
ISOLATED_PG_IMAGE="${ISOLATED_PG_IMAGE:-postgres:16-alpine}"
ISOLATED_HOST='127.0.0.1'

# Reuse the canonical T2 ownership, context-identity, marker, and mutation
# lock contract. This standalone GFS lane is still a T1 helper, but it mutates
# cluster-global GFS roles and therefore must have the same branch-owned safety
# boundary as the main T2 orchestrator.
T2_PROJECT_DIR="${PROJECT_DIR}"
MINIKUBE_PROFILE="${CONTEXT}"
T2_PROFILE="${CONTEXT}"
T2_CONTEXT="${CONTEXT}"
T2_PROFILE_ROOT="${T2_PROFILE_ROOT:-${CLERUM_PROFILE_CACHE_ROOT:-${HOME}/.cache/clerum/minikube-profiles}}"
T2_PROFILE_ENV="${T2_PROFILE_ENV:-${T2_PROFILE_ROOT}/${CONTEXT}/profile.env}"
T2_PORTS_ENV="${T2_PORTS_ENV:-${CLERUM_PROFILE_PORTS_ENV:-${T2_PROFILE_ROOT}/${CONTEXT}/ports.env}}"
T2_MARKER_NAME="${SYNC_CONFIGMAP}"
T2_CONTROL_NAMESPACE="${CONTROL_NS}"
export T2_PROJECT_DIR MINIKUBE_PROFILE T2_PROFILE T2_CONTEXT T2_PROFILE_ROOT \
  T2_PROFILE_ENV T2_PORTS_ENV T2_MARKER_NAME T2_CONTROL_NAMESPACE
source "${PROJECT_DIR}/scripts/minikube/t2-common.sh"
# shellcheck source=scripts/minikube/docker-cli-env.sh
source "${PROJECT_DIR}/scripts/minikube/docker-cli-env.sh"
# shellcheck source=real-postgres-local-preflight.sh
source "${SCRIPT_DIR}/real-postgres-local-preflight.sh"

GFS_DOCKER_RUN_TIMEOUT_SECONDS="${GFS_DOCKER_RUN_TIMEOUT_SECONDS:-${MINIKUBE_DOCKER_PULL_TIMEOUT_SECONDS}}"
GFS_DOCKER_EXEC_TIMEOUT_SECONDS="${GFS_DOCKER_EXEC_TIMEOUT_SECONDS:-${MINIKUBE_DOCKER_START_PROBE_TIMEOUT_SECONDS}}"
GFS_DOCKER_REMOVE_TIMEOUT_SECONDS="${GFS_DOCKER_REMOVE_TIMEOUT_SECONDS:-${MINIKUBE_DOCKER_INFO_TIMEOUT_SECONDS}}"

die() {
  printf '[gfs-real-pg-minikube] ERROR: %s\n' "$*" >&2
  exit 1
}

kc() {
  kubectl --context="${CONTEXT}" "$@"
}

require_command() {
  local command_name
  for command_name in "$@"; do
    command -v "${command_name}" >/dev/null 2>&1 || die "required command is missing: ${command_name}"
  done
}

verify_branch_gate() {
  t2_require_commands
  t2_repo_metadata
  t2_profile_scope
  # Profile status is checked before context identity so a missing/stopped
  # profile produces the supported bootstrap transition instead of an opaque
  # kube-context failure.
  t2_profile_status
  if [ "${T2_BOOTSTRAP_REQUIRED}" = true ]; then
    die "branch-owned Minikube profile is not bootstrapped: ${T2_PROFILE}"
  fi
  t2_context_check
  t2_profile_context_identity_check
  t2_mutation_lock
  t2_marker_check
}

wait_for_tcp() {
  local port="$1" deadline=$((SECONDS + TIMEOUT))
  while (( SECONDS < deadline )); do
    if python3 - "${port}" <<'PY' >/dev/null 2>&1
import socket
import sys

with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=1):
    pass
PY
    then
      return 0
    fi
    sleep 1
  done
  return 1
}

sanitize_file() {
  local file="$1"
  [[ -f "${file}" ]] || return 0
  python3 - "${file}" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(errors="replace")
text = re.sub(r"postgres(?:ql)?://[^\s\"'<>]+", "<minikube-postgres-dsn-redacted>", text)
path.write_text(text)
PY
}

PROFILE_PG_FORWARD_PID=""
PROFILE_PG_FORWARD_RECORD=""

stop_profile_postgres_forward() {
  [[ -n "${PROFILE_PG_FORWARD_PID}" ]] || return 0
  [[ -n "${PROFILE_PG_FORWARD_RECORD}" ]] || {
    printf '[gfs-real-pg-minikube] ERROR: profile PostgreSQL forward has no structured ownership record; refusing ambiguous cleanup\n' >&2
    return 1
  }
  if [[ ! -e "${PROFILE_PG_FORWARD_RECORD}" && ! -L "${PROFILE_PG_FORWARD_RECORD}" ]]; then
    if [[ "$(pf_owner_process_state "${PROFILE_PG_FORWARD_PID}")" == dead ]]; then
      PROFILE_PG_FORWARD_PID=''
      PROFILE_PG_FORWARD_RECORD=''
      return 0
    fi
    printf '[gfs-real-pg-minikube] ERROR: profile PostgreSQL forward record disappeared while its process may still be live\n' >&2
    return 1
  fi
  if ! pf_owner_cleanup_record "${PROFILE_PG_FORWARD_RECORD}" "${T2_PROFILE}" \
    "${T2_CONTEXT}" "${PROJECT_DIR}" "${CONTROL_NS}" control-postgres \
    "${PROFILE_PG_FORWARD_PORT}" 5432; then
    printf '[gfs-real-pg-minikube] ERROR: profile PostgreSQL forward ownership validation or cleanup failed\n' >&2
    return 1
  fi
  PROFILE_PG_FORWARD_PID=''
  PROFILE_PG_FORWARD_RECORD=''
}

verify_profile_postgres() {
  kc -n "${CONTROL_NS}" rollout status deployment/control-postgres --timeout="${TIMEOUT}s" >/dev/null 2>&1 || \
    die 'branch-profile control-postgres did not become Ready'

  local key encoded
  for key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
    encoded="$(kc -n "${CONTROL_NS}" get secret control-postgres -o "jsonpath={.data.${key}}" 2>/dev/null || true)"
    [[ -n "${encoded}" ]] || die "branch-profile control-postgres Secret is missing ${key}"
    printf '%s' "${encoded}" | python3 -c 'import base64,sys; base64.b64decode(sys.stdin.buffer.read(), validate=True)' >/dev/null 2>&1 || \
      die "branch-profile control-postgres Secret key is not valid base64: ${key}"
  done

  PROFILE_PG_FORWARD_PORT="$(choose_local_port)"
  kubectl --context="${CONTEXT}" -n "${CONTROL_NS}" port-forward \
    --address=127.0.0.1 svc/control-postgres "${PROFILE_PG_FORWARD_PORT}:5432" \
    >"${TMP_DIR}/profile-postgres-port-forward.log" 2>&1 &
  PROFILE_PG_FORWARD_PID=$!
  PROFILE_PG_FORWARD_RECORD="${TMP_DIR}/profile-postgres-forward.pid"
  pf_owner_pause 0.2
  if ! pf_owner_record_process "${PROFILE_PG_FORWARD_RECORD}" \
    "${PROFILE_PG_FORWARD_PID}" "${T2_PROFILE}" "${T2_CONTEXT}" \
    "${PROJECT_DIR}" "${CONTROL_NS}" control-postgres \
    "${PROFILE_PG_FORWARD_PORT}" 5432; then
    pf_owner_abort_child "${PROFILE_PG_FORWARD_PID}" "${T2_CONTEXT}" \
      "${CONTROL_NS}" control-postgres "${PROFILE_PG_FORWARD_PORT}" 5432 || true
    die 'branch-profile control-postgres port-forward ownership could not be proven'
  fi
  if ! wait_for_tcp "${PROFILE_PG_FORWARD_PORT}"; then
    sanitize_file "${TMP_DIR}/profile-postgres-port-forward.log"
    cat "${TMP_DIR}/profile-postgres-port-forward.log" >&2 || true
    die 'branch-profile control-postgres port-forward did not become reachable'
  fi
  if [[ "$(pf_owner_process_state "${PROFILE_PG_FORWARD_PID}")" != live ]]; then
    sanitize_file "${TMP_DIR}/profile-postgres-port-forward.log"
    cat "${TMP_DIR}/profile-postgres-port-forward.log" >&2 || true
    die 'branch-profile control-postgres port-forward exited before the GFS lane started'
  fi
  stop_profile_postgres_forward || die 'could not cleanly close the branch-profile PostgreSQL precondition forward'
}

real_postgres_suite_files() {
  local package="$1"
  case "${package}" in
    control-api)
      find "${PROJECT_DIR}/${package}/test" -type f \
        \( -name 'gfs*.realPostgres.integration.test.ts' \
        -o -name 'services.rateLimiter.realPostgres.integration.test.ts' \) -print | sort
      ;;
    gfs-controller)
      find "${PROJECT_DIR}/${package}" -type f \
        -name '*realPostgres.integration.test.ts' -print | sort
      ;;
    *)
      die "unsupported real-Postgres package: ${package}"
      ;;
  esac
}

run_suite() {
  local package="$1" suite_file relative_suite log_file json_file
  local total_files failed_files pending_files total_tests passed_tests pending_tests success reported_files
  local suite_index=0 suite_count=0
  local suite_files=()
  while IFS= read -r suite_file; do
    [[ -n "${suite_file}" ]] || continue
    suite_files+=("${suite_file}")
  done < <(real_postgres_suite_files "${package}")
  suite_count="${#suite_files[@]}"
  (( suite_count > 0 )) || die "no GFS real-Postgres suites found under ${package}"

  printf '[gfs-real-pg-minikube] running %s GFS real-Postgres suites (%s isolated processes)\n' \
    "${package}" "${suite_count}"
  for suite_file in "${suite_files[@]}"; do
    suite_index=$((suite_index + 1))
    relative_suite="${suite_file#"${PROJECT_DIR}/${package}/"}"
    log_file="${TMP_DIR}/${package//\//_}-${suite_index}.log"
    json_file="${TMP_DIR}/${package//\//_}-${suite_index}.json"
    if ! (
      cd "${PROJECT_DIR}/${package}"
      env \
        CONTROL_API_REAL_PG_ADMIN_URL="${ADMIN_DSN}" \
        CONTROL_API_REAL_PG_REQUIRED=1 VITEST_MAX_WORKERS=1 \
        FORCE_COLOR=0 NO_COLOR=1 \
        npm test -- --run --no-file-parallelism --maxWorkers=1 \
          "${relative_suite}" --reporter=json --outputFile="${json_file}"
    ) >"${log_file}" 2>&1; then
      sanitize_file "${log_file}"
      sanitize_file "${json_file}"
      cat "${log_file}" >&2 || true
      cat "${json_file}" >&2 || true
      die "${package}/${relative_suite} real-Postgres gate failed"
    fi

    sanitize_file "${log_file}"
    sanitize_file "${json_file}"
    [[ -s "${json_file}" ]] || die "${package}/${relative_suite} reporter produced no JSON result"
    read -r total_files _ failed_files pending_files total_tests passed_tests pending_tests success reported_files < <(python3 - "${json_file}" "${PROJECT_DIR}/${package}" "${relative_suite}" <<'PY'
import json
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text())
package_root = Path(sys.argv[2]).resolve()
expected = (package_root / sys.argv[3]).resolve()
test_results = result.get("testResults")
reported = []
if isinstance(test_results, list):
    for item in test_results:
        name = item.get("name") if isinstance(item, dict) else None
        if isinstance(name, str) and name:
            candidate = Path(name)
            reported.append((candidate if candidate.is_absolute() else package_root / candidate).resolve())

print(
    result.get("numTotalTestSuites", 0),
    result.get("numPassedTestSuites", 0),
    result.get("numFailedTestSuites", 0),
    result.get("numPendingTestSuites", 0),
    result.get("numTotalTests", 0),
    result.get("numPassedTests", 0),
    result.get("numPendingTests", 0),
    str(bool(result.get("success"))).lower(),
    len(reported) if reported == [expected] else -1,
)
PY
    )
    if [[ "${success}" != 'true' || "${total_files}" -le 0 || "${failed_files}" -ne 0 ||
          "${pending_files}" -ne 0 || "${total_tests}" -le 0 ||
          "${passed_tests}" -ne "${total_tests}" || "${pending_tests}" -ne 0 ||
          "${reported_files}" -ne 1 ]]; then
      cat "${log_file}" >&2 || true
      cat "${json_file}" >&2 || true
      die "${package}/${relative_suite} reporter did not pass all tests"
    fi
    printf '[gfs-real-pg-minikube] PASS %s (%s tests, 0 skipped)\n' \
      "${relative_suite}" "${passed_tests}"
  done
  printf '[gfs-real-pg-minikube] PASS %s (%s suites, no skips)\n' "${package}" "${suite_count}"
}

TMP_DIR="$(mktemp -d)"
ISOLATED_CONTAINER=""
ISOLATED_PORT=''
ADMIN_DSN=''
PROFILE_PG_FORWARD_PORT=''
GFS_DOCKER_ENV_PREPARED=false
GFS_RESTORE_REQUIRED=false
restore_gfs_runtime_credentials() {
  # The reader-role real-Postgres suite exercises the production role names,
  # which are cluster-global even though its fixture database is temporary.
  # Restore the branch profile before this gate exits so a failed or interrupted
  # T1 run cannot leave GFSC in NOLOGIN and poison the following T2 journey.
  if ! kc -n gfs get secret gfs-controller-db >/dev/null 2>&1; then
    printf '[gfs-real-pg-minikube] ERROR: required gfs-controller-db Secret is missing or unreadable; refusing to finish with GFS credentials unreconciled\n' >&2
    return 1
  fi
  if ! T2_SKIP_LOCK=true T2_LOCK_TOKEN="${T2_LOCK_TOKEN}" \
    T2_PROJECT_DIR="${T2_PROJECT_DIR}" T2_PROFILE="${T2_PROFILE}" T2_CONTEXT="${T2_CONTEXT}" \
    T2_PROFILE_ROOT="${T2_PROFILE_ROOT}" T2_PROFILE_ENV="${T2_PROFILE_ENV}" T2_PORTS_ENV="${T2_PORTS_ENV}" \
    GFS_RESTORE_ACTIVE_NOLOGIN=true CONTEXT="${CONTEXT}" \
    bash "${PROJECT_DIR}/deploy/scripts/reconcile-gfs-deploy-credentials.sh"; then
    printf '[gfs-real-pg-minikube] ERROR: failed to restore branch-profile GFS credentials\n' >&2
    return 1
  fi
}
stop_isolated_postgres() {
  [[ -n "${ISOLATED_CONTAINER}" ]] || return 0
  [[ "${GFS_DOCKER_ENV_PREPARED}" == true ]] || return 1
  if docker_cli_run_public gfs-t1-postgres-remove \
    "${GFS_DOCKER_REMOVE_TIMEOUT_SECONDS}" \
    docker rm -f "${ISOLATED_CONTAINER}" >/dev/null 2>&1; then
    ISOLATED_CONTAINER=''
    return 0
  fi
  return 1
}
prepare_gfs_docker() {
  docker_cli_env_validate_seconds GFS_DOCKER_RUN_TIMEOUT_SECONDS \
    "${GFS_DOCKER_RUN_TIMEOUT_SECONDS}" 3600 || return $?
  docker_cli_env_validate_seconds GFS_DOCKER_EXEC_TIMEOUT_SECONDS \
    "${GFS_DOCKER_EXEC_TIMEOUT_SECONDS}" 300 || return $?
  docker_cli_env_validate_seconds GFS_DOCKER_REMOVE_TIMEOUT_SECONDS \
    "${GFS_DOCKER_REMOVE_TIMEOUT_SECONDS}" 300 || return $?
  docker_cli_env_prepare false || return $?
  GFS_DOCKER_ENV_PREPARED=true
}
cleanup_gfs_docker_env() {
  [[ "${GFS_DOCKER_ENV_PREPARED}" == true ]] || return 0
  if docker_cli_env_cleanup; then
    GFS_DOCKER_ENV_PREPARED=false
    return 0
  fi
  return 1
}
cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM
  if ! stop_profile_postgres_forward; then status=1; fi
  if ! stop_isolated_postgres; then status=1; fi
  if ! cleanup_gfs_docker_env; then status=1; fi
  if [ "${GFS_RESTORE_REQUIRED}" = true ] && ! restore_gfs_runtime_credentials; then status=1; fi
  if ! rm -rf "${TMP_DIR}"; then status=1; fi
  if ! t2_lock_release "${status}"; then status=1; fi
  exit "${status}"
}
trap cleanup EXIT

choose_local_port() {
  python3 - <<'PY'
import socket

sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

if ! real_pg_local_preflight "${PROJECT_DIR}" true; then
  die "${REAL_PG_PREFLIGHT_ERROR_CODE}: ${REAL_PG_PREFLIGHT_ERROR_MESSAGE}"
fi
verify_branch_gate
verify_profile_postgres

ISOLATED_PORT="$(choose_local_port)"
ISOLATED_CONTAINER="evenfire-gfs-t1-pg-$$"
prepare_gfs_docker || die 'isolated GFS Docker runtime could not be prepared safely'
docker_cli_run_public gfs-t1-postgres-run "${GFS_DOCKER_RUN_TIMEOUT_SECONDS}" \
  docker run -d --rm --name "${ISOLATED_CONTAINER}" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p "127.0.0.1:${ISOLATED_PORT}:5432" \
  "${ISOLATED_PG_IMAGE}" >/dev/null || die 'isolated GFS PostgreSQL container failed to start'
wait_for_tcp "${ISOLATED_PORT}" || die 'isolated GFS PostgreSQL did not become reachable'
deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  if docker_cli_run_public gfs-t1-postgres-ready-probe \
    "${GFS_DOCKER_EXEC_TIMEOUT_SECONDS}" \
    docker exec "${ISOLATED_CONTAINER}" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker_cli_run_public gfs-t1-postgres-ready-final \
  "${GFS_DOCKER_EXEC_TIMEOUT_SECONDS}" \
  docker exec "${ISOLATED_CONTAINER}" pg_isready -U postgres >/dev/null 2>&1 ||
  die 'isolated GFS PostgreSQL did not become ready'
ADMIN_DSN="$(printf 'postgresql://postgres@%s:%s/postgres' "${ISOLATED_HOST}" "${ISOLATED_PORT}")"

GFS_RESTORE_REQUIRED=true
run_suite control-api
run_suite gfs-controller
printf '[gfs-real-pg-minikube] T1 PASS: real PostgreSQL executed against validated Minikube profile %s\n' "${CONTEXT}"
