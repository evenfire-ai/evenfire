#!/usr/bin/env bash
# Contract tests for scripts/e2e/llm-model-ensure.sh: how the seed adds or
# enables the LLM models setup needs through the admin API, and when it must
# leave a row alone.
#
# Hermetic: curl, kubectl and sleep are stubs on PATH. curl answers from a
# queue of "<status> <json>" lines and records each request; kubectl answers the
# read-only llm_catalog_dismissed lookup. Each case runs in a subshell.
#
# Every reply is taken from control-api's wire golden
# (control-api/test/fixtures/wire/llmModelsSetupEnsure.wire.json), which
# contracts.llmModelsSetupEnsure.wire.test.ts produces from the real routes.
# Rows only change their id/provider/model/enabled values; keys and types stay
# the producer's.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="${REPO_ROOT}/scripts/tests/test-e2e-llm-model-ensure.sh"
LIB="${REPO_ROOT}/scripts/e2e/llm-model-ensure.sh"
SEED="${REPO_ROOT}/scripts/e2e/seed-e2e-data.sh"
CONTEXT_LIB="${REPO_ROOT}/scripts/e2e/desktop-login-seed.sh"
GOLDEN="${REPO_ROOT}/control-api/test/fixtures/wire/llmModelsSetupEnsure.wire.json"

FAIL=0
PASSED=0
FAILED=0
pass() { echo "PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "FAIL: $1"; FAIL=1; FAILED=$((FAILED + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
method=GET url="" body=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s %s %s\n' "$method" "${url#http://capi.test/api/v1}" "$body" >>"${CURL_STUB_LOG:?}"
n="$(wc -l <"${CURL_STUB_LOG}" | tr -d ' ')"
reply="$(sed -n "${n}p" "${CURL_STUB_QUEUE:?}")"
if [ -z "$reply" ]; then echo "curl stub: no reply queued for call $n" >&2; exit 7; fi
printf '%s\n%s' "${reply#* }" "${reply%% *}"
STUB
cat >"$WORK/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
sql="$(cat)"
case "$sql" in
  *llm_catalog_sync_runs*)
    # The shared catalog query: one answer per call from $KUBECTL_CATALOG_SEQ.
    printf 'CATALOG %s\n' "$*" >>"${KUBECTL_STUB_LOG:?}"
    printf '%s\n' "$sql" >"${KUBECTL_STUB_LOG}.catalog-sql"
    n="$(grep -c '^CATALOG ' "${KUBECTL_STUB_LOG}")"
    answer="$(sed -n "${n}p" "${KUBECTL_CATALOG_SEQ:?}")"
    case "$answer" in EXIT1) exit 1 ;; EMPTY) ;; *) printf '%s\n' "$answer" ;; esac
    ;;
  *)
    printf 'CALL %s\n' "$*" >>"${KUBECTL_STUB_LOG:?}"
    case "${KUBECTL_STUB_MODE:-absent}" in
      dismissed) printf 't\n' ;;
      absent) ;;
      exit1) exit 1 ;;
    esac
    ;;
esac
STUB
cat >"$WORK/bin/sleep" <<'STUB'
#!/usr/bin/env bash
printf 'SLEEP %s\n' "$*" >>"${SLEEP_STUB_LOG:-/dev/null}"
STUB
chmod +x "$WORK/bin/curl" "$WORK/bin/kubectl" "$WORK/bin/sleep"

ROW_ID=44444444-4444-4444-8444-444444444444
# reply <golden key>: "<status> <body>" as the real route answered.
reply() { printf '%s %s' "$(jq -r ".$1.status" "$GOLDEN")" "$(jq -c ".$1.body" "$GOLDEN")"; }
# row <provider> <model> <enabled>: a producer row with these values.
row() {
  jq -c --arg id "$ROW_ID" --arg p "$1" --arg m "$2" --argjson e "$3" \
    '.list.body.rows[0] | .id = $id | .provider = $p | .model = $m | .enabled = $e' "$GOLDEN"
}
# rows_with <row-json>: a list response holding that row and an unrelated one.
rows_with() {
  printf '%s %s' "$(jq -r '.list.status' "$GOLDEN")" \
    "$(jq -c --argjson r "$1" '.list.body | .rows = [.rows[0], $r]' "$GOLDEN")"
}
NO_ROWS="$(printf '%s %s' "$(jq -r '.list.status' "$GOLDEN")" "$(jq -c '.list.body | .rows = [.rows[0]]' "$GOLDEN")")"
CREATED="$(reply create)"
CONFLICT="$(reply create_conflict)"
CONFIGMAP_FAILED="$(reply create_configmap_write_failed)"
ENABLED="$(reply enable)"

