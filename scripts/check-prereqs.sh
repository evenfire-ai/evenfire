#!/usr/bin/env bash
# ======================================================================
# Prerequisite Check (make prereqs / make doctor)
# ======================================================================
#
# Verifies EVERY dependency needed by `make minikube-setup` BEFORE any
# work starts, and prints the exact install command per platform for
# whatever is missing. Fails fast with a single summary instead of
# surfacing a bare "docker is not running" / "minikube: command not
# found" halfway through setup.
#
# Usage:
#   ./scripts/check-prereqs.sh
#   make prereqs      # or: make doctor
#
# Exit codes:
#   0  all required prerequisites satisfied
#   1  one or more required prerequisites missing or too old
# ======================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[PREREQS]${NC} $*"; }
ok()   { echo -e "  ${GREEN}OK${NC}    $*"; }
warn() { echo -e "  ${YELLOW}WARN${NC}  $*"; }
err()  { echo -e "  ${RED}MISSING${NC} $*"; }

# ── Platform detection ─────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) K8S_ARCH="amd64" ;;
  arm64|aarch64) K8S_ARCH="arm64" ;;
  *) K8S_ARCH="amd64" ;;
esac
case "$OS" in
  Darwin) K8S_OS="darwin" ;;
  Linux)  K8S_OS="linux" ;;
  *)      K8S_OS="linux" ;;
esac

MISSING=0

# Print a per-platform install hint block.
#   $1 = macOS (brew) command   $2 = Debian/Ubuntu (apt) command
hint() {
  local mac="$1" deb="$2"
  if [ "$OS" = "Darwin" ]; then
    echo -e "        macOS:         ${BOLD}$mac${NC}"
  elif [ "$OS" = "Linux" ]; then
    echo -e "        Debian/Ubuntu: ${BOLD}$deb${NC}"
  else
    echo -e "        macOS:         ${BOLD}$mac${NC}"
    echo -e "        Debian/Ubuntu: ${BOLD}$deb${NC}"
  fi
}

# Compare two dotted versions: returns 0 if $1 >= $2.
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

log "Checking prerequisites for 'make minikube-setup' on ${OS}/${ARCH}..."
echo

# ── git ────────────────────────────────────────────────────────────────
if command -v git >/dev/null 2>&1; then
  ok "git      $(git --version | awk '{print $3}')"
else
  err "git      not found"
  hint "brew install git" "sudo apt-get install -y git"
  MISSING=$((MISSING + 1))
fi

# ── make ───────────────────────────────────────────────────────────────
if command -v make >/dev/null 2>&1; then
  ok "make     $(make --version 2>/dev/null | head -n1 | awk '{print $3}')"
else
  err "make     not found"
  hint "xcode-select --install" "sudo apt-get install -y make"
  MISSING=$((MISSING + 1))
fi

# ── Node.js (>= 24; Desktop/Electron validation wants 24.x) ───────────
# The platform itself runs in containers, so the quickstart only needs a
# floor here. Pinning the whole install to 24.x would lock out newer runtimes
# for a Desktop-only concern. Desktop validation is where 24.x is contractual:
# CI pins node-version 24 and desktop-app/scripts/verify-electron-runtime.mjs
# enforces it before any Desktop test/build result counts.
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node --version | sed 's/^v//')"
  NODE_MAJOR="${NODE_VER%%.*}"
  if version_ge "$NODE_VER" "24.0.0"; then
    ok "node     v${NODE_VER}"
    if [ "$NODE_MAJOR" != "24" ]; then
      warn "node     v${NODE_VER} runs the quickstart, but Desktop/Electron validation requires 24.x"
    fi
  else
    err "node     v${NODE_VER} (need >= 24)"
    hint "brew install node@24" "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs"
    MISSING=$((MISSING + 1))
  fi
else
  err "node     not found (need >= 24)"
  hint "brew install node@24" "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs"
  MISSING=$((MISSING + 1))
fi

# ── python3 ────────────────────────────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
  ok "python3  $(python3 --version 2>&1 | awk '{print $2}')"
else
  err "python3  not found"
  hint "brew install python3" "sudo apt-get install -y python3"
  MISSING=$((MISSING + 1))
fi

# ── ruby ───────────────────────────────────────────────────────────────
# Renders the control-api DB migration overlay; ships with macOS.
if command -v ruby >/dev/null 2>&1; then
  ok "ruby     $(ruby --version 2>/dev/null | awk '{print $2}')"
else
  err "ruby     not found (renders the control-api DB migration overlay)"
  hint "ships with macOS — reinstall via 'brew install ruby'" "sudo apt-get install -y ruby"
  MISSING=$((MISSING + 1))
fi

# ── kubectl ────────────────────────────────────────────────────────────
if command -v kubectl >/dev/null 2>&1; then
  KV="$(kubectl version --client -o json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["clientVersion"]["gitVersion"])' 2>/dev/null \
        || kubectl version --client --short 2>/dev/null | awk '/Client/{print $NF}')"
  ok "kubectl  ${KV:-installed}"
