#!/usr/bin/env bash
set -euo pipefail

# Apply inter-service tokens as native K8s Secrets using `kubectl patch`.
#
# These secrets authenticate service-to-service calls:
#   - external-rest-api → control-api   (token X)
#   - rpc-proxy         → control-api   (token Y)
#   - workflow-approval-request-reader → control-api   (Figure D consulta token)
#   - workflow-approval-request-reader → channel-reader (Slack webhook handoff)
#   - workflow-recipes / host-context-controller → control-api
#                                      (shared InternalControl JWT HMAC)
#
# Why a dedicated script (not plain `gen-jwt-keys.sh`):
#   `gen-jwt-keys.sh` uses `kubectl create ... --dry-run=client | kubectl apply`,
#   which records the Secret in `last-applied-configuration`. The next CI
#   `kubectl apply -k` would then three-way-merge against base's
#   `stringData: {}` canary and wipe the token back to empty.
#
#   This script uses `kubectl patch --type=merge`, which writes keys OUTSIDE
#   the apply envelope. `kubectl apply -k` sees `stringData: {}` in base
#   AND the matching last-applied annotation — no diff, no wipe. Real tokens
#   survive every CI redeploy. Same pattern proven by apply-registry-secrets.sh.
#
# Idempotency: most tokens are resolved in this order — env var → existing
# Secret value → fresh `openssl rand -hex 32`. Re-running the script never
# rotates tokens silently. Member-registration HMAC is stricter: env var →
# existing Secret value → minikube local dev value, and outside minikube it
# fails closed unless the env var or existing Secret value is present.
#
# Env vars consumed:
#   CONTEXT                              kubectl context (unset = current)
#   CONTROL_API_INTERNAL_TOKEN_EXT_REST  override token X (default: preserve-or-generate)
#   CONTROL_API_INTERNAL_TOKEN_RPC       override token Y (default: preserve-or-generate)
#   RPC_PROXY_MCP_HOST_EDGE_TOKEN         dedicated rpc-proxy → mcp-host identity
#                                        (default: preserve-or-generate)
#   CONTROL_API_INTERNAL_TOKEN_WA_READER override workflow-approval-request-reader → control-api
#                                       consulta token (Figure D cross-bot fix PR1;
#                                       default: preserve-or-generate)
#   CHANNEL_READER_HANDOFF_TOKEN        override workflow-approval-request-reader → channel-reader
#                                       handoff token (default: preserve-or-generate)
#   CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
#                                        override member-registration HMAC.
#                                        Required outside minikube unless the
#                                        control-api Secret already has a value.
#   INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET override WRC HMAC (default: preserve-or-generate)
#   INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET override HCC HMAC (default: preserve-or-generate)
#   FORCE_CONSUMER_RESTART               if true, restart every consumer including
#                                        GFSC, WFC and HCC when credentials are unchanged
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=lib/clerum-minikube-context.sh
source "${SCRIPT_DIR}/lib/clerum-minikube-context.sh"
MEMBER_REGISTRATION_HMAC_KEY="CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET"

kctl() {
  if [ -n "${CONTEXT:-}" ]; then
    kubectl --context "$CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

log() { printf '[inter-service-tokens] %s\n' "$*" >&2; }
die() { printf '[inter-service-tokens] ERROR: %s\n' "$*" >&2; exit 1; }

# Read a plain string key from a Secret. Returns empty if Secret/key missing
# or if the current value looks like a legacy `replace-with-*` placeholder
# (so we treat those as "no real value present" and regenerate).
read_secret_key() {
  local ns="$1" secret="$2" key="$3"
  local encoded decoded
  encoded="$(kctl -n "$ns" get secret "$secret" -o jsonpath="{.data.$key}" 2>/dev/null || true)"
  [ -z "$encoded" ] && { echo ""; return; }
  decoded="$(printf '%s' "$encoded" | base64 --decode 2>/dev/null || echo "")"
  case "$decoded" in
    replace-with-*|"") echo ""; return ;;
  esac
  printf '%s' "$decoded"
}

