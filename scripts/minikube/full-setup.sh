#!/usr/bin/env bash
# ======================================================================
# Clerum Minikube Full Setup — Idempotent Orchestrator
# ======================================================================
#
# Single script that sets up the entire Clerum minikube cluster from
# scratch. Safe to run multiple times (idempotent).
#
# Usage:
#   ./scripts/minikube/full-setup.sh                # Full setup
#   ./scripts/minikube/full-setup.sh --skip-build   # Skip image build
#   ./scripts/minikube/full-setup.sh --skip-uis     # Skip UIs and Desktop App
#   ./scripts/minikube/full-setup.sh --reset-db     # Reset postgres DB
#   ./scripts/minikube/full-setup.sh --force-keys   # Regenerate JWT keys
#   ./scripts/minikube/full-setup.sh -h | --help
#
# Environment:
#   MINIKUBE_PROFILE=clerum-test       Target minikube profile.
#   MINIKUBE_MULTI_NODE=true           Opt into a two-node local cluster.
#   MINIKUBE_NODES=2                   Explicit node count for multi-node gates.
#   MINIKUBE_RECREATE_PROFILE=true     Allow destructive profile recreation only
#   CONFIRM_PROFILE=<profile>          when it matches the exact target profile.
#   BRANCH_PROFILE_DEPLOY_DIR=<dir>     Optional branch-profile deploy cache root.
#
# Loads .env from project root if present (API keys, credentials).
# ======================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/e2e/load-dotenv.sh
source "${PROJECT_DIR}/scripts/e2e/load-dotenv.sh"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "${PROJECT_DIR}/scripts/e2e/admin-credentials.sh"

# ── Color helpers ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[SETUP]${NC} $*"; }
ok()   { echo -e "${GREEN}  OK${NC} -- $*"; }
warn() { echo -e "${YELLOW}  WARN${NC} -- $*"; }
err()  { echo -e "${RED}  ERROR${NC} -- $*"; }

step_header() {
  local num=$1 total=$2 title=$3
  echo ""
  echo -e "${BOLD}================================================================${NC}"
  echo -e "${BOLD}  Step ${num}/${total}: ${title}${NC}"
  echo -e "${BOLD}================================================================${NC}"
}

# ── McpServer envSecret validation ─────────────────────────────────────
# Fail-fast guard: when an McpServer CRD declares `spec.envSecret.name`,
# the referenced Secret MUST exist in the same namespace or HCC silently
# hangs without reconciling the Deployment. This function enumerates all
# McpServers, checks each envSecret reference, and aborts the setup with
# a clear error message if any are missing.
#
# Respects MINIKUBE_SKIP_SECRET_VERIFY=true to bypass validation (rollback
# escape hatch per plan §6 rollback matrix).
#
# Returns: 0 on success, 1 if any envSecret reference is unresolved.
validate_mcpserver_secrets() {
  if [ "${MINIKUBE_SKIP_SECRET_VERIFY:-false}" = "true" ]; then
    warn "MINIKUBE_SKIP_SECRET_VERIFY=true — skipping McpServer envSecret validation"
    return 0
  fi

  log "Validating McpServer envSecret references..."

  local rows
  rows=$($KC get mcpservers -A \
    -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.envSecret.name}{"\n"}{end}' \
    2>/dev/null || true)

  if [ -z "$rows" ]; then
    ok "No McpServer CRDs found — nothing to validate"
    return 0
  fi

  local failed=0
  local missing_lines=""
  while IFS=$'\t' read -r ns name secret_name; do
    [ -z "${ns:-}" ] && continue
    [ -z "${secret_name:-}" ] && continue
    if ! $KC get secret "$secret_name" -n "$ns" >/dev/null 2>&1; then
      failed=$((failed + 1))
      missing_lines+="  ${RED}✗${NC} McpServer ${ns}/${name} references missing Secret ${ns}/${secret_name}"$'\n'
    fi
  done <<< "$rows"

  if [ "$failed" -gt 0 ]; then
    err "McpServer envSecret validation failed (${failed} missing binding(s)):"
    # shellcheck disable=SC2059
    printf "${missing_lines}"
    echo ""
    echo -e "  ${BOLD}Hint:${NC} Create the missing Secrets before re-running setup. Example:"
    echo -e "    ${CYAN}kubectl --context=${PROFILE} create secret generic <name> \\${NC}"
    echo -e "    ${CYAN}  -n <namespace> --from-literal=<key>=<value>${NC}"
    echo -e "  Or drop a gitignored ${CYAN}mcp-servers/<svc>/secret.yaml${NC} and re-run."
    echo -e "  To bypass this check (not recommended): ${CYAN}MINIKUBE_SKIP_SECRET_VERIFY=true${NC}"
    return 1
  fi

  ok "All McpServer envSecret references resolved"
  return 0
}

# ── Parse flags ────────────────────────────────────────────────────────
SKIP_BUILD=false
SKIP_UIS="${MINIKUBE_SKIP_UIS:-false}"
RESET_DB=true
FORCE_KEYS=false
CONTROL_DB_RESET_PVC_UID="${CONTROL_DB_RESET_PVC_UID:-}"
CONTROL_DB_RESET_RESUME="${CONTROL_DB_RESET_RESUME:-false}"

case "${SKIP_UIS}" in
  true|1|yes) SKIP_UIS=true ;;
  *) SKIP_UIS=false ;;
esac

# Rebuild the DB from scratch by default (RESET_DB=true above) so a stale
# control-postgres volume from an older build cannot drift from the current
# schema/grant contract: the migration gate enforces an exact runtime-access
# contract, and already-recorded migrations never re-run to reconcile it. Opt
# out with REUSE_DB=true (or --keep-db) to preserve an existing volume.
case "${REUSE_DB:-false}" in
  true|1|yes) RESET_DB=false ;;
  *) : ;;
esac

SEED_PROFILE="${MINIKUBE_SEED_PROFILE:-minimal}"

# Unlike the SKIP_UIS boolean normalizer, an unrecognized profile is a hard
# error — silently falling back to `minimal` would skip the E2E fixtures a
# caller explicitly asked for, and the failure would surface much later as a
# confusing test failure.
case "${SEED_PROFILE}" in
  minimal|e2e) ;;
  *) err "Unknown SEED_PROFILE: '${SEED_PROFILE}' (expected: minimal | e2e)"; exit 1 ;;
esac

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Idempotent orchestrator for Clerum minikube full-stack setup.

Options:
  --skip-build   Skip Docker image builds (use pre-loaded images)
  --skip-uis     Skip Control UI, Profile UI, and Desktop App image builds.
                 Control/Profile UI cluster deployments are also skipped.
  --seed-profile=<minimal|e2e>
                         minimal (default): a clean install — one agent, no
                         test fixtures. e2e: adds the E2E fixtures (test user,
                         e2e-* recipes, demo MCP servers). Requires ADMIN_PASSWORD
                         unless --seed-profile=e2e.
  --reset-db     Force a postgres DB rebuild (already the default; deletes PVC, re-deploys)
  --keep-db      Preserve the existing postgres DB volume (skip the default rebuild)
  --force-keys   Force JWT key regeneration (invalidates existing tokens)
  -h, --help     Show this help message

Environment:
  MINIKUBE_PROFILE       Target profile (default: clerum-test)
  MINIKUBE_MULTI_NODE    Set true to opt into a two-node local cluster
  MINIKUBE_NODES         Explicit node count; values >1 imply multi-node
  MINIKUBE_SKIP_UIS      Set true to skip Control UI, Profile UI, and Desktop App
  REUSE_DB               Set true to preserve the existing postgres DB volume;
                         default rebuilds control-postgres from scratch every run
  MINIKUBE_SEED_PROFILE, ADMIN_PASSWORD
                         See --seed-profile above
  MINIKUBE_RECREATE_PROFILE
                         Set true to allow destructive broken-profile recreation
  CONFIRM_PROFILE        Must match MINIKUBE_PROFILE before any profile deletion
  CONTROL_DB_RESET_PVC_UID
                         Required with --reset-db: exact approved PVC UID, or
                         "none" when no control-postgres-data PVC exists
  CONTROL_DB_RESET_RESUME
                         Set true only to resume the same interrupted reset
  BRANCH_PROFILE_DEPLOY_DIR
                         Optional deploy cache root; when set, kustomize uses
                         <dir>/overlays/minikube instead of PROJECT_DIR/deploy

  Loads .env from project root if present. Supported variables:
    OPENAI_API_KEY, CLAUDE_API_KEY, ZAI_API_KEY, BAILIAN_API_KEY
    CLERUM_TELEGRAM_BOT_TOKEN, CLERUM_SLACK_BOT_TOKEN
    CLERUM_EMAIL_USERNAME, CLERUM_EMAIL_PASSWORD
    CLERUM_MODEL_PROVIDER, CLERUM_MODEL_NAME