# run_case <name> <queue lines...> -- [NAME=value ...] -- <command...>
run_case() {
  local name="$1"; shift
  local queue="$WORK/$name.queue"
  : >"$queue"
  while [ "$1" != "--" ]; do printf '%s\n' "$1" >>"$queue"; shift; done
  shift
  : >"$WORK/$name.curl"; : >"$WORK/$name.kubectl"; : >"$WORK/$name.sleep"
  printf '%s\n' "${CATALOG_ANSWERS:-live}" | tr ' ' '\n' >"$WORK/$name.catalog"
  (
    set -u -o pipefail
    unset LLM_ENSURE_DB_FRESH LLM_ENSURE_HOST_MODEL LLM_ENSURE_MANIFEST LLM_ENSURE_MINIKUBE_PROFILE \
      LLM_ENSURE_CATALOG_STATE E2E_WORKFLOW_MODEL_PROVIDER E2E_WORKFLOW_MODEL_NAME SEED_PROFILE
    export PATH="$WORK/bin:$PATH" CURL_STUB_LOG="$WORK/$name.curl" CURL_STUB_QUEUE="$queue" \
      KUBECTL_STUB_LOG="$WORK/$name.kubectl" SLEEP_STUB_LOG="$WORK/$name.sleep"
    # Setup normally saw a live catalog; the catalog cases override this and
    # answer the shared llm_catalog_sync_runs query through KUBECTL_CATALOG_SEQ.
    export LLM_ENSURE_CATALOG_DECISION=live KUBECTL_CATALOG_SEQ="$WORK/$name.catalog"
    CONTEXT=clerum-test
    KC="kubectl --context=fixture"
    CONTROL_API_NS=control-plane
    CAPI_BASE=http://capi.test/api/v1
    AUTH_CURL=(-b jar -c jar -H 'Content-Type: application/json')
    while [ "$1" != "--" ]; do
      case "$1" in
        CONTEXT=*) CONTEXT="${1#CONTEXT=}" ;;
        *) export "${1?}" ;;
      esac
      shift
    done
    shift
    # shellcheck disable=SC2329
    log() { printf 'LOG -- %s\n' "$*"; }
    # shellcheck disable=SC2329
    warn() { printf 'WARN -- %s\n' "$*"; }
    # shellcheck disable=SC2329
    die() { printf 'DIE -- %s\n' "$*"; exit 1; }
    # shellcheck source=scripts/e2e/desktop-login-seed.sh
    source "$CONTEXT_LIB"
    # shellcheck source=scripts/e2e/llm-model-ensure.sh
    source "$LIB" || { echo LIB_NOT_SOURCED; exit 97; }
    if "$@"; then rc=0; else rc=$?; fi
    printf 'rc=%s\n' "$rc"
  ) </dev/null 2>&1
}

# shellcheck disable=SC2329
pairs_without_pipefail() { set +o pipefail; llm_ensure_seed_pairs "$@"; }
calls() { cat "$WORK/$1.curl"; }
writes() { grep -cE '^(POST|PUT|DELETE) ' "$WORK/$1.curl" || true; }
one_line() { printf '%s' "$1" | tr '\n' '|'; }

assert_e1_missing_row_is_created_with_a_post() {
  local out
  out="$(run_case e1 "$NO_ROWS" "$CREATED" -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'rc=0' &&
     printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED created zai/glm-5.1' &&
     [ "$(calls e1)" = "$(printf 'GET /admin/llm-models \nPOST /admin/llm-models {"provider":"zai","model":"glm-5.1","enabled":true}')" ]; then
    pass "E1 a missing pair is POSTed enabled and reported as created"
  else
    fail "E1 out=$(one_line "$out") calls=$(one_line "$(calls e1)")"
  fi
}

