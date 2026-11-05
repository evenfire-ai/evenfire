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
# mcp-host-config (gen-jwt-keys.sh writes it and restarts mcp-host itself;
# scripts/minikube/generate-keys.sh does not, and its callers run
# sync-auth-key.sh afterwards), and gfsc, whose gfs-config neither key script
# writes (sync-auth-key.sh does). Workflow pods get clerum-wrc-public-key when
# WRC creates them.
#
# Usage: restart_jwt_key_consumers <kubectl command and its leading args...>
#   restart_jwt_key_consumers kubectl --context clerum-dev-context
#   restart_jwt_key_consumers kubectl --context=clerum-test
# Pass the literal kubectl argv: it is echoed in the recovery commands.
# A Deployment that does not exist yet is skipped and logged; it reads the new
# keys when it is created. Reads and restarts are retried; a consumer that
# still fails does not stop the walk. Every other consumer is restarted, then
# the function prints one runnable restart command per pending Deployment and
# returns 1. Re-running the key script is not a recovery: it would rotate every
# key again.

JWT_KEY_RESTART_ATTEMPTS="${JWT_KEY_RESTART_ATTEMPTS:-3}"
JWT_KEY_RESTART_RETRY_SECONDS="${JWT_KEY_RESTART_RETRY_SECONDS:-2}"

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

restart_jwt_key_consumers() {
  [ "$#" -gt 0 ] || { echo "restart_jwt_key_consumers: kubectl command required" >&2; return 1; }
  local pair ns dep existing pending=()
  for pair in "control-plane:control-api" \
              "control-plane:control-ui" \
              "rpc-proxy:rpc-proxy" \
              "profiles:external-rest-api" \
              "control-plane:workflow-recipes" \
              "control-plane:host-context-controller" \
              "control-plane:codex-llm-proxy" \
              "control-plane:grok-llm-proxy"; do
    ns="${pair%%:*}"
    dep="${pair#*:}"
    if ! existing="$(jwt_key_retry "$@" -n "$ns" get deploy "$dep" --ignore-not-found -o name)"; then
      echo "  ERROR: cannot read deployment $ns/$dep" >&2
      pending+=("$ns/$dep")
      continue
    fi
    if [ -z "$existing" ]; then
      echo "  $ns/$dep not deployed yet; skipped."
      continue
    fi
    if ! jwt_key_retry "$@" -n "$ns" rollout restart deploy "$dep" >/dev/null; then
      echo "  ERROR: rollout restart of $ns/$dep failed" >&2
      pending+=("$ns/$dep")
      continue
    fi
    echo "  $ns/$dep restarted."
  done
  if [ "${#pending[@]}" -gt 0 ]; then
    echo "  ERROR: the keys are rotated but these restarts are pending. Do not re-run the key script (it would rotate every key again); restart each one:" >&2
    for pair in "${pending[@]}"; do
      echo "    $* -n ${pair%%/*} rollout restart deploy ${pair#*/}" >&2
    done
    return 1
  fi
}