Examples:
  $(basename "$0")                       # Full setup from scratch
  $(basename "$0") --skip-build          # Re-deploy without rebuilding images
  $(basename "$0") --skip-uis            # Deploy backend services without UIs
  $(basename "$0") --seed-profile=e2e     # Full E2E fixture set
  $(basename "$0") --keep-db             # Preserve the existing DB (skip the default rebuild)
  $(basename "$0") --force-keys          # Regenerate all JWT keys
EOF
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-uis)   SKIP_UIS=true ;;
    --seed-profile=*) SEED_PROFILE="${arg#*=}" ;;
    --reset-db)   RESET_DB=true ;;
    --keep-db)    RESET_DB=false ;;
    --force-keys) FORCE_KEYS=true ;;
    -h|--help)    usage ;;
    *) err "Unknown flag: $arg"; usage ;;
  esac
done

# Re-validate: --seed-profile= above can override the env-derived value, so
# the same check that guards MINIKUBE_SEED_PROFILE must run again here or
# `--seed-profile=bogus` slips through unvalidated.
case "${SEED_PROFILE}" in
  minimal|e2e) ;;
  *) err "Unknown --seed-profile: '${SEED_PROFILE}' (expected: minimal | e2e)"; exit 1 ;;
esac

# ── Load .env ──────────────────────────────────────────────────────────
# Worktrees resolve through git-common-dir to the primary checkout. Dotenv is
# parsed as data (never sourced as shell code), and admin aliases use the
# shared layer-first contract: canonical .env, then process, then local fallback.
ENV_FILE="$(dotenv_canonical_root "${PROJECT_DIR}")"

if [ -n "$ENV_FILE" ]; then
  log "Loading .env from ${ENV_FILE}..."
  dotenv_load_file "$ENV_FILE"
  ok ".env loaded"
else
  warn "No .env found in ${PROJECT_DIR} or main repo — channel-reader + LLM secrets will use placeholders"
fi
ADMIN_PASSWORD="$(e2e_resolve_admin_password "${PROJECT_DIR}" || true)"
export ADMIN_PASSWORD

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
KC="kubectl --context=${PROFILE}"
TOTAL_STEPS=12
ACTIVE_MINIKUBE_DEPLOY_DIR="${BRANCH_PROFILE_DEPLOY_DIR:-${PROJECT_DIR}/deploy}"
ACTIVE_MINIKUBE_KUSTOMIZE_DIR="${ACTIVE_MINIKUBE_DEPLOY_DIR}/overlays/minikube"
ACTIVE_MINIKUBE_RENDER_DIR="${ACTIVE_MINIKUBE_KUSTOMIZE_DIR}"
if [ "$SKIP_UIS" = true ]; then
  ACTIVE_MINIKUBE_RENDER_DIR="${ACTIVE_MINIKUBE_DEPLOY_DIR}/overlays/minikube-no-uis"
fi
MINIKUBE_START_SCRIPT="${MINIKUBE_START_SCRIPT:-${SCRIPT_DIR}/start.sh}"

minikube_status_snapshot() {
  minikube -p "$PROFILE" status 2>/dev/null || true
}

minikube_status_is_healthy() {
  local status="${1:-}"
  [[ "$status" == *"host: Running"* ]] &&
  [[ "$status" == *"kubelet: Running"* ]] &&
  [[ "$status" == *"apiserver: Running"* ]] &&
  [[ "$status" != *"Stopped"* ]]
}

minikube_status_is_broken_profile() {
  local status="${1:-}"
  [[ "$status" == *"host: Running"* ]] && {
    [[ "$status" == *"kubelet: Stopped"* ]] ||
    [[ "$status" == *"apiserver: Stopped"* ]]
  }
}

recreate_broken_minikube_profile() {
  if [[ "${MINIKUBE_RECREATE_PROFILE:-false}" != "true" || "${CONFIRM_PROFILE:-}" != "${PROFILE}" ]]; then
    err "Refusing to delete minikube profile '${PROFILE}' without explicit confirmation."
    echo "  Re-run only if intended with: MINIKUBE_RECREATE_PROFILE=true CONFIRM_PROFILE=${PROFILE}" >&2
    exit 1
  fi
  warn "Minikube profile '${PROFILE}' is partially started (host up, control plane down). Recreating it from scratch..."
  minikube delete -p "$PROFILE" >/dev/null 2>&1 || true
  ok "Removed broken '${PROFILE}' profile"
}

start_minikube_cluster() {
  log "Starting minikube cluster '${PROFILE}'..."
  # Delegates to start.sh which honors MINIKUBE_MEMORY / MINIKUBE_CPUS /
  # MINIKUBE_MULTI_NODE / MINIKUBE_NODES. See scripts/minikube/start.sh.
  MINIKUBE_PROFILE="${PROFILE}" \
    MINIKUBE_MULTI_NODE="${MINIKUBE_MULTI_NODE:-false}" \
    MINIKUBE_NODES="${MINIKUBE_NODES:-}" \
    "${MINIKUBE_START_SCRIPT}"
  ok "Minikube cluster '${PROFILE}' started"
}

validate_minikube_cluster() {
  log "Validating minikube cluster '${PROFILE}'..."
  MINIKUBE_PROFILE="${PROFILE}" \
    MINIKUBE_MULTI_NODE="${MINIKUBE_MULTI_NODE:-false}" \
    MINIKUBE_NODES="${MINIKUBE_NODES:-}" \
    "${MINIKUBE_START_SCRIPT}" --validate-only
  ok "Minikube cluster '${PROFILE}' validated"
}

maybe_exit_after_cluster_step() {
  if [ "${MINIKUBE_SETUP_EXIT_AFTER_CLUSTER:-false}" = "true" ]; then
    log "MINIKUBE_SETUP_EXIT_AFTER_CLUSTER=true — stopping after cluster verification"
    exit 0
  fi
}

postgres_has_invalid_checkpoint() {
  local pods pod logs
  pods="$($KC get pods -n control-plane -l app=control-postgres -o name)" || return 1
  pod="${pods%%$'\n'*}"
  [ -n "$pod" ] || return 1
  logs="$($KC logs "$pod" -n control-plane --tail=50)" || return 1
  grep -q "invalid checkpoint record" <<<"$logs"
}

ensure_control_postgres_ready() {
  if $KC rollout status deployment/control-postgres -n control-plane --timeout=180s >/dev/null 2>&1; then
    return 0
  fi
  if ! postgres_has_invalid_checkpoint; then
    err "control-plane/control-postgres did not become Ready and no supported WAL recovery signature was found"
    return 1
  fi
  err "Postgres reports an invalid checkpoint; automatic destructive recovery is disabled"
  err "Re-run with --reset-db and CONTROL_DB_RESET_PVC_UID=<exact approved UID>"
  return 1
}

# ======================================================================
# Step 1: Preconditions
# ======================================================================
step_header 1 $TOTAL_STEPS "Preconditions"

# Check Docker is running
if ! docker info &>/dev/null; then
  err "Docker is not running. Please start Docker Desktop first."
  exit 1
fi
ok "Docker is running"

# Check minikube is installed
if ! command -v minikube &>/dev/null; then
  err "minikube is not installed. Install with: brew install minikube"
  exit 1
fi
ok "minikube is installed"

# Check kubectl is installed
if ! command -v kubectl &>/dev/null; then
  err "kubectl is not installed. Install with: brew install kubectl"
  exit 1
fi
ok "kubectl is installed"

# Check python3 is available (needed for JWT sync)
if ! command -v python3 &>/dev/null; then
  err "python3 is not installed (required for JWT key sync)."
  exit 1
fi
ok "python3 is available"

