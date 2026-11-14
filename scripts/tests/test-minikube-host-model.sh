#!/usr/bin/env bash
# Contract tests for scripts/minikube/host-model.sh: how full-setup.sh picks the
# Host model from .env, and how it proves the (provider, model) pair is an
# enabled llm_allowed_models row before it applies the Host.
#
# Hermetic: kubectl is a stub on PATH that records its argv and stdin, and
# every case runs in a subshell where only the variables it names are set, so
# API keys exported in the developer's shell cannot change the outcome.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="${REPO_ROOT}/scripts/tests/test-minikube-host-model.sh"
LIB="${REPO_ROOT}/scripts/minikube/host-model.sh"
ENSURE_LIB="${REPO_ROOT}/scripts/e2e/llm-model-ensure.sh"
FULL_SETUP="${REPO_ROOT}/scripts/minikube/full-setup.sh"
HOST_YAML="${REPO_ROOT}/deploy/overlays/minikube/instances/host.yaml"
REGISTRY="${REPO_ROOT}/mcp-host/src/llm/registryCore.ts"

FAIL=0
PASSED=0
FAILED=0

pass() { echo "PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "FAIL: $1"; FAIL=1; FAILED=$((FAILED + 1)); }

# The library reports through the caller's err/warn, as full-setup.sh defines
# them. These print plain prefixes the cases can match. Only the sourced
# library calls them, which shellcheck cannot see.
# shellcheck disable=SC2329
err()  { printf 'ERROR -- %s\n' "$*"; }
# shellcheck disable=SC2329
warn() { printf 'WARN -- %s\n' "$*"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# kubectl stub: appends one record per call (CALL, each argument on its own ARG
# line, then everything read from stdin between STDIN and END) to
# $KUBECTL_STUB_LOG, and answers as $KUBECTL_STUB_MODE says.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
{
  printf 'CALL\n'
  for arg in "$@"; do printf 'ARG %s\n' "$arg"; done
  printf 'STDIN\n'
  cat
  printf 'END\n'
} >>"${KUBECTL_STUB_LOG:?}"
case "${KUBECTL_STUB_MODE:?}" in
  t) printf 't\n' ;;
  f) printf 'f\n' ;;
  empty) ;;
  exit1) printf 'error: unable to upgrade connection\n' >&2; exit 1 ;;
  unexpected) printf 't\nt\n' ;;
  seq)
    # One answer line per call from $KUBECTL_STUB_SEQ; "EXIT1" fails the call.
    n="$(grep -c '^CALL$' "${KUBECTL_STUB_LOG}")"
    answer="$(sed -n "${n}p" "${KUBECTL_STUB_SEQ:?}")"
    if [ "$answer" = EXIT1 ]; then exit 1; fi
    if [ "$answer" != EMPTY ]; then printf '%s\n' "$answer"; fi
    ;;
  *) printf 'kubectl stub: unknown mode %s\n' "$KUBECTL_STUB_MODE" >&2; exit 2 ;;
esac
STUB
chmod +x "$WORK/bin/kubectl"
# sleep stub: records each wait so the cases run instantly.
cat >"$WORK/bin/sleep" <<'STUB'
#!/usr/bin/env bash
printf 'SLEEP %s\n' "$*" >>"${SLEEP_STUB_LOG:-/dev/null}"
STUB
chmod +x "$WORK/bin/sleep"

# run_case <stub-log> <stub-mode> [NAME=value ...] -- <command...>
# Runs the command in a subshell with the library sourced, the kubectl stub
# first on PATH, KC naming it with an explicit context, and only the given
# NAME=value assignments set. Prints the command's output, then one line
# "rc=<status> provider=<RESOLVED_PROVIDER> model=<RESOLVED_MODEL>".
run_case() {
  local stub_log="$1" stub_mode="$2"
  shift 2
  (
    set -u -o pipefail
    unset OPENAI_API_KEY CLAUDE_API_KEY ZAI_API_KEY BAILIAN_API_KEY \
      CLERUM_MODEL_PROVIDER CLERUM_MODEL_NAME RESOLVED_PROVIDER RESOLVED_MODEL \
      CLERUM_CATALOG_WAIT_SECONDS CLERUM_CATALOG_WAIT_INTERVAL_SECONDS CATALOG_DECISION
    export PATH="$WORK/bin:$PATH"
    export KUBECTL_STUB_LOG="$stub_log" KUBECTL_STUB_MODE="$stub_mode"
    # Scoped to this case's subshell on purpose.
    # shellcheck disable=SC2030
    export KC="kubectl --context=fixture"
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
      export "${1?}"
      shift
    done
    shift
    # shellcheck source=scripts/minikube/host-model.sh
    if ! source "$LIB"; then
      echo "LIB_NOT_SOURCED"
      exit 97
    fi
    if "$@"; then rc=0; else rc=$?; fi
    printf 'rc=%s provider=%s model=%s\n' "$rc" "${RESOLVED_PROVIDER:-}" "${RESOLVED_MODEL:-}"
  ) </dev/null 2>&1
}

