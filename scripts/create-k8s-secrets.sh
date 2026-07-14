#!/usr/bin/env bash
# =============================================================================
# create-k8s-secrets.sh
#
# Reads credentials from .env and creates Kubernetes secrets and
# CommunicationChannel CRDs needed for E2E testing.
#
# Usage:
#   ./scripts/create-k8s-secrets.sh              # Create ALL secrets + CRDs
#   ./scripts/create-k8s-secrets.sh llm          # Only mcp-host-keys
#   ./scripts/create-k8s-secrets.sh mongodb      # Only mcp-mongodb-credentials
#   ./scripts/create-k8s-secrets.sh airtable     # Only mcp-airtable-credentials
#   ./scripts/create-k8s-secrets.sh channels     # (retired #273 — prints migration message; use Control UI)
#   ./scripts/create-k8s-secrets.sh telegram     # Only Telegram secret + CRD
#   ./scripts/create-k8s-secrets.sh slack        # Only Slack secret + CRD
#   ./scripts/create-k8s-secrets.sh email        # Only email credentials
#   ./scripts/create-k8s-secrets.sh status       # Show what's deployed
#
#   ENV_FILE=.env.prod ./scripts/create-k8s-secrets.sh llm  # Custom .env
#
# Targets can be combined:
#   ./scripts/create-k8s-secrets.sh llm mongodb telegram
#
# See docs/archive/testing/E2E-REAL-SYSTEMS-TESTING.md for credential details.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env}"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[SKIP]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# --- Usage ---
usage() {
  echo -e "${BOLD}Usage:${NC} $0 [target ...]"
  echo ""
  echo "Targets:"
  echo "  all        Create everything (default when no target given)"
  echo "  llm        Secret mcp-host-keys          (ns: mcp-host)   — OpenAI + Claude + ZAI + Bailian keys"
  echo "  mongodb    Secret mcp-mongodb-credentials (ns: mcp-server) — Connection string"
  echo "  airtable   Secret mcp-airtable-credentials(ns: mcp-server) — API key"
  echo "  channels   (retired #273) — create per-Host credentials via Control UI"
  echo "  telegram   (retired #273) — create CommunicationChannel + credentials via Control UI"
  echo "  slack      (retired #273) — create CommunicationChannel + credentials via Control UI"
  echo "  email      (retired #273) — create CommunicationChannel + credentials via Control UI"
  echo "  status     Show deployed secrets and readiness (no changes)"
  echo ""
  echo "Examples:"
  echo "  $0                          # Create all"
  echo "  $0 llm mongodb              # Only LLM keys + MongoDB"
  echo "  $0 telegram                  # Only Telegram"
  echo "  $0 status                    # Check what's deployed"
  echo "  ENV_FILE=.env.prod $0 llm    # Use custom .env file"
}

# --- Load .env ---
load_env() {
  if [ ! -f "$ENV_FILE" ]; then
    err "File not found: $ENV_FILE"
    echo "  Copy .env.example to .env and fill in your credentials:"
    echo "    cp .env.example .env"
    exit 1
  fi
  info "Loading credentials from $ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
}

# --- Verify cluster ---
check_cluster() {
  if ! kubectl cluster-info &>/dev/null; then
    err "Cannot connect to Kubernetes cluster. Is minikube running?"
    echo "  minikube start --cpus=6 --memory=10240"
    exit 1
  fi
  ok "Cluster reachable"
}

# --- Ensure namespaces ---
ensure_namespaces() {
  local namespaces=("$@")
  for ns in "${namespaces[@]}"; do
    kubectl create namespace "$ns" --dry-run=client -o yaml 2>/dev/null | kubectl apply -f - &>/dev/null
  done
}

# =============================================================================
# Individual secret creation functions
# =============================================================================

