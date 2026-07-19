#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# GKE User Session E2E — Full user session auth chain validation
# ═══════════════════════════════════════════════════════════════════════
#
# Validates the FULL user session flow from password-login to LLM chat:
#   1. Password Login → session JWT
#   2. RPC Token → scoped RPC JWT
#   3. List MCP Servers → server discovery
#   4. Host Health → host liveness
#   5. Send Message → LLM chat round-trip
#   6. Auth Rejection → negative tests (no token, invalid, wrong scope)
#
# Prerequisites:
#   - Port-forwards active:
#       external-rest-api on :8091
#       rpc-proxy on :8094
#   - CLERUM_ENABLE_AUTH=true in cluster
#   - The test user has a seeded password (scripts/e2e/seed-e2e-data.sh);
#     login uses POST /api/v1/auth/password-login with ADMIN_PASSWORD
#
# Usage:
#   ./scripts/e2e/e2e-gke-user-session.sh
#   ./scripts/e2e/e2e-gke-user-session.sh --verbose
#
# Environment:
#   E2E_TEST_EMAIL          (default: playwright@clerum.io)
#   E2E_HOST_REF            (default: chatllm)
#   E2E_THREAD_ID           (default: unique per invocation)
#   E2E_EXTERNAL_REST_API_URL (default: http://localhost:8091)
#   E2E_RPC_PROXY_URL       (default: http://localhost:8094)
#   ADMIN_PASSWORD          (default: changeme123!; the seeded user's password)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

VERBOSE="${1:-}"
PASS=0
FAIL=0
SKIP=0
TOTAL=0

log()   { echo -e "${CYAN}[user-session]${NC} $*"; }
pass()  { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()  { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; }
skip()  { SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)); echo -e "  ${YELLOW}SKIP${NC} $*"; }
detail(){ [[ "$VERBOSE" == "--verbose" ]] && echo -e "       $*"; }

# ── Configuration ────────────────────────────────────────────────────
TEST_EMAIL="${E2E_TEST_EMAIL:-playwright@clerum.io}"
TEST_HOST_REF="${E2E_HOST_REF:-chatllm}"
TEST_THREAD_ID="${E2E_THREAD_ID:-e2e-user-session-$(date +%s)-$$}"
EXTERNAL_REST_API_URL="${E2E_EXTERNAL_REST_API_URL:-http://localhost:8091}"
RPC_PROXY_URL="${E2E_RPC_PROXY_URL:-http://localhost:8094}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-changeme123!}"

echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Clerum GKE User Session E2E${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""
log "Config: email=$TEST_EMAIL host=$TEST_HOST_REF thread=$TEST_THREAD_ID"
log "Config: external-rest-api=$EXTERNAL_REST_API_URL"
log "Config: rpc-proxy=$RPC_PROXY_URL"
echo ""

# ── Prerequisite: Port-forward checks ────────────────────────────────
log "Prerequisite: Port-forward connectivity"

check_port_forward() {
  local url="$1" name="$2"
  if curl -sf --max-time 5 "$url/health" >/dev/null 2>&1; then
    pass "$name reachable at $url"
    return 0
  else
    return 1
  fi
}

EXT_UP=false
RPC_UP=false

if check_port_forward "$EXTERNAL_REST_API_URL" "external-rest-api"; then
  EXT_UP=true
else
  log "external-rest-api not reachable at $EXTERNAL_REST_API_URL — attempting port-forward..."
  kubectl port-forward -n profiles deployment/external-rest-api 8091:8091 >/dev/null 2>&1 &
  PF_EXT_PID=$!
  sleep 2
  if check_port_forward "$EXTERNAL_REST_API_URL" "external-rest-api (auto port-forward)"; then
    EXT_UP=true
  else
    fail "external-rest-api not reachable after port-forward attempt"
    kill $PF_EXT_PID 2>/dev/null || true
  fi
fi

if check_port_forward "$RPC_PROXY_URL" "rpc-proxy"; then
  RPC_UP=true
else
  log "rpc-proxy not reachable at $RPC_PROXY_URL — attempting port-forward..."
  kubectl port-forward -n rpc-proxy deployment/rpc-proxy 8094:8094 >/dev/null 2>&1 &
  PF_RPC_PID=$!
  sleep 2
  if check_port_forward "$RPC_PROXY_URL" "rpc-proxy (auto port-forward)"; then
    RPC_UP=true
  else
    fail "rpc-proxy not reachable after port-forward attempt"
    kill $PF_RPC_PID 2>/dev/null || true
  fi
fi

if [ "$EXT_UP" != "true" ] || [ "$RPC_UP" != "true" ]; then
  echo ""
  fail "Required port-forwards not available. Cannot proceed."
  echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${RED}${BOLD}  ABORTED: $FAIL/$TOTAL tests failed ($PASS passed, $SKIP skipped)${NC}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
  exit 1
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Run all phases in a single Node.js inline script
# (maintains token state across phases, avoids shell JWT escaping)
# ═════════════════════════════════════════════════════════════════════

log "Running user session phases via Node.js..."
echo ""

# Write Node.js script to temp file to avoid shell escaping issues
NODE_SCRIPT="/tmp/clerum-e2e-session-$$.js"
NODE_OUTPUT_FILE="/tmp/clerum-e2e-output-$$.txt"
trap "rm -f $NODE_SCRIPT $NODE_OUTPUT_FILE" EXIT

cat > "$NODE_SCRIPT" <<'NODESCRIPT'
const http = require('http');
const https = require('https');

// ── Helpers ──────────────────────────────────────────────────────────

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers,
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { data = body; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function emit(phase, status, detail) {
  console.log(JSON.stringify({ phase, status, detail }));
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    try {
      // Fallback for base64 without url-safe chars
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(Buffer.from(b64, 'base64').toString());
    } catch {
      return null;
    }
  }
}

const EXT_URL = "__EXT_URL__";
const RPC_URL = "__RPC_URL__";
const TEST_EMAIL = "__TEST_EMAIL__";
const TEST_HOST_REF = "__TEST_HOST__";
const TEST_THREAD_ID = "__TEST_THREAD__";

(async () => {
  let sessionToken = '';
  let rpcToken = '';

  // ── Phase 1: Password Login ────────────────────────────────────────
  try {
    const res = await request(EXT_URL + '/api/v1/auth/password-login', {
      method: 'POST',
      body: { email: TEST_EMAIL, password: process.env.ADMIN_PASSWORD || 'changeme123!' },
    });

    if (res.status !== 200) {
      emit('login', 'fail', 'HTTP ' + res.status + ': ' + JSON.stringify(res.data));
    } else if (!res.data || !res.data.token) {
      emit('login', 'fail', 'no token in response');
    } else {
      sessionToken = res.data.token;
      const payload = decodeJwtPayload(sessionToken);
      if (!payload) {
        emit('login', 'fail', 'token is not a valid JWT');
      } else {
        const fields = [];
        if (payload.userId || payload.sub) fields.push('userId=' + (payload.userId || payload.sub));
        if (payload.email) fields.push('email=' + payload.email);
        if (payload.teamId) fields.push('teamId=' + payload.teamId);
        if (payload.role) fields.push('role=' + payload.role);

        // Must have at least userId/sub and email
        if ((payload.userId || payload.sub) && payload.email) {
          emit('login', 'pass', fields.join(' '));
        } else {
          emit('login', 'fail', 'missing userId/email in JWT payload: ' + JSON.stringify(payload));
        }
      }
    }
  } catch (e) {
    emit('login', 'fail', 'request error: ' + e.message);
  }

  if (!sessionToken) {
    emit('login_token_present', 'fail', 'no session token -- cannot continue');
    // Emit skips for remaining phases
    emit('rpc_token', 'skip', 'no session token');
    emit('rpc_token_scopes', 'skip', 'no session token');
    emit('rpc_token_host_refs', 'skip', 'no session token');
    emit('list_servers', 'skip', 'no rpc token');
    emit('host_health', 'skip', 'no rpc token');
    emit('send_message', 'skip', 'no rpc token');
    emit('send_message_response', 'skip', 'no rpc token');
    emit('reject_no_token', 'skip', 'skipped');
    emit('reject_invalid_token', 'skip', 'skipped');
    emit('reject_wrong_scope', 'skip', 'skipped');
    return;
  }

  emit('login_token_present', 'pass', 'session JWT obtained (' + sessionToken.length + ' chars)');

  // ── Phase 2: RPC Token ─────────────────────────────────────────────
  try {
    const res = await request(EXT_URL + '/api/v1/rpc/token', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sessionToken },
      body: {
        hostRefs: [TEST_HOST_REF],
        scopes: [
          'host:message:invoke',
          'mcp:servers:list',
          'host:status:read',
          'host:health:read',
        ],
      },
    });

    if (res.status !== 200) {
      emit('rpc_token', 'fail', 'HTTP ' + res.status + ': ' + JSON.stringify(res.data));
    } else if (!res.data || !res.data.token) {
      emit('rpc_token', 'fail', 'no token in response');
    } else {
      rpcToken = res.data.token;
      emit('rpc_token', 'pass', 'RPC token obtained (' + rpcToken.length + ' chars)');

      const payload = decodeJwtPayload(rpcToken);
      if (!payload) {
        emit('rpc_token_scopes', 'fail', 'cannot decode RPC JWT');
        emit('rpc_token_host_refs', 'fail', 'cannot decode RPC JWT');
      } else {
        // Verify scopes
        const scopes = payload.scopes || payload.scope || [];
        const scopeList = Array.isArray(scopes) ? scopes : (typeof scopes === 'string' ? scopes.split(' ') : []);
        if (scopeList.includes('host:message:invoke')) {
          emit('rpc_token_scopes', 'pass', 'scopes=[' + scopeList.join(',') + ']');
        } else {
          emit('rpc_token_scopes', 'fail', 'host:message:invoke missing from scopes: ' + JSON.stringify(scopeList));
        }

        // Verify hostRefs
        const hostRefs = payload.hostRefs || payload.hosts || [];
        const hrList = Array.isArray(hostRefs) ? hostRefs : [];
        if (hrList.includes(TEST_HOST_REF)) {
          emit('rpc_token_host_refs', 'pass', 'hostRefs=[' + hrList.join(',') + ']');
        } else {
          emit('rpc_token_host_refs', 'fail', TEST_HOST_REF + ' missing from hostRefs: ' + JSON.stringify(hrList));
        }
      }
    }
  } catch (e) {
    emit('rpc_token', 'fail', 'request error: ' + e.message);
  }

  if (!rpcToken) {
    emit('list_servers', 'skip', 'no rpc token');
    emit('host_health', 'skip', 'no rpc token');
    emit('send_message', 'skip', 'no rpc token');
    emit('send_message_response', 'skip', 'no rpc token');
    emit('reject_no_token', 'skip', 'skipped');
    emit('reject_invalid_token', 'skip', 'skipped');
    emit('reject_wrong_scope', 'skip', 'skipped');
    return;
  }

  const authHeader = { Authorization: 'Bearer ' + rpcToken };

  // ── Phase 3: List MCP Servers ──────────────────────────────────────
  try {
    const res = await request(RPC_URL + '/api/v1/rpc/servers', {
      method: 'GET',
      headers: authHeader,
    });

    if (res.status !== 200) {
      emit('list_servers', 'fail', 'HTTP ' + res.status + ': ' + JSON.stringify(res.data));
    } else if (!res.data || !Array.isArray(res.data.servers)) {
      emit('list_servers', 'fail', 'response missing servers array: ' + JSON.stringify(res.data).slice(0, 200));
    } else {
      const names = res.data.servers.map(s => s.name || s.id || 'unnamed');
      emit('list_servers', 'pass', res.data.servers.length + ' servers: [' + names.slice(0, 5).join(',') + (names.length > 5 ? ',...' : '') + ']');
    }
  } catch (e) {
    emit('list_servers', 'fail', 'request error: ' + e.message);
  }

  // ── Phase 4: Host Health ───────────────────────────────────────────
  try {
    const res = await request(RPC_URL + '/api/v1/rpc/hosts/' + encodeURIComponent(TEST_HOST_REF) + '/health', {
      method: 'GET',
      headers: authHeader,
    });

    if (res.status !== 200) {
      emit('host_health', 'fail', 'HTTP ' + res.status + ': ' + JSON.stringify(res.data));
    } else if (!res.data || typeof res.data !== 'object') {
      emit('host_health', 'fail', 'response is not an object');
    } else {
      const status = res.data.status || res.data.healthy || res.data.state || 'unknown';
      emit('host_health', 'pass', 'host=' + TEST_HOST_REF + ' status=' + status);
    }
  } catch (e) {
    emit('host_health', 'fail', 'request error: ' + e.message);
  }

  // ── Phase 5: Send Message (LLM chat) ──────────────────────────────
  try {
    const res = await request(RPC_URL + '/api/v1/rpc/hosts/' + encodeURIComponent(TEST_HOST_REF) + '/messages', {
      method: 'POST',
      headers: authHeader,
      body: {
        content: 'What is 2+2? Reply with just the number.',
        threadId: TEST_THREAD_ID,
      },
    });

    if (res.status !== 200) {
      emit('send_message', 'fail', 'HTTP ' + res.status + ': ' + JSON.stringify(res.data).slice(0, 300));
    } else if (!res.data) {
      emit('send_message', 'fail', 'empty response body');
    } else {
      emit('send_message', 'pass', 'HTTP 200 received');

      // Verify response has content
      const content = res.data.response || res.data.content || res.data.reply || res.data.message || res.data.text || '';
      const model = res.data.model || res.data.modelId || '';
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

      if (contentStr.trim().length > 0) {
        const preview = contentStr.trim().slice(0, 100).replace(/\\n/g, ' ');
        emit('send_message_response', 'pass', 'response=\"' + preview + '\"' + (model ? ' model=' + model : ''));
      } else {
        emit('send_message_response', 'fail', 'response content is empty. Full response: ' + JSON.stringify(res.data).slice(0, 300));
      }
    }
  } catch (e) {
    emit('send_message', 'fail', 'request error: ' + e.message);
  }

  // ── Phase 6: Auth Rejection Tests ──────────────────────────────────

  // 6a. No token
  try {
    const res = await request(RPC_URL + '/api/v1/rpc/hosts/' + encodeURIComponent(TEST_HOST_REF) + '/messages', {
      method: 'POST',
      body: { content: 'test' },
    });

    if (res.status === 401) {
      emit('reject_no_token', 'pass', 'correctly rejected with 401 (no token)');
    } else {
      emit('reject_no_token', 'fail', 'expected 401, got HTTP ' + res.status);
    }
  } catch (e) {
    emit('reject_no_token', 'fail', 'request error: ' + e.message);
  }

  // 6b. Invalid token
  try {
    const res = await request(RPC_URL + '/api/v1/rpc/hosts/' + encodeURIComponent(TEST_HOST_REF) + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid-garbage-token-e2e-test' },
      body: { content: 'test' },
    });

    if (res.status === 401 || res.status === 403) {
      emit('reject_invalid_token', 'pass', 'correctly rejected with ' + res.status + ' (invalid token)');
    } else {
      emit('reject_invalid_token', 'fail', 'expected 401/403, got HTTP ' + res.status);
    }
  } catch (e) {
    emit('reject_invalid_token', 'fail', 'request error: ' + e.message);
  }

  // 6c. Token with wrong scope (request a token with only mcp:servers:list, then try messages)
  try {
    // Get a narrow-scoped RPC token
    const tokenRes = await request(EXT_URL + '/api/v1/rpc/token', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sessionToken },
      body: {
        hostRefs: [TEST_HOST_REF],
        scopes: ['mcp:servers:list'],  // missing host:message:invoke
      },
    });

    if (tokenRes.status !== 200 || !tokenRes.data || !tokenRes.data.token) {
      emit('reject_wrong_scope', 'skip', 'could not obtain narrow-scoped token (HTTP ' + tokenRes.status + ')');
    } else {
      const narrowToken = tokenRes.data.token;
      const res = await request(RPC_URL + '/api/v1/rpc/hosts/' + encodeURIComponent(TEST_HOST_REF) + '/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + narrowToken },
        body: { content: 'test' },
      });

      if (res.status === 403) {
        emit('reject_wrong_scope', 'pass', 'correctly rejected with 403 (missing host:message:invoke scope)');
      } else if (res.status === 401) {
        emit('reject_wrong_scope', 'pass', 'correctly rejected with 401 (scope enforcement)');
      } else {
        emit('reject_wrong_scope', 'fail', 'expected 403, got HTTP ' + res.status);
      }
    }
  } catch (e) {
    emit('reject_wrong_scope', 'fail', 'request error: ' + e.message);
  }

})().catch(e => {
  console.log(JSON.stringify({ phase: 'fatal', status: 'fail', detail: 'unhandled: ' + e.message }));
});
NODESCRIPT