assert_e2_disabled_row_on_a_fresh_db_is_enabled_with_a_put() {
  local out
  out="$(run_case e2 "$(rows_with "$(row zai glm-4.7 false)")" "$ENABLED" -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'rc=0' &&
     printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED enabled zai/glm-4.7' &&
     [ "$(calls e2)" = "$(printf 'GET /admin/llm-models \nPUT /admin/llm-models/%s {"enabled":true}' "$ROW_ID")" ]; then
    pass "E2 a disabled row on a DB this run created is enabled with PUT {enabled:true}"
  else
    fail "E2 out=$(one_line "$out") calls=$(one_line "$(calls e2)")"
  fi
}

assert_e3_disabled_row_on_a_reused_db_is_left_alone() {
  local out
  out="$(run_case e3 "$(rows_with "$(row zai glm-4.7 false)")" -- LLM_ENSURE_DB_FRESH=false -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'rc=0' &&
     printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED skipped-reuse zai/glm-4.7' &&
     printf '%s\n' "$out" | grep '^WARN -- ' | grep -F LLM_MODEL_ENSURE_SKIPPED_REUSE | grep -Fq 'Control UI' &&
     [ "$(writes e3)" = 0 ]; then
    pass "E3 a disabled row on a reused DB is not flipped; setup warns how to enable it"
  else
    fail "E3 out=$(one_line "$out") calls=$(one_line "$(calls e3)")"
  fi
  # Unset means reused: a direct seed run never re-enables a row.
  out="$(run_case e3b "$(rows_with "$(row zai glm-4.7 false)")" -- -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED skipped-reuse zai/glm-4.7' && [ "$(writes e3b)" = 0 ]; then
    pass "E3 without LLM_ENSURE_DB_FRESH the DB counts as reused"
  else
    fail "E3 unset freshness flipped or failed: $(one_line "$out")"
  fi
}

assert_e4_enabled_row_is_a_no_op() {
  local out
  out="$(run_case e4 "$(rows_with "$(row zai glm-5.1 true manual)")" -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'rc=0' &&
     printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED present zai/glm-5.1' && [ "$(writes e4)" = 0 ]; then
    pass "E4 an enabled row is left as is and reported as present"
  else
    fail "E4 out=$(one_line "$out") calls=$(one_line "$(calls e4)")"
  fi
}

assert_e5_post_conflict_rereads_and_enables() {
  local out
  out="$(run_case e5 "$NO_ROWS" "$CONFLICT" "$(rows_with "$(row zai glm-4.7 false)")" "$ENABLED" \
    -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'rc=0' &&
     printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED enabled zai/glm-4.7' &&
     [ "$(cut -d' ' -f1 "$WORK/e5.curl" | tr '\n' ' ')" = "GET POST GET PUT " ]; then
    pass "E5 a 409 on POST re-reads the rows and enables the row the catalog sync inserted"
  else
    fail "E5 out=$(one_line "$out") calls=$(one_line "$(calls e5)")"
  fi
  # On a reused DB the row appeared during this run (our read saw none), so it
  # is the catalog sync's, not an operator's disable.
  out="$(run_case e5b "$NO_ROWS" "$CONFLICT" "$(rows_with "$(row zai glm-4.7 false)")" "$ENABLED" \
    -- LLM_ENSURE_DB_FRESH=false -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED enabled zai/glm-4.7'; then
    pass "E5 on a reused DB a row inserted between the read and the POST is enabled"
  else
    fail "E5 reuse variant: $(one_line "$out")"
  fi
  out="$(run_case e5c "$NO_ROWS" "$CONFLICT" "$NO_ROWS" -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && printf '%s\n' "$out" | grep -Fq 'LLM_MODEL_ENSURE_FAILED'; then
    pass "E5 a 409 with no row on re-read fails instead of looping"
  else
    fail "E5 409 without a row: $(one_line "$out")"
  fi
}