resolve_token() {
  local env_var="$1" ns="$2" secret="$3" key="$4"
  local env_val="${!env_var:-}"
  if [ -n "$env_val" ]; then
    printf '%s' "$env_val"; return
  fi
  local existing
  existing="$(read_secret_key "$ns" "$secret" "$key")"
  if [ -n "$existing" ]; then
    printf '%s' "$existing"; return
  fi
  openssl rand -hex 32
}

is_minikube_context() {
  is_clerum_minikube_context
}

read_minikube_member_registration_hmac() {
  local candidate script
  for candidate in \
    "${CLERUM_PROJECT_DIR:-}/scripts/minikube/deploy-evenfire-member-registration.sh" \
    "${REPO_ROOT}/scripts/minikube/deploy-evenfire-member-registration.sh"; do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate" ]; then
      script="$candidate"
      break
    fi
  done
  [ -n "${script:-}" ] || return 1
  awk -F= '$1 == "DEV_HMAC_SECRET" {
    gsub(/^"/, "", $2)
    gsub(/"$/, "", $2)
    print $2
    exit
  }' "$script"
}

resolve_member_registration_hmac() {
  local env_val="${!MEMBER_REGISTRATION_HMAC_KEY:-}"
  if [ -n "$env_val" ]; then
    printf '%s' "$env_val"; return
  fi

  local existing
  existing="$(read_secret_key control-plane control-api-internal-tokens "$MEMBER_REGISTRATION_HMAC_KEY")"
  if [ -n "$existing" ]; then
    printf '%s' "$existing"; return
  fi

  if is_minikube_context; then
    local minikube_hmac
    minikube_hmac="$(read_minikube_member_registration_hmac || true)"
    if [ -n "$minikube_hmac" ]; then
      printf '%s' "$minikube_hmac"; return
    fi
    # The evenfire-member-registration sibling is optional in the OSS single-tenant
    # tree (it lives in a separate repo and is excluded from the public snapshot).
    # When it is absent, generate a local dev HMAC so `make minikube-setup` continues
    # instead of aborting — member invitation / registration flows stay non-functional
    # until the sibling is deployed, per docs/deploy/minikube.md ("setup simply prints a
    # warning and continues"). The value is preserved across re-runs by the existing-Secret
    # read above. In the monorepo the sibling script is present, so this branch is inert.
    printf '[inter-service-tokens] WARN: evenfire-member-registration sibling not found; generating a local dev member-registration HMAC (invitation/registration flows will fail until it is deployed)\n' >&2
    openssl rand -hex 32; return
  fi

  die "CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET is required when no existing control-api Secret value is present"
}

ensure_secret() {
  local ns="$1" name="$2"
  if ! kctl -n "$ns" get secret "$name" >/dev/null 2>&1; then
    kctl -n "$ns" create secret generic "$name"
  fi
}

ensure_namespace() {
  local ns="$1"
  if ! kctl get ns "$ns" >/dev/null 2>&1; then
    log "Namespace '$ns' missing — creating it"
    kctl create ns "$ns"
  fi
}

log "Resolving inter-service tokens (context: ${CONTEXT:-<current>})"

# jq is expected on GitHub runners and operator workstations. JSON patches
# avoid YAML quoting surprises with commas/equals in the token strings.
command -v jq >/dev/null 2>&1 || die "jq is required (apt-get install jq)"

for ns in control-plane profiles rpc-proxy channels webhook-ingress gfs mcp-host; do
  ensure_namespace "$ns"
done
# Resolve each token from the side that already holds it (if any). We read
# from the *consumer* Secret first because the consumer is the only authority
# on its own token — if someone rotated it out-of-band, we want to keep the
# rotated value in sync on the control-api side too.
TOKEN_EXT_REST="$(resolve_token CONTROL_API_INTERNAL_TOKEN_EXT_REST \
  profiles external-rest-api-secrets EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN)"
TOKEN_RPC="$(resolve_token CONTROL_API_INTERNAL_TOKEN_RPC \
  rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)"
TOKEN_RPC_MCP_HOST_EDGE="$(resolve_token RPC_PROXY_MCP_HOST_EDGE_TOKEN \
  rpc-proxy rpc-proxy-secrets RPC_PROXY_MCP_HOST_EDGE_TOKEN)"
TOKEN_WEBHOOK_PROXY="$(resolve_token CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY \
  webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN)"
TOKEN_WA_READER="$(resolve_token CONTROL_API_INTERNAL_TOKEN_WA_READER \
  channels workflow-approval-request-reader-credentials control-api-token)"
TOKEN_CODEX_LLM_PROXY="$(resolve_token CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY \
  control-plane codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN)"
TOKEN_GFSC="$(resolve_token CONTROL_API_INTERNAL_TOKEN_GFSC \
  gfs gfs-controller-service-token token)"
TOKEN_WFC="$(resolve_token CONTROL_API_INTERNAL_TOKEN_WFC \
  mcp-host workspace-files-controller-service-token token)"
if [[ "$TOKEN_GFSC" == "$TOKEN_WFC" || "$TOKEN_GFSC" == "$TOKEN_RPC" || "$TOKEN_WFC" == "$TOKEN_RPC" ]]; then
  die "filesystem controller service tokens must be distinct from each other and rpc-proxy"
fi
TOKEN_GROK_LLM_PROXY="$(resolve_token CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY \
  control-plane grok-llm-proxy-secrets GROK_LLM_PROXY_CONTROL_API_TOKEN)"
READER_HANDOFF_TOKEN_VALUE="$(resolve_token CHANNEL_READER_HANDOFF_TOKEN \
  channels workflow-approval-request-reader-credentials channel-reader-handoff-token)"
INTERNAL_CONTROL_WRC_HMAC="$(resolve_token INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET \
  control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET)"
INTERNAL_CONTROL_HCC_HMAC="$(resolve_token INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET \
  control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET)"
MEMBER_REGISTRATION_HMAC="$(resolve_member_registration_hmac)"

for other_token in "$TOKEN_EXT_REST" "$TOKEN_RPC" "$TOKEN_WEBHOOK_PROXY" \
  "$TOKEN_WA_READER" "$TOKEN_CODEX_LLM_PROXY" "$TOKEN_GFSC" "$TOKEN_WFC" \
  "$TOKEN_GROK_LLM_PROXY" "$READER_HANDOFF_TOKEN_VALUE"; do
  if [[ "$TOKEN_RPC_MCP_HOST_EDGE" == "$other_token" ]]; then
    die "rpc-proxy to mcp-host edge token must be a distinct service credential"
  fi
done
if [[ ${#TOKEN_RPC_MCP_HOST_EDGE} -lt 16 || ${#TOKEN_RPC_MCP_HOST_EDGE} -gt 4096 ]]; then
  die "rpc-proxy to mcp-host edge token must contain 16 to 4096 characters"
fi

for pair in \
  "EXT_REST:$TOKEN_EXT_REST" \
  "RPC:$TOKEN_RPC" \
  "RPC_MCP_HOST_EDGE:$TOKEN_RPC_MCP_HOST_EDGE" \
  "WEBHOOK_PROXY:$TOKEN_WEBHOOK_PROXY" \
  "WA_READER:$TOKEN_WA_READER" \
  "CODEX_LLM_PROXY:$TOKEN_CODEX_LLM_PROXY" \
  "GFSC:$TOKEN_GFSC" \
  "WFC:$TOKEN_WFC" \
  "GROK_LLM_PROXY:$TOKEN_GROK_LLM_PROXY" \
  "CHANNEL_READER_HANDOFF:$READER_HANDOFF_TOKEN_VALUE" \
  "INTERNAL_CONTROL_WRC_HMAC:$INTERNAL_CONTROL_WRC_HMAC" \
  "INTERNAL_CONTROL_HCC_HMAC:$INTERNAL_CONTROL_HCC_HMAC" \
  "MEMBER_REGISTRATION_HMAC:$MEMBER_REGISTRATION_HMAC"; do
  name="${pair%%:*}"
  val="${pair#*:}"
  [ -n "$val" ] || die "token $name resolved to empty — refusing to patch"
done

if [ "$TOKEN_CODEX_LLM_PROXY" = "$TOKEN_GROK_LLM_PROXY" ]; then
  die "codex-llm-proxy and grok-llm-proxy tokens must be distinct"
fi
SERVICE_TOKENS_MAP="external-rest-api=${TOKEN_EXT_REST},rpc-proxy=${TOKEN_RPC},webhook-proxy=${TOKEN_WEBHOOK_PROXY},workflow-approval-reader=${TOKEN_WA_READER},codex-llm-proxy=${TOKEN_CODEX_LLM_PROXY},grok-llm-proxy=${TOKEN_GROK_LLM_PROXY},gfs-controller=${TOKEN_GFSC},workspace-files-controller=${TOKEN_WFC}"
INTERNAL_TOKENS_LIST="${TOKEN_EXT_REST},${TOKEN_RPC},${TOKEN_WEBHOOK_PROXY},${TOKEN_WA_READER},${TOKEN_CODEX_LLM_PROXY},${TOKEN_GROK_LLM_PROXY},${TOKEN_GFSC},${TOKEN_WFC}"

# --- 1. control-api-internal-tokens (control-plane) ---
log "Patching Secret control-api-internal-tokens (control-plane)"
ensure_secret control-plane control-api-internal-tokens
CA_PATCH="$(jq -cn \
  --arg map  "$SERVICE_TOKENS_MAP" \
  --arg list "$INTERNAL_TOKENS_LIST" \
  --arg memberRegistrationHmacKey "$MEMBER_REGISTRATION_HMAC_KEY" \
  --arg memberRegistrationHmac "$MEMBER_REGISTRATION_HMAC" \
  '{stringData: {
    CONTROL_API_INTERNAL_SERVICE_TOKENS: $map,
    CONTROL_API_INTERNAL_TOKENS: $list,
    ($memberRegistrationHmacKey): $memberRegistrationHmac
  }}')"
kctl -n control-plane patch secret control-api-internal-tokens --type=merge -p "$CA_PATCH"

# --- 1b. retired reader -> control-api service token cleanup ---
log "Removing legacy reader internal control-api tokens if present (channels)"
kctl -n channels delete secret channel-reader-internal-tokens --ignore-not-found=true >/dev/null
kctl -n channels patch secret workflow-approval-request-reader-credentials \
  --type=json \
  -p='[{"op":"remove","path":"/data/service-token"}]' >/dev/null 2>&1 || true

# --- 2. internal-control-jwt-secrets (control-plane) ---
# Compare the HCC-consumed key only. The merge patch writes WRC + HCC together,
# so a whole-Secret resourceVersion (or parsing `patched (no change)`) would
# Recreate HCC on a WRC-only rotation. Values stay in shell locals — never logged.
HCC_HMAC_BEFORE="$(read_secret_key control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET)"
# GFSC/WFC consume these Secrets as process-start environment variables, so a
# token change requires an exact-selector rollout after patching the Secrets.
GFSC_TOKEN_BEFORE="$(read_secret_key gfs gfs-controller-service-token token)"
WFC_TOKEN_BEFORE="$(read_secret_key mcp-host workspace-files-controller-service-token token)"
RPC_MCP_HOST_EDGE_BEFORE="$(read_secret_key rpc-proxy rpc-proxy-secrets RPC_PROXY_MCP_HOST_EDGE_TOKEN)"
MCP_HOST_EDGE_BEFORE="$(read_secret_key mcp-host rpc-proxy-edge-credentials RPC_PROXY_MCP_HOST_EDGE_TOKEN)"
if [ "${FORCE_CONSUMER_RESTART:-}" = "true" ] || [ "$GFSC_TOKEN_BEFORE" != "$TOKEN_GFSC" ]; then
  GFSC_TOKEN_CHANGED=true
else
  GFSC_TOKEN_CHANGED=false
fi
if [ "${FORCE_CONSUMER_RESTART:-}" = "true" ] || [ "$WFC_TOKEN_BEFORE" != "$TOKEN_WFC" ]; then
  WFC_TOKEN_CHANGED=true
else
  WFC_TOKEN_CHANGED=false
fi
if [ "${FORCE_CONSUMER_RESTART:-}" = "true" ] || \
   [ -z "$HCC_HMAC_BEFORE" ] || \
   [ "$HCC_HMAC_BEFORE" != "$INTERNAL_CONTROL_HCC_HMAC" ]; then
  HCC_SECRET_CHANGED=true
else
  HCC_SECRET_CHANGED=false
fi
if [ "$RPC_MCP_HOST_EDGE_BEFORE" != "$TOKEN_RPC_MCP_HOST_EDGE" ] || \
   [ "$MCP_HOST_EDGE_BEFORE" != "$TOKEN_RPC_MCP_HOST_EDGE" ]; then
  RPC_MCP_HOST_EDGE_CHANGED=true
else
  RPC_MCP_HOST_EDGE_CHANGED=false
fi
log "Patching Secret internal-control-jwt-secrets (control-plane)"
ensure_secret control-plane internal-control-jwt-secrets
INTERNAL_CONTROL_PATCH="$(jq -cn \
  --arg wrc "$INTERNAL_CONTROL_WRC_HMAC" \
  --arg hcc "$INTERNAL_CONTROL_HCC_HMAC" \
  '{stringData: {
    INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET: $wrc,
    INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET: $hcc
  }}')"
