#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — Figure D multi-bot per-CommunicationChannel delivery + cross-bot authz
# ═══════════════════════════════════════════════════════════════════════
#
# Companion gate for PR1 (.ralph/plans/figure-d-multibot-pr1.md). Proves, on a
# live cluster, what unit tests cannot:
#
#   B4 (always)      — migration 0039 applied: communication_channel_ref column
#                      + idx_wama_channel_ref index + status CHECK admits
#                      skipped_no_bot + ONLY telegram NULL-ref rows force-disabled
#                      (Slack / other models untouched).
#   metric (always)  — control-api exposes workflow_approval_delivery_skipped_no_bot_total.
#   B1/B2/B3 (opt-in)— real two-bot delivery, cross-bot block, and skipped_no_bot,
#                      gated on E2E_FIGURE_D_BOT_A_TOKEN / _BOT_B_TOKEN. Without
#                      them the scenarios SKIP loudly (never silently pass).
#   B2b              — the deployed reader's decisionHandler actually parses a
#                      16-hex (64-bit) channelAlias. Guards against a stale reader
#                      image whose compact regex still expects 8 hex — which the
#                      consulta-only B2 cannot detect (it never hits the reader's
#                      /webhooks/telegram callback-parse path).
#   B5/B6            — non-regression of Figure C + Modo A is covered by
#                      scripts/e2e/e2e-workflow-approvals*.sh (run those too).
#
# Usage:
#   KUBECONTEXT=clerum-test bash scripts/e2e/e2e-figure-d-multibot.sh
#   # Optional two-bot scenarios:
#   E2E_FIGURE_D_BOT_A_TOKEN=... E2E_FIGURE_D_BOT_B_TOKEN=... \
#     KUBECONTEXT=clerum-test bash scripts/e2e/e2e-figure-d-multibot.sh
#
# ═══════════════════════════════════════════════════════════════════════

set -u
set -o pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# KUBECONTEXT should be set explicitly to a branch/PR-owned profile. Defaulting
# to the shared `clerum-test` profile risks producing PR evidence against a stale
# shared cluster. We still allow it (it is a valid local profile per CLAUDE.md),
# but warn loudly + print evidence (HEAD/context) when it was not set explicitly.
KUBECONTEXT_WAS_SET=1; [ -z "${KUBECONTEXT:-}" ] && KUBECONTEXT_WAS_SET=0
KCTX="${KUBECONTEXT:-clerum-test}"
CONTROL_PLANE_NS="${CONTROL_PLANE_NS:-control-plane}"

pass=0; fail=0; skip=0; total=0
log()  { echo -e "${CYAN}[figure-d-multibot]${NC} $*"; }
ok()   { echo -e "  ${GREEN}PASS${NC} $*"; pass=$((pass+1)); total=$((total+1)); }
no()   { echo -e "  ${RED}FAIL${NC} $*"; fail=$((fail+1)); total=$((total+1)); }
skp()  { echo -e "  ${YELLOW}SKIP${NC} $*"; skip=$((skip+1)); total=$((total+1)); }

# ── Allowed-context guard (CLAUDE.md): never touch a non-Clerum cluster ──
case "$KCTX" in
  clerum-test|clerum-codex-*|clerum-detached-*|clerum-feat-*|clerum-fix-*|gke_${GCP_PROJECT}_us-central1-a_clerum-dev|gke_${GCP_PROJECT}_us-central1-a_clerum) ;;
  *) echo -e "${RED}Refusing to run against non-Clerum context: $KCTX${NC}"; exit 2 ;;
esac

kc() { kubectl --context="$KCTX" "$@"; }

psql_q() {
  local pg
  pg="$(kc -n "$CONTROL_PLANE_NS" get pod -l app=control-postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)"
  [ -z "$pg" ] && { echo "__NO_PG__"; return 1; }
  kc -n "$CONTROL_PLANE_NS" exec "$pg" -- psql -U postgres -d profiles -tA -c "$1" 2>/dev/null
}