assert_e6_unexpected_statuses_fail() {
  local out
  out="$(run_case e6 "$NO_ROWS" "$CONFIGMAP_FAILED" \
    -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' &&
     printf '%s\n' "$out" | grep -F 'LLM_MODEL_ENSURE_FAILED' | grep -F 'HTTP 503' | grep -Fq 'configmap_write_failed' &&
     ! printf '%s\n' "$out" | grep -Fq 'runtime propagation is delayed' &&
     ! printf '%s\n' "$out" | grep -q '^LLM_MODEL_ENSURED'; then
    pass "E6 a 503 configmap_write_failed on POST fails, naming the status and error code only"
  else
    fail "E6 out=$(one_line "$out")"
  fi
  out="$(run_case e6b "$(rows_with "$(row zai glm-4.7 false)")" "$CONFIGMAP_FAILED" \
    -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && printf '%s\n' "$out" | grep -F 'PUT' | grep -Fq 'HTTP 503'; then
    pass "E6 a 503 on PUT fails"
  else
    fail "E6 PUT 503: $(one_line "$out")"
  fi
  out="$(run_case e6c '401 {"error":"unauthorized"}' -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && printf '%s\n' "$out" | grep -F 'GET /admin/llm-models' | grep -Fq 'HTTP 401' &&
     [ "$(writes e6c)" = 0 ]; then
    pass "E6 a failed GET fails before any write"
  else
    fail "E6 GET 401: $(one_line "$out")"
  fi
}

assert_e7_a_non_minikube_context_is_refused() {
  local out
  out="$(run_case e7 -- CONTEXT=gke_your-gcp-project_us-central1-a_example-dev LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && printf '%s\n' "$out" | grep -Fq 'LLM_MODEL_ENSURE_REFUSED' &&
     [ ! -s "$WORK/e7.curl" ]; then
    pass "E7 ensure_llm_model_enabled refuses a non-minikube context without calling the API"
  else
    fail "E7 out=$(one_line "$out") calls=$(one_line "$(calls e7)")"
  fi
  out="$(run_case e7b -- CONTEXT=gke_your-gcp-project_us-central1-a_example-dev LLM_ENSURE_HOST_MODEL=zai/glm-5.1 -- ensure_seed_llm_models)"
  if printf '%s\n' "$out" | grep -qx 'rc=0' && printf '%s\n' "$out" | grep '^LOG -- ' | grep -Fq 'not a minikube context' &&
     [ ! -s "$WORK/e7b.curl" ]; then
    pass "E7 the seed skips the ensure outside minikube (the admin owns the allowlist there)"
  else
    fail "E7 seed outside minikube: $(one_line "$out")"
  fi
}

assert_e8_reuse_respects_an_operator_removal() {
  local out
  out="$(KUBECTL_STUB_MODE=dismissed run_case e8 "$NO_ROWS" -- LLM_ENSURE_DB_FRESH=false -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED skipped-reuse zai/glm-5.1' && [ "$(writes e8)" = 0 ] &&
     grep -Fq 'psql' "$WORK/e8.kubectl"; then
    pass "E8 on a reused DB a pair an operator removed is not re-created"
  else
    fail "E8 out=$(one_line "$out") calls=$(one_line "$(calls e8)")"
  fi
  out="$(KUBECTL_STUB_MODE=absent run_case e8b "$NO_ROWS" "$CREATED" -- LLM_ENSURE_DB_FRESH=false -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED created zai/glm-5.1'; then
    pass "E8 on a reused DB a pair never removed is created"
  else
    fail "E8 reuse create: $(one_line "$out")"
  fi
  out="$(KUBECTL_STUB_MODE=absent run_case e8c "$NO_ROWS" "$CREATED" -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED created zai/glm-5.1' && [ ! -s "$WORK/e8c.kubectl" ]; then
    pass "E8 a fresh DB skips the removal lookup"
  else
    fail "E8 fresh lookup: $(one_line "$out")"
  fi
  out="$(KUBECTL_STUB_MODE=exit1 run_case e8d "$NO_ROWS" -- LLM_ENSURE_DB_FRESH=false -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && [ "$(writes e8d)" = 0 ]; then
    pass "E8 a failed removal lookup fails before any write"
  else
    fail "E8 lookup failure: $(one_line "$out")"
  fi
}

