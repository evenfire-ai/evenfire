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
  *) printf 'kubectl stub: unknown mode %s\n' "$KUBECTL_STUB_MODE" >&2; exit 2 ;;
esac
STUB
chmod +x "$WORK/bin/kubectl"

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
      CLERUM_MODEL_PROVIDER CLERUM_MODEL_NAME RESOLVED_PROVIDER RESOLVED_MODEL
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

assert_h9_full_setup_sources_the_library_and_checks_before_the_host() {
  local source_line resolve_line assert_line heredoc_line
  # shellcheck disable=SC2016
  source_line="$(grep -nF 'source "${SCRIPT_DIR}/host-model.sh"' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  resolve_line="$(grep -nE '^resolve_host_model \|\| exit 1$' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  # shellcheck disable=SC2016
  assert_line="$(grep -nE '^assert_host_model_allowed "\$RESOLVED_PROVIDER" "\$RESOLVED_MODEL" \|\| exit 1$' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  heredoc_line="$(grep -nF 'cat <<HOSTEOF' "$FULL_SETUP" | head -n 1 | cut -d: -f1)"
  if [ -n "$source_line" ] && [ -n "$resolve_line" ] && [ -n "$assert_line" ] && [ -n "$heredoc_line" ] &&
     [ "$source_line" -lt "$resolve_line" ] && [ "$resolve_line" -lt "$assert_line" ] &&
     [ "$assert_line" -lt "$heredoc_line" ]; then
    pass "H9 full-setup.sh sources host-model.sh, resolves, then checks before the Host heredoc"
  else
    fail "H9 order source=${source_line:-none} resolve=${resolve_line:-none} assert=${assert_line:-none} heredoc=${heredoc_line:-none}"
  fi
  # The positive source line above is the witness that this grep reads the
  # right file.
  if [ -n "$source_line" ] &&
     ! grep -Eq '^(resolve_model_provider|default_model_for_provider|resolve_host_model|assert_host_model_allowed)\(\)' "$FULL_SETUP"; then
    pass "H9 full-setup.sh keeps no inline copy of the host-model functions"
  else
    fail "H9 full-setup.sh still defines a host-model function inline (or does not source the library)"
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
assert_h9_full_setup_sources_the_library_and_checks_before_the_host
assert_h10_host_yaml_placeholder_is_openai_gpt_5_4_mini
assert_h11_default_models_match_the_mcp_host_registry
assert_every_defined_case_is_invoked

echo "SUMMARY: ${PASSED} passed, ${FAILED} failed"
if [ $((PASSED + FAILED)) -eq 0 ]; then
  echo "FAIL: no case ran"
  FAIL=1
fi
exit $FAIL
