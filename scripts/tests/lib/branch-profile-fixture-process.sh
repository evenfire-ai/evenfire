#!/usr/bin/env bash
# Ownership records for processes created by the branch-profile lifecycle fixture.
# Callers source port-forward-owner.sh first; no production process is adopted.

fixture_process_lock_registration() {
  local dir="$1" index
  for ((index = 0; index < 100; index += 1)); do
    if mkdir -- "${dir}/.lock" 2>/dev/null; then return 0; fi
    [[ -d "$dir" ]] || return 1
    pf_owner_pause 0.05
  done
  return 1
}

fixture_process_close_registration() {
  local dir="$1"
  fixture_process_lock_registration "$dir" || return 1
  if ! : >"${dir}/.closed"; then
    rmdir -- "${dir}/.lock" || true
    return 1
  fi
  # The caller holds this lock through cleanup and removal of the fixture.
}

fixture_process_register() (
  local dir="$1" pid="$2" after_exec="$3" start before_exec temporary
  umask 077
  fixture_process_lock_registration "$dir" || return 1
  trap 'rmdir -- "${dir}/.lock" || exit 1' EXIT
  [[ ! -e "${dir}/.closed" ]] || return 1
  pf_owner_validate_pid "$pid" || return 1
  [[ -n "$after_exec" && "$after_exec" != *$'\n'* && "$after_exec" != *$'\r'* ]] || return 1
  start="$(pf_owner_process_start "$pid")" || return 1
  before_exec="$(pf_owner_process_command "$pid")" || return 1
  temporary="$(mktemp "${dir}/${pid}.XXXXXXXX")" || return 1
  if ! printf '%s\n%s\n%s\n%s\n' "$pid" "$start" "$before_exec" "$after_exec" >"$temporary" ||
     ! mv -- "$temporary" "${temporary}.ready"; then
    rm -f -- "$temporary"
    return 1
  fi
)

fixture_process_cleanup_record() {
  local record="$1" pid start before_exec after_exec extra state actual_start command_line index
  [[ -f "$record" && ! -L "$record" ]] || return 1
  {
    IFS= read -r pid && IFS= read -r start && IFS= read -r before_exec && IFS= read -r after_exec || return 1
    if IFS= read -r extra || [[ -n "$extra" ]]; then return 1; fi
  } <"$record"
  pf_owner_validate_pid "$pid" && pf_owner_validate_process_start "$start" || return 1
  [[ -n "$before_exec" && -n "$after_exec" ]] || return 1
  state="$(pf_owner_process_state "$pid")" || return 1
  case "$state" in
    dead) return 0 ;;
    live) ;;
    *) return 1 ;;
  esac
  if ! actual_start="$(pf_owner_process_start "$pid")"; then
    [[ "$(pf_owner_process_state "$pid")" == dead ]] && return 0
    return 1
  fi
  # A different start means the fixture process exited and this PID was reused.
  [[ "$actual_start" == "$start" ]] || return 0
  if ! command_line="$(pf_owner_process_command "$pid")"; then
    [[ "$(pf_owner_process_state "$pid")" == dead ]] && return 0
    return 1
  fi
  [[ "$command_line" == "$before_exec" || "$command_line" == "$after_exec" ]] || return 1
  if ! actual_start="$(pf_owner_process_start "$pid")"; then
    [[ "$(pf_owner_process_state "$pid")" == dead ]] && return 0
    return 1
  fi
  [[ "$actual_start" == "$start" ]] || return 0
  if ! pf_owner_signal_process "$pid" KILL 2>/dev/null; then
    [[ "$(pf_owner_process_state "$pid")" == dead ]] || return 1
  fi
  for ((index = 0; index < 20; index += 1)); do
    state="$(pf_owner_process_state "$pid")" || return 1
    if [[ "$state" == dead ]]; then
      pf_owner_reap_process "$pid"
      return 0
    fi
    [[ "$state" == live ]] || return 1
    if ! actual_start="$(pf_owner_process_start "$pid")"; then
      [[ "$(pf_owner_process_state "$pid")" == dead ]] && return 0
      return 1
    fi
    [[ "$actual_start" == "$start" ]] || return 0
    pf_owner_pause 0.05
  done
  return 1
}