# Inject config variables into the Node.js script
sed -i.bak "s|__EXT_URL__|${EXTERNAL_REST_API_URL}|g; s|__RPC_URL__|${RPC_PROXY_URL}|g; s|__TEST_EMAIL__|${TEST_EMAIL}|g; s|__TEST_HOST__|${TEST_HOST_REF}|g; s|__TEST_THREAD__|${TEST_THREAD_ID}|g" "$NODE_SCRIPT" 2>/dev/null || \
sed -i '' "s|__EXT_URL__|${EXTERNAL_REST_API_URL}|g; s|__RPC_URL__|${RPC_PROXY_URL}|g; s|__TEST_EMAIL__|${TEST_EMAIL}|g; s|__TEST_HOST__|${TEST_HOST_REF}|g; s|__TEST_THREAD__|${TEST_THREAD_ID}|g" "$NODE_SCRIPT"
rm -f "${NODE_SCRIPT}.bak"

ADMIN_PASSWORD="$ADMIN_PASSWORD" node --no-warnings "$NODE_SCRIPT" > "$NODE_OUTPUT_FILE" 2>&1
NODE_OUTPUT=$(cat "$NODE_OUTPUT_FILE")

# ═════════════════════════════════════════════════════════════════════
# Parse Node.js JSON output and call pass()/fail()/skip()
# ═════════════════════════════════════════════════════════════════════

