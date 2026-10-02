#!/usr/bin/env bash
# Fixed CLI surface for the two owned forwards the subscription-image runner
# consumes. No source path or command body comes from caller arguments; each
# operation has a literal call into the existing ownership library.
set -euo pipefail

fail() { printf '%s\n' 'Invalid subscription-image forward ownership request' >&2; exit 2; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WORKTREE="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
operation="${1:-}"
[[ $# -gt 0 ]] || fail
shift
case "$operation" in
  matches) [[ $# -eq 8 ]] || fail ;;
  *) fail ;;
esac

args=("$@")
record="$1" profile="$2" context="$3" worktree="$4" namespace="$5" service="$6"
local_port="$7" remote_port="$8"
[[ "$profile" =~ ^[a-z0-9][a-z0-9-]{0,62}$ && ${#profile} -le 63 ]] || fail
[[ "$profile" == "${MINIKUBE_PROFILE:-}" && "$context" == "$profile" &&
   "$context" == "${CONTROL_API_REAL_PG_CONTEXT:-}" && "$worktree" == "$WORKTREE" ]] || fail
case "$namespace/$service" in
  profiles/external-rest-api) [[ "$remote_port" == 8091 ]] || fail ;;
  rpc-proxy/rpc-proxy) [[ "$remote_port" == 8094 ]] || fail ;;
  *) fail ;;
esac
[[ "$local_port" =~ ^[0-9]{4,5}$ ]] || fail
(( 10#$local_port >= 1024 && 10#$local_port <= 65535 )) || fail

cache_root="${MINIKUBE_PROFILE_CACHE_ROOT:-${HOME}/.cache/clerum/minikube-profiles}"
[[ "$cache_root" == /* ]] || fail
pid_directory="$(cd -- "${cache_root}/${profile}/pids" && pwd -P)" || fail
[[ "${record%/*}" == "$pid_directory" ]] || fail
[[ "${record##*/}" == "${service}.pid" ]] || fail
[[ ! -L "$record" && -f "$record" ]] || fail

# shellcheck source=scripts/minikube/port-forward-owner.sh
source "${SCRIPT_DIR}/../minikube/port-forward-owner.sh"
case "$operation" in
  matches) pf_owner_record_process_matches "${args[@]}" ;;
esac
