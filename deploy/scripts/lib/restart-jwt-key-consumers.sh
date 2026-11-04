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
# Not in this list: mcp-host (and gfsc), which read the RPC public key from
# ConfigMaps. gen-jwt-keys.sh writes mcp-host-config and restarts mcp-host itself;
# scripts/minikube/generate-keys.sh does not, and its callers run
# sync-auth-key.sh afterwards. Workflow pods get clerum-wrc-public-key when WRC
# creates them.
#
# Usage: restart_jwt_key_consumers <kubectl command and its leading args...>
#   restart_jwt_key_consumers kctl
#   restart_jwt_key_consumers kubectl --context=clerum-test
# A Deployment that does not exist yet is skipped and logged; it reads the new
# keys when it is created. A failed read of a Deployment returns 1.

restart_jwt_key_consumers() {
  [ "$#" -gt 0 ] || { echo "restart_jwt_key_consumers: kubectl command required" >&2; return 1; }
  local pair ns dep existing
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
    if ! existing="$("$@" -n "$ns" get deploy "$dep" --ignore-not-found -o name)"; then
      echo "  ERROR: cannot read deployment $ns/$dep" >&2
      return 1
    fi
    if [ -z "$existing" ]; then
      echo "  $ns/$dep not deployed yet; skipped."
      continue
    fi
    "$@" -n "$ns" rollout restart deploy "$dep" >/dev/null || return 1
    echo "  $ns/$dep restarted."
  done
}