# What full-setup.sh step 6f does before the Host heredoc. run_case invokes it
# inside the case's subshell, where resolve_host_model sets the two variables.
# shellcheck disable=SC2329,SC2031
resolve_then_check() {
  resolve_host_model || return $?
  assert_host_model_allowed "$RESOLVED_PROVIDER" "$RESOLVED_MODEL"
}

stub_calls() {
  if [ -f "$1" ]; then grep -c '^CALL$' "$1"; else echo 0; fi
}

stub_argv() {
  sed -n 's/^ARG //p' "$1" | tr '\n' ' ' | sed 's/ $//'
}

stub_stdin() {
  sed -n '/^STDIN$/,/^END$/p' "$1" | sed '1d;$d'
}

one_line() {
  printf '%s' "$1" | tr '\n' '|'
}

assert_h1_model_name_without_provider_is_refused() {
  local log="$WORK/h1.log" out refused=false
  out="$(run_case "$log" t CLERUM_MODEL_NAME=glm-4.7 OPENAI_API_KEY=sk-fixture -- resolve_then_check)"
  if printf '%s\n' "$out" | grep -Eq '^rc=[1-9]'; then
    pass "H1 a model name without a provider is refused (non-zero)"
  else
    fail "H1 a model name without a provider was accepted: $(one_line "$out")"
  fi
  # The refusal message is emitted by resolve_host_model itself and names both
  # variables. It is also the liveness witness for the negative check below.
  if printf '%s\n' "$out" | grep '^ERROR -- ' | grep -F 'CLERUM_MODEL_NAME' | grep -Fq 'CLERUM_MODEL_PROVIDER'; then
    refused=true
    pass "H1 the refusal names CLERUM_MODEL_NAME and CLERUM_MODEL_PROVIDER"
  else
    fail "H1 no refusal naming both variables: $(one_line "$out")"
  fi
  if [ "$refused" = true ] && [ "$(stub_calls "$log")" = 0 ]; then
    pass "H1 the catalog was never queried after the refusal"
  else
    fail "H1 refused=${refused}, catalog queries=$(stub_calls "$log") (expected a refusal and zero queries)"
  fi
}

assert_h2_no_key_defaults_to_openai_gpt_5_4_mini() {
  local out
  out="$(run_case "$WORK/h2.log" t -- resolve_host_model)"
  if printf '%s\n' "$out" | grep -qx 'rc=0 provider=openai model=gpt-5.4-mini'; then
    pass "H2 no API key resolves to openai/gpt-5.4-mini"
  else
    fail "H2 no API key did not resolve to openai/gpt-5.4-mini: $(one_line "$out")"
  fi
  if printf '%s\n' "$out" | grep '^WARN -- ' | grep -Fq 'will NOT reply'; then
    pass "H2 the no-key default warns that the agent will not reply"
  else
    fail "H2 the no-key default did not warn: $(one_line "$out")"
  fi
}

assert_h3_only_a_zai_key_selects_zai_and_its_default() {
  local out
  out="$(run_case "$WORK/h3.log" t ZAI_API_KEY=zai-fixture -- resolve_host_model)"
  if printf '%s\n' "$out" | grep -qx 'rc=0 provider=zai model=glm-5.1'; then
    pass "H3 only ZAI_API_KEY resolves to zai/glm-5.1"
  else
    fail "H3 only ZAI_API_KEY did not resolve to zai/glm-5.1: $(one_line "$out")"
  fi
}

assert_h4_explicit_provider_and_name_are_used_as_given() {
  local out
  out="$(run_case "$WORK/h4.log" t CLERUM_MODEL_PROVIDER=zai CLERUM_MODEL_NAME=glm-4.7 \
    OPENAI_API_KEY=sk-fixture -- resolve_host_model)"
  if printf '%s\n' "$out" | grep -qx 'rc=0 provider=zai model=glm-4.7'; then
    pass "H4 CLERUM_MODEL_PROVIDER + CLERUM_MODEL_NAME are used as given"
  else
    fail "H4 the explicit pair was not used as given: $(one_line "$out")"
  fi
  # A provider with no default in the library and no CLERUM_MODEL_NAME leaves
  # the model empty, which is refused rather than applied.
  out="$(run_case "$WORK/h4-empty.log" t CLERUM_MODEL_PROVIDER=groq GROQ_API_KEY=gsk-fixture -- resolve_host_model)"
  if printf '%s\n' "$out" | grep -Eq '^rc=[1-9]' &&
     printf '%s\n' "$out" | grep '^ERROR -- ' | grep -Fq 'CLERUM_MODEL_NAME'; then
    pass "H4 a provider without a known default and without CLERUM_MODEL_NAME is refused"
  else
    fail "H4 an empty model was not refused: $(one_line "$out")"
  fi
}

