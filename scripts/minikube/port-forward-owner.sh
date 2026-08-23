#!/usr/bin/env bash
# Exact ownership records and fail-closed cleanup for kubectl port-forwards.
# This file is a library; callers retain lifecycle and health-check policy.

PF_OWNER_RECORD_VERSION=1
PF_OWNER_ADDRESS=127.0.0.1

pf_owner_error() {
  printf 'PORT_FORWARD_OWNERSHIP_ERROR: %s\n' "$*" >&2
  return 1
}

pf_owner_validate_pid() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

pf_owner_validate_port() {
  local port="${1:-}"
  [[ "${port}" =~ ^[0-9]{1,5}$ ]] || return 1
  (( 10#${port} >= 1 && 10#${port} <= 65535 ))
}

pf_owner_validate_binding() {
  local profile="${1:-}" context="${2:-}" worktree="${3:-}"
  local namespace="${4:-}" service="${5:-}" local_port="${6:-}"
  local remote_port="${7:-}" canonical_worktree

  [[ "${profile}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||
    pf_owner_error "invalid profile binding: ${profile:-<empty>}" || return 1
  [[ "${context}" =~ ^[A-Za-z0-9][A-Za-z0-9._:@/-]*$ ]] ||
    pf_owner_error "invalid context binding: ${context:-<empty>}" || return 1
  [[ "${namespace}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] ||
    pf_owner_error "invalid namespace binding: ${namespace:-<empty>}" || return 1
  [[ "${service}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] ||
    pf_owner_error "invalid service binding: ${service:-<empty>}" || return 1
  pf_owner_validate_port "${local_port}" ||
    pf_owner_error "invalid local port binding: ${local_port:-<empty>}" || return 1
  pf_owner_validate_port "${remote_port}" ||
    pf_owner_error "invalid remote port binding: ${remote_port:-<empty>}" || return 1
  [[ -n "${worktree}" && -d "${worktree}" ]] ||
    pf_owner_error "worktree binding is missing: ${worktree:-<empty>}" || return 1
  canonical_worktree="$(cd -- "${worktree}" && pwd -P)" ||
    pf_owner_error "cannot canonicalize worktree binding: ${worktree}" || return 1
  [[ "${worktree}" == "${canonical_worktree}" ]] ||
    pf_owner_error "worktree binding is not canonical: ${worktree}" || return 1
  [[ "${worktree}" != *$'\n'* && "${worktree}" != *$'\r'* && "${worktree}" != *$'\t'* ]] ||
    pf_owner_error 'worktree binding contains a control character' || return 1
}

pf_owner_validate_process_start() {
  local process_start="${1:-}"
  [[ -n "${process_start}" && "${process_start}" != unavailable ]] || return 1
  [[ "${process_start}" != *$'\n'* && "${process_start}" != *$'\r'* &&
     "${process_start}" != *$'\t'* ]]
}

pf_owner_process_state() {
  local pid="$1" observed process_status status
  if kill -0 "${pid}" 2>/dev/null; then
    # A terminated child can remain as a zombie until its owning shell reaps
    # it. Treat that state as safe-to-reap instead of calling blocking `wait`
    # while an actually live process may still be ignoring TERM.
    process_status="$(LC_ALL=C ps -ww -p "${pid}" -o stat= 2>/dev/null || true)"
    process_status="$(printf '%s' "${process_status}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "${process_status}" in
      Z*) printf 'dead\n'; return 0 ;;
    esac
    printf 'live\n'
    return 0
  fi

  status=0
  observed="$(LC_ALL=C ps -ww -p "${pid}" -o pid= 2>/dev/null)" || status=$?
  observed="$(printf '%s' "${observed}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [[ "${observed}" == "${pid}" ]]; then
    printf 'live\n'
  elif [[ "${status}" -eq 1 && -z "${observed}" ]]; then
    printf 'dead\n'
  else
    printf 'unknown\n'
  fi
}

pf_owner_process_start() {
  local pid="$1" process_start
  process_start="$(LC_ALL=C TZ=UTC0 ps -ww -p "${pid}" -o lstart= 2>/dev/null)" || return 1
  process_start="$(printf '%s' "${process_start}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  pf_owner_validate_process_start "${process_start}" || return 1
  printf '%s\n' "${process_start}"
}

pf_owner_process_command() {
  local pid="$1" command_line
  command_line="$(LC_ALL=C ps -ww -p "${pid}" -o command= 2>/dev/null)" || return 1
  command_line="$(printf '%s' "${command_line}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -n "${command_line}" && "${command_line}" != *$'\n'* && "${command_line}" != *$'\r'* ]] || return 1
  printf '%s\n' "${command_line}"
}

pf_owner_command_matches() {
  local command_line="$1" context="$2" namespace="$3" service="$4"
  local local_port="$5" remote_port="$6"
  local -a argv=()

  read -r -a argv <<<"${command_line}"
  (( ${#argv[@]} == 8 )) || return 1
  [[ "${argv[0]##*/}" == kubectl &&
     "${argv[1]}" == "--context=${context}" &&
     "${argv[2]}" == -n &&
     "${argv[3]}" == "${namespace}" &&
     "${argv[4]}" == port-forward &&
     "${argv[5]}" == "--address=${PF_OWNER_ADDRESS}" &&
     "${argv[6]}" == "svc/${service}" &&
     "${argv[7]}" == "${local_port}:${remote_port}" ]]
}

pf_owner_signal_process() {
  local pid="$1" signal="$2"
  kill "-${signal}" -- "${pid}"
}

pf_owner_reap_process() {
  wait "$1" 2>/dev/null || true
}

pf_owner_pause() {
  sleep "$1"
}

pf_owner_validate_termination_policy() {
  local attempts="$1" delay="$2"
  [[ "${attempts}" =~ ^[1-9][0-9]*$ ]] && (( 10#${attempts} <= 200 )) ||
    pf_owner_error 'termination attempts must be an integer from 1 to 200' || return 1
  [[ "${delay}" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
    pf_owner_error 'termination delay must be a number from 0 to 1 second' || return 1
  awk -v delay="${delay}" 'BEGIN { exit !(delay >= 0 && delay <= 1) }' ||
    pf_owner_error 'termination delay must be a number from 0 to 1 second' || return 1
}

pf_owner_write_record_atomic() {
  local pidfile="$1" pid="$2" process_start="$3" profile="$4"
  local context="$5" worktree="$6" namespace="$7" service="$8"
  local local_port="$9" remote_port="${10}"
  local pid_dir tmp_file

  pf_owner_validate_pid "${pid}" || pf_owner_error "invalid PID: ${pid:-<empty>}" || return 1
  pf_owner_validate_process_start "${process_start}" ||
    pf_owner_error "process-start identity is unavailable for PID ${pid}" || return 1
  pf_owner_validate_binding "${profile}" "${context}" "${worktree}" \
    "${namespace}" "${service}" "${local_port}" "${remote_port}" || return 1

  pid_dir="$(dirname -- "${pidfile}")"
  [[ -d "${pid_dir}" && ! -L "${pid_dir}" ]] ||
    pf_owner_error "pid directory is missing or unsafe: ${pid_dir}" || return 1
  [[ ! -L "${pidfile}" ]] ||
    pf_owner_error "refusing to replace a symlinked pidfile: ${pidfile}" || return 1

  tmp_file="$(mktemp "${pidfile}.tmp.XXXXXX")" || {
    pf_owner_error "cannot create an atomic pidfile beside ${pidfile}"
    return 1
  }
  if ! chmod 600 "${tmp_file}" || ! {
    printf '%s\n' "${pid}"
    printf 'PORT_FORWARD_OWNER_VERSION=%s\n' "${PF_OWNER_RECORD_VERSION}"
    printf 'PID=%s\n' "${pid}"
    printf 'PROCESS_START=%s\n' "${process_start}"
    printf 'PROFILE=%s\n' "${profile}"
    printf 'CONTEXT=%s\n' "${context}"
    printf 'WORKTREE=%s\n' "${worktree}"
    printf 'NAMESPACE=%s\n' "${namespace}"
    printf 'SERVICE=%s\n' "${service}"
    printf 'LOCAL_PORT=%s\n' "${local_port}"
    printf 'REMOTE_PORT=%s\n' "${remote_port}"
    printf 'ADDRESS=%s\n' "${PF_OWNER_ADDRESS}"
  } >"${tmp_file}"; then
    rm -f -- "${tmp_file}"
    pf_owner_error "cannot write ownership record: ${pidfile}"
    return 1
  fi
  # Publish with an atomic, no-clobber hard link. A concurrent owner that
  # appeared after cleanup must make this launch fail; replacing its record
  # would orphan a live process and destroy the evidence needed to stop safely.
  if ! ln "${tmp_file}" "${pidfile}" 2>/dev/null; then
    rm -f -- "${tmp_file}"
    pf_owner_error "cannot publish ownership record without replacing an existing owner: ${pidfile}"
    return 1
  fi
  if ! rm -f -- "${tmp_file}"; then
    printf 'PORT_FORWARD_OWNERSHIP_WARN: canonical record is valid, but temporary hard link remains: %s\n' \
      "${tmp_file}" >&2
  fi
}

pf_owner_reset_record() {
  PF_OWNER_RECORD_FIRST_PID=''
  PF_OWNER_RECORD_VERSION_VALUE=''
  PF_OWNER_RECORD_PID=''
  PF_OWNER_RECORD_START=''
  PF_OWNER_RECORD_PROFILE=''
  PF_OWNER_RECORD_CONTEXT=''
  PF_OWNER_RECORD_WORKTREE=''
  PF_OWNER_RECORD_NAMESPACE=''
  PF_OWNER_RECORD_SERVICE=''
  PF_OWNER_RECORD_LOCAL_PORT=''
  PF_OWNER_RECORD_REMOTE_PORT=''
  PF_OWNER_RECORD_ADDRESS=''
}

pf_owner_read_record() {
  local pidfile="$1" line key value seen='|'
  pf_owner_reset_record
  [[ -f "${pidfile}" && -r "${pidfile}" && ! -L "${pidfile}" ]] ||
    pf_owner_error "pidfile is missing, unreadable, or a symlink: ${pidfile}" || return 1

  IFS= read -r PF_OWNER_RECORD_FIRST_PID <"${pidfile}" ||
    pf_owner_error "pidfile is empty: ${pidfile}" || return 1
  pf_owner_validate_pid "${PF_OWNER_RECORD_FIRST_PID}" ||
    pf_owner_error "pidfile has no numeric first-line PID: ${pidfile}" || return 1

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == *=* && "${line}" != *$'\r'* && "${line}" != *$'\t'* ]] ||
      pf_owner_error "pidfile has a malformed structured line: ${pidfile}" || return 1
    key="${line%%=*}"
    value="${line#*=}"
    case "${seen}" in
      *"|${key}|"*) pf_owner_error "pidfile repeats ${key}: ${pidfile}"; return 1 ;;
    esac
    seen="${seen}${key}|"
    case "${key}" in
      PORT_FORWARD_OWNER_VERSION) PF_OWNER_RECORD_VERSION_VALUE="${value}" ;;
      PID) PF_OWNER_RECORD_PID="${value}" ;;
      PROCESS_START) PF_OWNER_RECORD_START="${value}" ;;
      PROFILE) PF_OWNER_RECORD_PROFILE="${value}" ;;
      CONTEXT) PF_OWNER_RECORD_CONTEXT="${value}" ;;
      WORKTREE) PF_OWNER_RECORD_WORKTREE="${value}" ;;
      NAMESPACE) PF_OWNER_RECORD_NAMESPACE="${value}" ;;
      SERVICE) PF_OWNER_RECORD_SERVICE="${value}" ;;
      LOCAL_PORT) PF_OWNER_RECORD_LOCAL_PORT="${value}" ;;
      REMOTE_PORT) PF_OWNER_RECORD_REMOTE_PORT="${value}" ;;
      ADDRESS) PF_OWNER_RECORD_ADDRESS="${value}" ;;
      *) pf_owner_error "pidfile contains unsupported key ${key}: ${pidfile}"; return 1 ;;
    esac
  done < <(sed -n '2,$p' "${pidfile}")

  [[ "${PF_OWNER_RECORD_VERSION_VALUE}" == "${PF_OWNER_RECORD_VERSION}" ]] ||
    pf_owner_error "pidfile has an unsupported record version: ${pidfile}" || return 1
  [[ "${PF_OWNER_RECORD_PID}" == "${PF_OWNER_RECORD_FIRST_PID}" ]] ||
    pf_owner_error "pidfile PID fields disagree: ${pidfile}" || return 1
  pf_owner_validate_process_start "${PF_OWNER_RECORD_START}" ||
    pf_owner_error "pidfile has no exact process-start identity: ${pidfile}" || return 1
  [[ "${PF_OWNER_RECORD_ADDRESS}" == "${PF_OWNER_ADDRESS}" ]] ||
    pf_owner_error "pidfile address binding is not ${PF_OWNER_ADDRESS}: ${pidfile}" || return 1
  pf_owner_validate_binding "${PF_OWNER_RECORD_PROFILE}" "${PF_OWNER_RECORD_CONTEXT}" \
    "${PF_OWNER_RECORD_WORKTREE}" "${PF_OWNER_RECORD_NAMESPACE}" \
    "${PF_OWNER_RECORD_SERVICE}" "${PF_OWNER_RECORD_LOCAL_PORT}" \
    "${PF_OWNER_RECORD_REMOTE_PORT}" || return 1
}