kctl -n control-plane patch secret internal-control-jwt-secrets --type=merge -p "$INTERNAL_CONTROL_PATCH"
LEGACY_INTERNAL_CONTROL_KEY="$(printf 'INTERNAL_CONTROL_JWT_%s_%s' HMAC SECRET)"
if kctl -n control-plane get secret internal-control-jwt-secrets -o json \
  | jq -e --arg key "$LEGACY_INTERNAL_CONTROL_KEY" '.data[$key]' >/dev/null; then
  LEGACY_INTERNAL_CONTROL_REMOVE_PATCH="$(jq -cn \
    --arg path "/data/${LEGACY_INTERNAL_CONTROL_KEY}" \
    '[{op: "remove", path: $path}]')"
  kctl -n control-plane patch secret internal-control-jwt-secrets --type=json \
    -p="$LEGACY_INTERNAL_CONTROL_REMOVE_PATCH"
fi

# --- 3. external-rest-api-secrets (profiles) ---
# Adds the SERVICE_TOKEN key alongside the JWT public key that gen-jwt-keys.sh
# already writes. Patch only adds keys — does not touch JWT_PUBLIC_KEY.
log "Patching Secret external-rest-api-secrets (profiles)"
ensure_secret profiles external-rest-api-secrets
EXT_PATCH="$(jq -cn --arg t "$TOKEN_EXT_REST" \
  '{stringData: {
    EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: $t
  }}')"
