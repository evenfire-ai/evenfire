#!/usr/bin/env bash
# Fixed CLI surface for the existing ownership library. No source path or
# command body comes from caller arguments; each operation has a literal call.
set -euo pipefail

fail() { printf '%s\n' 'Invalid approved-tools port-forward ownership request' >&2; exit 2; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WORKTREE="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
operation="${1:-}"
[[ $# -gt 0 ]] || fail
shift
case "$operation" in
  record) [[ $# -eq 9 ]] || fail ;;
  matches|cleanup) [[ $# -eq 8 ]] || fail ;;
  *) fail ;;
esac

# Preserve the original argument vector for the ownership library after checking
# each semantic binding. Paths are data, never sourced or evaluated.
args=("$@")
record="$1"
shift
if [[ "$operation" == record ]]; then
  [[ "$1" =~ ^[1-9][0-9]{0,9}$ ]] || fail
  shift
fi
profile="$1" context="$2" worktree="$3" namespace="$4" service="$5"
local_port="$6" remote_port="$7"
[[ "$profile" =~ ^clerum-[a-z0-9-]+-[a-f0-9]{7,8}$ && ${#profile} -le 100 ]] || fail
[[ "$profile" == "${MINIKUBE_PROFILE:-}" && "$context" == "$profile" &&
   "$context" == "${CONTROL_API_REAL_PG_CONTEXT:-}" && "$worktree" == "$WORKTREE" ]] || fail
case "$namespace" in
  control-plane) [[ "$service" == codex-llm-proxy && "$remote_port" == 9090 ]] || fail ;;
  mcp-server) [[ "$service" =~ ^approved-tools-[a-f0-9]{12}-mcp-(83|150|250)$ && "$remote_port" == 8080 ]] || fail ;;
  *) fail ;;
esac
[[ "$local_port" =~ ^[0-9]{4,5}$ ]] || fail
(( 10#$local_port >= 1024 && 10#$local_port <= 65535 )) || fail
[[ "${T2_PROFILE_ROOT:-}" == /* ]] || fail
pid_directory="$(cd -- "${T2_PROFILE_ROOT}/${profile}/pids" && pwd -P)" || fail
[[ "${record%/*}" == "$pid_directory" ]] || fail
filename="${record##*/}"
[[ "$filename" =~ ^approved-tools-[a-f0-9]{12}-(codex-llm-proxy|approved-tools-[a-f0-9]{12}-mcp-(83|150|250))\.pid$ ]] || fail
[[ "$filename" == *"-${service}.pid" ]] || fail

# shellcheck source=scripts/minikube/port-forward-owner.sh
source "${SCRIPT_DIR}/../minikube/port-forward-owner.sh"
case "$operation" in
  record) pf_owner_record_process "${args[@]}" ;;
  matches) pf_owner_record_process_matches "${args[@]}" ;;
  cleanup) pf_owner_cleanup_record "${args[@]}" ;;
esac
