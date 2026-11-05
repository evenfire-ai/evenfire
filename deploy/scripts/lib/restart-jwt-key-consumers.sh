#!/usr/bin/env bash
# Restart the Deployments that read the JWT keys and companion secrets written
# by deploy/scripts/gen-jwt-keys.sh and scripts/minikube/generate-keys.sh.
#
# Each of these Deployments reads the rotated values once, at startup, so it
# keeps the old ones in memory until it restarts. A key rotation therefore
# restarts them itself instead of relying on a later deploy:
# apply-inter-service-tokens.sh restarts only consumers whose own tokens
# changed (#1138).
#   control-plane/control-api              control-api-secrets
#   control-plane/control-ui               control-ui-secrets
#   rpc-proxy/rpc-proxy                    rpc-proxy-secrets (envFrom)
#   profiles/external-rest-api             external-rest-api-secrets (envFrom)
#   control-plane/workflow-recipes         control-api-public-key ConfigMap; reads
#                                          clerum-wrc-signing-key once at startup
#   control-plane/host-context-controller  control-api-public-key ConfigMap
#   control-plane/codex-llm-proxy          control-api-public-key ConfigMap
#   control-plane/grok-llm-proxy           control-api-public-key ConfigMap
# Not in this list: mcp-host, which reads the RPC public key from
# mcp-host-config (gen-jwt-keys.sh writes it and restarts the mcp-host
# namespace with restart_jwt_key_namespace; scripts/minikube/generate-keys.sh
# does not write it, and its callers run sync-auth-key.sh afterwards), and gfsc,
# whose gfs-config neither key script writes (sync-auth-key.sh does). Workflow
# pods get clerum-wrc-public-key when WRC creates them.
#
# Usage: restart_jwt_key_consumers <kubectl command and its leading args...>
#        restart_jwt_key_namespace <namespace> <kubectl command and its leading args...>
#   restart_jwt_key_consumers kubectl --context clerum-dev-context
#   restart_jwt_key_namespace mcp-host kubectl --context=clerum-test
# Pass the literal kubectl argv: it is echoed in the recovery commands.
# A Deployment that does not exist yet is skipped and logged; it reads the new
# keys when it is created. Reads and restarts are retried; a consumer that
# still fails does not stop the walk. Every other consumer is restarted, then
# the function prints one runnable restart command per pending Deployment and
# returns 1. Re-running the key script is not a recovery: it would rotate every
# key again.
#
# A pending consumer that apply-inter-service-tokens.sh also reconciles is
# marked with that script's restart-pending token stamp
# (lib/token-consumer-stamp.sh), so the next deploy's token step restarts it
# without a manual step. control-ui is not one of its consumers; its command
# must be run. A pending mcp-host restart is healed by the next deploy's
# sync-auth-key.sh step, which restarts every mcp-host pod still on the old key.

JWT_KEY_RESTART_ATTEMPTS="${JWT_KEY_RESTART_ATTEMPTS:-3}"
JWT_KEY_RESTART_RETRY_SECONDS="${JWT_KEY_RESTART_RETRY_SECONDS:-2}"
# apply-inter-service-tokens.sh's stamp annotation and its restart obligation
# value (TOKEN_STAMP_ANNOTATION and TOKEN_STAMP_PENDING_VALUE there).
JWT_KEY_TOKEN_STAMP_ANNOTATION="clerum.io/inter-service-tokens-sha256"
JWT_KEY_TOKEN_STAMP_PENDING_VALUE="restart-pending"

jwt_key_retry() {
  local attempt out
  for ((attempt = 1; attempt <= JWT_KEY_RESTART_ATTEMPTS; attempt++)); do
    if out="$("$@")"; then
      printf '%s' "$out"
      return 0
    fi
    if [ "$attempt" -lt "$JWT_KEY_RESTART_ATTEMPTS" ]; then
      sleep "$JWT_KEY_RESTART_RETRY_SECONDS"
    fi
  done
  return 1
}