kctl -n profiles patch secret external-rest-api-secrets --type=merge -p "$EXT_PATCH"

# --- 4. rpc-proxy-secrets (rpc-proxy) ---
# Adds/updates RPC_PROXY_CONTROL_API_SERVICE_TOKEN alongside JWT public key
# and desktop tokens written by gen-jwt-keys.sh.
log "Patching Secret rpc-proxy-secrets (rpc-proxy)"
ensure_secret rpc-proxy rpc-proxy-secrets
RPC_PATCH="$(jq -cn --arg t "$TOKEN_RPC" --arg edge "$TOKEN_RPC_MCP_HOST_EDGE" \
  '{stringData: {
    RPC_PROXY_CONTROL_API_SERVICE_TOKEN: $t,
    RPC_PROXY_MCP_HOST_EDGE_TOKEN: $edge
  }}')"
kctl -n rpc-proxy patch secret rpc-proxy-secrets --type=merge -p "$RPC_PATCH"

# --- 4a. Dedicated rpc-proxy → mcp-host caller identity ---
log "Patching Secret rpc-proxy-edge-credentials (mcp-host)"
ensure_secret mcp-host rpc-proxy-edge-credentials
MCP_HOST_EDGE_PATCH="$(jq -cn --arg edge "$TOKEN_RPC_MCP_HOST_EDGE" \
  '{stringData: {RPC_PROXY_MCP_HOST_EDGE_TOKEN: $edge}}')"