else
  err "kubectl  not found"
  hint "brew install kubectl" "sudo apt-get install -y kubectl  (or use the curl installer below)"
  echo    "        one-shot, no sudo (into ~/.local/bin):"
  echo -e "          ${BOLD}curl -fsSLo ~/.local/bin/kubectl \"https://dl.k8s.io/release/\$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/${K8S_OS}/${K8S_ARCH}/kubectl\" && chmod +x ~/.local/bin/kubectl${NC}"
  MISSING=$((MISSING + 1))
fi

# ── minikube (>= 1.30) ─────────────────────────────────────────────────
if command -v minikube >/dev/null 2>&1; then
  MK_VER="$(minikube version --short 2>/dev/null | sed 's/^v//')"
  if [ -n "$MK_VER" ] && version_ge "$MK_VER" "1.30.0"; then
    ok "minikube v${MK_VER}"
  else
    warn "minikube v${MK_VER:-unknown} (recommended >= 1.30)"
  fi
else
  err "minikube not found (need >= 1.30)"
  hint "brew install minikube" "use the curl installer below"
  echo    "        one-shot, no sudo (into ~/.local/bin):"
  echo -e "          ${BOLD}curl -fsSLo ~/.local/bin/minikube https://storage.googleapis.com/minikube/releases/latest/minikube-${K8S_OS}-${K8S_ARCH} && chmod +x ~/.local/bin/minikube${NC}"
  MISSING=$((MISSING + 1))
fi

# ── Docker (installed AND running) ─────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "docker   daemon reachable"
    # Best-effort resource check: minikube-setup needs >= 10 GB RAM / 6 CPUs.
    MEM_BYTES="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
    CPUS="$(docker info --format '{{.NCPU}}' 2>/dev/null || echo 0)"
    if [ "${MEM_BYTES:-0}" -gt 0 ]; then
      # Round to the nearest GB (+0.5 GB before the integer divide): docker's
      # MemTotal sits a little below physical RAM, so a 10 GB allocation reports
      # ~9.7 GB and would truncate to 9 → a spurious "wants >= 10 GB" warning.
      MEM_GB=$(((MEM_BYTES + 512 * 1024 * 1024) / (1024 * 1024 * 1024)))
      if [ "$MEM_GB" -lt 10 ]; then
        warn "docker has ~${MEM_GB} GB RAM allocated (setup wants >= 10 GB — raise it in Docker Desktop → Settings → Resources)"
      else
        ok "docker   ~${MEM_GB} GB RAM allocated"
      fi
    fi
    if [ "${CPUS:-0}" -gt 0 ] && [ "$CPUS" -lt 6 ]; then
      warn "docker has ${CPUS} CPUs allocated (setup wants >= 6)"
    elif [ "${CPUS:-0}" -ge 6 ]; then
      ok "docker   ${CPUS} CPUs allocated"
    fi
  else
    err "docker   installed but daemon not reachable"
    if [ "$OS" = "Darwin" ]; then
      echo -e "        Start it: ${BOLD}open -a 'Docker Desktop'${NC} (then re-run 'make prereqs')"
    else
      echo -e "        Start it: ${BOLD}sudo systemctl start docker${NC}  (and add yourself: ${BOLD}sudo usermod -aG docker \$USER${NC}, then re-login)"
    fi
    MISSING=$((MISSING + 1))
  fi
else
  err "docker   not found"
  hint "install Docker Desktop: https://www.docker.com/products/docker-desktop/" "sudo apt-get install -y docker.io  (then: sudo usermod -aG docker \$USER)"
  MISSING=$((MISSING + 1))
fi

# ── .env content check ─────────────────────────────────────────────────
# `make minikube-setup` requires ADMIN_PASSWORD and at least one LLM key.
# Parse the specific keys instead of sourcing .env (never execute it).
env_value() {
  # Last non-comment assignment wins; strips surrounding quotes/whitespace.
  # Tolerates an optional leading `export ` (a common .env habit).
  local key="$1" file="$2" raw
  raw="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -n1)" || return 0
  raw="${raw#*=}"
  raw="${raw%\"}"; raw="${raw#\"}"
  raw="${raw%\'}"; raw="${raw#\'}"
  printf '%s' "$raw" | sed 's/[[:space:]]*$//'
}

echo
ENV_FILE="$PROJECT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  err ".env     not found — setup aborts in Step 1"
  echo -e "        Create it: ${BOLD}cp .env.example .env${NC}"
  echo    "        then set ADMIN_PASSWORD (required, no default) and ONE LLM key"
  MISSING=$((MISSING + 1))