# jwt_key_restart_deployment <namespace> <deployment> <kubectl argv...>
# Appends "<namespace>/<deployment>" to JWT_KEY_PENDING on failure.
jwt_key_restart_deployment() {
  local ns="$1" dep="$2" existing
  shift 2
  if ! existing="$(jwt_key_retry "$@" -n "$ns" get deploy "$dep" --ignore-not-found -o name)"; then
    echo "  ERROR: cannot read deployment $ns/$dep" >&2
    JWT_KEY_PENDING+=("$ns/$dep")
    return 0
  fi
  if [ -z "$existing" ]; then
    echo "  $ns/$dep not deployed yet; skipped."
    return 0
  fi
  if ! jwt_key_retry "$@" -n "$ns" rollout restart deploy "$dep" >/dev/null; then
    echo "  ERROR: rollout restart of $ns/$dep failed" >&2
    JWT_KEY_PENDING+=("$ns/$dep")
    return 0
  fi
  echo "  $ns/$dep restarted."
}

# jwt_key_report_pending <kubectl argv...>
# Prints one runnable command per JWT_KEY_PENDING entry and marks the token
# consumers for the next token step; returns 1 when anything is pending. An
# entry "<namespace>/" (no name) stands for every Deployment in the namespace.
jwt_key_report_pending() {
  local item ns dep
  [ "${#JWT_KEY_PENDING[@]}" -eq 0 ] && return 0
  echo "  ERROR: the keys are rotated but these restarts are pending. Do not re-run the key script (it would rotate every key again); restart each one:" >&2
  for item in "${JWT_KEY_PENDING[@]}"; do
    ns="${item%%/*}"
    dep="${item#*/}"
    if [ -z "$dep" ]; then
      echo "    $* -n $ns rollout restart deploy" >&2
    else
      echo "    $* -n $ns rollout restart deploy $dep" >&2
    fi
  done
  for item in "${JWT_KEY_PENDING[@]}"; do
    ns="${item%%/*}"
    dep="${item#*/}"
    case "$item" in
      control-plane/control-ui|*/) continue ;;
      mcp-host/*) continue ;;
    esac
    if jwt_key_retry "$@" -n "$ns" annotate deploy "$dep" --overwrite \
         "$JWT_KEY_TOKEN_STAMP_ANNOTATION=$JWT_KEY_TOKEN_STAMP_PENDING_VALUE" >/dev/null; then
      echo "  $ns/$dep marked restart-pending: the next apply-inter-service-tokens.sh run restarts it." >&2
    else
      echo "  ERROR: cannot mark $ns/$dep restart-pending; run its command above." >&2
    fi
  done
  return 1
}

restart_jwt_key_consumers() {
  [ "$#" -gt 0 ] || { echo "restart_jwt_key_consumers: kubectl command required" >&2; return 1; }
  local pair
  JWT_KEY_PENDING=()
  for pair in "control-plane:control-api" \
              "control-plane:control-ui" \
              "rpc-proxy:rpc-proxy" \
              "profiles:external-rest-api" \
              "control-plane:workflow-recipes" \
              "control-plane:host-context-controller" \
              "control-plane:codex-llm-proxy" \
              "control-plane:grok-llm-proxy"; do
    jwt_key_restart_deployment "${pair%%:*}" "${pair#*:}" "$@"
  done
  jwt_key_report_pending "$@"
}

# Restarts every Deployment in <namespace>. gen-jwt-keys.sh uses it for
# mcp-host, whose Deployments (including the workspace-files-controller
# Deployments that host-context-controller creates there) read the RPC public
# key from mcp-host-config.
restart_jwt_key_namespace() {
  [ "$#" -gt 1 ] || { echo "restart_jwt_key_namespace: namespace and kubectl command required" >&2; return 1; }
  local ns="$1" names name
  shift
  JWT_KEY_PENDING=()
  if ! names="$(jwt_key_retry "$@" -n "$ns" get deploy -o name)"; then
    echo "  ERROR: cannot list deployments in $ns" >&2
    JWT_KEY_PENDING+=("$ns/")
  elif [ -z "$names" ]; then
    echo "  no deployment in $ns yet; skipped."
  else
    while IFS= read -r name; do
      name="${name#deployment.apps/}"
      if [ -n "$name" ]; then
        jwt_key_restart_deployment "$ns" "$name" "$@"
      fi
    done <<<"$names"
  fi
  jwt_key_report_pending "$@"
}