pf_owner_record_matches() {
  local profile="$1" context="$2" worktree="$3" namespace="$4"
  local service="$5" local_port="$6" remote_port="$7"
  [[ "${PF_OWNER_RECORD_PROFILE}" == "${profile}" &&
     "${PF_OWNER_RECORD_CONTEXT}" == "${context}" &&
     "${PF_OWNER_RECORD_WORKTREE}" == "${worktree}" &&
     "${PF_OWNER_RECORD_NAMESPACE}" == "${namespace}" &&
     "${PF_OWNER_RECORD_SERVICE}" == "${service}" &&
     "${PF_OWNER_RECORD_LOCAL_PORT}" == "${local_port}" &&
     "${PF_OWNER_RECORD_REMOTE_PORT}" == "${remote_port}" ]]
}

pf_owner_remove_dead_record() {
  local pidfile="$1"
  [[ ! -L "${pidfile}" ]] || pf_owner_error "refusing to remove symlinked pidfile: ${pidfile}" || return 1
  rm -f -- "${pidfile}"
}

pf_owner_record_process() {
  local pidfile="$1" pid="$2" profile="$3" context="$4" worktree="$5"
  local namespace="$6" service="$7" local_port="$8" remote_port="$9"
  local state start_before start_after command_line

  pf_owner_validate_binding "${profile}" "${context}" "${worktree}" \
    "${namespace}" "${service}" "${local_port}" "${remote_port}" || return 1
  pf_owner_validate_pid "${pid}" || pf_owner_error "invalid PID: ${pid:-<empty>}" || return 1
  state="$(pf_owner_process_state "${pid}")"
  [[ "${state}" == live ]] ||
    pf_owner_error "PID ${pid} is not live while recording ownership (${state})" || return 1
  start_before="$(pf_owner_process_start "${pid}")" ||
    pf_owner_error "cannot capture process-start identity for PID ${pid}" || return 1
  command_line="$(pf_owner_process_command "${pid}")" ||
    pf_owner_error "cannot inspect kubectl argv for PID ${pid}" || return 1
  pf_owner_command_matches "${command_line}" "${context}" "${namespace}" \
    "${service}" "${local_port}" "${remote_port}" ||
    pf_owner_error "PID ${pid} does not have the exact expected kubectl argv" || return 1
  start_after="$(pf_owner_process_start "${pid}")" ||
    pf_owner_error "cannot recheck process-start identity for PID ${pid}" || return 1
  [[ "${start_before}" == "${start_after}" ]] ||
    pf_owner_error "PID ${pid} changed identity while ownership was recorded" || return 1
  pf_owner_write_record_atomic "${pidfile}" "${pid}" "${start_before}" \
    "${profile}" "${context}" "${worktree}" "${namespace}" "${service}" \
    "${local_port}" "${remote_port}"
}