assert_e9_seed_pairs_by_profile() {
  local manifest="$WORK/manifest.txt" out
  printf '# comment\nzai/glm-4.7\n\nopenai/gpt-5.4-mini  # trailing\nzai/glm-5.1\n' >"$manifest"
  out="$(run_case e9 -- SEED_PROFILE=minimal LLM_ENSURE_HOST_MODEL=zai/glm-5.1 LLM_ENSURE_MANIFEST="$manifest" -- llm_ensure_seed_pairs extra/x)"
  if [ "$(printf '%s\n' "$out" | tr '\n' ' ')" = "zai/glm-5.1 rc=0 " ]; then
    pass "E9 the minimal profile ensures only the Host model"
  else
    fail "E9 minimal pairs: $(one_line "$out")"
  fi
  out="$(run_case e9b -- SEED_PROFILE=e2e LLM_ENSURE_HOST_MODEL=zai/glm-5.1 LLM_ENSURE_MANIFEST="$manifest" \
    E2E_WORKFLOW_MODEL_PROVIDER=claude E2E_WORKFLOW_MODEL_NAME=claude-sonnet-4-6 -- llm_ensure_seed_pairs openai/gpt-5.4-mini zai/glm-5)"
  if [ "$(printf '%s\n' "$out" | tr '\n' ' ')" = "zai/glm-5.1 zai/glm-4.7 openai/gpt-5.4-mini claude/claude-sonnet-4-6 zai/glm-5 rc=0 " ]; then
    pass "E9 the e2e profile adds the manifest, the E2E workflow model and the extra pairs, once each"
  else
    fail "E9 e2e pairs: $(one_line "$out")"
  fi
  # Without pipefail, as a caller may run it: the failure must still surface.
  out="$(run_case e9c -- SEED_PROFILE=e2e LLM_ENSURE_MANIFEST="$WORK/absent.txt" -- pairs_without_pipefail)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && printf '%s\n' "$out" | grep -Fq 'LLM_MODEL_ENSURE_FAILED'; then
    pass "E9 an unreadable manifest fails, even without pipefail"
  else
    fail "E9 unreadable manifest: $(one_line "$out")"
  fi
  printf 'zai/glm-4.7\n' >"$WORK/one.txt"
  out="$(run_case e9e "$NO_ROWS" "$CREATED" "$(rows_with "$(row zai glm-4.7 true)")" \
    -- SEED_PROFILE=e2e LLM_ENSURE_DB_FRESH=true LLM_ENSURE_HOST_MODEL=zai/glm-5.1 LLM_ENSURE_MANIFEST="$WORK/one.txt" -- ensure_seed_llm_models)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED created zai/glm-5.1' &&
     printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED present zai/glm-4.7' && printf '%s\n' "$out" | grep -qx 'rc=0'; then
    pass "E9 ensure_seed_llm_models ensures every pair in order"
  else
    fail "E9 seed loop: $(one_line "$out")"
  fi
}

assert_e10_seed_ensures_after_login_and_before_grants() {
  local source_line call_line dispatch_end step2_line grants_line
  # shellcheck disable=SC2016
  source_line="$(grep -nF 'source "${SCRIPT_DIR}/llm-model-ensure.sh"' "$SEED" | head -1 | cut -d: -f1)"
  call_line="$(grep -nE '^ensure_seed_llm_models ' "$SEED" | head -1 | cut -d: -f1)"
  dispatch_end="$(awk '/^# ─── Step 1: Bootstrap before login/{s=1} s && /^fi$/{print NR; exit}' "$SEED")"
  step2_line="$(grep -nF '# ─── Step 2: Persist users' "$SEED" | head -1 | cut -d: -f1)"
  grants_line="$(grep -nE '^  seed_plugin_sdk_demo_grants_if_enabled$' "$SEED" | head -1 | cut -d: -f1)"
  if [ -n "$source_line" ] && [ -n "$call_line" ] && [ -n "$dispatch_end" ] && [ -n "$step2_line" ] && [ -n "$grants_line" ] &&
     [ "$dispatch_end" -lt "$source_line" ] && [ "$source_line" -lt "$call_line" ] &&
     [ "$call_line" -lt "$step2_line" ] && [ "$call_line" -lt "$grants_line" ]; then
    pass "E10 the seed ensures LLM models after its admin session and before users and grants"
  else
    fail "E10 order dispatch_end=${dispatch_end:-none} source=${source_line:-none} call=${call_line:-none} step2=${step2_line:-none} grants=${grants_line:-none}"
  fi
  if sed -n "${call_line:-1},$((${call_line:-1} + 1))p" "$SEED" | grep -Fq '|| die'; then
    pass "E10 a failed ensure aborts the seed"
  else
    fail "E10 the ensure call does not abort the seed on failure"
  fi
}

