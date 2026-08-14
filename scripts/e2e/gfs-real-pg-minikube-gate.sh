#!/usr/bin/env bash
# Run the real-Postgres T1 suites against the control-postgres instance in an
# explicitly validated, branch-owned Minikube profile.
#
# This runner is deliberately separate from CI: CI supplies its own ephemeral
# Postgres DSN, while this gate obtains a short-lived localhost port-forward to
# the selected Minikube service. It never discovers or accepts a GKE context.
set -euo pipefail
set +x

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
CONTEXT="${CONTEXT:-${MINIKUBE_PROFILE:-}}"
SYNC_CONFIGMAP="${CLERUM_PRE_GATE_SYNC_CONFIGMAP:-clerum-pre-gate-sync-state}"
CONTROL_NS="${CONTROL_NS:-control-plane}"
PG_SERVICE="${PG_SERVICE:-control-postgres}"
PG_SECRET="${PG_SECRET:-control-postgres}"
TIMEOUT="${TIMEOUT:-120}"
PORTS_ENV="${CLERUM_PROFILE_PORTS_ENV:-${HOME}/.cache/clerum/minikube-profiles/${CONTEXT}/ports.env}"

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

is_branch_profile() {
  [[ "${1}" =~ ^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]]
}

reject_unsafe_context() {
  [[ -n "${CONTEXT}" ]] || die 'CONTEXT or MINIKUBE_PROFILE is required'
  case "${CONTEXT}" in
    gke_*) die "refusing non-Minikube or production context: ${CONTEXT}" ;;
    *prod*) die "refusing non-Minikube or production context: ${CONTEXT}" ;;
  esac
  if [[ "${CONTEXT}" != "clerum-test" ]] && ! is_branch_profile "${CONTEXT}"; then
    die "context is not an allowed local/branch profile: ${CONTEXT}"
  fi
}

verify_profile_ownership() {
  if ! is_branch_profile "${CONTEXT}"; then
    return 0
  fi
  [[ -f "${PORTS_ENV}" ]] || die "branch profile ports.env is missing: ${PORTS_ENV}"

  local profile_name profile_repo profile_dir
  profile_dir="${PORTS_ENV%/ports.env}"
  profile_name="$(awk -F= '$1 == "PROFILE" { print substr($0, index($0, "=") + 1); exit }' "${profile_dir}/profile.env" 2>/dev/null || true)"
  profile_repo="$(awk -F= '$1 == "REPO_DIR" { print substr($0, index($0, "=") + 1); exit }' "${profile_dir}/profile.env" 2>/dev/null || true)"
  [[ "${profile_name}" == "${CONTEXT}" ]] || die "ports.env/profile marker belongs to '${profile_name:-unknown}', not ${CONTEXT}"
  [[ -n "${profile_repo}" ]] || die 'profile marker has no REPO_DIR'
  [[ "$(cd -- "${profile_repo}" 2>/dev/null && pwd -P)" == "${PROJECT_DIR}" ]] || \
    die "profile marker is owned by another worktree: ${profile_repo}"
}

verify_clean_and_sync_marker() {
  local head worktree_id marker_json
  [[ -z "$(git -C "${PROJECT_DIR}" status --porcelain)" ]] || \
    die 'worktree is dirty; run pre-gate-sync after committing or cleanly restoring changes'
  head="$(git -C "${PROJECT_DIR}" rev-parse --verify HEAD)"
  worktree_id="$(printf '%s' "${PROJECT_DIR}" | shasum | awk '{print $1}')"
  marker_json="$(kc -n "${CONTROL_NS}" get configmap "${SYNC_CONFIGMAP}" -o json 2>/dev/null)" || \
    die "validated pre-gate marker is missing: ${CONTROL_NS}/${SYNC_CONFIGMAP}"

  python3 - "${worktree_id}" "${head}" "${marker_json}" <<'PY'
import json
import sys

expected_worktree, expected_head, marker_json = sys.argv[1:]
payload = json.loads(marker_json)
data = payload.get("data") or {}
if not data.get("clusterFingerprint"):
    raise SystemExit("pre-gate marker has no cluster fingerprint")
if data.get("worktreeId") != expected_worktree:
    raise SystemExit("pre-gate marker belongs to another worktree")
if data.get("gitHead") != expected_head:
    raise SystemExit("pre-gate marker does not match the current HEAD")
PY
}