get_label() {
  case "$1" in
    login)                 echo "Phase 1: Password login returns valid session JWT" ;;
    login_token_present)   echo "Phase 1: Session token present" ;;
    rpc_token)             echo "Phase 2: RPC token obtained" ;;
    rpc_token_scopes)      echo "Phase 2: RPC token contains host:message:invoke scope" ;;
    rpc_token_host_refs)   echo "Phase 2: RPC token contains requested hostRef" ;;
    list_servers)          echo "Phase 3: List MCP servers via rpc-proxy" ;;
    host_health)           echo "Phase 4: Host health check via rpc-proxy" ;;
    send_message)          echo "Phase 5: Send message to LLM host" ;;
    send_message_response) echo "Phase 5: LLM response contains content" ;;
    reject_no_token)       echo "Phase 6: Reject request without token (401)" ;;
    reject_invalid_token)  echo "Phase 6: Reject request with invalid token (401/403)" ;;
    reject_wrong_scope)    echo "Phase 6: Reject request with wrong scope (403)" ;;
    fatal)                 echo "FATAL ERROR" ;;
    *)                     echo "$1" ;;
  esac
}

# Pre-process all JSON lines into tab-separated fields in one Node.js call
PARSED_OUTPUT=$(echo "$NODE_OUTPUT" | node --no-warnings -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    for (const line of d.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.phase && obj.status) {
          const detail = (obj.detail || '').replace(/[\t\n\r]/g, ' ');
          console.log(obj.phase + '\t' + obj.status + '\t' + detail);
        }
      } catch {}
    }
  });