assert_e11_writes_go_through_the_api_only() {
  # The library may read llm_catalog_dismissed; it must never write SQL.
  if grep -F 'llm_catalog_dismissed' "$LIB" >/dev/null &&
     ! grep -Eiq '(INSERT|UPDATE|DELETE)[[:space:]]+(INTO[[:space:]]+)?llm_' "$LIB"; then
    pass "E11 the ensure library writes no SQL"
  else
    fail "E11 the ensure library writes llm_* tables through SQL"
  fi
}

assert_e12_setup_signal_admits_its_own_profile_only() {
  local out
  out="$(run_case e12 "$(rows_with "$(row zai glm-5.1 true)")" \
    -- CONTEXT=clerum-oauth19 LLM_ENSURE_MINIKUBE_PROFILE=clerum-oauth19 -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED present zai/glm-5.1' && printf '%s\n' "$out" | grep -qx 'rc=0'; then
    pass "E12 a profile name the name check does not know (clerum-oauth19) is accepted with setup's signal"
  else
    fail "E12 signalled profile: $(one_line "$out")"
  fi
  out="$(run_case e12b -- CONTEXT=clerum-oauth19 -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && printf '%s\n' "$out" | grep -Fq LLM_MODEL_ENSURE_REFUSED && [ ! -s "$WORK/e12b.curl" ]; then
    pass "E12 the same profile without the signal is refused"
  else
    fail "E12 unsignalled profile: $(one_line "$out")"
  fi
  out="$(run_case e12c -- CONTEXT=clerum-other LLM_ENSURE_MINIKUBE_PROFILE=clerum-oauth19 -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && printf '%s\n' "$out" | grep -Fq LLM_MODEL_ENSURE_REFUSED && [ ! -s "$WORK/e12c.curl" ]; then
    pass "E12 a signal naming another context is refused"
  else
    fail "E12 mismatched signal: $(one_line "$out")"
  fi
  out="$(run_case e12d -- CONTEXT=clerum-test LLM_ENSURE_MINIKUBE_PROFILE=clerum-oauth19 LLM_ENSURE_HOST_MODEL=zai/glm-5.1 -- ensure_seed_llm_models)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && printf '%s\n' "$out" | grep -Fq LLM_MODEL_ENSURE_REFUSED && [ ! -s "$WORK/e12d.curl" ]; then
    pass "E12 the seed fails, not skips, when setup's signal names another context"
  else
    fail "E12 seed with mismatched signal: $(one_line "$out")"
  fi
}