secret_value() {
  local key="$1" encoded
  encoded="$(kc -n "${CONTROL_NS}" get secret "${PG_SECRET}" -o "jsonpath={.data.${key}}" 2>/dev/null)" || \
    die "cannot read ${CONTROL_NS}/${PG_SECRET}.${key}"
  [[ -n "${encoded}" ]] || die "${CONTROL_NS}/${PG_SECRET}.${key} is empty"
  printf '%s' "${encoded}" | python3 -c 'import base64,sys; print(base64.b64decode(sys.stdin.read(), validate=True).decode(), end="")'
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
  local total_files failed_files pending_files total_tests passed_tests pending_tests success
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
        CONTROL_API_REAL_PG_REQUIRED=1 \
        FORCE_COLOR=0 NO_COLOR=1 \
        npm test -- --run "${relative_suite}" --reporter=json --outputFile="${json_file}"
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
    read -r total_files _ failed_files pending_files total_tests passed_tests pending_tests success < <(python3 - "${json_file}" <<'PY'
import json
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text())

print(
    result.get("numTotalTestSuites", 0),
    result.get("numPassedTestSuites", 0),
    result.get("numFailedTestSuites", 0),
    result.get("numPendingTestSuites", 0),
    result.get("numTotalTests", 0),
    result.get("numPassedTests", 0),
    result.get("numPendingTests", 0),
    str(bool(result.get("success"))).lower(),
)
PY
    )
    if [[ "${success}" != 'true' || "${total_files}" -le 0 || "${failed_files}" -ne 0 ||
          "${pending_files}" -ne 0 || "${total_tests}" -le 0 ||
          "${passed_tests}" -ne "${total_tests}" || "${pending_tests}" -ne 0 ]]; then
      cat "${log_file}" >&2 || true
      cat "${json_file}" >&2 || true
      die "${package}/${relative_suite} reporter did not pass all tests"
    fi
    printf '[gfs-real-pg-minikube] PASS %s (%s tests, 0 skipped)\n' \
      "${relative_suite}" "${passed_tests}"
  done
  printf '[gfs-real-pg-minikube] PASS %s (%s suites, no skips)\n' "${package}" "${suite_count}"
}

require_command git kubectl npm python3 shasum
reject_unsafe_context
verify_profile_ownership
verify_clean_and_sync_marker
kc -n "${CONTROL_NS}" get service "${PG_SERVICE}" >/dev/null || die "${CONTROL_NS}/${PG_SERVICE} service is missing"
kc -n "${CONTROL_NS}" rollout status deployment/control-postgres --timeout="${TIMEOUT}s" >/dev/null || \
  die 'control-postgres is not Ready in the validated profile'

PG_USER="$(secret_value POSTGRES_USER)"
PG_PASSWORD="$(secret_value POSTGRES_PASSWORD)"
PG_DATABASE="$(secret_value POSTGRES_DB)"
[[ -n "${PG_USER}" && -n "${PG_PASSWORD}" && -n "${PG_DATABASE}" ]] || die 'control-postgres secret is incomplete'

TMP_DIR="$(mktemp -d)"
PORT_FORWARD_PID=''
LOCAL_PORT=''
restore_gfs_runtime_credentials() {
  # The reader-role real-Postgres suite exercises the production role names,
  # which are cluster-global even though its fixture database is temporary.
  # Restore the branch profile before this gate exits so a failed or interrupted
  # T1 run cannot leave GFSC in NOLOGIN and poison the following T2 journey.
  if ! kc -n gfs get secret gfs-controller-db >/dev/null 2>&1; then
    return 0
  fi
  if ! GFS_RESTORE_ACTIVE_NOLOGIN=true CONTEXT="${CONTEXT}" \
    bash "${PROJECT_DIR}/deploy/scripts/reconcile-gfs-deploy-credentials.sh"; then
    printf '[gfs-real-pg-minikube] ERROR: failed to restore branch-profile GFS credentials\n' >&2
    return 1
  fi
}
stop_port_forward() {
  if [[ -z "${PORT_FORWARD_PID}" ]] || ! kill -0 "${PORT_FORWARD_PID}" >/dev/null 2>&1; then
    PORT_FORWARD_PID=''
    return 0
  fi
  local command_line
  command_line="$(ps -p "${PORT_FORWARD_PID}" -o command= 2>/dev/null || true)"
  if [[ "${command_line}" == *'port-forward'* &&
        "${command_line}" == *"svc/${PG_SERVICE}"* &&
        "${command_line}" == *"${LOCAL_PORT}:5432"* ]]; then
    kill "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
    wait "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
  fi
  PORT_FORWARD_PID=''
}
cleanup() {
  local status=$?
  stop_port_forward
  if ! restore_gfs_runtime_credentials; then
    status=1
  fi
  rm -rf "${TMP_DIR}"
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

port_forward_ready=false
for _attempt in 1 2 3 4 5; do
  LOCAL_PORT="$(choose_local_port)"
  kubectl --context="${CONTEXT}" -n "${CONTROL_NS}" port-forward \
    --address=127.0.0.1 "svc/${PG_SERVICE}" "${LOCAL_PORT}:5432" \
    >"${TMP_DIR}/port-forward.log" 2>&1 &
  PORT_FORWARD_PID=$!
  if wait_for_tcp "${LOCAL_PORT}"; then
    port_forward_ready=true
    break
  fi
  stop_port_forward
done
[[ "${port_forward_ready}" == true ]] || {
  cat "${TMP_DIR}/port-forward.log" >&2 || true
  die 'Minikube PostgreSQL port-forward did not become reachable'
}

ADMIN_DSN="$(printf '%s\0%s\0%s' "${PG_USER}" "${PG_PASSWORD}" "${LOCAL_PORT}" | python3 -c '
from urllib.parse import quote
import sys

user, password, port = sys.stdin.buffer.read().split(b"\0")[:3]
user = user.decode()
password = password.decode()
port = port.decode()
print("postgresql://{}:{}@127.0.0.1:{}/postgres".format(
    quote(user, safe=""), quote(password, safe=""), port
), end="")
')"
unset PG_USER PG_PASSWORD PG_DATABASE
[[ -n "${ADMIN_DSN}" ]] || die 'constructed Minikube PostgreSQL admin DSN is empty'

run_suite control-api
run_suite gfs-controller
printf '[gfs-real-pg-minikube] T1 PASS: real PostgreSQL executed against validated Minikube profile %s\n' "${CONTEXT}"