pf_owner_cleanup_record() {
  local pidfile="$1" profile="$2" context="$3" worktree="$4"
  local namespace="$5" service="$6" local_port="$7" remote_port="$8"
  local pid state actual_start command_line attempts delay index

  pf_owner_validate_binding "${profile}" "${context}" "${worktree}" \
    "${namespace}" "${service}" "${local_port}" "${remote_port}" || return 1
  [[ -e "${pidfile}" || -L "${pidfile}" ]] || return 0
  [[ ! -L "${pidfile}" ]] ||
    pf_owner_error "refusing to inspect or remove a symlinked pidfile: ${pidfile}" || return 1
  IFS= read -r pid <"${pidfile}" ||
    pf_owner_error "refusing to remove an empty pidfile: ${pidfile}" || return 1
  pf_owner_validate_pid "${pid}" ||
    pf_owner_error "refusing to remove a pidfile without a numeric PID: ${pidfile}" || return 1

  state="$(pf_owner_process_state "${pid}")"
  case "${state}" in
    dead)
      pf_owner_reap_process "${pid}"
      pf_owner_remove_dead_record "${pidfile}"
      return
      ;;
    live) ;;
    *) pf_owner_error "cannot establish whether PID ${pid} is live; leaving ${pidfile}"; return 1 ;;
  esac

  pf_owner_read_record "${pidfile}" || return 1
  pf_owner_record_matches "${profile}" "${context}" "${worktree}" \
    "${namespace}" "${service}" "${local_port}" "${remote_port}" ||
    pf_owner_error "live PID ${pid} belongs to a different profile, context, worktree, service, or port binding" || return 1

  actual_start="$(pf_owner_process_start "${pid}")" ||
    pf_owner_error "cannot re-read process-start identity for live PID ${pid}" || return 1
  [[ "${actual_start}" == "${PF_OWNER_RECORD_START}" ]] ||
    pf_owner_error "live PID ${pid} has a different process-start identity" || return 1
  command_line="$(pf_owner_process_command "${pid}")" ||
    pf_owner_error "cannot inspect kubectl argv for live PID ${pid}" || return 1
  pf_owner_command_matches "${command_line}" "${context}" "${namespace}" \
    "${service}" "${local_port}" "${remote_port}" ||
    pf_owner_error "live PID ${pid} does not have the exact recorded kubectl argv" || return 1
  actual_start="$(pf_owner_process_start "${pid}")" ||
    pf_owner_error "cannot recheck process-start identity for live PID ${pid}" || return 1
  [[ "${actual_start}" == "${PF_OWNER_RECORD_START}" ]] ||
    pf_owner_error "live PID ${pid} changed identity before cleanup" || return 1

  attempts="${PF_OWNER_TERMINATE_ATTEMPTS:-20}"
  delay="${PF_OWNER_TERMINATE_DELAY:-0.05}"
  pf_owner_validate_termination_policy "${attempts}" "${delay}" || return 1

  if ! pf_owner_signal_process "${pid}" TERM 2>/dev/null; then
    state="$(pf_owner_process_state "${pid}")"
    [[ "${state}" == dead ]] ||
      pf_owner_error "TERM failed for exact owned PID ${pid}; leaving ${pidfile}" || return 1
  fi
  for ((index = 0; index < attempts; index += 1)); do
    state="$(pf_owner_process_state "${pid}")"
    case "${state}" in
      dead)
        pf_owner_reap_process "${pid}"
        pf_owner_remove_dead_record "${pidfile}"
        return
        ;;
      live)
        actual_start="$(pf_owner_process_start "${pid}")" ||
          pf_owner_error "cannot recheck live PID ${pid} after TERM; leaving ${pidfile}" || return 1
        [[ "${actual_start}" == "${PF_OWNER_RECORD_START}" ]] ||
          pf_owner_error "PID ${pid} was reused after TERM; leaving ${pidfile}" || return 1
        ;;
      *)
        pf_owner_error "process state became ambiguous after TERM for PID ${pid}; leaving ${pidfile}"
        return 1
        ;;
    esac
    pf_owner_pause "${delay}"
  done
  pf_owner_error "exact owned PID ${pid} did not exit after TERM; leaving ${pidfile}"
}