kctl -n mcp-host patch secret rpc-proxy-edge-credentials --type=merge -p "$MCP_HOST_EDGE_PATCH"

# --- 4a. filesystem controller checkpoint identities ---
log "Patching distinct filesystem controller service tokens"
ensure_secret gfs gfs-controller-service-token
GFSC_PATCH="$(jq -cn --arg t "$TOKEN_GFSC" '{stringData: {token: $t}}')"
kctl -n gfs patch secret gfs-controller-service-token --type=merge -p "$GFSC_PATCH"
ensure_secret mcp-host workspace-files-controller-service-token
WFC_PATCH="$(jq -cn --arg t "$TOKEN_WFC" '{stringData: {token: $t}}')"
kctl -n mcp-host patch secret workspace-files-controller-service-token --type=merge -p "$WFC_PATCH"

# --- 4b. webhook-proxy-secrets (webhook-ingress) ---
# Adds/updates WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN. webhook-proxy uses
# this token to authenticate against control-api's registry endpoint
# (/api/v1/internal/webhook/registry/...).
log "Patching Secret webhook-proxy-secrets (webhook-ingress)"
ensure_secret webhook-ingress webhook-proxy-secrets
WEBHOOK_PROXY_PATCH="$(jq -cn --arg t "$TOKEN_WEBHOOK_PROXY" \
  '{stringData: {WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN: $t}}')"