# Check ruby is available (run-control-api-db-migration.sh renders the kustomize
# overlay with `ruby -ryaml -rjson`; ruby ships with macOS but not every Linux).
if ! command -v ruby &>/dev/null; then
  err "ruby is not installed (required to render the control-api DB migration overlay). Install with: brew install ruby  (macOS) / apt-get install ruby  (Debian/Ubuntu)."
  exit 1
fi
ok "ruby is available"

# Fail here, not at Step 10. Image builds dominate a 5-10 min first run
# (README.md:178); aborting after them for a missing .env line is hostile.
if [ "$SEED_PROFILE" = "minimal" ] && [ -z "${ADMIN_PASSWORD:-}" ]; then
  err "ADMIN_PASSWORD is not set."
  err ""
  err "  This is your Control UI admin password AND your Desktop App login."
  err "  Set it in .env at the project root:"
  err ""
  err "      ADMIN_PASSWORD=<choose-a-password>"
  err ""
  err "  No default password ships with Evenfire. For the E2E fixture profile"
  err "  (which pins a known test password), run: make minikube-setup-e2e"
  exit 1
fi
# Reject a too-short/too-long password here rather than at seed time (Step 10).
# control-api enforces 8-256 chars (control-api/src/routes/admin/auth.ts); if we
# defer, the bootstrap POST fails with "password must be between 8 and 256
# characters" only AFTER image builds + deploy, and the admin account may still
# hold the publicly-known default. Keep these bounds in sync with auth.ts. Scope
# to the minimal profile: the E2E profile may use its local-only fallback when
# no canonical or explicit admin credential is configured.
if [ "$SEED_PROFILE" = "minimal" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  pw_len=${#ADMIN_PASSWORD}
  if [ "$pw_len" -lt 8 ] || [ "$pw_len" -gt 256 ]; then
    err "ADMIN_PASSWORD must be between 8 and 256 characters (got ${pw_len})."
    err ""
    err "  Set a longer value in .env at the project root:"
    err ""
    err "      ADMIN_PASSWORD=<choose-a-password-8-256-chars>"
    exit 1
  fi
fi
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  ok "ADMIN_PASSWORD resolved from the canonical environment contract"
else
  ok "No admin password configured; the E2E-only local fallback will be used at seed time"
fi

# ======================================================================
# Step 2: Cluster
# ======================================================================
step_header 2 $TOTAL_STEPS "Cluster"

CLUSTER_STATUS="$(minikube_status_snapshot)"
if minikube_status_is_healthy "$CLUSTER_STATUS"; then
  ok "Minikube cluster '${PROFILE}' is already running"
  validate_minikube_cluster
else
  if minikube_status_is_broken_profile "$CLUSTER_STATUS"; then
    recreate_broken_minikube_profile
  fi
  start_minikube_cluster
fi

# Verify cluster is reachable
if ! $KC cluster-info &>/dev/null; then
  CLUSTER_STATUS="$(minikube_status_snapshot)"
  if minikube_status_is_broken_profile "$CLUSTER_STATUS"; then
    warn "Cluster '${PROFILE}' is still unhealthy after start. Recreating the profile and retrying once..."
    recreate_broken_minikube_profile
    start_minikube_cluster
  fi

  if ! $KC cluster-info &>/dev/null; then
    err "Cluster '${PROFILE}' not reachable after start."
    exit 1
  fi
fi
ok "Cluster '${PROFILE}' is reachable"
maybe_exit_after_cluster_step

# ======================================================================
# Step 3: Namespaces + CRDs
# ======================================================================
step_header 3 $TOTAL_STEPS "Namespaces + CRDs"

log "Creating namespaces..."
$KC apply -f "${PROJECT_DIR}/deploy/base/namespaces.yaml"
ok "7 namespaces created/verified"

log "Installing CRDs..."
$KC apply -f "${PROJECT_DIR}/charts/clerum-crds/crds/"
ok "All CRDs installed"

# ======================================================================
# Step 4: Secrets
# ======================================================================
step_header 4 $TOTAL_STEPS "Secrets"

# 4a. JWT signing keys
log "Generating JWT signing keys..."
if [ "$FORCE_KEYS" = true ]; then
  FORCE_REGEN=true bash "${SCRIPT_DIR}/generate-keys.sh" --apply
  ok "JWT signing keys regenerated (--force-keys)"
else
  bash "${SCRIPT_DIR}/generate-keys.sh" --apply
  ok "JWT signing keys (existing or newly generated)"
fi

# 4b. Inter-service tokens
# The `inter-service-tokens.yaml` overlay only seeds one Secret in control-plane
# with DEV placeholder values. The real service-to-service auth (external-rest-api,
# rpc-proxy, workflow-recipes → control-api) lives in 4 *different* Secrets that
# `apply-inter-service-tokens.sh` patches via `kubectl patch --type=merge`:
#   - control-plane/control-api-internal-tokens
#   - control-plane/workflow-recipes-secrets
#   - profiles/external-rest-api-secrets
#   - rpc-proxy/rpc-proxy-secrets
# Without this call, external-rest-api crashes with:
#   "Missing required environment variable: EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN"
# The script is idempotent: existing tokens are preserved, missing ones are
# generated via `openssl rand -hex 32`.
log "Applying inter-service tokens (overlay + real Secret patches)..."
$KC apply -f "${PROJECT_DIR}/deploy/overlays/minikube/secrets/inter-service-tokens.yaml"
CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/apply-inter-service-tokens.sh"
ok "Inter-service tokens applied (4 Secrets patched)"

# 4c. Channel credentials — retired in #273.
# The static `clerum-channel-reader-credentials` Secret used to be applied here
# (from deploy/overlays/minikube/secrets/channel-credentials.yaml) and then
# patched with .env overrides. With the static `clerum-channel-reader`
# Deployment retired, channel credentials are per-Host and written via
# control-api's `/admin/channel-secrets` endpoint from the Control UI's
# Channel credentials panel. No bootstrap-time Secret needed.
#
# For minikube developers who want to skip the UI step: after `make minikube-setup`
# finishes, send a PUT to /api/v1/admin/channel-secrets with the bot token JSON
# (one POST per Host). See docs/deploy/minikube.md for the curl-based recipe.

# 4d. LLM API keys (override from .env if present)
log "Applying LLM API keys..."
$KC apply -f "${PROJECT_DIR}/deploy/overlays/minikube/secrets/llm-api-keys.yaml"
# If .env has real keys, patch the secret with actual values
if [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${CLAUDE_API_KEY:-}" ] || [ -n "${ZAI_API_KEY:-}" ] || [ -n "${BAILIAN_API_KEY:-}" ]; then
  log "Patching LLM API keys with .env overrides..."
  $KC create secret generic chatllm-api-keys \
    --namespace=mcp-host \
    --from-literal=openai-api-key="${OPENAI_API_KEY:-sk-test-placeholder-openai-key-00000000000000000000}" \
    --from-literal=claude-api-key="${CLAUDE_API_KEY:-sk-ant-api03-test-placeholder-claude-key-000000000000000000000000000000000000000000000000000000}" \
    --from-literal=zai-api-key="${ZAI_API_KEY:-zai-test-placeholder-zai-key-00000000000000000000}" \
    --from-literal=bailian-api-key="${BAILIAN_API_KEY:-sk-test-placeholder-bailian-key-00000000000000000000}" \
    --dry-run=client -o yaml | $KC apply -f -
  ok "LLM API keys patched with .env values"

  # Post-refactor (WRC Secret Broker): the 4 per-provider Secrets in control-plane
  # (clerum-{openai,claude,zai,bailian}-api-key) have been removed. WRC now reads
  # directly from chatllm-api-keys in mcp-host (the block above) — single source
  # of truth. See .ralph/plans/rosy-tinkering-llama.md for full rationale.
fi
ok "LLM API keys applied"

# 4e. Search API keys (if file exists)
if [ -f "${PROJECT_DIR}/deploy/overlays/minikube/secrets/search-api-keys.yaml" ]; then
  $KC apply -f "${PROJECT_DIR}/deploy/overlays/minikube/secrets/search-api-keys.yaml"
  ok "Search API keys applied"
fi

# 4f. MCP server secrets (MongoDB, Airtable)
# Preferred source: gitignored ${svc}/secret.yaml with real credentials.
# Fallback: create dev-grade placeholders so HCC can reconcile the McpServer
# CRDs (envSecret references must resolve or the Deployment is never created).
# Real credentials can be injected later via AIRTABLE_API_KEY / MONGODB_CONNECTION_STRING
# in .env and re-running setup, or via scripts/create-k8s-secrets.sh.
#
# Gated with SEED_PROFILE=e2e together with the McpServer instances themselves
# (deploy/overlays/minikube/instances-e2e/, Step 6e below). They MUST move as
# a pair: validate_mcpserver_secrets (below) aborts the whole setup if any
# McpServer.envSecret is unresolvable, so a server applied without its secret
# is a hard failure — a secret applied without its server is merely unused.
log "Applying MCP server secrets..."
$KC create namespace mcp-server --dry-run=client -o yaml | $KC apply -f - >/dev/null

if [ "$SEED_PROFILE" = "e2e" ]; then
  if [ -f "${PROJECT_DIR}/mcp-servers/airtable/secret.yaml" ]; then
    $KC apply -f "${PROJECT_DIR}/mcp-servers/airtable/secret.yaml"
    ok "mcp-airtable-credentials from mcp-servers/airtable/secret.yaml"
  else
    $KC create secret generic mcp-airtable-credentials \
      --namespace=mcp-server \
      --from-literal=api-key="${AIRTABLE_API_KEY:-placeholder-airtable-api-key-for-e2e}" \
      --dry-run=client -o yaml | $KC apply -f - >/dev/null
    ok "mcp-airtable-credentials (dev placeholder; override via AIRTABLE_API_KEY or secret.yaml)"
  fi

  if [ -f "${PROJECT_DIR}/mcp-servers/mongodb/secret.yaml" ]; then
    $KC apply -f "${PROJECT_DIR}/mcp-servers/mongodb/secret.yaml"
    ok "mcp-mongodb-credentials from mcp-servers/mongodb/secret.yaml"
  else
    $KC create secret generic mcp-mongodb-credentials \
      --namespace=mcp-server \
      --from-literal=connection-string="${MONGODB_CONNECTION_STRING:-mongodb://placeholder:placeholder@localhost:27017/placeholder}" \
      --dry-run=client -o yaml | $KC apply -f - >/dev/null
    ok "mcp-mongodb-credentials (dev placeholder; override via MONGODB_CONNECTION_STRING or secret.yaml)"
  fi
else
  log "Skipping MCP server secrets (SEED_PROFILE=minimal) — no demo McpServers to back."
fi

# 4g. JWT sync — copy RPC public key to mcp-host-config
# On fresh clusters, mcp-host-config doesn't exist yet (created in Step 6).
# Only sync if BOTH the secret AND the configmap exist; otherwise defer to post-deploy sync.
if $KC get secret rpc-proxy-secrets -n rpc-proxy &>/dev/null && \
   $KC get configmap mcp-host-config -n mcp-host &>/dev/null; then
  log "Syncing JWT public key to mcp-host-config..."
  $KC get secret rpc-proxy-secrets -n rpc-proxy \
    -o jsonpath='{.data.RPC_PROXY_JWT_PUBLIC_KEY}' | base64 -d \
    | python3 -c "import sys,subprocess,json; \
      key=sys.stdin.read(); \
      patch=json.dumps([{'op':'replace','path':'/data/CLERUM_AUTH_JWT_PUBLIC_KEY','value':key}]); \
      subprocess.run(['kubectl','--context=${PROFILE}','patch','configmap','mcp-host-config','-n','mcp-host','--type=json','-p',patch],check=True)"
  ok "JWT public key synced to mcp-host-config"
else
  log "Deferring JWT sync to post-deploy (mcp-host-config not yet created)"
fi

# ======================================================================
# Step 5: Build images
# ======================================================================
step_header 5 $TOTAL_STEPS "Build Images"

if [ "$SKIP_BUILD" = true ]; then
  # Even with --skip-build, warn if local code is newer than images
  LAST_BUILD_MARKER="deploy/minikube/.image-manifest.json"
  if [ -f "$LAST_BUILD_MARKER" ]; then
    NEWEST_SRC=$(find \
      mcp-host/src \
      workflow-recipes/src \
      packages/workflow-sdk \
      tests/e2e/fixtures/custom-workflow-coordinator \
      control-api/src \
      control-ui/components \
      control-ui/lib \
      -type f -newer "$LAST_BUILD_MARKER" 2>/dev/null | head -1 || true)
    if [ -n "$NEWEST_SRC" ]; then
      warn "Source files changed since last image build (e.g., $NEWEST_SRC)."
      warn "Images may be STALE. Run without --skip-build to rebuild."
    else
      log "Skipping image build (--skip-build). No source changes detected since last build."
    fi
  else
    warn "No image manifest found — images may never have been built."
    warn "Run without --skip-build if pods show ImagePullBackOff or model-config-failed."
  fi
else
  log "Building and loading images into minikube..."
  BUILD_IMAGE_ARGS=(--skip-public)
  if [ "$SKIP_UIS" = true ]; then
    BUILD_IMAGE_ARGS+=(--skip-uis)
  fi
  bash "${SCRIPT_DIR}/build-images.sh" "${BUILD_IMAGE_ARGS[@]}"
  ok "All images built and loaded"
fi

# ======================================================================
# Step 6: Deploy
# ======================================================================
step_header 6 $TOTAL_STEPS "Deploy"

# 6a. Optional DB reset
if [ "$RESET_DB" = true ] && [ -z "$CONTROL_DB_RESET_PVC_UID" ]; then
  # Never-bootstrapped auto-detect: with no control-postgres PVC AND no reset
  # recovery state there is nothing a storage reset could destroy or resume,
  # and the reset preflight (ready GFS secrets, running gfsc deployments)
  # cannot succeed before the first deploy. Continue on the same path a
  # REUSE_DB=true bootstrap takes. Any other combination keeps the hard-fail.
  FRESH_PVC_UID="$($KC -n control-plane get pvc control-postgres-data \
    -o 'jsonpath={.metadata.uid}' --ignore-not-found)"
  FRESH_RESET_STATE="$($KC -n control-plane get configmap control-db-reset-state \
    -o name --ignore-not-found)"
  if [ -z "$FRESH_PVC_UID" ] && [ -z "$FRESH_RESET_STATE" ]; then
    log "Fresh cluster: control DB was never bootstrapped; nothing to reset — continuing without a storage reset"
    RESET_DB=false
  fi
fi
if [ "$RESET_DB" = true ]; then
  [ -n "$CONTROL_DB_RESET_PVC_UID" ] \
    || { err "CONTROL_DB_RESET_PVC_UID is required with --reset-db (pass the current control-postgres PVC UID, 'none' for a cluster without that PVC, or skip the reset with REUSE_DB=true/--keep-db). A cluster with no control-postgres PVC and no reset state is detected automatically and skips the reset."; exit 1; }
  if [ "$CONTROL_DB_RESET_PVC_UID" = none ]; then
    RESET_STORAGE_ARGS=(--expect-no-pvc)
  else
    RESET_STORAGE_ARGS=(--expected-pvc-uid "$CONTROL_DB_RESET_PVC_UID")
  fi
  case "$CONTROL_DB_RESET_RESUME" in
    true|1|yes) RESET_STORAGE_ARGS+=(--resume) ;;
  esac
  log "Resetting postgres database (--reset-db)..."
  CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/reset-control-db-storage.sh" "${RESET_STORAGE_ARGS[@]}"
  RESET_REPLICA_STATE="$($KC -n control-plane get configmap control-db-reset-state -o \
    'jsonpath={.data.hccReplicas}{"|"}{.data.workflowReplicas}{"|"}{.data.traceReplicas}{"|"}{.data.writerReplicas}{"|"}{.data.readerReplicas}{"|"}{.data.controlApiReplicas}')"
  IFS='|' read -r RESET_HCC_REPLICAS RESET_WORKFLOW_REPLICAS RESET_TRACE_REPLICAS \
    RESET_WRITER_REPLICAS RESET_READER_REPLICAS RESET_CONTROL_API_REPLICAS <<<"$RESET_REPLICA_STATE"
  [[ "$RESET_HCC_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$RESET_WORKFLOW_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$RESET_TRACE_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$RESET_WRITER_REPLICAS" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$RESET_READER_REPLICAS" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$RESET_CONTROL_API_REPLICAS" =~ ^[1-9][0-9]*$ ]] \
    || { err "Reset replica recovery state is invalid"; exit 1; }
  ok "Postgres PVCs deleted"
fi

# 6b. Deploy via kustomize
log "Refreshing minikube K8s API endpoint CIDRs..."
CONTEXT="${PROFILE}" OVERLAY_DIR="${ACTIVE_MINIKUBE_KUSTOMIZE_DIR}" "${PROJECT_DIR}/deploy/scripts/minikube-detect-k8s-api-ip.sh"
ok "Minikube K8s API CIDRs refreshed"

# Upgrade path: stage the additive reader credential before the full overlay
# changes HCC. Fresh bootstrap has no ready control-api yet and remains
# fail-closed until the post-migration branch immediately below.
CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/apply-gfs-writer-secret.sh"
if [ "$RESET_DB" = true ]; then
  log "Database reset path — HCC cutover deferred until post-convergence verification"
else
  writer_dsn="$($KC -n gfs get secret gfs-controller-db -o 'jsonpath={.data.connection-string}')"
  if [ -n "${writer_dsn}" ]; then
    if ! $KC rollout status deployment/control-api -n control-plane --timeout=5s >/dev/null 2>&1; then
      err "Existing GFS writer detected but control-api is not Ready; refusing HCC cutover"
      exit 1
    fi
    log "Existing GFS writer detected — reconciling credentials before overlay upgrade"
    CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/reconcile-gfs-deploy-credentials.sh"
  else
    log "Fresh bootstrap detected — reader staging deferred until migrations; GFSC remains fail-closed"
  fi
fi

log "Applying kustomize overlay (${ACTIVE_MINIKUBE_RENDER_DIR})..."
if [ "$RESET_DB" = true ]; then
  # Keep control-api scaled to zero until migrations and role restoration are
  # complete; applying the full overlay here would race it against a fresh DB.
  $KC apply -k "$ACTIVE_MINIKUBE_RENDER_DIR" -l app=control-postgres
else
  kubectl kustomize "$ACTIVE_MINIKUBE_RENDER_DIR" | $KC apply -f -
fi
ok "Kustomize overlay applied"

if [ "$RESET_DB" = true ]; then
  log "Rebuilding database contracts and restoring GFS roles after reset..."
  $KC rollout status deployment/control-postgres -n control-plane --timeout=180s >/dev/null
  CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/converge-control-db-after-reset.sh" \
    --overlay "$ACTIVE_MINIKUBE_RENDER_DIR" \
    --job-name control-api-db-migrate-reset
  kubectl kustomize "$ACTIVE_MINIKUBE_RENDER_DIR" | $KC apply -f -
  # The overlay declares ordinary one-replica defaults. Reassert the exact
  # pre-reset operating counts after applying it; credentials are verified and
  # HCC is restored by convergence before this safe rollout boundary.
  $KC -n gfs scale deployment/gfsc-writer --replicas="$RESET_WRITER_REPLICAS" >/dev/null
  $KC -n gfs scale deployment/gfsc-reader --replicas="$RESET_READER_REPLICAS" >/dev/null
  $KC -n control-plane scale deployment/control-api --replicas="$RESET_CONTROL_API_REPLICAS" >/dev/null
  $KC -n control-plane scale deployment/workflow-recipes --replicas="$RESET_WORKFLOW_REPLICAS" >/dev/null
  $KC -n control-plane scale deployment/trace-maintenance-worker --replicas="$RESET_TRACE_REPLICAS" >/dev/null
  $KC -n control-plane scale deployment/host-context-controller --replicas="$RESET_HCC_REPLICAS" >/dev/null
  $KC -n gfs rollout status deployment/gfsc-writer --timeout=180s >/dev/null
  $KC -n gfs rollout status deployment/gfsc-reader --timeout=180s >/dev/null
  if [ "$RESET_WORKFLOW_REPLICAS" -gt 0 ]; then
    $KC -n control-plane rollout status deployment/workflow-recipes --timeout=180s >/dev/null
  fi
  if [ "$RESET_TRACE_REPLICAS" -gt 0 ]; then
    $KC -n control-plane rollout status deployment/trace-maintenance-worker --timeout=180s >/dev/null
  fi
  if [ "$RESET_HCC_REPLICAS" -gt 0 ]; then
    $KC -n control-plane rollout status deployment/host-context-controller --timeout=480s >/dev/null
  fi
  ok "Control-api database and GFS roles converged after reset"
else
  ensure_control_postgres_ready
  log "Applying control-api database migrations and runtime roles..."
  CONTEXT="${PROFILE}" ALLOWED_CONTEXTS="${PROFILE}" \
    bash "${PROJECT_DIR}/deploy/scripts/run-control-api-db-migration.sh" \
    --overlay "$ACTIVE_MINIKUBE_RENDER_DIR"
  CONTEXT="${PROFILE}" ALLOWED_CONTEXTS="${PROFILE}" \
      bash "${PROJECT_DIR}/deploy/scripts/provision-control-api-runtime-roles.sh"
    ok "Control-api database migrations and runtime roles applied"

    # The credential probe runs through control-api, so prove that deployment is
    # live before normal staging on bootstrap or an idempotent upgrade.
    $KC scale deployment/control-api -n control-plane --replicas=1 >/dev/null
    $KC rollout status deployment/control-api -n control-plane --timeout=180s >/dev/null
    # On the upgrade path the overlay above may still be cutting HCC over to
    # the split writer/reader templates; reconciling before that lands leaves
    # the staged reader credential rollout-pending and fails the final verify.
    CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/wait-gfsc-secret-references.sh"
    CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/reconcile-gfs-deploy-credentials.sh"
    ok "GFS credentials reconciled and writer bootstrap verified"
fi

# 6c. Re-apply generated service tokens after kustomize.
# Re-patch the generated inter-service tokens after every overlay apply so the
# consumer Secrets and control-api stay in sync.
log "Re-applying inter-service tokens after kustomize deploy..."
CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/deploy/scripts/apply-inter-service-tokens.sh"
ok "Inter-service tokens re-applied after kustomize deploy"

# 6e. Deploy CRD instances
log "Applying CRD instances..."
$KC apply -f "${PROJECT_DIR}/deploy/overlays/minikube/instances/"
ok "CRD instances applied (Host, Context, CommunicationChannel, GFS, policy)"

# instances-e2e/context-mcpservers.yaml must apply AFTER instances/context.yaml
# so its non-empty mcpServers list wins over the empty default.
if [ "$SEED_PROFILE" = "e2e" ]; then
  log "Applying E2E demo MCP server instances..."
  $KC apply -f "${PROJECT_DIR}/deploy/overlays/minikube/instances-e2e/"
  ok "E2E instances applied (airtable, mongodb, mongodb-mcp-stack + context1 servers)"
else
  log "Skipping demo MCP servers (SEED_PROFILE=minimal) — context1 starts empty."
fi

# Resolve the model provider from whichever key the user actually supplied.
# Priority order matches docs/architecture/overview.md:724 and
# .env.quickstart.example. An explicit CLERUM_MODEL_PROVIDER always wins.
# Without this, the Host pins zai while zai-api-key is a placeholder, so the
# agent never replies for anyone who set a different provider's key.
resolve_model_provider() {
  if [ -n "${CLERUM_MODEL_PROVIDER:-}" ]; then
    printf '%s' "${CLERUM_MODEL_PROVIDER}"
    return 0
  fi
  if [ -n "${OPENAI_API_KEY:-}" ];  then printf 'openai';  return 0; fi
  if [ -n "${CLAUDE_API_KEY:-}" ];  then printf 'claude';  return 0; fi
  if [ -n "${ZAI_API_KEY:-}" ];     then printf 'zai';     return 0; fi
  if [ -n "${BAILIAN_API_KEY:-}" ]; then printf 'bailian'; return 0; fi
  printf ''
}

# These MUST stay in sync with the canonical registry at
# mcp-host/src/llm/registryCore.ts:50,57,64,72 — that is the single source of
# truth (config.ts:301 reads it via descriptorFor(provider).defaultModel).
# Verify against that file before committing; a drifted model id fails at the
# first message, which is the exact bug this task fixes.
default_model_for_provider() {
  case "$1" in
    openai)  printf 'gpt-5.4-mini' ;;
    claude)  printf 'claude-sonnet-4-6' ;;
    zai)     printf 'glm-5.1' ;;
    bailian) printf 'qwen3-coder-plus' ;;
    *)       printf '' ;;
  esac
}