create_llm() {
  echo ""
  info "--- Secret: mcp-host-keys (ns: mcp-host) ---"
  ensure_namespaces mcp-host

  local args=()

  if [ -n "${OPENAI_API_KEY:-}" ]; then
    args+=(--from-literal=openai-api-key="${OPENAI_API_KEY}")
    ok "  openai-api-key: set (${#OPENAI_API_KEY} chars)"
  else
    warn "  openai-api-key: empty (OpenAI tests will fail)"
  fi

  if [ -n "${CLAUDE_API_KEY:-}" ]; then
    args+=(--from-literal=claude-api-key="${CLAUDE_API_KEY}")
    ok "  claude-api-key: set (${#CLAUDE_API_KEY} chars)"
  else
    warn "  claude-api-key: empty (Claude tests will fail)"
  fi

  if [ -n "${ZAI_API_KEY:-}" ]; then
    args+=(--from-literal=zai-api-key="${ZAI_API_KEY}")
    ok "  zai-api-key: set (${#ZAI_API_KEY} chars)"
  else
    warn "  zai-api-key: empty (ZAI tests will fail)"
  fi

  if [ -n "${BAILIAN_API_KEY:-}" ]; then
    args+=(--from-literal=bailian-api-key="${BAILIAN_API_KEY}")
    ok "  bailian-api-key: set (${#BAILIAN_API_KEY} chars)"
  else
    warn "  bailian-api-key: empty (Bailian tests will fail)"
  fi

  if [ ${#args[@]} -gt 0 ]; then
    kubectl create secret generic mcp-host-keys \
      --namespace=mcp-host \
      "${args[@]}" \
      --dry-run=client -o yaml | kubectl apply -f -
    ok "  Secret mcp-host-keys applied"
  else
    warn "  No LLM keys set — skipping mcp-host-keys"
  fi
}

create_mongodb() {
  echo ""
  info "--- Secret: mcp-mongodb-credentials (ns: mcp-server) ---"
  ensure_namespaces mcp-server

  if [ -n "${MONGODB_CONNECTION_STRING:-}" ]; then
    kubectl create secret generic mcp-mongodb-credentials \
      --namespace=mcp-server \
      --from-literal=connection-string="${MONGODB_CONNECTION_STRING}" \
      --dry-run=client -o yaml | kubectl apply -f -
    ok "  connection-string: set (${#MONGODB_CONNECTION_STRING} chars)"
    ok "  Secret mcp-mongodb-credentials applied"
  else
    warn "  MONGODB_CONNECTION_STRING empty — skipping (MongoDB tests will fail)"
  fi
}

create_airtable() {
  echo ""
  info "--- Secret: mcp-airtable-credentials (ns: mcp-server) ---"
  ensure_namespaces mcp-server

  if [ -n "${AIRTABLE_API_KEY:-}" ]; then
    kubectl create secret generic mcp-airtable-credentials \
      --namespace=mcp-server \
      --from-literal=api-key="${AIRTABLE_API_KEY}" \
      --dry-run=client -o yaml | kubectl apply -f -
    ok "  api-key: set (${#AIRTABLE_API_KEY} chars)"
    ok "  Secret mcp-airtable-credentials applied"
  else
    warn "  AIRTABLE_API_KEY empty — skipping (Airtable tests will fail)"
  fi
}

# Retired in #273: telegram / slack / email / channels targets used to
# create the static `clerum-channel-reader-credentials` Secret and the
# matching e2e CommunicationChannel CRDs. With the static deployment
# retired in favor of per-Host channel-reader pods, channel credentials
# are written by control-api's `/admin/channel-secrets` endpoint from
# the Control UI (Channel credentials panel), and CommunicationChannels
# are created via the Control UI's "New communication channel" page.
#
# The functions are kept as one-line redirects so operators with old
# scripts see a clear migration message rather than a silent no-op.

_deprecated_channel_target() {
  local target="$1"
  warn "  '$target' target retired in #273 — static clerum-channel-reader Deployment is gone."
  info "  Create per-Host channel credentials via the Control UI (Channel credentials panel)."
  info "  Direct API: POST/PUT /api/v1/admin/channel-secrets { host, data: { 'telegram-bot-token': '...' } }"
}

create_telegram() { _deprecated_channel_target telegram; }
create_slack()    { _deprecated_channel_target slack; }
create_email()    { _deprecated_channel_target email; }

create_channels() { _deprecated_channel_target channels; }

# (#273) The _preserve_channel_secret_keys helper that lived here is gone
# along with create_telegram/slack/email/channels. Per-Host credentials are
# now multi-owner-safe by virtue of control-api's mergeSecret semantics
# (`/admin/channel-secrets` PUT), not by this script reading + re-writing
# the whole shared Secret on every key change.

# =============================================================================
# Status: show what's deployed without making changes
# =============================================================================
show_status() {
  echo ""
  info "=== Deployed Secrets ==="

  echo ""
  echo "  Namespace: mcp-host"
  if kubectl get secret mcp-host-keys -n mcp-host &>/dev/null; then
    local keys
    keys=$(kubectl get secret mcp-host-keys -n mcp-host -o json | \
      python3 -c "import sys,json; d=json.load(sys.stdin).get('data',{}); [print(f'    {k}: ({len(d[k])} chars base64)') for k in sorted(d)]" 2>/dev/null || \
      echo "    (could not read keys)")
    echo -e "  ${GREEN}EXISTS${NC} mcp-host-keys"
    echo "$keys"
  else
    echo -e "  ${YELLOW}MISSING${NC} mcp-host-keys"
  fi

  echo ""
  echo "  Namespace: mcp-server"
  for secret in mcp-mongodb-credentials mcp-airtable-credentials; do
    if kubectl get secret "$secret" -n mcp-server &>/dev/null; then
      echo -e "  ${GREEN}EXISTS${NC} $secret"
    else
      echo -e "  ${YELLOW}MISSING${NC} $secret"
    fi
  done

  echo ""
  echo "  Namespace: channels"
  # Per-Host channel-reader credential Secrets are written by control-api's
  # /admin/channel-secrets endpoint (Control UI), one per Host. Listing them
  # by managed label since names are dynamic (channel-reader-<host>-credentials).
  local channel_secrets
  channel_secrets=$(kubectl get secret -n channels -l clerum.io/component=channel-reader \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)
  if [ -n "$channel_secrets" ]; then
    echo -e "  ${GREEN}EXISTS${NC} per-Host channel-reader credential Secrets:"
    echo "$channel_secrets" | sed 's/^/    /'
  else
    echo -e "  ${YELLOW}NONE${NC}    no per-Host channel-reader credentials configured (create via Control UI)"
  fi

  echo ""
  info "=== CommunicationChannels ==="
  kubectl get communicationchannels -A 2>/dev/null | grep -E "^(NAMESPACE|.*e2e-)" || echo "  (none found)"

  echo ""
  info "=== Test Readiness ==="

  # Load env to check which vars are set
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
  fi

  _check "Core (LLM + MongoDB)"  OPENAI_API_KEY MONGODB_CONNECTION_STRING
  _check "Airtable"              AIRTABLE_API_KEY
  _check "Claude provider"       CLAUDE_API_KEY
  _check "ZAI provider"          ZAI_API_KEY
  _check "Bailian provider"      BAILIAN_API_KEY
  _check "Telegram channel"      CLERUM_TELEGRAM_BOT_TOKEN CLERUM_TELEGRAM_USER_ID
  _check "Slack channel"         CLERUM_SLACK_BOT_TOKEN CLERUM_SLACK_CHANNEL_ID CLERUM_SLACK_USERNAME
  _check "Email (real IMAP)"     CLERUM_EMAIL_USERNAME CLERUM_EMAIL_PASSWORD
  echo -e "  ${GREEN}READY${NC}  Email (Mailpit in-cluster) — no credentials needed"
  echo -e "  ${GREEN}READY${NC}  Kubernetes — cluster connected"
}

_check() {
  local label="$1"; shift
  local is_ok=true
  local missing=()
  for var in "$@"; do
    if [ -z "${!var:-}" ]; then
      is_ok=false
      missing+=("$var")
    fi
  done
  if $is_ok; then
    echo -e "  ${GREEN}READY${NC}  $label"
  else
    echo -e "  ${YELLOW}SKIP${NC}   $label (missing: ${missing[*]})"
  fi
}

# =============================================================================
# Main
# =============================================================================

# Handle --help / -h
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

# Parse targets
TARGETS=("${@:-all}")

# Status doesn't need .env or cluster checks
if [[ "${TARGETS[*]}" == "status" ]]; then
  check_cluster
  if [ -f "$ENV_FILE" ]; then
    load_env
  fi
  show_status
  exit 0
fi

# Everything else needs .env and cluster
load_env
check_cluster

# Execute targets
for target in "${TARGETS[@]}"; do
  case "$target" in
    all)
      create_llm
      create_mongodb
      create_airtable
      create_channels
      echo ""
      show_status
      ;;
    llm)        create_llm ;;
    mongodb)    create_mongodb ;;
    airtable)   create_airtable ;;
    channels)   create_channels ;;
    telegram)   create_telegram ;;
    slack)      create_slack ;;
    email)      create_email ;;
    status)     show_status ;;
    *)
      err "Unknown target: $target"
      echo ""
      usage
      exit 1
      ;;
  esac
done

# Show next steps (unless just running status)
if [[ "${TARGETS[*]}" != "status" ]]; then
  echo ""
  info "Done. Next steps:"
  echo "  ./scripts/create-k8s-secrets.sh status    # Verify what's deployed"
  echo "  See docs/archive/testing/E2E-REAL-SYSTEMS-TESTING.md for test execution"
fi