kctl -n webhook-ingress patch secret webhook-proxy-secrets --type=merge -p "$WEBHOOK_PROXY_PATCH"

# --- 4d. codex-llm-proxy-secrets (control-plane) ---
# Dedicated service token only. The proxy never receives the full
# CONTROL_API_INTERNAL_SERVICE_TOKENS map.
log "Patching Secret codex-llm-proxy-secrets (control-plane)"
ensure_secret control-plane codex-llm-proxy-secrets
CODEX_LLM_PROXY_PATCH="$(jq -cn --arg t "$TOKEN_CODEX_LLM_PROXY" \
  '{stringData: {CODEX_LLM_PROXY_CONTROL_API_TOKEN: $t}}')"
kctl -n control-plane patch secret codex-llm-proxy-secrets --type=merge -p "$CODEX_LLM_PROXY_PATCH"

# --- 4e. grok-llm-proxy-secrets (control-plane) ---
log "Patching Secret grok-llm-proxy-secrets (control-plane)"
ensure_secret control-plane grok-llm-proxy-secrets
GROK_LLM_PROXY_PATCH="$(jq -cn --arg t "$TOKEN_GROK_LLM_PROXY" \
  '{stringData: {GROK_LLM_PROXY_CONTROL_API_TOKEN: $t}}')"
kctl -n control-plane patch secret grok-llm-proxy-secrets --type=merge -p "$GROK_LLM_PROXY_PATCH"

