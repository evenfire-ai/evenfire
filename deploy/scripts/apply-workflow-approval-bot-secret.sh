#!/usr/bin/env bash
set -euo pipefail

# Apply Figure D workflow-approval reader secrets as native K8s Secrets using
# `kubectl patch`.
#
# Figure D approval delivery is channel-scoped. The control-api worker resolves
# provider bot credentials from each CommunicationChannel, not from a
# cluster-global worker secret.
#
# Populated Secret:
#   channels/workflow-approval-request-reader-credentials  (webhook secret)
#        telegram-webhook-secret  — PRE-WIRED defense for the FUTURE Mode B
#        (inline buttons / webhook). Auto-generated; does NOT activate the
#        webhook path (nobody calls setWebhook in this PR). Populating it has
#        NO effect on the channel-reader getUpdates polling.
#
# Why `kubectl patch --type=merge` (NOT `create --dry-run | apply`):
#   The Secret ships `stringData: {}` as a loud canary in base
#   (deploy/base/channels/secrets-canary.yaml). `create|apply` records the value
#   in last-applied-configuration; the next `kubectl apply -k` would
#   three-way-merge against the empty base canary and WIPE the value back to
#   empty. `patch --type=merge` writes OUTSIDE the apply envelope, so the real
#   value survives every CI redeploy. Same pattern as apply-inter-service-tokens.sh.
#
# Idempotency: each value is resolved env var → existing Secret value →
#   (telegram-webhook-secret only) freshly generated. Re-running never rotates
#   a present value silently.
#
# Env vars consumed:
#   CONTEXT                              kubectl context (unset = current)
#   WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET (optional) webhook secret-token;
#                                            auto-generated if absent
#   FORCE_CONSUMER_RESTART                   if true, restart the reader even
#                                            when telegram-webhook-secret is
#                                            unchanged
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/clerum-minikube-context.sh
source "${SCRIPT_DIR}/lib/clerum-minikube-context.sh"
# shellcheck source=lib/token-consumer-stamp.sh
source "${SCRIPT_DIR}/lib/token-consumer-stamp.sh"

READER_NS="channels"
READER_SECRET="workflow-approval-request-reader-credentials"

kctl() {
  if [ -n "${CONTEXT:-}" ]; then
    kubectl --context "$CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

log() { printf '[workflow-approval-bot-secret] %s\n' "$*" >&2; }

die() { printf '[workflow-approval-bot-secret] ERROR: %s\n' "$*" >&2; exit 1; }

is_minikube_context() {
  is_clerum_minikube_context
}

# Read a plain string key from a Secret. Returns empty if Secret/key missing
# or the value looks like a `replace-with-*` placeholder.
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

# Resolve a value: env var → existing Secret value → (empty).
resolve_value() {
  local env_var="$1" ns="$2" secret="$3" key="$4"
  local env_val="${!env_var:-}"
  if [ -n "$env_val" ]; then
    printf '%s' "$env_val"; return
  fi
  read_secret_key "$ns" "$secret" "$key"
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

command -v jq >/dev/null 2>&1 || die "jq is required (apt-get install jq)"

log "Resolving Figure D workflow-approval reader secrets (context: ${CONTEXT:-<current>})"

ensure_namespace "$READER_NS"

# --- Reader webhook secret-token (channels/...) — PRE-WIRED for Mode B ---
# Auto-generate if absent. This does NOT activate the webhook path; it only
# makes the secret-token available so the future Mode B PR (ingress +
# setWebhook) does not have to touch provisioning. The reader validates it
# only IF a webhook ever arrives (server.ts), which it will not until
# setWebhook is called.
WEBHOOK_SECRET="$(resolve_value WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET "$READER_NS" "$READER_SECRET" telegram-webhook-secret)"
if [ -z "$WEBHOOK_SECRET" ]; then
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  log "Generated fresh telegram-webhook-secret (pre-wired defense; webhook path stays inactive)"
fi
# The reader reads telegram-webhook-secret as an env var
# (deploy/base/channels/workflow-approval-request-reader/deployment.yaml), so it
# restarts when that value differs from its token stamp
# (lib/token-consumer-stamp.sh; this script's stamp annotation is separate from
# apply-inter-service-tokens.sh's, which covers the reader's other keys). A
# missed or failed restart keeps the old stamp and is retried by the next run.
# READER_CHANGED (stored value before this run versus the value it writes) is
# used only when the reader has no stamp yet. Values stay in shell locals and
# are never logged.
WEBHOOK_SECRET_BEFORE="$(read_secret_key "$READER_NS" "$READER_SECRET" telegram-webhook-secret)"
if [ -z "$WEBHOOK_SECRET_BEFORE" ] || [ "$WEBHOOK_SECRET_BEFORE" != "$WEBHOOK_SECRET" ]; then
  READER_CHANGED=true
else
  READER_CHANGED=false
fi
READER_STAMP="$(token_stamp_of "telegram-webhook-secret=$WEBHOOK_SECRET")"

log "Patching Secret $READER_SECRET ($READER_NS)"
ensure_secret "$READER_NS" "$READER_SECRET"
READER_PATCH="$(jq -cn --arg s "$WEBHOOK_SECRET" '{stringData: {"telegram-webhook-secret": $s}}')"
kctl -n "$READER_NS" patch secret "$READER_SECRET" --type=merge -p "$READER_PATCH"

# --- Roll the reader when its stamp differs (skipped if not deployed) ---
# shellcheck disable=SC2034 # filled and read by lib/token-consumer-stamp.sh
TOKEN_RESTART_PENDING=()
reconcile_token_consumer "clerum.io/workflow-approval-bot-secret-sha256" \
  "$READER_NS" clerum-workflow-approval-request-reader "$READER_CHANGED" "$READER_STAMP"
token_stamp_fail_if_pending "${CONTEXT:-}" || exit 1

log "Done."
