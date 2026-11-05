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
#   FORCE_CONSUMER_RESTART               if true, restart every consumer even when
#                                        none of the tokens it reads changed
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=lib/clerum-minikube-context.sh
source "${SCRIPT_DIR}/lib/clerum-minikube-context.sh"
# shellcheck source=lib/token-consumer-stamp.sh
source "${SCRIPT_DIR}/lib/token-consumer-stamp.sh"
MEMBER_REGISTRATION_HMAC_KEY="CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET"
# TOKEN_STAMP_ANNOTATION (the stamp on each consumer Deployment) comes from
# lib/token-consumer-stamp.sh.

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

for ns in control-plane profiles rpc-proxy channels webhook-ingress; do
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
TOKEN_WEBHOOK_PROXY="$(resolve_token CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY \
  webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN)"
TOKEN_WA_READER="$(resolve_token CONTROL_API_INTERNAL_TOKEN_WA_READER \
  channels workflow-approval-request-reader-credentials control-api-token)"
TOKEN_CODEX_LLM_PROXY="$(resolve_token CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY \
  control-plane codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN)"
TOKEN_GROK_LLM_PROXY="$(resolve_token CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY \
  control-plane grok-llm-proxy-secrets GROK_LLM_PROXY_CONTROL_API_TOKEN)"
READER_HANDOFF_TOKEN_VALUE="$(resolve_token CHANNEL_READER_HANDOFF_TOKEN \
  channels workflow-approval-request-reader-credentials channel-reader-handoff-token)"
INTERNAL_CONTROL_WRC_HMAC="$(resolve_token INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET \
  control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET)"
INTERNAL_CONTROL_HCC_HMAC="$(resolve_token INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET \
  control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET)"
MEMBER_REGISTRATION_HMAC="$(resolve_member_registration_hmac)"

for pair in \
  "EXT_REST:$TOKEN_EXT_REST" \
  "RPC:$TOKEN_RPC" \
  "WEBHOOK_PROXY:$TOKEN_WEBHOOK_PROXY" \
  "WA_READER:$TOKEN_WA_READER" \
  "CODEX_LLM_PROXY:$TOKEN_CODEX_LLM_PROXY" \
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
SERVICE_TOKENS_MAP="external-rest-api=${TOKEN_EXT_REST},rpc-proxy=${TOKEN_RPC},webhook-proxy=${TOKEN_WEBHOOK_PROXY},workflow-approval-reader=${TOKEN_WA_READER},codex-llm-proxy=${TOKEN_CODEX_LLM_PROXY},grok-llm-proxy=${TOKEN_GROK_LLM_PROXY}"
INTERNAL_TOKENS_LIST="${TOKEN_EXT_REST},${TOKEN_RPC},${TOKEN_WEBHOOK_PROXY},${TOKEN_WA_READER},${TOKEN_CODEX_LLM_PROXY},${TOKEN_GROK_LLM_PROXY}"