# --- 4c. workflow-approval-request-reader-credentials (channels) ---
# Figure D cross-bot fix (PR1): the reader uses this token to authenticate its
# consulta call to control-api
# (GET /api/v1/internal/workflow-approval-reader/approvals/:id/can-approve).
# Same internalServiceAuth pattern as rpc-proxy / webhook-proxy.
log "Patching Secret workflow-approval-request-reader-credentials (channels) — control-api-token"
ensure_secret channels workflow-approval-request-reader-credentials
WA_READER_PATCH="$(jq -cn \
  --arg controlApiToken "$TOKEN_WA_READER" \
  --arg channelReaderHandoffToken "$READER_HANDOFF_TOKEN_VALUE" \
  '{stringData: {
    "control-api-token": $controlApiToken,
    "channel-reader-handoff-token": $channelReaderHandoffToken
  }}')"
kctl -n channels patch secret workflow-approval-request-reader-credentials --type=merge -p "$WA_READER_PATCH"

# Roll the consumers so they pick up the fresh tokens on first deploy. Safe
# no-ops if the Deployments do not yet exist. HCC is Recreate + replicas:1
# and reloads HMAC only at process start, so skip that extra rollout when the
# HCC key this run writes equals the key already in the Secret (image/spec
# applies still roll HCC themselves). This is not "the running pod env matches
# the Secret": an out-of-band kubectl patch of the HCC key, then a re-run that
# preserve-or-generates from the Secret, will skip. Heal that with
# FORCE_CONSUMER_RESTART=true.
EDGE_PROXY_RESTART=false
EDGE_HCC_RESTART=false
EDGE_HOSTS_RESTART=false
for pair in "control-plane:control-api" \
            "control-plane:codex-llm-proxy" \
            "control-plane:grok-llm-proxy" \
            "control-plane:workflow-recipes" \
            "profiles:external-rest-api" \
            "webhook-ingress:webhook-proxy" \
            "channels:clerum-workflow-approval-request-reader"; do
  ns="${pair%%:*}"
  dep="${pair#*:}"
  if [ "$ns" = "control-plane" ] && [ "$dep" = "host-context-controller" ] && \
     [ "$HCC_SECRET_CHANGED" != "true" ]; then
    log "Skipping rollout of $ns/$dep: hcc-hmac unchanged"
    continue
  fi
  if kctl -n "$ns" get deploy "$dep" >/dev/null 2>&1; then
    log "Rolling deployment $ns/$dep to pick up fresh Secret values"
    kctl -n "$ns" rollout restart deploy "$dep" >/dev/null
  fi
done

# HCC, RPC Proxy, and HCC-managed Hosts share a protocol transition boundary.
# Defer those restarts to the cohort-aware coordinator; direct restarts here
# could let token rotation bypass the strict-Host / compatible-Proxy order.
if kctl -n control-plane get deploy host-context-controller >/dev/null 2>&1; then
  if [ "$HCC_SECRET_CHANGED" = "true" ]; then
    log "Rolling deployment control-plane/host-context-controller through the edge coordinator"
    EDGE_HCC_RESTART=true
  else
    log "Skipping rollout of control-plane/host-context-controller: hcc-hmac unchanged"
  fi
fi
if { [ "$RPC_MCP_HOST_EDGE_CHANGED" = "true" ] || \
     [ "${FORCE_CONSUMER_RESTART:-}" = "true" ]; } && \
   kctl -n rpc-proxy get deploy rpc-proxy >/dev/null 2>&1; then
  EDGE_PROXY_RESTART=true
fi

# MCP Host consumes the edge token as an environment variable. Restart only
# HCC-managed Host deployments when either Secret projection changes so every
# pod reloads the same preserved credential used by RPC Proxy.
if [ "$RPC_MCP_HOST_EDGE_CHANGED" = "true" ] || \
   [ "${FORCE_CONSUMER_RESTART:-}" = "true" ]; then
  HOST_DEPLOYMENTS="$(kctl -n mcp-host get deployments \
    -l clerum.io/managed-by=host-context-controller -o name)"
  if [ -n "$HOST_DEPLOYMENTS" ]; then
    EDGE_HOSTS_RESTART=true
  fi
fi