assert_h5_enabled_pair_passes_with_values_as_psql_variables() {
  local log="$WORK/h5.log" out expected_argv stdin
  out="$(run_case "$log" t -- assert_host_model_allowed zai glm-4.7)"
  if printf '%s\n' "$out" | grep -Eq '^rc=0 '; then
    pass "H5 an enabled pair (stub answers t) is accepted"
  else
    fail "H5 an enabled pair was refused: $(one_line "$out")"
  fi
  expected_argv='--context=fixture exec -i -n control-plane deployment/control-postgres -- psql -U postgres -d profiles -v ON_ERROR_STOP=1 -v provider=zai -v model=glm-4.7 -Atq -f -'
  if [ -f "$log" ] && [ "$(stub_calls "$log")" = 1 ] && [ "$(stub_argv "$log")" = "$expected_argv" ]; then
    pass "H5 control-postgres is queried once with provider/model as psql -v variables"
  else
    fail "H5 unexpected kubectl call: calls=$(stub_calls "$log") argv='$( [ -f "$log" ] && stub_argv "$log")'"
  fi
  stdin="$( [ -f "$log" ] && stub_stdin "$log")"
  # shellcheck disable=SC2016
  if printf '%s' "$stdin" | grep -Fq "provider = :'provider'" &&
     printf '%s' "$stdin" | grep -Fq "model = :'model'" &&
     printf '%s' "$stdin" | grep -Fq 'llm_allowed_models' &&
     ! printf '%s' "$stdin" | grep -Fq 'glm-4.7' &&
     ! printf '%s' "$stdin" | grep -Fq "'zai'"; then
    pass "H5 the SQL on stdin reads :'provider'/:'model' and carries no literal value"
  else
    fail "H5 the SQL on stdin does not use psql variables: '$(one_line "$stdin")'"
  fi
}

# One refusal case: the stub answers <mode>, the function must return non-zero
# with <code> in an ERROR line, after exactly one catalog query (the witness).
check_refusal() {
  local id="$1" mode="$2" code="$3" log="$WORK/$1-$2.log" out
  out="$(run_case "$log" "$mode" -- assert_host_model_allowed openai glm-4.7)"
  if printf '%s\n' "$out" | grep -Eq '^rc=[1-9]' &&
     printf '%s\n' "$out" | grep '^ERROR -- ' | grep -Fq "$code"; then
    pass "$id stub '$mode' is refused with $code"
  else
    fail "$id stub '$mode' was not refused with $code: $(one_line "$out")"
  fi
  if [ "$(stub_calls "$log")" = 1 ]; then
    pass "$id the catalog was queried exactly once for stub '$mode'"
  else
    fail "$id expected one catalog query for stub '$mode', saw $(stub_calls "$log")"
  fi
}

assert_h6_missing_row_is_host_model_unknown() {
  check_refusal H6 empty HOST_MODEL_UNKNOWN
}

assert_h7_disabled_row_is_host_model_disabled() {
  check_refusal H7 f HOST_MODEL_DISABLED
}

assert_h8_failed_or_unreadable_check_is_host_model_check_failed() {
  local log="$WORK/h8-no-kc.log" out refused=false
  check_refusal H8 exit1 HOST_MODEL_CHECK_FAILED
  check_refusal H8 unexpected HOST_MODEL_CHECK_FAILED
  # Without KC the query cannot name the profile's context. The refusal message
  # is the witness that the function ran and stopped before kubectl.
  out="$(run_case "$log" t KC= -- assert_host_model_allowed openai gpt-5.4-mini)"
  if printf '%s\n' "$out" | grep -Eq '^rc=[1-9]' &&
     printf '%s\n' "$out" | grep '^ERROR -- ' | grep -F 'HOST_MODEL_CHECK_FAILED' | grep -Fq 'KC'; then
    refused=true
    pass "H8 an unset KC is refused with HOST_MODEL_CHECK_FAILED"
  else
    fail "H8 an unset KC was not refused: $(one_line "$out")"
  fi
  if [ "$refused" = true ] && [ "$(stub_calls "$log")" = 0 ]; then
    pass "H8 no kubectl call is made without KC"
  else
    fail "H8 refused=${refused}, kubectl calls=$(stub_calls "$log") (expected a refusal and zero calls)"
  fi
}