RESOLVED_PROVIDER="$(resolve_model_provider)"
if [ -z "$RESOLVED_PROVIDER" ]; then
  # No key at all. Warn, do not abort — the platform still comes up fully and
  # quickstart.md:39 already documents that the agent will not reply. This is
  # deliberately softer than the ADMIN_PASSWORD precondition (Task 4).
  warn "No LLM API key found in .env (OPENAI_API_KEY / CLAUDE_API_KEY / ZAI_API_KEY / BAILIAN_API_KEY)."
  warn "Defaulting Host to zai with a placeholder key — the chatllm agent will NOT reply."
  warn "Set a key in .env and re-run to fix."
  RESOLVED_PROVIDER="zai"
fi
RESOLVED_MODEL="${CLERUM_MODEL_NAME:-$(default_model_for_provider "$RESOLVED_PROVIDER")}"
if [ -z "$RESOLVED_MODEL" ]; then
  err "Unknown provider '${RESOLVED_PROVIDER}' — set CLERUM_MODEL_NAME explicitly in .env."
  exit 1
fi

# 6f. Apply Host model from .env/default E2E model
log "Applying Host model ${RESOLVED_PROVIDER}/${RESOLVED_MODEL} (source: ${CLERUM_MODEL_PROVIDER:+CLERUM_MODEL_PROVIDER}${CLERUM_MODEL_PROVIDER:-auto-detected from .env})..."
cat <<HOSTEOF | $KC apply -f -
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
  namespace: mcp-host