" 2>/dev/null || echo "")

# Display pass/fail/skip results (pipe to while runs in subshell, so
# we display here and count separately below)
echo "$PARSED_OUTPUT" | while IFS=$'\t' read -r phase status detail_msg; do
  [ -z "$phase" ] && continue
  label=$(get_label "$phase")
  case "$status" in
    pass) pass "$label ($detail_msg)" ;;
    fail) fail "$label ($detail_msg)" ;;
    skip) skip "$label ($detail_msg)" ;;
    *)    fail "$label (unknown status: $status)" ;;
  esac
done

# The while loop above runs in a subshell (due to pipe), so PASS/FAIL/SKIP
# counters are lost. Re-count using a here-string (no subshell).
PASS=0; FAIL=0; SKIP=0; TOTAL=0

# Add the prerequisite pass counts (2 port-forward checks passed if we got here)
PASS=2; TOTAL=2

while IFS=$'\t' read -r _phase status _detail; do
  [ -z "$status" ] && continue
  case "$status" in
    pass) PASS=$((PASS+1)); TOTAL=$((TOTAL+1)) ;;
    fail) FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)) ;;
    skip) SKIP=$((SKIP+1)); TOTAL=$((TOTAL+1)) ;;
  esac
done <<< "$PARSED_OUTPUT"

echo ""

# ═════════════════════════════════════════════════════════════════════
# SUMMARY
# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  ALL PASSED: $PASS/$TOTAL tests passed ($SKIP skipped)${NC}"
else
  echo -e "${RED}${BOLD}  FAILURES: $FAIL/$TOTAL tests failed ($PASS passed, $SKIP skipped)${NC}"
fi
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"

# Cleanup background port-forwards if we started them
if [ -n "${PF_EXT_PID:-}" ]; then kill "$PF_EXT_PID" 2>/dev/null || true; fi
if [ -n "${PF_RPC_PID:-}" ]; then kill "$PF_RPC_PID" 2>/dev/null || true; fi

exit $FAIL
