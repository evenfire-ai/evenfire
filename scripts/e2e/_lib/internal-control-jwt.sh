#!/usr/bin/env bash
# scripts/e2e/_lib/internal-control-jwt.sh
#
# HS256 InternalControl JWT signer for E2E harnesses.
#
# Mirrors `control-api/src/utils/auth/internalControlToken.ts` and the
# matching signers in `host-context-controller` and `workflow-recipes`.
# Used by harnesses calling `/auth/mcp-host/...` from outside the cluster
# (Desktop App E2E, bash recovery scripts, load tests).
#
# Usage:
#   source scripts/e2e/_lib/internal-control-jwt.sh
#   token=$(sign_internal_control_jwt wrc)
#   curl -H "Authorization: Bearer $token" ...
#
# Required env for each issuer (one of, evaluated in order):
#   1. E2E_INTERNAL_CONTROL_JWT_<ISS>_HMAC_SECRET
#   2. INTERNAL_CONTROL_JWT_<ISS>_HMAC_SECRET
#   3. Cluster Secret `internal-control-jwt-secrets` in `control-plane`
#      key `INTERNAL_CONTROL_JWT_<ISS>_HMAC_SECRET`
#      (auto-fetched via kubectl with optional --context $K8S_CONTEXT)
# Minimal deps: node, openssl, base64, tr, awk, date, kubectl (only for fallback).

_b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }

resolve_internal_control_hmac_secret() {
  local iss="${1:-all}"
  if [[ "$iss" == "all" ]]; then
    resolve_internal_control_hmac_secret wrc >/dev/null
    resolve_internal_control_hmac_secret hcc >/dev/null
    return 0
  fi

  local issuer_upper
  case "$iss" in
    wrc) issuer_upper="WRC" ;;
    hcc) issuer_upper="HCC" ;;
    *)
      printf 'resolve_internal_control_hmac_secret: invalid iss "%s" (expected wrc|hcc)\n' "$iss" >&2
      return 1
      ;;
  esac

  local e2e_env="E2E_INTERNAL_CONTROL_JWT_${issuer_upper}_HMAC_SECRET"
  local runtime_env="INTERNAL_CONTROL_JWT_${issuer_upper}_HMAC_SECRET"
  local secret="${!e2e_env:-${!runtime_env:-}}"
  if [[ -n "$secret" ]]; then
    printf '%s' "$secret"
    return 0
  fi

  local kubectl_args=()
  [[ -n "${K8S_CONTEXT:-}" ]] && kubectl_args+=(--context "$K8S_CONTEXT")
  kubectl_args+=(-n control-plane get secret internal-control-jwt-secrets
    -o "jsonpath={.data.INTERNAL_CONTROL_JWT_${issuer_upper}_HMAC_SECRET}")

  local encoded
  encoded=$(kubectl "${kubectl_args[@]}" 2>/dev/null) || return 1
  [[ -z "$encoded" ]] && return 1

  printf '%s' "$encoded" | base64 --decode 2>/dev/null
}

# sign_internal_control_jwt <iss>
#   <iss>: "wrc" or "hcc"
#
# Emits a freshly signed HS256 JWT to stdout. Empty stdout means failure
# (caller should check `[[ -z "$token" ]]`).
sign_internal_control_jwt() {
  local iss="$1"
  case "$iss" in
    wrc | hcc) ;;
    *)
      printf 'sign_internal_control_jwt: invalid iss "%s" (expected wrc|hcc)\n' "$iss" >&2
      return 1
      ;;
  esac

  local secret
  secret=$(resolve_internal_control_hmac_secret "$iss") || return 1
  [[ -z "$secret" ]] && return 1

  local now exp jti header payload data sig
  now=$(date +%s)
  exp=$((now + 60))
  if command -v uuidgen >/dev/null 2>&1; then
    jti=$(uuidgen | tr 'A-Z' 'a-z')
  else
    jti=$(openssl rand -hex 16)
  fi

  header=$(printf '{"alg":"HS256","typ":"JWT"}' | _b64url)
  payload=$(
    printf '{"iss":"%s","aud":"control-api","sub":"%s-provisioner","iat":%d,"exp":%d,"jti":"%s"}' \
      "$iss" "$iss" "$now" "$exp" "$jti" | _b64url
  )
  data="${header}.${payload}"
  sig=$(
    printf '%s' "$secret" | IC_JWT_DATA="$data" node -e '
const crypto = require("node:crypto");
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const key = Buffer.concat(chunks).toString("utf8");
  const data = process.env.IC_JWT_DATA || "";
  process.stdout.write(crypto.createHmac("sha256", key).update(data).digest("base64url"));
});
'
  )

  printf '%s.%s' "$data" "$sig"
}