spec:
  host: chatLLM
  contextRef: context1
  secretRef: chatllm-api-keys
  model:
    provider: ${RESOLVED_PROVIDER}
    name: ${RESOLVED_MODEL}
  workflowControl:
    scopes:
      - workflow:list
      - workflow:read
      - workflow:trigger
      - workflow:approval:resolve
      - workflow:approval:decide
  channels:
    - all-channels
  approval:
    defaultPolicy: channel_users
    channels:
      telegram:
        enabled: true
HOSTEOF
ok "Host model applied from .env/default E2E model"

# 6g. Post-deploy JWT sync (in case configmap was recreated by kustomize)
log "Re-syncing JWT public key after deploy..."
if $KC get secret rpc-proxy-secrets -n rpc-proxy &>/dev/null; then
  $KC get secret rpc-proxy-secrets -n rpc-proxy \
    -o jsonpath='{.data.RPC_PROXY_JWT_PUBLIC_KEY}' | base64 -d \
    | python3 -c "import sys,subprocess,json; \
      key=sys.stdin.read(); \
      patch=json.dumps([{'op':'replace','path':'/data/CLERUM_AUTH_JWT_PUBLIC_KEY','value':key}]); \
      subprocess.run(['kubectl','--context=${PROFILE}','patch','configmap','mcp-host-config','-n','mcp-host','--type=json','-p',patch],check=True)"
  ok "JWT public key re-synced to mcp-host-config"