log "Context: $KCTX"
if [ "$KUBECONTEXT_WAS_SET" = "0" ]; then
  log "${YELLOW}WARNING: KUBECONTEXT not set — defaulted to the SHARED 'clerum-test' profile.${NC}"
  log "${YELLOW}  For trustworthy PR/branch evidence, set KUBECONTEXT=clerum-feat-<topic>-<sha>.${NC}"
fi
if command -v git >/dev/null 2>&1; then
  log "Evidence: HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo '?') context=$KCTX"
fi

# ─── B4: migration 0039 applied ────────────────────────────────────────
log "B4 — migration 0039 + schema"

ver="$(psql_q "SELECT version FROM schema_migrations WHERE version = '0039_wama_communication_channel_ref';")"
[ "$ver" = "0039_wama_communication_channel_ref" ] \
  && ok "schema_migrations records 0039" \
  || no "0039 not recorded in schema_migrations (got: '$ver')"

col="$(psql_q "SELECT column_name FROM information_schema.columns WHERE table_name='workflow_approval_medium_accounts' AND column_name='communication_channel_ref';")"
[ "$col" = "communication_channel_ref" ] \
  && ok "wama.communication_channel_ref column exists" \
  || no "communication_channel_ref column missing"

idx="$(psql_q "SELECT indexname FROM pg_indexes WHERE tablename='workflow_approval_medium_accounts' AND indexname='idx_wama_channel_ref';")"
[ "$idx" = "idx_wama_channel_ref" ] \
  && ok "idx_wama_channel_ref index exists" \
  || no "idx_wama_channel_ref index missing"

# CHECK admits skipped_no_bot: inspect the status CHECK constraint definition.
admit="$(psql_q "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='notification_deliveries'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%skipped_no_bot%';")"
[ -n "$admit" ] && ok "notification_deliveries.status CHECK admits skipped_no_bot" || no "status CHECK missing skipped_no_bot (constraint does not admit it)"

# Force-disable is telegram-only: no active telegram row may have a NULL ref.
orphan="$(psql_q "SELECT count(*) FROM workflow_approval_medium_accounts WHERE medium='telegram' AND communication_channel_ref IS NULL AND disabled_at IS NULL;")"
[ "$orphan" = "0" ] \
  && ok "no active telegram rows with NULL channel ref (force-disable applied)" \
  || no "found $orphan active telegram rows with NULL channel ref"

# ─── Metric exposed ────────────────────────────────────────────────────
log "metric — skipped_no_bot counter"
metric="$(kc -n "$CONTROL_PLANE_NS" exec deploy/control-api -- \
  sh -c 'wget -qO- http://localhost:8090/metrics 2>/dev/null || curl -s http://localhost:8090/metrics 2>/dev/null' 2>/dev/null \
  | grep -c 'workflow_approval_delivery_skipped_no_bot_total' || true)"
[ "${metric:-0}" -ge 1 ] 2>/dev/null \
  && ok "workflow_approval_delivery_skipped_no_bot_total exposed on /metrics" \
  || skp "metric not observed (control-api may gate /metrics; verify manually)"

# ─── B1/B2/B3: automated two-bot harness (fake-telegram-server) ────────
# Runs without real Telegram bots: the minikube overlay deploys
# tests/e2e/fixtures/fake-telegram-server and points the delivery worker at it
# (WORKFLOW_APPROVAL_TELEGRAM_API_ROOT override). The harness seeds DB rows the
# delivery worker + reader consulta consume, then asserts behaviour. Every
# seeded row / CR / Secret is cleaned up. Skips loudly when the fixture is absent
# (e.g. GKE), never silently passes.
log "B1/B2/B3 — two-bot delivery + cross-bot + no_bot (fake-telegram harness)"

CHANNELS_NS="${CHANNELS_NS:-channels}"
FD_FAKE_DEPLOY="${FD_FAKE_DEPLOY:-fake-telegram-server}"