assert_e13_catalog_is_rechecked_before_creating_rows() {
  local out manifest="$WORK/two.txt"
  # Setup saw vendored; the sync goes live while the seed waits and inserts the
  # pair, which is then enabled rather than duplicated as a manual row.
  out="$(CATALOG_ANSWERS="vendored live" run_case e13 "$NO_ROWS" "$(rows_with "$(row zai glm-4.7 false)")" "$ENABLED" \
    -- LLM_ENSURE_CATALOG_DECISION=vendored LLM_ENSURE_DB_FRESH=false LLM_ENSURE_CATALOG_WAIT_SECONDS=10 -- ensure_llm_model_enabled zai glm-4.7)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED enabled zai/glm-4.7' &&
     [ "$(grep -c '^CATALOG ' "$WORK/e13.kubectl")" = 2 ] &&
     [ "$(cut -d' ' -f1,2 "$WORK/e13.curl" | tr '\n' '|')" = "GET /admin/llm-models|GET /admin/llm-models|PUT /admin/llm-models/${ROW_ID}|" ] &&
     ! printf '%s\n' "$out" | grep -Fq LLM_MODEL_ENSURE_BEFORE_CATALOG; then
    pass "E13 an undecided catalog is re-checked; a row the sync inserted meanwhile is enabled, not POSTed"
  else
    fail "E13 out=$(one_line "$out") calls=$(one_line "$(calls e13)")"
  fi
  # Still undecided at the deadline: re-read (the sync may have inserted it),
  # then create anyway and warn once for the run.
  printf 'zai/glm-5.1\nzai/glm-5\n' >"$manifest"
  out="$(CATALOG_ANSWERS="EMPTY EMPTY" run_case e13b "$NO_ROWS" "$NO_ROWS" "$CREATED" \
    -- SEED_PROFILE=minimal LLM_ENSURE_HOST_MODEL=zai/glm-5.1 LLM_ENSURE_CATALOG_DECISION=none LLM_ENSURE_DB_FRESH=true \
       LLM_ENSURE_CATALOG_WAIT_SECONDS=5 -- ensure_seed_llm_models)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED created zai/glm-5.1' && printf '%s\n' "$out" | grep -qx 'rc=0' &&
     [ "$(printf '%s\n' "$out" | grep -c 'LLM_MODEL_ENSURE_BEFORE_CATALOG')" = 1 ] &&
     printf '%s\n' "$out" | grep '^WARN -- ' | grep -F LLM_MODEL_ENSURE_BEFORE_CATALOG | grep -Fq 'manual'; then
    pass "E13 with no live run by the deadline the row is created and LLM_MODEL_ENSURE_BEFORE_CATALOG warns"
  else
    fail "E13 undecided: $(one_line "$out") calls=$(one_line "$(calls e13b)")"
  fi
  out="$(CATALOG_ANSWERS="vendored vendored" run_case e13c "$NO_ROWS" "$NO_ROWS" "$CREATED" "$NO_ROWS" "$CREATED" \
    -- SEED_PROFILE=e2e LLM_ENSURE_MANIFEST="$manifest" LLM_ENSURE_CATALOG_DECISION=none LLM_ENSURE_DB_FRESH=true \
       LLM_ENSURE_CATALOG_WAIT_SECONDS=5 -- ensure_seed_llm_models)"
  if [ "$(printf '%s\n' "$out" | grep -c 'LLM_MODEL_ENSURE_BEFORE_CATALOG')" = 1 ] &&
     [ "$(grep -c '^CATALOG ' "$WORK/e13c.kubectl")" = 2 ] && printf '%s\n' "$out" | grep -qx 'rc=0'; then
    pass "E13 the catalog check and its warning run once per seed, not per pair"
  else
    fail "E13 once per seed: $(one_line "$out") calls=$(one_line "$(calls e13c)")"
  fi
  out="$(CATALOG_ANSWERS="EXIT1" run_case e13d "$NO_ROWS" -- LLM_ENSURE_CATALOG_DECISION=none LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'rc=1' && [ "$(writes e13d)" = 0 ]; then
    pass "E13 an unreadable llm_catalog_sync_runs fails before any write"
  else
    fail "E13 status failure: $(one_line "$out")"
  fi
  out="$(run_case e13e "$NO_ROWS" "$CREATED" -- LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED created zai/glm-5.1' && ! grep -q '^CATALOG ' "$WORK/e13e.kubectl"; then
    pass "E13 a catalog setup already saw live is not re-checked"
  else
    fail "E13 live skip: $(one_line "$out")"
  fi
  # A direct seed run (no decision from setup) on a reused DB whose latest run
  # is vendored but an older one was live: the shared rule answers live, so no
  # wait and no warning.
  out="$(CATALOG_ANSWERS="live" run_case e13f "$NO_ROWS" "$CREATED" -- LLM_ENSURE_CATALOG_DECISION= LLM_ENSURE_DB_FRESH=true -- ensure_llm_model_enabled zai glm-5.1)"
  if printf '%s\n' "$out" | grep -qx 'LLM_MODEL_ENSURED created zai/glm-5.1' &&
     ! printf '%s\n' "$out" | grep -Fq LLM_MODEL_ENSURE_BEFORE_CATALOG && [ ! -s "$WORK/e13f.sleep" ] &&
     [ "$(grep -c '^CATALOG ' "$WORK/e13f.kubectl")" = 1 ] &&
     grep -Fq "ORDER BY (source = 'live') DESC" "$WORK/e13f.kubectl.catalog-sql"; then
    pass "E13 an old live run behind a newer vendored one counts as decided (any live run): no wait, no warning"
  else
    fail "E13 old live + newer vendored: $(one_line "$out")"
  fi
}