if [ "$EDGE_PROXY_RESTART" = "true" ] || [ "$EDGE_HCC_RESTART" = "true" ] || \
   [ "$EDGE_HOSTS_RESTART" = "true" ]; then
  EDGE_ROLLOUT_CONTEXT="${CONTEXT:-$(kubectl config current-context)}"
  [ -n "$EDGE_ROLLOUT_CONTEXT" ] || die "cannot resolve Kubernetes context for edge rollout"
  EDGE_RESTART_ARGS=(restart-targets --context "$EDGE_ROLLOUT_CONTEXT")
  [ "$EDGE_PROXY_RESTART" != "true" ] || EDGE_RESTART_ARGS+=(--restart-proxy)
  [ "$EDGE_HCC_RESTART" != "true" ] || EDGE_RESTART_ARGS+=(--restart-hcc)
  [ "$EDGE_HOSTS_RESTART" != "true" ] || EDGE_RESTART_ARGS+=(--restart-all-hosts)
  bash "${REPO_ROOT}/scripts/minikube/rollout-rpc-proxy-edge-protocol.sh" \
    "${EDGE_RESTART_ARGS[@]}"
fi

if kctl -n channels get deploy -l app=channel-reader >/dev/null 2>&1; then
  log "Rolling channel-reader deployments to pick up fresh Secret values"
  kctl -n channels rollout restart deploy -l app=channel-reader >/dev/null || true
fi

# GFSC and WFC read their dedicated Secret values into process-start
# environment variables. Restart all exact producer-selected Deployments only
# when the corresponding credential changes (or an operator explicitly forces
# every consumer to reload). Bound the combined verification window so a large
# set of per-filesystem WFC Deployments cannot wait indefinitely.
restart_and_verify_selected_deployments() {
  local ns="$1" selector="$2" label="$3" deployments resource remaining
  remaining=$((CONSUMER_ROLLOUT_DEADLINE - SECONDS))
  [ "$remaining" -gt 0 ] || die "credential rollout deadline expired before listing $label deployments"
  if ! deployments="$(kctl -n "$ns" get deployments -l "$selector" \
    -o name --request-timeout="${remaining}s")"; then
    die "could not list $label deployments for credential refresh"
  fi
  if [ -z "$deployments" ]; then
    log "No $label deployments exist; credential will be consumed when they are created"
    return
  fi
  while IFS= read -r resource; do
    [ -n "$resource" ] || continue
    case "$resource" in
      deployment.apps/*|deployment/*) ;;
      *) die "unexpected deployment resource returned for $label" ;;
    esac
    remaining=$((CONSUMER_ROLLOUT_DEADLINE - SECONDS))
    [ "$remaining" -gt 0 ] || die "credential rollout deadline expired before $label verification"
    log "Restarting $label deployment ${resource#*/} to load the updated credential"
    if ! kctl -n "$ns" rollout restart "$resource" \
      --request-timeout="${remaining}s" >/dev/null; then
      die "could not restart $label deployment ${resource#*/}"
    fi
    remaining=$((CONSUMER_ROLLOUT_DEADLINE - SECONDS))
    [ "$remaining" -gt 0 ] || die "credential rollout deadline expired before $label verification"
    if ! kctl -n "$ns" rollout status "$resource" --timeout="${remaining}s" \
      --request-timeout="${remaining}s" >/dev/null; then
      die "credential rollout did not become ready for $label deployment ${resource#*/}"
    fi
  done <<< "$deployments"
}

if [ "$GFSC_TOKEN_CHANGED" = "true" ] || [ "$WFC_TOKEN_CHANGED" = "true" ]; then
  CONSUMER_ROLLOUT_DEADLINE=$((SECONDS + 180))
  if [ "$GFSC_TOKEN_CHANGED" = "true" ]; then
    restart_and_verify_selected_deployments \
      gfs clerum.io/globalfilesystem GFSC
  fi
  if [ "$WFC_TOKEN_CHANGED" = "true" ]; then
    restart_and_verify_selected_deployments \
      mcp-host clerum.io/sharedfilesystem WFC
  fi
fi

log "Done."