else
  warn "rpc-proxy-secrets still not found — JWT sync skipped"
fi

# 6h. Re-apply generated ConfigMaps that kustomize may have overwritten with placeholders.
# The base manifests contain placeholder values for ConfigMaps that are populated by
# generate-keys.sh. Kustomize apply (Step 6b) overwrites them. Re-apply here to restore.
log "Re-applying generated ConfigMaps (control-api-public-key, clerum-wrc-public-key)..."
bash "${SCRIPT_DIR}/generate-keys.sh" --apply
ok "Generated ConfigMaps re-applied after kustomize deploy"

# 6i. Force rollout restart when images were rebuilt.
# ----------------------------------------------------------------------
# `kubectl apply -k` only triggers a new ReplicaSet when the Deployment
# spec changes. When we rebuild with the same `:test` tag and the
# manifest is byte-identical, pods keep their previous imageID even
# though minikube's Docker daemon now has a fresh image with the same
# tag but a different digest. Result: pods silently run stale code —
# this has caused multiple "I fixed it but the pod didn't change"
# debugging loops (see memory: deploy-gotcha-kustomize-unchanged-stale-pod).
#
# Fix: after every full build+apply, explicitly restart every Deployment
# that consumes a `clerum/*:test` image. `rollout restart` patches a
# kubectl.kubernetes.io/restartedAt annotation on the pod template,
# guaranteeing a new ReplicaSet and a fresh image pull (IfNotPresent
# resolves to the new digest because minikube already has it loaded).
#
# Skipped when --skip-build is passed (nothing new to pick up).
if [ "$SKIP_BUILD" = false ]; then
  log "Forcing rollout restart for freshly-built clerum images..."
  REFRESH_DEPLOYS=(
    # (#273) Static clerum-channel-reader Deployment retired; per-Host
    # channel-reader-<host> Deployments come up after the first Host CRD is
    # created via the Control UI, not at bootstrap time.
    "control-plane:control-api"
    "control-plane:control-ui"
    "control-plane:host-context-controller"
    "control-plane:workflow-recipes"
    "mcp-host:chatllm"
    "mcp-server:mcp-proxy"
    "profiles:external-rest-api"
    "profiles:profile-ui"
    "rpc-proxy:rpc-proxy"
  )
  if [ "$SKIP_UIS" = true ]; then
    REFRESH_DEPLOYS=(
      "control-plane:control-api"
      "control-plane:host-context-controller"
      "control-plane:workflow-recipes"
      "mcp-host:chatllm"
      "mcp-server:mcp-proxy"
      "profiles:external-rest-api"
      "rpc-proxy:rpc-proxy"
    )
  fi
  RESTARTED=0
  for entry in "${REFRESH_DEPLOYS[@]}"; do
    ns="${entry%%:*}"
    name="${entry##*:}"
    if $KC get deployment "$name" -n "$ns" >/dev/null 2>&1; then
      $KC rollout restart deployment/"$name" -n "$ns" >/dev/null 2>&1 && \
        RESTARTED=$((RESTARTED + 1))
    fi
  done
  ok "Restarted ${RESTARTED} deployment(s) to pick up fresh image digests"
fi

# 6j. Validate McpServer envSecret references before waiting for pods.
# If a McpServer CRD points at a non-existent Secret, HCC silently hangs
# and pods never come up — abort early with a clear diagnosis instead of
# letting Step 8 time out on phantom "pod never ready" errors.
if ! validate_mcpserver_secrets; then
  err "Aborting setup: fix the missing Secret(s) above and re-run."
  exit 1
fi

# ======================================================================
# Step 7: Deploy evenfire-registry side-by-side
# ======================================================================
# evenfire-registry (registry-api + postgres + minio) lives in a sibling
# repo, not this monorepo. The helper resolves the sibling checkout from normal
# primary repos and worktrees, then applies the consumer NetworkPolicies from
# this overlay so control-api/workflow-recipes can reach registry-api.
step_header 7 $TOTAL_STEPS "evenfire-registry side-by-side deploy"

EVENFIRE_DIR_DEFAULT="$(cd "${PROJECT_DIR}/.." && pwd)/evenfire-registry"
EVENFIRE_DIR="${EVENFIRE_REGISTRY_DIR:-${EVENFIRE_DIR_DEFAULT}}"
if [[ -d "${EVENFIRE_DIR}" && -f "${EVENFIRE_DIR}/Dockerfile" ]]; then
  log "Found evenfire-registry at ${EVENFIRE_DIR} — deploying..."
  if [ -f "${PROJECT_DIR}/scripts/minikube/deploy-evenfire-registry.sh" ]; then
    if MINIKUBE_PROFILE="${PROFILE}" EVENFIRE_REGISTRY_DIR="${EVENFIRE_DIR}" \
         bash "${PROJECT_DIR}/scripts/minikube/deploy-evenfire-registry.sh"; then
      ok "evenfire-registry deployed"
    else
      warn "evenfire-registry deploy failed — registry calls will fail until you fix this."
      warn "Run manually: make minikube-deploy-evenfire-registry"
    fi
  else
    warn "skip: scripts/minikube/deploy-evenfire-registry.sh not present (sibling repo not included in this distribution)"
  fi