# --- Consumer restart decision ---
# Each consumer's restart is decided by its token stamp
# (lib/token-consumer-stamp.sh): the sha256 of the values its pods were last
# restarted onto, kept as an annotation on the Deployment. A consumer restarts
# when its stamp differs from the values this run writes.
#
# The "changed in this run" flags below compare each Secret value before this
# run with the value it writes, before any Secret is patched. Every existing
# consumer with a changed value is marked restart-pending before the first
# write, so a failed restart, a run that dies half-way, or an out-of-band edit
# that this run reverts (control-api's map and list are rebuilt from the
# callers on every run) is restarted by this run or the next one without any
# manual step. Values stay in shell locals and are never logged.
#
# Each control-api service token has two ends: the caller reads it from its own
# Secret, and control-api verifies it from CONTROL_API_INTERNAL_SERVICE_TOKENS.
# A token that changed at either end counts as changed for both ends.
#
# Prints "true" or "false". Arguments are repeated
# (namespace, secret, key, value-this-run-writes) groups.
consumer_tokens_changed() {
  [ "$#" -gt 0 ] && [ $(( $# % 4 )) -eq 0 ] || \
    die "consumer_tokens_changed: expected (namespace secret key value) groups"
  local current
  while [ "$#" -gt 0 ]; do
    current="$(read_secret_key "$1" "$2" "$3")"
    if [ -z "$current" ] || [ "$current" != "$4" ]; then
      echo true; return
    fi
    shift 4
  done
  echo false
}

# Current control-api service-token map ("name=token,..."), read once.
CURRENT_SERVICE_TOKENS_MAP="$(read_secret_key control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)"

# Prints "true" when a control-api service token changed at either end: the
# caller's Secret key (namespace, secret, key) or the caller's entry (name) in
# control-api's current service-token map. Arguments:
# name namespace secret key value-this-run-writes.
service_token_changed() {
  local name="$1" ns="$2" secret="$3" key="$4" value="$5"
  local entry current_entry="" entries=() caller_key_changed
  # Bash clears `set -e` inside command substitutions, so a `die` in the inner
  # call is propagated explicitly; the caller's assignment then fails too.
  caller_key_changed="$(consumer_tokens_changed "$ns" "$secret" "$key" "$value")" || exit 1
  if [ "$caller_key_changed" = "true" ]; then
    echo true; return
  fi
  if [ -n "$CURRENT_SERVICE_TOKENS_MAP" ]; then
    IFS=',' read -r -a entries <<<"$CURRENT_SERVICE_TOKENS_MAP"
  fi
  for entry in "${entries[@]+"${entries[@]}"}"; do
    if [ "${entry%%=*}" = "$name" ]; then
      current_entry="${entry#*=}"
      break
    fi
  done
  if [ "$current_entry" != "$value" ]; then
    echo true; return
  fi
  echo false
}

# Consumer → keys it reads (deploy/base manifests; per-Host channel-reader
# Deployments are built by host-context-controller buildChannelReaderDeployment).
# Map entry names match SERVICE_TOKENS_MAP above.
EXTERNAL_REST_API_CHANGED="$(service_token_changed external-rest-api \
  profiles external-rest-api-secrets EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN "$TOKEN_EXT_REST")"
RPC_PROXY_CHANGED="$(service_token_changed rpc-proxy \
  rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN "$TOKEN_RPC")"
WEBHOOK_PROXY_CHANGED="$(service_token_changed webhook-proxy \
  webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN "$TOKEN_WEBHOOK_PROXY")"
CODEX_LLM_PROXY_CHANGED="$(service_token_changed codex-llm-proxy \
  control-plane codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN "$TOKEN_CODEX_LLM_PROXY")"
GROK_LLM_PROXY_CHANGED="$(service_token_changed grok-llm-proxy \
  control-plane grok-llm-proxy-secrets GROK_LLM_PROXY_CONTROL_API_TOKEN "$TOKEN_GROK_LLM_PROXY")"
WA_READER_CONTROL_API_TOKEN_CHANGED="$(service_token_changed workflow-approval-reader \
  channels workflow-approval-request-reader-credentials control-api-token "$TOKEN_WA_READER")"
# The reader sends the handoff token and the channel-readers verify it; both
# read the same key, so one comparison decides both restarts.
CHANNEL_READER_CHANGED="$(consumer_tokens_changed \
  channels workflow-approval-request-reader-credentials channel-reader-handoff-token "$READER_HANDOFF_TOKEN_VALUE")"
if [ "$WA_READER_CONTROL_API_TOKEN_CHANGED" = "true" ] || [ "$CHANNEL_READER_CHANGED" = "true" ]; then
  WA_READER_CHANGED=true
else
  WA_READER_CHANGED=false
fi
WORKFLOW_RECIPES_CHANGED="$(consumer_tokens_changed \
  control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET "$INTERNAL_CONTROL_WRC_HMAC")"
HCC_CHANGED="$(consumer_tokens_changed \
  control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET "$INTERNAL_CONTROL_HCC_HMAC")"
# control-api envFrom-loads control-api-internal-tokens and
# internal-control-jwt-secrets whole; only the keys written here are compared.
# It also restarts whenever a service token it verifies changed at the caller's
# end (the other end of each pair above).
CONTROL_API_CHANGED="$(consumer_tokens_changed \
  control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS "$SERVICE_TOKENS_MAP" \
  control-plane control-api-internal-tokens CONTROL_API_INTERNAL_TOKENS "$INTERNAL_TOKENS_LIST" \
  control-plane control-api-internal-tokens "$MEMBER_REGISTRATION_HMAC_KEY" "$MEMBER_REGISTRATION_HMAC" \
  control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET "$INTERNAL_CONTROL_WRC_HMAC" \
  control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET "$INTERNAL_CONTROL_HCC_HMAC")"
for caller_changed in "$EXTERNAL_REST_API_CHANGED" "$RPC_PROXY_CHANGED" "$WEBHOOK_PROXY_CHANGED" \
                      "$CODEX_LLM_PROXY_CHANGED" "$GROK_LLM_PROXY_CHANGED" \
                      "$WA_READER_CONTROL_API_TOKEN_CHANGED"; do
  if [ "$caller_changed" = "true" ]; then
    CONTROL_API_CHANGED=true
  fi
done

# Token stamp per consumer: the values each one reads, as written by this run.
STAMP_CONTROL_API="$(token_stamp_of \
  "CONTROL_API_INTERNAL_SERVICE_TOKENS=$SERVICE_TOKENS_MAP" \
  "CONTROL_API_INTERNAL_TOKENS=$INTERNAL_TOKENS_LIST" \
  "$MEMBER_REGISTRATION_HMAC_KEY=$MEMBER_REGISTRATION_HMAC" \
  "INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET=$INTERNAL_CONTROL_WRC_HMAC" \
  "INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET=$INTERNAL_CONTROL_HCC_HMAC")"
STAMP_WORKFLOW_RECIPES="$(token_stamp_of "INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET=$INTERNAL_CONTROL_WRC_HMAC")"
STAMP_HCC="$(token_stamp_of "INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET=$INTERNAL_CONTROL_HCC_HMAC")"
STAMP_CODEX_LLM_PROXY="$(token_stamp_of "CODEX_LLM_PROXY_CONTROL_API_TOKEN=$TOKEN_CODEX_LLM_PROXY")"
STAMP_GROK_LLM_PROXY="$(token_stamp_of "GROK_LLM_PROXY_CONTROL_API_TOKEN=$TOKEN_GROK_LLM_PROXY")"
STAMP_EXTERNAL_REST_API="$(token_stamp_of "EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN=$TOKEN_EXT_REST")"
STAMP_RPC_PROXY="$(token_stamp_of "RPC_PROXY_CONTROL_API_SERVICE_TOKEN=$TOKEN_RPC")"
STAMP_WEBHOOK_PROXY="$(token_stamp_of "WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN=$TOKEN_WEBHOOK_PROXY")"
STAMP_WA_READER="$(token_stamp_of \
  "control-api-token=$TOKEN_WA_READER" \
  "channel-reader-handoff-token=$READER_HANDOFF_TOKEN_VALUE")"
STAMP_CHANNEL_READER="$(token_stamp_of "channel-reader-handoff-token=$READER_HANDOFF_TOKEN_VALUE")"

# Fixed consumers: "namespace:deployment:changed-in-run:desired-stamp".
TOKEN_CONSUMERS=(
  "control-plane:control-api:${CONTROL_API_CHANGED}:${STAMP_CONTROL_API}"
  "control-plane:codex-llm-proxy:${CODEX_LLM_PROXY_CHANGED}:${STAMP_CODEX_LLM_PROXY}"
  "control-plane:grok-llm-proxy:${GROK_LLM_PROXY_CHANGED}:${STAMP_GROK_LLM_PROXY}"
  "control-plane:workflow-recipes:${WORKFLOW_RECIPES_CHANGED}:${STAMP_WORKFLOW_RECIPES}"
  "control-plane:host-context-controller:${HCC_CHANGED}:${STAMP_HCC}"
  "profiles:external-rest-api:${EXTERNAL_REST_API_CHANGED}:${STAMP_EXTERNAL_REST_API}"
  "rpc-proxy:rpc-proxy:${RPC_PROXY_CHANGED}:${STAMP_RPC_PROXY}"
  "webhook-ingress:webhook-proxy:${WEBHOOK_PROXY_CHANGED}:${STAMP_WEBHOOK_PROXY}"
  "channels:clerum-workflow-approval-request-reader:${WA_READER_CHANGED}:${STAMP_WA_READER}"
)

# --- 0. Record restart obligations before any Secret is written ---
# Every existing consumer whose values change is marked restart-pending here
# (see "Consumer restart decision"). If a mark cannot be written, the run stops
# before changing any Secret.
for entry in "${TOKEN_CONSUMERS[@]}"; do
  IFS=':' read -r ns dep changed _stamp <<<"$entry"
  token_stamp_mark_pending "$TOKEN_STAMP_ANNOTATION" "$ns" "$dep" "$changed" || exit 1
done
if [ "$CHANNEL_READER_CHANGED" = "true" ]; then
  channel_readers_before="$(token_stamp_retry kctl -n channels get deploy -l app=channel-reader \
      -o 'jsonpath={range .items[*]}{.metadata.name}{"\n"}{end}')" \
    || die "cannot list channel-reader deployments before writing Secrets; no Secret was written"
  while IFS= read -r channel_reader; do
    [ -n "$channel_reader" ] || continue
    token_stamp_mark_pending "$TOKEN_STAMP_ANNOTATION" channels "$channel_reader" true || exit 1
  done <<<"$channel_readers_before"
fi

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
RPC_PATCH="$(jq -cn --arg t "$TOKEN_RPC" \
  '{stringData: {RPC_PROXY_CONTROL_API_SERVICE_TOKEN: $t}}')"
kctl -n rpc-proxy patch secret rpc-proxy-secrets --type=merge -p "$RPC_PATCH"

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

# Restart each consumer whose token stamp differs from the values written above
# (see "Consumer restart decision"). Image/spec applies still roll Deployments
# on their own; a Deployment that does not exist yet is skipped.
TOKEN_RESTART_PENDING=()
for entry in "${TOKEN_CONSUMERS[@]}"; do
  IFS=':' read -r ns dep changed stamp <<<"$entry"
  reconcile_token_consumer "$TOKEN_STAMP_ANNOTATION" "$ns" "$dep" "$changed" "$stamp"
done

# Per-Host channel-reader Deployments (built by host-context-controller in the
# channels namespace, label app=channel-reader) read only the handoff token.
if ! channel_readers="$(token_stamp_retry kctl -n channels get deploy -l app=channel-reader \
     -o 'jsonpath={range .items[*]}{.metadata.name}{"\n"}{end}')"; then
  log "ERROR: cannot list channel-reader deployments; their restart is pending"
  TOKEN_RESTART_PENDING+=("channels/app=channel-reader")
elif [ -z "$channel_readers" ]; then
  log "Skipping rollout of channels/app=channel-reader: none deployed"
else
  while IFS= read -r channel_reader; do
    [ -n "$channel_reader" ] || continue
    reconcile_token_consumer "$TOKEN_STAMP_ANNOTATION" channels "$channel_reader" \
      "$CHANNEL_READER_CHANGED" "$STAMP_CHANNEL_READER"
  done <<<"$channel_readers"
fi

token_stamp_fail_if_pending "${CONTEXT:-}" || exit 1

log "Done."