assert_e16_seed_and_setup_share_one_catalog_rule() {
  local host_lib="${REPO_ROOT}/scripts/minikube/host-model.sh" shared="${REPO_ROOT}/scripts/minikube/llm-catalog-runs.sh"
  if grep -Fq 'llm_catalog_sync_source)' "$LIB" && grep -Fq 'llm_catalog_sync_source)' "$host_lib" &&
     [ "$(grep -l 'FROM llm_catalog_sync_runs' "$LIB" "$host_lib" "$shared" 2>/dev/null)" = "$shared" ] &&
     ! grep -Fq 'discovery/status' "$LIB"; then
    pass "E16 the seed and setup's 6f wait read the catalog through the one shared llm_catalog_sync_source"
  else
    fail "E16 the catalog rule is implemented more than once (or not shared)"
  fi
}

assert_e14_stub_replies_come_from_the_producer_golden() {
  if [ -r "$GOLDEN" ] &&
     [ "$(jq -r '.list.body | keys | join(",")' "$GOLDEN")" = rows ] &&
     [ "$(jq -r '[.list.body.rows[] | (.id|type), (.enabled|type)] | unique | join(",")' "$GOLDEN")" = "boolean,string" ] &&
     [ "$(jq -r '.create_conflict.status, .create_conflict.body.error, .create_configmap_write_failed.status, .create_configmap_write_failed.body.error' "$GOLDEN" | tr '\n' ' ')" = "409 conflict 503 configmap_write_failed " ]; then
    pass "E14 the golden carries rows[].id/enabled, 409 conflict and 503 configmap_write_failed"
  else
    fail "E14 the wire golden is missing or no longer has the shape the ensure reads"
  fi
}

assert_e15_requests_are_bounded() {
  local body
  body="$(awk '/^llm_ensure_request\(\) \{$/,/^\}$/' "$LIB")"
  if printf '%s\n' "$body" | grep -Fq -- '--max-time'; then
    pass "E15 every admin API request carries a curl --max-time"
  else
    fail "E15 llm_ensure_request has no --max-time"
  fi
}

assert_every_defined_case_is_invoked() {
  local defined invoked missing
  defined="$(grep -oE '^assert_[a-z_0-9]+\(\) \{' "$SELF" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_0-9]+$' "$SELF" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -n "$defined" ] && [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    # shellcheck disable=SC2086
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_e1_missing_row_is_created_with_a_post
assert_e2_disabled_row_on_a_fresh_db_is_enabled_with_a_put
assert_e3_disabled_row_on_a_reused_db_is_left_alone
assert_e4_enabled_row_is_a_no_op
assert_e5_post_conflict_rereads_and_enables
assert_e6_unexpected_statuses_fail
assert_e7_a_non_minikube_context_is_refused
assert_e8_reuse_respects_an_operator_removal
assert_e9_seed_pairs_by_profile
assert_e10_seed_ensures_after_login_and_before_grants
assert_e11_writes_go_through_the_api_only
assert_e12_setup_signal_admits_its_own_profile_only
assert_e13_catalog_is_rechecked_before_creating_rows
assert_e14_stub_replies_come_from_the_producer_golden
assert_e15_requests_are_bounded
assert_e16_seed_and_setup_share_one_catalog_rule
assert_every_defined_case_is_invoked

echo "SUMMARY: ${PASSED} passed, ${FAILED} failed"
if [ $((PASSED + FAILED)) -eq 0 ]; then
  echo "FAIL: no case ran"
  FAIL=1
fi
exit $FAIL