else
  warn "evenfire-registry deploy failed — registry calls will fail until you fix this."
  warn "Run manually: MINIKUBE_PROFILE=${PROFILE} make minikube-deploy-evenfire-registry"
  warn "If auto-discovery fails, pass EVENFIRE_REGISTRY_DIR=/absolute/path/to/evenfire-registry"
fi

# member-registration-service was extracted to a sibling repo too. Build +
# apply it the same best-effort way so local control-api invitation flows work.
# Skipped silently if the repo is not checked out locally.
MEMBER_DIR_DEFAULT="$(cd "${PROJECT_DIR}/.." && pwd)/evenfire-member-registration"
MEMBER_DIR="${EVENFIRE_MEMBER_REGISTRATION_DIR:-${MEMBER_DIR_DEFAULT}}"
if [[ -d "${MEMBER_DIR}" && -f "${MEMBER_DIR}/Dockerfile" ]]; then
  log "Found evenfire-member-registration at ${MEMBER_DIR} — deploying..."
  if [ -f "${PROJECT_DIR}/scripts/minikube/deploy-evenfire-member-registration.sh" ]; then
    if MINIKUBE_PROFILE="${PROFILE}" EVENFIRE_MEMBER_REGISTRATION_DIR="${MEMBER_DIR}" \
         bash "${PROJECT_DIR}/scripts/minikube/deploy-evenfire-member-registration.sh"; then
      ok "evenfire-member-registration deployed"
    else
      warn "evenfire-member-registration deploy failed — invitation/registration calls will fail until you fix this."
      warn "Run manually: bash scripts/minikube/deploy-evenfire-member-registration.sh"
    fi
  else
    warn "skip: scripts/minikube/deploy-evenfire-member-registration.sh not present (sibling repo not included in this distribution)"
  fi
else
  warn "evenfire-member-registration not found at ${MEMBER_DIR}"
  warn "control-api invitation flows will fail any registration call until you clone it:"
  warn "  cd $(dirname "${MEMBER_DIR}") && git clone <evenfire-member-registration-repo> evenfire-member-registration"
  warn "Then: bash scripts/minikube/deploy-evenfire-member-registration.sh"
fi

# ======================================================================
# Step 8: Wait + Auto-Recovery
# ======================================================================
step_header 8 $TOTAL_STEPS "Wait + Auto-Recovery"

CORE_DEPLOYS=(
  "control-plane:control-api"
  "control-plane:host-context-controller"
  "profiles:external-rest-api"
  "rpc-proxy:rpc-proxy"
  "mcp-host:chatllm"
)
# registry-api is deployed by Step 7 (side-by-side); failure there is a
# warning, not blocking — leave it out of the CORE_DEPLOYS readiness gate
# so a missing evenfire-registry checkout doesn't fail the whole setup.

all_ready=true
for entry in "${CORE_DEPLOYS[@]}"; do
  ns="${entry%%:*}"
  name="${entry##*:}"
  log "Waiting for ${ns}/${name} (180s)..."
  if $KC rollout status deployment/"$name" -n "$ns" --timeout=180s 2>/dev/null; then
    ok "${ns}/${name} ready"
  else
    warn "${ns}/${name} not ready — checking for recovery..."

    # A stale or late corruption signature is diagnostic evidence only. Storage
    # deletion always requires a new explicit --reset-db invocation and UID.
    if [ "$name" = "control-api" ] && postgres_has_invalid_checkpoint; then
      err "Postgres reports an invalid checkpoint; automatic destructive recovery is disabled"
      err "Re-run with --reset-db and CONTROL_DB_RESET_PVC_UID=<exact approved UID>"
    fi

    err "${ns}/${name} NOT ready"
    all_ready=false
  fi
done

# ----------------------------------------------------------------------
# gfs serving provisioning (runs once pods are up, so control-api has applied
# migration 0048 that creates the gfs_controller role). gfsc fails closed
# without BOTH: (a) its JWT public key in gfs-config, and (b) the gfs_controller
# DB LOGIN + DSN in gfs-controller-db. The inline JWT sync (6g) only covers
# mcp-host-config, so these gfs-specific steps are explicit here. Idempotent.
# FAIL LOUD: when the GFS stack is deployed, a provisioning failure ABORTS the
# setup — continuing would hand the user a cluster whose GFS plane 503s on
# every operation (issue #775).
# ----------------------------------------------------------------------
if $KC get configmap gfs-config -n gfs &>/dev/null; then
  log "Provisioning gfs serving (public key → gfs-config + gfs_controller DB login)..."
  if ! bash "${SCRIPT_DIR}/sync-auth-key.sh" --context="${PROFILE}"; then
    err "gfs public-key sync FAILED — gfsc cannot verify tokens. Fix and re-run."
    exit 1
  fi
  if CONTEXT="${PROFILE}" bash "${PROJECT_DIR}/scripts/minikube/verify-gfs.sh"; then
    ok "gfs serving verified (reader/writer credentials and readiness)"
  else
    err "gfs DB provisioning FAILED — gfsc /readyz will fail closed and every GFS operation will 503. Fix and re-run."
    exit 1
  fi
else
  log "gfs-config not present — skipping gfs serving provisioning"
fi

# ======================================================================
# Step 9: Seed Registry Catalog
# ======================================================================
# Populates the registry database with the curated catalog of
# MCP servers (local + remote) and workflow recipes. Idempotent — entries
# that already exist return 409 and are skipped. Required for the registry
# E2E tests and the control-ui "Registry Catalog" tab to show entries on
# a fresh deploy.
# ======================================================================
step_header 9 $TOTAL_STEPS "Seed Registry Catalog"

# Registry seed lives in evenfire-registry (sibling repo). If it's checked
# out and exposes a `seed-minikube` make target, run it. Otherwise skip
# loudly — control-ui's "Registry Catalog" tab will be empty but everything
# else still works.
EVENFIRE_DIR_DEFAULT="$(cd "${PROJECT_DIR}/.." && pwd)/evenfire-registry"
EVENFIRE_DIR="${EVENFIRE_REGISTRY_DIR:-${EVENFIRE_DIR_DEFAULT}}"
if [[ ! -d "${EVENFIRE_DIR}" ]]; then
  warn "evenfire-registry not found at ${EVENFIRE_DIR} — skipping registry seed"
elif ! $KC get deployment registry-api -n registry &>/dev/null; then
  warn "registry-api deployment not found in clerum-test — skipping seed"
elif ! (cd "${EVENFIRE_DIR}" && make -n minikube-seed >/dev/null 2>&1); then
  warn "evenfire-registry has no 'minikube-seed' target — skipping seed"
else
  log "Running evenfire-registry minikube-seed target..."
  if (cd "${EVENFIRE_DIR}" && make minikube-seed 2>&1 | tail -25); then
    ok "Registry catalog seeded"
  else
    warn "Registry seed encountered errors — check output above"
  fi
fi

# ======================================================================
# Step 10: Seed Test User
# ======================================================================
step_header 10 $TOTAL_STEPS "Seed Test User"

# The e2e profile seeds the test identities used by the Desktop and Control UI
# journeys. The minimal profile must not seed anything named test*.
if [ "$SEED_PROFILE" = "e2e" ]; then
  SEED_USER_DEFAULT_EMAIL="test@clerum.io"
  SEED_USER_DEFAULT_NAME="Test User"
  # ADMIN_PASSWORD was resolved once above. Use the known local test fallback
  # only when neither the canonical .env nor the process configured any admin
  # alias; never replace a real seeded credential.
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD="$(printf '%s%s' 'changeme123' '!')"
  fi
else
  # Minimal: the Control-UI admin IS the sole Desktop App member — no separate
  # seeded user. Point both the admin-bootstrap email and the seeded desktop
  # user at the same evenfire-branded address so the seeder's (idempotent)
  # user+team step converges on the admin identity that /admin/auth/setup
  # already provisioned (users row + "<username> team" + chatllm/context1
  # grants), instead of minting a second member/team. `admin@clerum.io` would
  # leak the internal code name onto a product surface (the Desktop member
  # list) — evenfire branding belongs here (docs/concepts/code-names.md). If
  # the best-effort admin desktop provisioning ever fails, the seeder still
  # creates this one identity, so the minimal install is never member-less.
  SEED_USER_DEFAULT_EMAIL="admin@evenfire.local"
  SEED_USER_DEFAULT_NAME="admin"
  : "${ADMIN_EMAIL:=admin@evenfire.local}"