# filtered psql: strip psql command-status tags (INSERT 0 1 …) so RETURNING
# captures are clean.
fd_q() { psql_q "$1" | grep -vE '^(INSERT|UPDATE|DELETE|SELECT|BEGIN|COMMIT|ROLLBACK)( [0-9]|$)'; }
fd_fake() { kc -n "$CHANNELS_NS" exec "$FD_FAKE_POD" -- node -e "$1" "${@:2}"; }
fd_ca()   { kc -n "$CONTROL_PLANE_NS" exec "$FD_CA_POD" -- node -e "$1" "${@:2}"; }
# 16 hex / 64-bit channelAlias — must match CHANNEL_ALIAS_LEN in control-api.
fd_channel_alias() { python3 -c "import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])" "$1"; }
fd_metric() {
  kc -n "$CONTROL_PLANE_NS" exec deploy/control-api -- \
    sh -c 'wget -qO- http://localhost:8090/metrics 2>/dev/null || curl -s http://localhost:8090/metrics 2>/dev/null' 2>/dev/null \
    | awk '/^workflow_approval_delivery_skipped_no_bot_total\{medium="telegram"\}/{print $2}' | head -1
}

FD_FAKE_POD="$(kc -n "$CHANNELS_NS" get pod -l app="$FD_FAKE_DEPLOY" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
FD_CA_POD="$(kc -n "$CONTROL_PLANE_NS" get pod -l app=control-api -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"

if [ -z "$FD_FAKE_POD" ] || [ -z "$FD_CA_POD" ]; then
  skp "B1 multi-bot delivery — fake-telegram-server not deployed (minikube overlay only)"
  skp "B2 cross-bot block — requires fake-telegram harness + control-api"
  skp "B3 skipped_no_bot — requires fake-telegram harness"
  log "Deploy the minikube overlay (deploy/overlays/minikube) to run B1/B2/B3 automatically."
