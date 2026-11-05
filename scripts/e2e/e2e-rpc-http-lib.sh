# shellcheck shell=bash
# shellcheck disable=SC2034  # HTTP_STATUS and HTTP_BODY are outputs read by the caller.
# HTTP helper for the RPC gateway Host-path journey
# (e2e-rpc-gateway-host-paths.sh). Sourced by the harness; defines functions
# only. The caller defines `call_budget <seconds>`, which caps a request at the
# remaining run budget.
{ set +x; } 2>/dev/null

# http_call <label> <timeout-seconds> <body|''> <bearer|''> [curl args...]
#   → HTTP_STATUS / HTTP_BODY in the caller's shell.
# Credentials never reach argv, where any local user can read them with ps:
# a non-empty body reaches curl on stdin (--data-binary @-), and a non-empty
# bearer reaches it as a header read from fd 3 (-H @/dev/fd/3), fed by a
# here-string, so no credential file is left behind if the run is killed. The
# pipe stays inside this function: piping into http_call at a call site would
# run it in a subshell and leave the previous call's HTTP_STATUS and HTTP_BODY
# in the caller. `-q` comes first so no curlrc (for example a trace setting)
# is loaded.
http_call() {
  local label=$1 body=$3 bearer=$4 budget resp
  local -a auth=()
  budget="$(call_budget "$2")"
  shift 4
  HTTP_STATUS=000
  HTTP_BODY=''
  if [ "$budget" -le 0 ]; then
    echo "${label}: J4 deadline expired before the request" >&2
    return 1
  fi
  [ -z "$bearer" ] || auth=(-H @/dev/fd/3)
  if [ -n "$body" ]; then
    if ! resp="$(printf '%s' "$body" | curl -q -sS -m "$budget" -w '\n%{http_code}' --data-binary @- \
      ${auth[@]+"${auth[@]}"} "$@" 3<<<"Authorization: Bearer ${bearer}")"; then
      echo "${label}: curl error" >&2
      return 1
    fi
  elif ! resp="$(curl -q -sS -m "$budget" -w '\n%{http_code}' \
    ${auth[@]+"${auth[@]}"} "$@" 3<<<"Authorization: Bearer ${bearer}")"; then
    echo "${label}: curl error" >&2
    return 1
  fi
  HTTP_STATUS="$(printf '%s\n' "$resp" | tail -n1)"
  HTTP_BODY="$(printf '%s\n' "$resp" | sed '$d')"
}