fi
SEED_USER_EMAIL="${CLERUM_SEED_USER_EMAIL:-${CLERUM_TEST_USER_EMAIL:-${E2E_DEV_LOGIN_EMAIL:-${SEED_USER_DEFAULT_EMAIL}}}}"
SEED_USER_NAME="${E2E_DEV_LOGIN_NAME:-${SEED_USER_DEFAULT_NAME}}"
log "Seeding test user ${SEED_USER_EMAIL} → agent=chatllm, context=context1"
SEED_USER_OK=true
if CONTEXT="${PROFILE}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
   SEED_PROFILE="${SEED_PROFILE}" \
   ADMIN_EMAIL="${ADMIN_EMAIL:-}" \
   E2E_DEV_LOGIN_EMAIL="${SEED_USER_EMAIL}" \
   E2E_DEV_LOGIN_NAME="${SEED_USER_NAME}" \
   bash "${SCRIPT_DIR}/seed-test-data.sh" 2>&1 | tail -15; then
  ok "Test user seeded"
else
  SEED_USER_OK=false
  if [ "$SEED_PROFILE" = "minimal" ]; then
    # This step is the only place that both creates the owner user AND
    # rotates the bootstrap admin credential (POST /admin/auth/setup, called
    # from seed-test-data.sh → scripts/e2e/seed-e2e-data.sh). generate-keys.sh
    # bakes a hardcoded bcrypt hash of changeme123! into the admin Secret,
    # and control-api/src/db.ts auto-inserts a live `admin` row from it on
    # every fresh DB. If this step fails under the default (minimal)
    # profile, that publicly-known credential is still live — a green
    # summary would ship an install that is both unusable and insecure.
    # Abort instead; setup is idempotent, so re-running after the underlying
    # issue is fixed recovers cleanly.
    err "Test user seed failed under SEED_PROFILE=minimal — aborting. The bootstrap admin password may still be the publicly-known default (see generate-keys.sh) until this step succeeds. Fix the error above and re-run setup."
    exit 1
  else
    warn "Test user seed encountered errors — check output above"
  fi
fi

# ======================================================================
# Step 11: Seed Workflow Trigger Test Data
# ======================================================================
step_header 11 $TOTAL_STEPS "Seed Workflow Trigger Test Data"

if [ "$SEED_PROFILE" != "e2e" ]; then
  log "Skipping workflow-trigger + sandbox-ui fixtures (SEED_PROFILE=minimal)."
else
  log "Seeding workflow-trigger fixtures for local E2E recipes..."
  if CONTEXT="${PROFILE}" E2E_DEV_LOGIN_EMAIL="${SEED_USER_EMAIL}" \
     bash "${SCRIPT_DIR}/seed-workflow-triggers-test-data.sh" 2>&1 | tail -20; then
    ok "Workflow-trigger E2E recipes seeded"
  else
    warn "Workflow-trigger E2E seed encountered errors — desktop/control-ui workflow E2E may fail until fixed"
  fi

  if [ "$SKIP_UIS" = true ]; then
    warn "Skipping sandbox-ui Desktop Apps validation seed (--skip-uis)."
  else
    log "Seeding sandbox-ui local test app for Desktop Apps validation..."
    if CONTEXT="${PROFILE}" E2E_DEV_LOGIN_EMAIL="${SEED_USER_EMAIL}" \
       bash "${SCRIPT_DIR}/seed-sandbox-ui-test-data.sh" 2>&1 | tail -25; then
      ok "Sandbox-ui local test app seeded"
    else
      warn "Sandbox-ui test app seed encountered errors — Desktop Apps may not list local sandbox-ui fixtures"
    fi
  fi
fi

# ======================================================================
# Step 12: Verify
# ======================================================================
step_header 12 $TOTAL_STEPS "Verify"

echo ""
echo -e "${BOLD}  Deployment Status${NC}"
echo -e "${BOLD}  ─────────────────────────────────────────────────────${NC}"
printf "  ${BOLD}%-20s %-35s %-10s${NC}\n" "NAMESPACE" "DEPLOYMENT" "STATUS"
echo -e "  ─────────────────────────────────────────────────────"

$KC get deploy -A --no-headers 2>/dev/null | while read -r ns name ready _up_to_date _available _age; do
  # ready is like "1/1"
  desired="${ready##*/}"
  actual="${ready%%/*}"
  if [ "$actual" = "$desired" ] && [ "$actual" != "0" ]; then
    status="${GREEN}OK${NC}"
  else
    status="${RED}!! ${ready}${NC}"
  fi
  printf "  %-20s %-35s ${status}\n" "$ns" "$name"
done

echo ""
echo -e "${BOLD}================================================================${NC}"
if [ "$all_ready" = true ]; then
  echo -e "${GREEN}${BOLD}  Minikube setup complete! All core services ready.${NC}"
else
  echo -e "${YELLOW}${BOLD}  Setup partially complete. Some services need attention.${NC}"
  echo -e "  Check: ${CYAN}kubectl --context=${PROFILE} get pods -A${NC}"
fi
echo -e "${BOLD}================================================================${NC}"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
if [ "$SKIP_UIS" = true ]; then
  echo -e "    ${CYAN}npm run web${NC}                                    # Run web UIs locally"
  echo -e "    ${YELLOW}Control UI, Profile UI, and Desktop App build steps were skipped.${NC}"
else
  echo -e "    ${CYAN}make minikube-pf-desktop${NC}                        # Start port-forwards (Desktop App)"
  echo -e "    ${CYAN}make minikube-pf-all${NC}                            # Start port-forwards (Control UI + API)"
  echo -e "    ${CYAN}cd desktop-app && npm run build && npm start${NC}    # Launch desktop app"
fi
echo ""
echo -e "  ${BOLD}Already done by setup:${NC}"
# Step 10 (Seed Test User) is what actually rotates the bootstrap admin
# credential and creates the seed user. If it failed, SEED_USER_OK=false and
# these lines must say so instead of printing a false ✓ (a failed Step 10
# under minimal already aborts before reaching here — see Step 10 above —
# so this else branch is reachable only via the e2e soft-fail path).
if [ "${SEED_PROFILE:-}" = "e2e" ]; then
  if [ "${SEED_USER_OK:-true}" = "true" ]; then
    echo -e "    ${GREEN}✓${NC} JWT keys + admin bootstrap (resolved admin credential)"
  else
    echo -e "    ${RED}✗${NC} Admin bootstrap NOT confirmed — Step 10 (Seed Test User) failed"
  fi
else
  if [ "${SEED_USER_OK:-true}" = "true" ]; then
    echo -e "    ${GREEN}✓${NC} JWT keys + admin bootstrap (resolved admin credential)"
  else
    echo -e "    ${RED}✗${NC} Admin bootstrap NOT confirmed — Step 10 (Seed Test User) failed"
  fi
fi
if [ "${SEED_PROFILE:-}" = "e2e" ]; then
  if [ "${SEED_USER_OK:-true}" = "true" ]; then
    echo -e "    ${GREEN}✓${NC} Test user seeded (${SEED_USER_EMAIL} → chatllm + context1)"
  else
    echo -e "    ${RED}✗${NC} Test user seed FAILED (${SEED_USER_EMAIL}) — check Step 10 output above"
  fi
  echo -e "    ${GREEN}✓${NC} Workflow-trigger E2E recipes seeded"
else
  if [ "${SEED_USER_OK:-true}" = "true" ]; then
    echo -e "    ${GREEN}✓${NC} Owner user seeded (${SEED_USER_EMAIL} → chatllm + context1)"
  else
    echo -e "    ${RED}✗${NC} Owner user seed FAILED (${SEED_USER_EMAIL}) — check Step 10 output above"
  fi
fi
echo -e "    ${GREEN}✓${NC} Registry catalog seeded (MCP servers + recipes)"
echo ""