else
  TSX="$(date +%s)$$"
  mkchan() { # name secret token chat puid  (empty token => no telegram-bot-token key)
    if [ -n "$3" ]; then
      kc -n "$CHANNELS_NS" create secret generic "$2" --from-literal=telegram-bot-token="$3" >/dev/null 2>&1
    else
      kc -n "$CHANNELS_NS" create secret generic "$2" --from-literal=placeholder=x >/dev/null 2>&1
    fi
    printf 'apiVersion: clerum.io/v1alpha1\nkind: CommunicationChannel\nmetadata:\n  name: %s\n  namespace: %s\nspec:\n  hostRef: chatllm\n  credentialsSecretRef:\n    name: %s\n  telegram:\n    - channelId: "%s"\n      chatType: private\n      userIds: ["%s"]\n' \
      "$1" "$CHANNELS_NS" "$2" "$4" "$5" | kc apply -f - >/dev/null 2>&1
  }
  seed_delivery() { # email puid chat ccref idemp dedupe -> echoes uid
    local uid
    uid=$(fd_q "INSERT INTO users (email) VALUES ('$1') RETURNING id;")
    fd_q "INSERT INTO workflow_approval_medium_accounts (user_id,medium,provider_user_id,provider_channel_id,communication_channel_ref,verified_at) VALUES ('$uid','telegram','$2','$3','$4',NOW());" >/dev/null
    local war
    war=$(fd_q "INSERT INTO workflow_approval_requests (recipe_namespace,recipe_name,expires_at,status,target_user_id,payload,idempotency_key) VALUES ('sandbox-recipes','figd-e2e',NOW()+INTERVAL '1 hour','pending','$uid','{\"title\":\"Approve?\",\"actions\":[{\"label\":\"Approve\",\"id\":\"approve\"}]}'::jsonb,'$5') RETURNING id;")
    fd_q "INSERT INTO notification_deliveries (event_type,dedupe_key,audience,payload,status) VALUES ('approval.requested','$6','{\"userId\":\"$uid\"}'::jsonb,'{\"approvalRequestId\":\"$war\"}'::jsonb,'queued') RETURNING id;" >/dev/null
    echo "$uid"
  }
  wait_status() { # delivery_user_id expected_status -> echoes final status
    local u="$1" exp="$2" st=""
    for _ in 1 2 3 4 5 6 7 8; do
      sleep 3
      st=$(fd_q "SELECT status FROM notification_deliveries WHERE audience->>'userId'='$u';")
      [ "$st" = "$exp" ] && break
      case "$st" in sent|failed|skipped_no_bot) break;; esac
    done
    echo "$st"
  }
  cleanup_user() { # user_id
    fd_q "DELETE FROM notification_deliveries WHERE audience->>'userId'='$1';" >/dev/null
    fd_q "DELETE FROM workflow_approval_requests WHERE target_user_id='$1';" >/dev/null
    fd_q "DELETE FROM workflow_approval_medium_accounts WHERE user_id='$1';" >/dev/null
    fd_q "DELETE FROM users WHERE id='$1';" >/dev/null
  }
  del_chan() { kc -n "$CHANNELS_NS" delete communicationchannel "$1" >/dev/null 2>&1 || true; kc -n "$CHANNELS_NS" delete secret "$2" >/dev/null 2>&1 || true; }

  # ── B1: per-channel two-bot delivery (each delivery uses ITS channel's bot) ──
  fd_fake 'const h=require("http");const r=h.request({host:"127.0.0.1",port:8080,path:"/reset",method:"POST"},x=>x.resume());r.end()' >/dev/null 2>&1
  B1_TOKA="botA${TSX}"; B1_TOKB="botB${TSX}"; B1_CHATA="71${TSX}"; B1_CHATB="72${TSX}"
  mkchan "figd-bota-${TSX}" "figd-seca-${TSX}" "$B1_TOKA" "$B1_CHATA" "uidA${TSX}"
  mkchan "figd-botb-${TSX}" "figd-secb-${TSX}" "$B1_TOKB" "$B1_CHATB" "uidB${TSX}"
  B1_UA=$(seed_delivery "figd-b1a-${TSX}@clerum.io" "uidA${TSX}" "$B1_CHATA" "channels/figd-bota-${TSX}" "idmA${TSX}" "ddA${TSX}")
  B1_UB=$(seed_delivery "figd-b1b-${TSX}@clerum.io" "uidB${TSX}" "$B1_CHATB" "channels/figd-botb-${TSX}" "idmB${TSX}" "ddB${TSX}")
  B1_SA=$(wait_status "$B1_UA" sent); B1_SB=$(wait_status "$B1_UB" sent)
  B1_SENDS=$(fd_fake 'const h=require("http");h.get("http://127.0.0.1:8080/sends",x=>{let d="";x.on("data",c=>d+=c);x.on("end",()=>console.log(d))})' 2>/dev/null)
  B1_VERDICT=$(printf '%s' "$B1_SENDS" | python3 -c "
import sys,json
try: sends=json.load(sys.stdin).get('sends',[])
except Exception: sends=[]
ta,tb,ca,cb='$B1_TOKA','$B1_TOKB','$B1_CHATA','$B1_CHATB'
ok = any(s.get('token')==ta and str(s.get('chat_id'))==ca for s in sends) \
 and any(s.get('token')==tb and str(s.get('chat_id'))==cb for s in sends) \
 and not any(s.get('token')==ta and str(s.get('chat_id'))==cb for s in sends) \
 and not any(s.get('token')==tb and str(s.get('chat_id'))==ca for s in sends)
print('OK' if ok else 'BAD')
" 2>/dev/null)
  if [ "$B1_SA" = "sent" ] && [ "$B1_SB" = "sent" ] && [ "$B1_VERDICT" = "OK" ]; then
    ok "B1 per-channel two-bot delivery — A->botA, B->botB, no cross-bot leak"
  else
    no "B1 per-channel delivery (A=$B1_SA B=$B1_SB verdict=$B1_VERDICT)"
  fi
  cleanup_user "$B1_UA"; cleanup_user "$B1_UB"
  del_chan "figd-bota-${TSX}" "figd-seca-${TSX}"; del_chan "figd-botb-${TSX}" "figd-secb-${TSX}"

  # ── B2: cross-bot identity block (D1 STRICT) at the control-api CONSULTA ──
  # Scope note: this exercises the consulta endpoint DIRECTLY (the reader's
  # pre-check barrier #1). It does NOT replay a Telegram callback through the
  # reader's /webhooks/telegram → mcp-host → provider-decision path. The full
  # reader round-trip (forged callback -> 403 cross_bot_mismatch + WAR stays
  # pending; correct callback -> WAR approved -> step resumes) is validated by
  # the live weld in .local-notes/b7-*.sh, not by this gate. Do not read B2 as a
  # full end-to-end callback test.
  B2_TOKEN=$(kc -n "$CHANNELS_NS" get secret workflow-approval-request-reader-credentials -o jsonpath='{.data.control-api-token}' 2>/dev/null | base64 -d 2>/dev/null)
  if [ -z "$B2_TOKEN" ]; then
    no "B2 cross-bot block — reader control-api-token secret not found"
  else
    B2_PUID="figd-b2-${TSX}"; B2_CHANA="channels/figd-chanA-${TSX}"; B2_CHANB="channels/figd-chanB-${TSX}"
    B2_AA=$(fd_channel_alias "$B2_CHANA"); B2_AB=$(fd_channel_alias "$B2_CHANB")
    B2_UID=$(fd_q "INSERT INTO users (email) VALUES ('figd-b2-${TSX}@clerum.io') RETURNING id;")
    fd_q "INSERT INTO workflow_approval_medium_accounts (user_id,medium,provider_user_id,provider_channel_id,communication_channel_ref,verified_at) VALUES ('$B2_UID','telegram','$B2_PUID','73${TSX}','$B2_CHANA',NOW());" >/dev/null
    B2_WAR=$(fd_q "INSERT INTO workflow_approval_requests (recipe_namespace,recipe_name,expires_at,status,target_user_id,payload,idempotency_key) VALUES ('sandbox-recipes','figd-e2e-b2',NOW()+INTERVAL '1 hour','pending','$B2_UID','{}'::jsonb,'figd-b2-${TSX}') RETURNING id;")
    b2_consulta() { # alias providerUserId
      fd_ca 'const http=require("http");const [id,alias,puid,token]=process.argv.slice(1);const u="http://localhost:8090/api/v1/internal/workflow-approval-reader/approvals/"+id+"/can-approve?medium=telegram&providerUserId="+encodeURIComponent(puid)+"&channelAlias="+alias;http.get(u,{headers:{"x-service-token":"workflow-approval-reader","Authorization":"Bearer "+token}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode+" "+d))}).on("error",e=>console.log("ERR "+e.message));' "$B2_WAR" "$1" "$2" "$B2_TOKEN"
    }
    B2_OK=$(b2_consulta "$B2_AA" "$B2_PUID")
    B2_FORGE=$(b2_consulta "$B2_AB" "$B2_PUID")
    B2_NOACC=$(b2_consulta "$B2_AA" "nobody-${TSX}")
    if printf '%s' "$B2_OK" | grep -q '"canApprove":true' \
       && printf '%s' "$B2_FORGE" | grep -q '"reason":"cross_bot_mismatch"' \
       && printf '%s' "$B2_NOACC" | grep -q '"reason":"account_not_verified"'; then
      ok "B2 cross-bot block (consulta D1 STRICT, direct endpoint) — matching alias approves, forged -> cross_bot_mismatch, unknown user -> account_not_verified"
    else
      no "B2 cross-bot block (ok=$B2_OK forge=$B2_FORGE noacc=$B2_NOACC)"
    fi
    cleanup_user "$B2_UID"
  fi

  # ── B2b: reader decisionHandler parses a 16-hex channelAlias (stale-image guard) ──
  # B2 exercises ONLY the control-api consulta. It cannot catch a reader image whose
  # compact callback regex still expects an 8-hex channelAlias (the 64-bit widening,
  # PR1). Such a stale reader rejects every Figure-D callback with
  # invalid_decision_payload BEFORE any cross-bot logic runs, yet B2 still passes —
  # the gap a live weld (.local-notes/b7-*.sh) caught but the gate did not. This check
  # exercises the reader's OWN parse path: it runs the DEPLOYED reader's compiled
  # normalizeTelegramDecision against a compact 16-hex callback and asserts the
  # channelAlias round-trips. decisionHandler has no import side effects, so a bare
  # `node import` of the built module is safe.
  FD_READER_POD="$(kc -n "$CHANNELS_NS" get pod -l app=workflow-approval-request-reader -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -z "$FD_READER_POD" ]; then
    skp "B2b reader decisionHandler parse — reader pod not found in $CHANNELS_NS"
  else
    B2B_ROUTE=$(fd_channel_alias "sandbox-recipes/figd-b2b-${TSX}")
    B2B_CHAN=$(fd_channel_alias "channels/figd-b2b-${TSX}")
    B2B_OUT=$(kc -n "$CHANNELS_NS" exec "$FD_READER_POD" -- node --input-type=module -e '
import { normalizeTelegramDecision } from "/app/dist/decisionHandler.js";
const [route, chan] = process.argv.slice(1);
const b64 = Buffer.from("99999999888877776666555555555555", "hex").toString("base64url");
const data = `a:${b64}:~${route}:${chan}`;
if (Buffer.byteLength(data, "utf8") > 64) { console.log("OVER64"); process.exit(0); }
const r = normalizeTelegramDecision({ callback_query: { id: "x", from: { id: 1 }, message: { chat: { id: 2, type: "private" } }, data } });
console.log(JSON.stringify({ alias: (r && r.channelAlias) || null, match: !!(r && r.channelAlias === chan) }));
' "$B2B_ROUTE" "$B2B_CHAN" 2>/dev/null)
    if printf '%s' "$B2B_OUT" | grep -q '"match":true'; then
      ok "B2b reader decisionHandler parses 16-hex channelAlias (deployed reader image not stale)"
    else
      no "B2b reader decisionHandler did NOT parse 16-hex channelAlias — stale reader image? (out=$B2B_OUT)"
    fi
  fi

  # ── B3: skipped_no_bot — channel whose Secret has no telegram-bot-token ──
  B3_M0=$(fd_metric); B3_M0=${B3_M0:-0}
  mkchan "figd-nobot-${TSX}" "figd-secnb-${TSX}" "" "74${TSX}" "uidNB${TSX}"
  B3_U=$(seed_delivery "figd-b3-${TSX}@clerum.io" "uidNB${TSX}" "74${TSX}" "channels/figd-nobot-${TSX}" "idmNB${TSX}" "ddNB${TSX}")
  B3_ST=$(wait_status "$B3_U" skipped_no_bot)
  B3_M1=$(fd_metric); B3_M1=${B3_M1:-0}
  if [ "$B3_ST" = "skipped_no_bot" ] && awk "BEGIN{exit !($B3_M1>$B3_M0)}"; then
    ok "B3 skipped_no_bot — no-token channel -> status skipped_no_bot + metric increment ($B3_M0->$B3_M1)"
  else
    no "B3 skipped_no_bot (status=$B3_ST metric=$B3_M0→$B3_M1)"
  fi
  cleanup_user "$B3_U"; del_chan "figd-nobot-${TSX}" "figd-secnb-${TSX}"
fi

# ─── B5/B6 pointers ────────────────────────────────────────────────────
log "B5/B6 — non-regression (run separately):"
log "  scripts/e2e/e2e-workflow-approvals.sh           (Figure C + token surface)"
log "  scripts/e2e/e2e-workflow-approvals-recovery.sh  (recovery/rotation)"

echo
log "Summary: ${GREEN}${pass} pass${NC} / ${RED}${fail} fail${NC} / ${YELLOW}${skip} skip${NC} (of $total)"
[ "$fail" -eq 0 ] || exit 1