assert_h9_full_setup_waits_classifies_and_checks_after_the_seed() {
  local source_line resolve_line wait_line state_line heredoc_line seed_line ensure_env_line assert_line
  local defer_line step10_line
  # shellcheck disable=SC2016
  source_line="$(grep -nF 'source "${SCRIPT_DIR}/host-model.sh"' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  resolve_line="$(grep -nE '^resolve_host_model \|\| exit 1$' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  wait_line="$(grep -nE '^wait_for_catalog_decision \|\| exit 1$' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  # shellcheck disable=SC2016
  state_line="$(grep -nE '^host_model_state "\$RESOLVED_PROVIDER" "\$RESOLVED_MODEL" \|\| exit 1$' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  heredoc_line="$(grep -nF 'cat <<HOSTEOF' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  step10_line="$(grep -nF 'step_header 10 ' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  # shellcheck disable=SC2016
  ensure_env_line="$(grep -nF 'LLM_ENSURE_HOST_MODEL="${RESOLVED_PROVIDER}/${RESOLVED_MODEL}"' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  # shellcheck disable=SC2016
  seed_line="$(grep -nF 'bash "${SCRIPT_DIR}/seed-test-data.sh"' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  # shellcheck disable=SC2016
  assert_line="$(grep -nE '^  assert_host_model_allowed "\$RESOLVED_PROVIDER" "\$RESOLVED_MODEL" \|\| exit 1$' "$FULL_SETUP" | tail -n 1 | cut -d: -f1)"
  if [ -n "$source_line" ] && [ -n "$resolve_line" ] && [ -n "$wait_line" ] && [ -n "$state_line" ] &&
     [ -n "$heredoc_line" ] && [ -n "$step10_line" ] && [ -n "$ensure_env_line" ] && [ -n "$seed_line" ] && [ -n "$assert_line" ] &&
     [ "$source_line" -lt "$resolve_line" ] && [ "$resolve_line" -lt "$wait_line" ] &&
     [ "$wait_line" -lt "$state_line" ] && [ "$state_line" -lt "$heredoc_line" ] &&
     [ "$heredoc_line" -lt "$step10_line" ] && [ "$step10_line" -lt "$ensure_env_line" ] &&
     [ "$ensure_env_line" -lt "$seed_line" ] && [ "$seed_line" -lt "$assert_line" ]; then
    pass "H9 full-setup resolves, waits for the catalog, classifies, hands the pair to the Step 10 seed, then checks"
  else
    fail "H9 order source=${source_line:-none} resolve=${resolve_line:-none} wait=${wait_line:-none} state=${state_line:-none} heredoc=${heredoc_line:-none} step10=${step10_line:-none} env=${ensure_env_line:-none} seed=${seed_line:-none} assert=${assert_line:-none}"
  fi
  # The hard check lives in the non-deferred branch of Step 10: the deferred
  # branch provisions nothing, so 6f only warns there.
  defer_line="$(awk -v s="${step10_line:-0}" 'NR > s && /^if \[ "\$DEFER_BOOTSTRAP_SEED" = true \]; then$/ {print NR; exit}' "$FULL_SETUP")"
  if [ -n "$defer_line" ] && [ -n "$assert_line" ] &&
     awk -v d="$defer_line" -v a="$assert_line" 'NR > d && NR < a && /^else$/ {found=1} END {exit !found}' "$FULL_SETUP" &&
     grep -Fq 'HOST_MODEL_PENDING' "$FULL_SETUP"; then
    pass "H9 the post-seed check runs only when Step 10 seeds; deferred setup warns HOST_MODEL_PENDING"
  else
    fail "H9 the post-seed check is not confined to the seeding branch (defer=${defer_line:-none} assert=${assert_line:-none})"
  fi
  # A reused DB keeps a disabled Host model disabled, so 6f fails there at once.
  # shellcheck disable=SC2016
  if awk '/^# 6f\./,/^cat <<HOSTEOF/' "$FULL_SETUP" |
     grep -A2 -F 'elif [ "$HOST_MODEL_STATE" = disabled ] && [ "$CONTROL_DB_CREATED_BY_RUN" != true ]; then' |
     grep -Fq 'assert_host_model_allowed "$RESOLVED_PROVIDER" "$RESOLVED_MODEL" || exit 1' &&
     grep -Fq 'LLM_ENSURE_DB_FRESH="${CONTROL_DB_CREATED_BY_RUN}"' "$FULL_SETUP"; then
    pass "H9 a disabled Host model on a reused DB fails at 6f; the seed learns whether the DB is fresh"
  else
    fail "H9 6f does not stop on a disabled Host model of a reused DB, or the seed is not told the DB freshness"
  fi
  if [ -n "$source_line" ] &&
     ! grep -Eq '^(resolve_model_provider|default_model_for_provider|resolve_host_model|host_model_state|assert_host_model_allowed|wait_for_catalog_decision)\(\)' "$FULL_SETUP"; then
    pass "H9 full-setup.sh keeps no inline copy of the host-model functions"
  else
    fail "H9 full-setup.sh still defines a host-model function inline (or does not source the library)"
  fi
}

# shellcheck disable=SC2329,SC2031
dismissed_of() { host_model_dismissed "$@" || return $?; printf 'dismissed=%s\n' "$HOST_MODEL_DISMISSED"; }
# shellcheck disable=SC2329,SC2031
state_of() { host_model_state "$@" || return $?; printf 'state=%s\n' "$HOST_MODEL_STATE"; }

assert_h12_host_model_state_classifies_the_row() {
  local mode expected out
  for mode in t:enabled f:disabled empty:unknown; do
    expected="${mode#*:}"
    out="$(run_case "$WORK/h12-${mode%%:*}.log" "${mode%%:*}" -- state_of zai glm-5.1)"
    if [ "$out" = "state=${expected}"$'\n'"rc=0 provider= model=" ]; then
      pass "H12 host_model_state prints ${expected} for stub '${mode%%:*}'"
    else
      fail "H12 stub '${mode%%:*}' expected ${expected}: $(one_line "$out")"
    fi
  done
  out="$(run_case "$WORK/h12-exit1.log" exit1 -- host_model_state zai glm-5.1)"
  if printf '%s\n' "$out" | grep -Eq 'rc=[1-9]' && printf '%s\n' "$out" | grep '^ERROR -- ' | grep -Fq HOST_MODEL_CHECK_FAILED; then
    pass "H12 host_model_state fails with HOST_MODEL_CHECK_FAILED when the query fails"
  else
    fail "H12 a failed query was not reported: $(one_line "$out")"
  fi
}

# wait_case <id> <answers...> -- [NAME=value ...]
# Runs wait_for_catalog_decision against the seq stub and prints its output,
# then "decision=<CATALOG_DECISION> calls=<n> sleeps=<n>".
wait_case() {
  local id="$1" log="$WORK/$1.log" seq="$WORK/$1.seq"
  shift
  : >"$seq"
  while [ "$1" != "--" ]; do printf '%s\n' "$1" >>"$seq"; shift; done
  shift
  rm -f "$log" "$WORK/$id.sleep"
  # shellcheck disable=SC2329,SC2031
  probe() { wait_for_catalog_decision; local rc=$?; printf 'decision=%s ' "${CATALOG_DECISION:-}"; return "$rc"; }
  KUBECTL_STUB_SEQ="$seq" SLEEP_STUB_LOG="$WORK/$id.sleep" run_case "$log" seq "$@" -- probe
  printf 'calls=%s sleeps=%s\n' "$(stub_calls "$log")" "$( [ -f "$WORK/$id.sleep" ] && wc -l <"$WORK/$id.sleep" | tr -d ' ' || echo 0)"
}

assert_h13_catalog_wait_returns_on_the_first_live_run() {
  local out stdin
  out="$(wait_case h13 EMPTY vendored live -- CLERUM_CATALOG_WAIT_SECONDS=60 CLERUM_CATALOG_WAIT_INTERVAL_SECONDS=5)"
  if printf '%s\n' "$out" | grep -q 'decision=live rc=0' && printf '%s\n' "$out" | grep -qx 'calls=3 sleeps=2' &&
     ! printf '%s\n' "$out" | grep -q '^WARN'; then
    pass "H13 the wait polls past none and vendored and returns live without a warning"
  else
    fail "H13 out=$(one_line "$out")"
  fi
  stdin="$(stub_stdin "$WORK/h13.log" | head -n 4)"
  # "Decided" means any live run, not the latest one: a reused DB can hold an
  # old live run behind a newer vendored one.
  if printf '%s' "$stdin" | grep -Fq 'FROM llm_catalog_sync_runs' &&
     printf '%s' "$stdin" | grep -Fq "ORDER BY (source = 'live') DESC" &&
     ! printf '%s' "$stdin" | grep -Eiq 'insert|update|delete'; then
    pass "H13 the wait only reads llm_catalog_sync_runs, ranking any live run first"
  else
    fail "H13 unexpected wait SQL: $(one_line "$stdin")"
  fi
}

assert_h14_vendored_only_warns_and_continues() {
  local out
  out="$(wait_case h14 vendored vendored vendored -- CLERUM_CATALOG_WAIT_SECONDS=10 CLERUM_CATALOG_WAIT_INTERVAL_SECONDS=5)"
  if printf '%s\n' "$out" | grep -q 'decision=vendored rc=0' && printf '%s\n' "$out" | grep -qx 'calls=3 sleeps=2' &&
     printf '%s\n' "$out" | grep '^WARN -- ' | grep -F CATALOG_SYNC_VENDORED_ONLY | grep -F models.dev | grep -Fq MODELS_DEV_API_URL; then
    pass "H14 a vendored-only catalog by the deadline warns (egress, MODELS_DEV_API_URL) and continues"
  else
    fail "H14 out=$(one_line "$out")"
  fi
}

assert_h15_no_run_by_the_deadline_warns_and_continues() {
  local out
  out="$(wait_case h15 EMPTY EMPTY -- CLERUM_CATALOG_WAIT_SECONDS=5 CLERUM_CATALOG_WAIT_INTERVAL_SECONDS=5)"
  if printf '%s\n' "$out" | grep -q 'decision=none rc=0' && printf '%s\n' "$out" | grep -qx 'calls=2 sleeps=1' &&
     printf '%s\n' "$out" | grep '^WARN -- ' | grep -Fq CATALOG_SYNC_PENDING; then
    pass "H15 no sync run by the deadline warns CATALOG_SYNC_PENDING and continues"
  else
    fail "H15 out=$(one_line "$out")"
  fi
  out="$(wait_case h15b EMPTY -- CLERUM_CATALOG_WAIT_SECONDS=0)"
  if printf '%s\n' "$out" | grep -q 'decision=none rc=0' && printf '%s\n' "$out" | grep -qx 'calls=1 sleeps=0'; then
    pass "H15 CLERUM_CATALOG_WAIT_SECONDS=0 probes once without waiting"
  else
    fail "H15 zero timeout: $(one_line "$out")"
  fi
}

assert_h20_catalog_wait_ignores_an_exported_control_api_ns() {
  local out argv
  # The seed honours CONTROL_API_NS; the setup's wait must keep querying the
  # namespace the rest of full-setup uses.
  out="$(wait_case h20 live -- CONTROL_API_NS=elsewhere CLERUM_CATALOG_WAIT_SECONDS=0)"
  argv="$(stub_argv "$WORK/h20.log")"
  if printf '%s\n' "$out" | grep -q 'decision=live rc=0' &&
     printf '%s' "$argv" | grep -Fq 'exec -i -n control-plane deployment/control-postgres' &&
     ! printf '%s' "$argv" | grep -Fq elsewhere; then
    pass "H20 the catalog wait queries control-plane even with CONTROL_API_NS exported"
  else
    fail "H20 out=$(one_line "$out") argv='$argv'"
  fi
}

assert_h16_catalog_wait_fails_on_a_broken_channel_or_bad_input() {
  local out
  out="$(wait_case h16 EXIT1 -- CLERUM_CATALOG_WAIT_SECONDS=30)"
  if printf '%s\n' "$out" | grep -Eq 'rc=[1-9]' && printf '%s\n' "$out" | grep '^ERROR -- ' | grep -Fq CATALOG_WAIT_CHECK_FAILED &&
     printf '%s\n' "$out" | grep -qx 'calls=1 sleeps=0'; then
    pass "H16 a failed llm_catalog_sync_runs query stops setup at once"
  else
    fail "H16 out=$(one_line "$out")"
  fi
  out="$(wait_case h16b live -- CLERUM_CATALOG_WAIT_SECONDS=soon)"
  if printf '%s\n' "$out" | grep -Eq 'rc=[1-9]' && printf '%s\n' "$out" | grep -qx 'calls=0 sleeps=0'; then
    pass "H16 a non-numeric CLERUM_CATALOG_WAIT_SECONDS is refused before any query"
  else
    fail "H16 bad timeout: $(one_line "$out")"
  fi
}

assert_h10_host_yaml_placeholder_is_openai_gpt_5_4_mini() {
  local model_block
  # The block under `model:` may carry comment lines; drop them and keep the
  # keys that follow.
  model_block="$(grep -A6 -E '^  model:$' "$HOST_YAML" | grep -vE '^ +#')"
  if printf '%s\n' "$model_block" | grep -qx '    provider: openai' &&
     printf '%s\n' "$model_block" | grep -qx '    name: gpt-5.4-mini'; then
    pass "H10 host.yaml placeholder is openai/gpt-5.4-mini"
  else
    fail "H10 host.yaml placeholder is not openai/gpt-5.4-mini: $(one_line "$model_block")"
  fi
}

assert_h17_host_model_dismissed_reads_the_tombstone() {
  local mode expected out
  for mode in t:true empty:false; do
    expected="${mode#*:}"
    out="$(run_case "$WORK/h17-${mode%%:*}.log" "${mode%%:*}" -- dismissed_of zai glm-5.1)"
    if printf '%s\n' "$out" | grep -qx "dismissed=${expected}" &&
       stub_stdin "$WORK/h17-${mode%%:*}.log" | grep -Fq "FROM llm_catalog_dismissed"; then
      pass "H17 host_model_dismissed is ${expected} for stub '${mode%%:*}'"
    else
      fail "H17 stub '${mode%%:*}': $(one_line "$out")"
    fi
  done
  out="$(run_case "$WORK/h17-exit1.log" exit1 -- dismissed_of zai glm-5.1)"
  if printf '%s\n' "$out" | grep -Eq 'rc=[1-9]' && printf '%s\n' "$out" | grep -Fq HOST_MODEL_CHECK_FAILED; then
    pass "H17 a failed tombstone query fails"
  else
    fail "H17 failed query: $(one_line "$out")"
  fi
}

# Runs full-setup's real 6f block (from "# 6f." to the Host heredoc) with the
# library calls stubbed: STATE is the Host model's allowlist state, FRESH the
# DB freshness, DEFER the seed deferral, DISMISSED the tombstone answer.
# Prints the block's output, then "rc=<status> calls=<stubbed calls>".
run_6f() {
  local block
  block="$(awk '/^# 6f\. /{s=1} s && /^cat <<HOSTEOF/{exit} s{print}' "$FULL_SETUP")"
  [ -n "$block" ] || { echo "NO_6F_BLOCK"; return; }
  (
    unset LLM_ENSURE_MINIKUBE_PROFILE
    export PROFILE="$1" HOST_MODEL_STATE_FIXTURE="$2" CONTROL_DB_CREATED_BY_RUN="$3" \
      DEFER_BOOTSTRAP_SEED="$4" DISMISSED_FIXTURE="$5"
    bash -c '
      source "$1"
      source "$3"
      calls=""
      log()  { echo "LOG $*"; }
      ok()   { echo "OK $*"; }
      warn() { echo "WARN $*"; }
      err()  { echo "ERR $*"; }
      resolve_host_model() { RESOLVED_PROVIDER=zai RESOLVED_MODEL=glm-5.1; }
      wait_for_catalog_decision() { CATALOG_DECISION=live; }
      host_model_state() { HOST_MODEL_STATE="$HOST_MODEL_STATE_FIXTURE"; }
      host_model_dismissed() { calls="$calls dismissed"; HOST_MODEL_DISMISSED="$DISMISSED_FIXTURE"; }
      assert_host_model_allowed() { calls="$calls assert"; err "HOST_MODEL_DISABLED"; return 1; }
      trap '"'"'echo "rc=$? calls=${calls# }"'"'"' EXIT
      eval "$2"
    ' _ "$ENSURE_LIB" "$block" "$LIB" 2>&1
  )
}

assert_h18_step_6f_decides_before_the_host_is_applied() {
  local out problems=""
  out="$(run_6f clerum-oauth19 enabled true false false)"
  printf '%s\n' "$out" | grep -qx 'rc=0 calls=' || problems+="enabled did not pass through: $(one_line "$out"); "
  # A profile name the seed's name check does not know still provisions: setup
  # hands the seed its own profile as the signal.
  out="$(run_6f clerum-oauth19 unknown true false false)"
  printf '%s\n' "$out" | grep -qx 'rc=0 calls=' && printf '%s\n' "$out" | grep -Fq 'Step 10 provisions' ||
    problems+="unknown on a fresh DB of clerum-oauth19 did not defer to Step 10: $(one_line "$out"); "
  out="$(run_6f clerum-test unknown false true false)"
  printf '%s\n' "$out" | grep -qx 'rc=0 calls=' && printf '%s\n' "$out" | grep -Fq HOST_MODEL_PENDING ||
    problems+="deferred seed did not only warn: $(one_line "$out"); "
  out="$(run_6f clerum-test disabled false false false)"
  printf '%s\n' "$out" | grep -qx 'rc=1 calls=assert' || problems+="reused disabled did not stop at 6f: $(one_line "$out"); "
  out="$(run_6f clerum-test disabled true false false)"
  printf '%s\n' "$out" | grep -qx 'rc=0 calls=' || problems+="fresh disabled did not defer to Step 10: $(one_line "$out"); "
  out="$(run_6f clerum-test unknown false false true)"
  printf '%s\n' "$out" | grep -qx 'rc=1 calls=dismissed' && printf '%s\n' "$out" | grep -Fq 'ERR HOST_MODEL_DISMISSED' ||
    problems+="reused tombstoned pair did not stop at 6f: $(one_line "$out"); "
  out="$(run_6f clerum-test unknown false false false)"
  printf '%s\n' "$out" | grep -qx 'rc=0 calls=dismissed' || problems+="reused missing pair did not defer to Step 10: $(one_line "$out"); "
  if [ -z "$problems" ]; then
    pass "H18 6f: enabled passes, missing/disabled defer to Step 10 on a fresh DB (any profile name), defer warns, reused disabled or tombstoned stops"
  else
    fail "H18 $problems"
  fi
}

assert_h19_seed_output_keeps_every_model_line_visible() {
  local block
  block="$(awk '/^  SEED_OUTPUT_FILE=/{s=1} s{print} s && /rm -f "\$SEED_OUTPUT_FILE"/{exit}' "$FULL_SETUP")"
  # shellcheck disable=SC2016
  if printf '%s\n' "$block" | grep -Fq 'bash "${SCRIPT_DIR}/seed-test-data.sh" >"$SEED_OUTPUT_FILE" 2>&1' &&
     printf '%s\n' "$block" | grep -Fq "grep 'LLM_MODEL_ENSURE' \"\$SEED_OUTPUT_FILE\"" &&
     ! grep -Fq 'seed-test-data.sh" 2>&1 | tail' "$FULL_SETUP"; then
    pass "H19 the seed's LLM_MODEL_ENSURE lines are printed in full, not cut by tail -15"
  else
    fail "H19 the seed output is still truncated before the LLM_MODEL_ENSURE lines are shown"
  fi
  # shellcheck disable=SC2016
  if grep -Fq 'LLM_ENSURE_MINIKUBE_PROFILE="${LLM_ENSURE_MINIKUBE_PROFILE}"' "$FULL_SETUP" &&
     grep -Fq 'LLM_ENSURE_CATALOG_DECISION="${CATALOG_DECISION}"' "$FULL_SETUP"; then
    pass "H19 the seed receives setup's profile signal and catalog decision"
  else
    fail "H19 the seed is not given the profile signal or the catalog decision"
  fi
}

registry_default_model() {
  grep -A4 -E "^  $1: \\{" "$REGISTRY" | grep -oE "defaultModel: '[^']+'" | head -n 1 |
    sed -E "s/^defaultModel: '(.*)'$/\\1/"
}

assert_h11_default_models_match_the_mcp_host_registry() {
  local registry_provider registry_value library_value
  for registry_provider in openai claude zai bailian; do
    registry_value="$(registry_default_model "$registry_provider")"
    # shellcheck source=scripts/minikube/host-model.sh
    library_value="$( (source "$LIB" && default_model_for_provider "$registry_provider") 2>/dev/null)"
    if [ -n "$registry_value" ] && [ "$library_value" = "$registry_value" ]; then
      pass "H11 default_model_for_provider $registry_provider = registryCore.ts ($registry_value)"
    else
      fail "H11 $registry_provider: library '${library_value}' vs registryCore.ts '${registry_value}'"
    fi
  done
}

# The guard that keeps this file honest: a case defined but never added to the
# call block below reports nothing at all, which reads as a green run.
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

assert_h1_model_name_without_provider_is_refused
assert_h2_no_key_defaults_to_openai_gpt_5_4_mini
assert_h3_only_a_zai_key_selects_zai_and_its_default
assert_h4_explicit_provider_and_name_are_used_as_given
assert_h5_enabled_pair_passes_with_values_as_psql_variables
assert_h6_missing_row_is_host_model_unknown
assert_h7_disabled_row_is_host_model_disabled
assert_h8_failed_or_unreadable_check_is_host_model_check_failed
assert_h9_full_setup_waits_classifies_and_checks_after_the_seed
assert_h10_host_yaml_placeholder_is_openai_gpt_5_4_mini
assert_h11_default_models_match_the_mcp_host_registry
assert_h12_host_model_state_classifies_the_row
assert_h13_catalog_wait_returns_on_the_first_live_run
assert_h14_vendored_only_warns_and_continues
assert_h15_no_run_by_the_deadline_warns_and_continues
assert_h16_catalog_wait_fails_on_a_broken_channel_or_bad_input
assert_h17_host_model_dismissed_reads_the_tombstone
assert_h18_step_6f_decides_before_the_host_is_applied
assert_h19_seed_output_keeps_every_model_line_visible
assert_h20_catalog_wait_ignores_an_exported_control_api_ns
assert_every_defined_case_is_invoked

echo "SUMMARY: ${PASSED} passed, ${FAILED} failed"
if [ $((PASSED + FAILED)) -eq 0 ]; then
  echo "FAIL: no case ran"
  FAIL=1
fi
exit $FAIL