else
  ok ".env     present"

  # ADMIN_PASSWORD — required, no default ships.
  if [ -n "$(env_value ADMIN_PASSWORD "$ENV_FILE")" ]; then
    ok ".env     ADMIN_PASSWORD set"
  else
    err ".env     ADMIN_PASSWORD is empty (required — setup aborts in Step 1)"
    echo -e "        Set it in .env: ${BOLD}ADMIN_PASSWORD=<choose-a-strong-password>${NC}"
    MISSING=$((MISSING + 1))
  fi

  # At least one LLM key — setup infers the provider from whichever is set.
  #
  # Canonical provider→primary-credential map, mirrored from the registry in
  # packages/llm-providers/index.cjs (PROVIDER_CREDENTIAL_SLOTS). All 21
  # providers; the value is each provider's PRIMARY credential env var (vertex
  # and bedrock also need secondary vars — see the per-provider note below).
  # Keep in sync with that file if providers are added.
  PROVIDER_KEYS="\
openai:OPENAI_API_KEY \
claude:CLAUDE_API_KEY \
zai:ZAI_API_KEY \
bailian:BAILIAN_API_KEY \
vertex:VERTEX_SERVICE_ACCOUNT_JSON \
bedrock:AWS_ACCESS_KEY_ID \
openrouter:OPENROUTER_API_KEY \
gemini:GEMINI_API_KEY \
deepseek:DEEPSEEK_API_KEY \
groq:GROQ_API_KEY \
together:TOGETHER_API_KEY \
fireworks:FIREWORKS_API_KEY \
mistral:MISTRAL_API_KEY \
xai:XAI_API_KEY \
cerebras:CEREBRAS_API_KEY \
deepinfra:DEEPINFRA_API_KEY \
perplexity:PERPLEXITY_API_KEY \
moonshot:MOONSHOT_API_KEY \
nebius:NEBIUS_API_KEY \
novita:NOVITA_API_KEY \
azure:AZURE_OPENAI_API_KEY"

  provider_key_for() {
    local p="$1" pair
    for pair in $PROVIDER_KEYS; do
      if [ "${pair%%:*}" = "$p" ]; then printf '%s' "${pair#*:}"; return 0; fi
    done
    return 1
  }

  LLM_KEYS_SET=""
  for pair in $PROVIDER_KEYS; do
    k="${pair#*:}"
    if [ -n "$(env_value "$k" "$ENV_FILE")" ]; then
      LLM_KEYS_SET="$LLM_KEYS_SET $k"
    fi
  done
  if [ -n "$LLM_KEYS_SET" ]; then
    ok ".env     LLM key set —$LLM_KEYS_SET"
  else
    # Non-fatal: setup boots with test placeholders (default zai). The agent
    # just can't reach a model until a real key is added — matches the
    # "optional" behavior documented in docs/deploy/minikube.md.
    warn ".env     no LLM key set — setup will boot with placeholders (default zai); the agent can't call a model until you add one"
    echo    "        Set one of 21 providers in .env (OPENAI_API_KEY / CLAUDE_API_KEY / GEMINI_API_KEY / GROQ_API_KEY / MISTRAL_API_KEY …); setup infers the provider. Full list: docs/deploy/llm-providers.md"
  fi

  # Provider/key consistency — non-fatal, catches a common mismatch.
  PROVIDER="$(env_value CLERUM_MODEL_PROVIDER "$ENV_FILE")"
  if [ -n "$PROVIDER" ]; then
    if PROVIDER_KEY="$(provider_key_for "$PROVIDER")"; then
      if [ -z "$(env_value "$PROVIDER_KEY" "$ENV_FILE")" ]; then
        warn ".env     CLERUM_MODEL_PROVIDER='$PROVIDER' but $PROVIDER_KEY is empty"
      fi
      # Multi-credential providers need more than the primary key.
      case "$PROVIDER" in
        bedrock) [ -z "$(env_value AWS_SECRET_ACCESS_KEY "$ENV_FILE")" ] && \
          warn ".env     provider 'bedrock' also needs AWS_SECRET_ACCESS_KEY (+ AWS_REGION)" ;;
        vertex)  [ -z "$(env_value VERTEX_PROJECT_ID "$ENV_FILE")" ] && \
          warn ".env     provider 'vertex' also needs VERTEX_PROJECT_ID" ;;
        azure)   [ -z "$(env_value AZURE_OPENAI_ENDPOINT "$ENV_FILE")" ] && \
          warn ".env     provider 'azure' also needs AZURE_OPENAI_ENDPOINT" ;;
      esac
    else
      warn ".env     CLERUM_MODEL_PROVIDER='$PROVIDER' is not a known provider (see docs/deploy/llm-providers.md)"
    fi
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────
echo
if [ "$MISSING" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All required prerequisites satisfied.${NC} Next: ${BOLD}make minikube-setup${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}${MISSING} required prerequisite(s) missing.${NC} Install the item(s) above, then re-run ${BOLD}make prereqs${NC}."
  echo    "Full walkthrough: docs/get-started/minikube.md"
  exit 1
fi