pf_owner_abort_child() {
  local pid="$1" context="$2" namespace="$3" service="$4"
  local local_port="$5" remote_port="$6" job_pid command_line state found=false
  local process_start actual_start attempts delay index signal

  pf_owner_validate_pid "${pid}" || return 1
  while IFS= read -r job_pid; do
    if [[ "${job_pid}" == "${pid}" ]]; then
      found=true
      break
    fi
  done < <(jobs -pr)
  if [[ "${found}" != true ]]; then
    state="$(pf_owner_process_state "${pid}")"
    [[ "${state}" == dead ]] && return 0
    pf_owner_error "unrecorded PID ${pid} is not a current shell child; refusing to signal it"
    return 1
  fi

  command_line="$(pf_owner_process_command "${pid}")" ||
    pf_owner_error "cannot inspect unrecorded child PID ${pid}; refusing to signal it" || return 1
  pf_owner_command_matches "${command_line}" "${context}" "${namespace}" \
    "${service}" "${local_port}" "${remote_port}" ||
    pf_owner_error "unrecorded child PID ${pid} has unexpected argv; refusing to signal it" || return 1
  process_start="$(pf_owner_process_start "${pid}")" ||
    pf_owner_error "cannot capture unrecorded child PID ${pid} identity; refusing to signal it" || return 1

  attempts="${PF_OWNER_TERMINATE_ATTEMPTS:-20}"
  delay="${PF_OWNER_TERMINATE_DELAY:-0.05}"
  pf_owner_validate_termination_policy "${attempts}" "${delay}" || return 1

  pf_owner_signal_process "${pid}" TERM 2>/dev/null || true
  for signal in TERM KILL; do
    for ((index = 0; index < attempts; index += 1)); do
      state="$(pf_owner_process_state "${pid}")"
      if [[ "${state}" == dead ]]; then
        pf_owner_reap_process "${pid}"
        return 0
      fi
      [[ "${state}" == live ]] ||
        pf_owner_error "unrecorded child PID ${pid} state became ambiguous after ${signal}" || return 1
      actual_start="$(pf_owner_process_start "${pid}")" ||
        pf_owner_error "cannot recheck unrecorded child PID ${pid} after ${signal}" || return 1
      [[ "${actual_start}" == "${process_start}" ]] ||
        pf_owner_error "unrecorded child PID ${pid} was reused after ${signal}" || return 1
      pf_owner_pause "${delay}"
    done
    if [[ "${signal}" == TERM ]]; then
      command_line="$(pf_owner_process_command "${pid}")" ||
        pf_owner_error "cannot recheck unrecorded child PID ${pid} before KILL" || return 1
      pf_owner_command_matches "${command_line}" "${context}" "${namespace}" \
        "${service}" "${local_port}" "${remote_port}" ||
        pf_owner_error "unrecorded child PID ${pid} changed argv before KILL" || return 1
      pf_owner_signal_process "${pid}" KILL 2>/dev/null || true
    fi
  done
  pf_owner_error "unrecorded child PID ${pid} did not exit after bounded TERM/KILL cleanup"
}
