#!/bin/bash
# Clusterless contract tests for scripts/ops/egress-proxy-value-preflight.sh.
#
# Every Kubernetes response and every fixture value is synthetic. A `kubectl`
# stub on PATH serves fixture JSON; an `awk` wrapper earlier on PATH records the
# names (never the values) of the environment the preflight hands to the check
# and then execs the real awk. Every negative assertion has a witness from the
# same run: the verdict line, the check's message line, the recorded invocation,
# or the direct run of the same check.
#
# The assertions that depend on the sibling change to nginx-egress-proxy/
# egress-proxy-template-check and on the new shared corpus (spec §3 and §5.5)
# always run: this checkout carries the check, the corpus and the HCC/image name
# lists, so a missing input is a hard failure, never a skip.
# EGRESS_PREFLIGHT_INTEGRATION stays accepted for callers that set it and
# selects the same run.
#
# shellcheck disable=SC2016 # templates, URLs and values are literal fixtures.
set -u
set -o pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
SCRIPT="$ROOT/scripts/ops/egress-proxy-value-preflight.sh"
CHECK="$ROOT/nginx-egress-proxy/egress-proxy-template-check"
CORPUS="$ROOT/nginx-egress-proxy/egress-proxy-value-corpus.tsv"
HCC="$ROOT/host-context-controller/src/reconciler.ts"
ENTRYPOINT="$ROOT/nginx-egress-proxy/egress-proxy-entrypoint"
REAL_AWK=$(command -v awk)

# No assertion is ever PENDING: the old gate let the default run exit 0 with
# three assertions skipped. 0 and 1 are both accepted so an existing invocation
# cannot reintroduce the skip; any other value is a caller typo.
case "${EGRESS_PREFLIGHT_INTEGRATION:-1}" in
  0 | 1) ;;
  *)
    printf 'FAIL EGRESS_PREFLIGHT_INTEGRATION must be 0 or 1 (got %s)\n' \
      "$EGRESS_PREFLIGHT_INTEGRATION"
    exit 2
    ;;
esac

TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/egress-value-preflight-test.XXXXXXXX") || exit 2
trap 'rm -rf -- "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/bin" "$TEST_DIR/fixtures"
export FIXTURE_ROOT="$TEST_DIR/fixtures"
export CONTEXT=fixture-context NAMESPACE=fixture-namespace
export PATH="$TEST_DIR/bin:$PATH"

cat >"$TEST_DIR/bin/kubectl" <<'STUB'
#!/bin/bash
set -u
context=''; namespace=''; kind=''; name=''
while [ "$#" -gt 0 ]; do
  case $1 in
    --context) context=${2:-}; shift 2 ;;
    --context=*) context=${1#*=}; shift ;;
    -n|--namespace) namespace=${2:-}; shift 2 ;;
    --namespace=*) namespace=${1#*=}; shift ;;
    -o|--output) shift 2 ;;
    -o=*|--output=*) shift ;;
    --ignore-not-found|--ignore-not-found=true) shift ;;
    get)
      kind=${2:-}; shift 2
      if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then name=$1; shift; fi
      ;;
    *) exit 2 ;;
  esac
done
[ "$context" = fixture-context ] && [ "$namespace" = fixture-namespace ] && [ -n "$kind" ] || exit 2
[ ! -e "$FIXTURE_ROOT/fail-kubectl" ] || exit 1
case $kind in
  mcpservers|mcpservers.clerum.io) file="$FIXTURE_ROOT/servers.json" ;;
  configmap|configmaps) file="$FIXTURE_ROOT/configmap-$name.json" ;;
  deployment|deployments) file="$FIXTURE_ROOT/deployment-$name.json" ;;
  secret|secrets) file="$FIXTURE_ROOT/secret-$name.json" ;;
  *) exit 2 ;;
esac
[ ! -f "$file" ] || cat "$file"
STUB
chmod +x "$TEST_DIR/bin/kubectl"

# The wrapper records names only, and uses no external command: the child that
# runs the check is `env -i`, so it has no PATH.
{
  printf '#!/bin/bash\n'
  printf 'if [ -e %q ]; then exit 1; fi\n' "$TEST_DIR/no-verdict"
  printf 'epvp_seen_line=""\n'
  printf 'for epvp_seen_name in $(compgen -e); do epvp_seen_line="$epvp_seen_line $epvp_seen_name"; done\n'
  printf 'printf "%%s\\n" "$epvp_seen_line" >> %q\n' "$TEST_DIR/awk-names"
  printf 'exec %q "$@"\n' "$REAL_AWK"
} >"$TEST_DIR/bin/awk"
chmod +x "$TEST_DIR/bin/awk"

passed=0
failed=0
pending=0
all_output="$TEST_DIR/all-output"
: >"$all_output"

pass() { printf 'PASS %s\n' "$*"; passed=$((passed + 1)); }
fail() { printf 'FAIL %s\n' "$*"; failed=$((failed + 1)); }

reset_fixture() {
  rm -f -- "$FIXTURE_ROOT"/* "$TEST_DIR/awk-names" "$TEST_DIR/no-verdict"
  printf '{"items":[]}\n' >"$FIXTURE_ROOT/servers.json"
}

# add_server NAME URL TEMPLATE ENV_JSON [HEADERS_JSON]
add_server() {
  local name=$1 url=$2 template=$3 env_json=$4 headers=${5:-[]}
  jq --arg n "$name" --arg u "$url" --argjson h "$headers" \
    '.items += [{metadata:{name:$n},spec:{remote:{baseUrl:$u,authHeaders:$h}}}]' \
    "$FIXTURE_ROOT/servers.json" >"$TEST_DIR/servers-next"
  mv "$TEST_DIR/servers-next" "$FIXTURE_ROOT/servers.json"
  jq -n --arg t "$template" '{data:{"default.conf.template":$t}}' \
    >"$FIXTURE_ROOT/configmap-$name-nginx-conf.json"
  jq -n --argjson e "$env_json" \
    '{spec:{template:{spec:{containers:[{name:"egress-proxy",env:$e}]}}}}' \
    >"$FIXTURE_ROOT/deployment-$name.json"
}

set_server_flag() { # NAME KEY VALUE(json: true|false)
  jq --arg n "$1" --arg k "$2" --argjson v "$3" \
    '(.items[] | select(.metadata.name == $n) | .spec[$k]) = $v' \
    "$FIXTURE_ROOT/servers.json" >"$TEST_DIR/servers-next"
  mv "$TEST_DIR/servers-next" "$FIXTURE_ROOT/servers.json"
}

literal() { jq -cn --arg n "$1" --arg v "$2" '[{name:$n,value:$v}]'; }
secret_ref() { jq -cn --arg n "$1" '[{name:$n,valueFrom:{secretKeyRef:{name:"fixture-secret",key:"credential"}}}]'; }

# secret_bytes PRINTF_B_FORMAT: the fixture Secret holds exactly those bytes.
secret_bytes() {
  local encoded
  encoded=$(printf '%b' "$1" | base64 | tr -d '\n')
  jq -n --arg v "$encoded" '{data:{credential:$v}}' \
    >"$FIXTURE_ROOT/secret-fixture-secret.json"
}

run_case() { # LABEL EXPECTED_RC WITNESS [EXECUTABLE]
  local label=$1 expected=$2 witness=$3 executable=${4:-$SCRIPT} rc
  "$executable" >"$TEST_DIR/output" 2>&1
  rc=$?
  cat "$TEST_DIR/output" >>"$all_output"
  if [ "$rc" -eq "$expected" ] && grep -Fq -- "$witness" "$TEST_DIR/output"; then
    pass "$label"
  else
    fail "$label (exit=$rc expected=$expected witness=$witness)"
  fi
}

expect_output() { # LABEL TEXT
  if grep -Fq -- "$2" "$TEST_DIR/output"; then
    pass "$1"
  else
    fail "$1 (missing witness: $2)"
  fi
}

# Negative assertion. Call only after the same case's run_case witness passed.
expect_absent() { # LABEL TEXT
  if grep -Fq -- "$2" "$TEST_DIR/output"; then
    fail "$1 (unexpected text: $2)"
  else
    pass "$1"
  fi
}

count_lines() { # FILE TEXT
  grep -Fc -- "$2" "$1" 2>/dev/null || true
}

# The awk wrapper records one line per invocation, holding the names (never the
# values) of its environment. Only the `env -i` child that runs the check lacks
# CONTEXT, so this reports whether exactly that child saw NAME.
check_ran_with() { # NAME -> yes|no
  LC_ALL=C "$REAL_AWK" -v n="$1" '
    {
      seen = 0; context = 0
      for (i = 1; i <= NF; i++) {
        if ($i == n) seen = 1
        if ($i == "CONTEXT") context = 1
      }
      if (seen) { total++; if (!context) clean++ }
    }
    END { print (total == 1 && clean == 1) ? "yes" : "no" }' \
    "$TEST_DIR/awk-names" 2>/dev/null || printf 'no\n'
}

# What the live check itself decides for a template and one literal value. Used
# to prove the preflight delegates to the check instead of re-implementing a
# class, without pinning either the old or the new check's verdict.
direct_verdict() { # TEMPLATE PRINTF_B_FORMAT_VALUE
  local value rc
  printf '%s' "$1" >"$TEST_DIR/direct-template"
  value=$(printf '%b' "$2"; printf x)
  value=${value%x}
  LC_ALL=C API_KEY="$value" "$REAL_AWK" -f "$CHECK" "$TEST_DIR/direct-template" \
    >/dev/null 2>&1
  rc=$?
  case $rc in
    0) printf 'OK' ;;
    1) printf 'REJECT' ;;
    *) printf 'ERROR' ;;
  esac
}

if [ ! -x "$SCRIPT" ] || [ ! -r "$CHECK" ]; then
  printf 'FAIL required preflight script or checker is missing\n'
  exit 1
fi

# --- CLEAN ----------------------------------------------------------------
reset_fixture
add_server clean 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY 'TESTKEY-CLEAN-9482')"
run_case clean 0 'server=fixture-namespace/clean verdict=OK'
expect_output clean-summary 'VERDICT=CLEAN checked=1 ok=1 rejected=0 inconclusive=0'

# --- REJECT from the check ------------------------------------------------
reset_fixture
add_server query 'https://example.com/mcp?q=${API_KEY}' \
  'proxy_pass https://example.com/mcp?q=${API_KEY};' "$(secret_ref API_KEY)"
secret_bytes 'TESTKEY-B64/def+gh=='
run_case query-reject 1 'server=fixture-namespace/query verdict=REJECT'
expect_output query-reject-witness 'the value of API_KEY is not allowed in'
expect_output query-reject-summary 'VERDICT=VALUES_REJECTED checked=1 ok=0 rejected=1'

reset_fixture
add_server header 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(secret_ref API_KEY)"
secret_bytes 'TESTKEY-TRAIL\0012'
run_case trailing-newline 1 'server=fixture-namespace/header verdict=REJECT'
expect_output trailing-newline-witness 'the value of API_KEY is not allowed in a quoted string'

# B1: an invalid byte before CRLF. Every check generation rejects the CR/LF.
secret_bytes 'TESTKEY-FFB1\0377\0015\0012'
run_case invalid-byte-crlf 1 'server=fixture-namespace/header verdict=REJECT'
expect_output invalid-byte-crlf-witness 'the value of API_KEY is not allowed in a quoted string'

# B1: bytes >= 0x80 are obs-text in a header value and are accepted. Both the
# [[:cntrl:]] rule under LC_ALL=C and the byte-wise rule accept this value, so
# the assertion executes in every run and is not class-dependent.
secret_bytes 'TESTKEY-U2028\0342\0200\0250b'
run_case quoted-obs-text-accept 0 'server=fixture-namespace/header verdict=OK'
expect_output quoted-obs-text-summary 'VERDICT=CLEAN'

# The preflight must report what the live check decides, not a class of its own.
reset_fixture
faithful_template='proxy_pass https://example.com/mcp?q=${API_KEY};'
add_server faithful 'https://example.com/mcp?q=${API_KEY}' "$faithful_template" \
  "$(secret_ref API_KEY)"
secret_bytes 'TESTKEY-B64/def%2Bgh=='
expected=$(direct_verdict "$faithful_template" 'TESTKEY-B64/def%2Bgh==')
"$SCRIPT" >"$TEST_DIR/output" 2>&1
faithful_rc=$?
cat "$TEST_DIR/output" >>"$all_output"
case $expected in
  OK) faithful_want=0 ;;
  REJECT) faithful_want=1 ;;
  *) faithful_want=2 ;;
esac
if [ "$faithful_rc" -eq "$faithful_want" ] &&
  grep -Fq "server=fixture-namespace/faithful verdict=$expected" "$TEST_DIR/output"; then
  pass "check-faithful-delegation ($expected)"
else
  fail "check-faithful-delegation (exit=$faithful_rc expected=$faithful_want verdict=$expected)"
fi

# --- static S1 ------------------------------------------------------------
reset_fixture
add_server static 'https://mcp.example.com/mcp?q=TESTKEY-QLIT\c' 'return 200 ok;' '[]'
run_case literal-backslash 1 'server=fixture-namespace/static verdict=REJECT'
expect_output literal-backslash-witness 'static: S1'
expect_absent literal-query-not-printed 'TESTKEY-QLIT'

reset_fixture
add_server staticpath 'https://mcp.example.com/TESTKEY-PATH;segment' 'return 200 ok;' '[]'
run_case literal-path-semicolon 1 'server=fixture-namespace/staticpath verdict=REJECT'
expect_output literal-path-witness 'static: S1'
expect_absent literal-path-not-printed 'TESTKEY-PATH'

# --- static S2 ------------------------------------------------------------
reset_fixture
headers='[{"header":"X-Api-Key","valueTemplate":"${NGINX_ENVSUBST_FILTER}"}]'
add_server reserved 'https://mcp.example.com/mcp?q=${PATH}' 'return 200 ok;' '[]' "$headers"
run_case reserved-static 1 'server=fixture-namespace/reserved verdict=REJECT'
expect_output reserved-query-witness 'static: S2 query placeholder PATH'
expect_output reserved-header-witness \
  'static: S2 authHeader X-Api-Key references reserved name NGINX_ENVSUBST_FILTER'

# --- referenced names only ------------------------------------------------
reset_fixture
envs=$(jq -cn '[{name:"LD_PRELOAD",value:"TESTKEY-UNREFERENCED"},
  {name:"API_KEY",value:"TESTKEY-CLEAN-9482"}]')
add_server onlyrefs 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' "$envs"
run_case only-referenced 0 'server=fixture-namespace/onlyrefs verdict=OK'
if grep -F ' API_KEY ' "$TEST_DIR/awk-names" | grep -Fq ' LC_ALL ' &&
  ! grep -F ' API_KEY ' "$TEST_DIR/awk-names" | grep -Fq ' CONTEXT ' &&
  ! grep -Fq ' LD_PRELOAD ' "$TEST_DIR/awk-names"; then
  pass only-referenced-environment
else
  fail 'only-referenced-environment (LC_ALL/API_KEY missing or LD_PRELOAD exported)'
fi

# --- duplicate env entries: the last one wins ----------------------------
# Kubernetes keeps the last entry of a duplicated env name, and HCC builds the
# same last-wins Map (reconciler.ts:1407). A first-wins lookup calls this server
# CLEAN while the pod and the new HCC run the rejected value.
reset_fixture
envs=$(jq -cn '[{name:"API_KEY",value:"TESTKEY-CLEAN-9482"},
  {name:"API_KEY",value:"TESTKEY-TRAIL\u0001x"}]')
add_server dup-last-invalid 'https://example.com/mcp' \
  'proxy_set_header X-Key "${API_KEY}";' "$envs"
run_case duplicate-env-last-invalid 1 \
  'server=fixture-namespace/dup-last-invalid verdict=REJECT'
expect_output duplicate-env-last-invalid-witness \
  'the value of API_KEY is not allowed in a quoted string'
if [ "$(check_ran_with API_KEY)" = yes ]; then
  pass duplicate-env-last-invalid-resolution
else
  fail 'duplicate-env-last-invalid-resolution (no single check run saw API_KEY)'
fi

# Reverse order: the rejected value is the first entry and the valid one is
# last, so only a last-wins lookup reports OK.
reset_fixture
envs=$(jq -cn '[{name:"API_KEY",value:"TESTKEY-TRAIL\u0001x"},
  {name:"API_KEY",value:"TESTKEY-CLEAN-9482"}]')
add_server dup-last-valid 'https://example.com/mcp' \
  'proxy_set_header X-Key "${API_KEY}";' "$envs"
run_case duplicate-env-last-valid 0 \
  'server=fixture-namespace/dup-last-valid verdict=OK'
expect_output duplicate-env-last-valid-summary \
  'VERDICT=CLEAN checked=1 ok=1 rejected=0 inconclusive=0'
if [ "$(check_ran_with API_KEY)" = yes ]; then
  pass duplicate-env-last-valid-resolution
else
  fail 'duplicate-env-last-valid-resolution (no single check run saw API_KEY)'
fi

# --- unsafe-env-name ------------------------------------------------------
reset_fixture
add_server unsafe 'https://example.com/mcp' 'proxy_set_header X-Key "${LD_PRELOAD}";' \
  "$(literal LD_PRELOAD 'TESTKEY-LOADER')"
add_server internal 'https://example.com/mcp' 'proxy_set_header X-Key "${epvp_i}";' \
  "$(literal epvp_i 'TESTKEY-INTERNAL')"
add_server witness 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY 'TESTKEY-CLEAN-9482')"
run_case unsafe-env-name 3 \
  'server=fixture-namespace/unsafe verdict=INCONCLUSIVE reason=unsafe-env-name name=LD_PRELOAD'
expect_output unsafe-internal-name \
  'server=fixture-namespace/internal verdict=INCONCLUSIVE reason=unsafe-env-name name=epvp_i'
expect_output unsafe-witness 'server=fixture-namespace/witness verdict=OK'
# The child that runs the check is `env -i`, so its record line has no CONTEXT;
# the preflight's own awk runs inherit CONTEXT. Exactly one such invocation
# exists: the witness server. The two unsafe servers never reach the check.
if [ "$(grep -Fvc ' CONTEXT ' "$TEST_DIR/awk-names" || true)" -eq 1 ] &&
  [ "$(count_lines "$TEST_DIR/awk-names" ' API_KEY ')" -eq 1 ] &&
  ! grep -Fq ' LD_PRELOAD ' "$TEST_DIR/awk-names" &&
  ! grep -Fq ' epvp_i ' "$TEST_DIR/awk-names"; then
  pass unsafe-not-exported
else
  fail 'unsafe-not-exported (check ran for an unsafe name or a reserved name was exported)'
fi

# --- dependent-env-reference ---------------------------------------------
reset_fixture
add_server dependent 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY '$(TESTKEY_OTHER)')"
run_case dependent-env-reference 3 \
  'server=fixture-namespace/dependent verdict=INCONCLUSIVE reason=dependent-env-reference name=API_KEY'
expect_output dependent-advice 'advice: Kubernetes expands $(NAME)'

# --- unsupported value sources -------------------------------------------
reset_fixture
envs=$(jq -cn '[{name:"API_KEY",valueFrom:{configMapKeyRef:{name:"fixture",key:"key"}}}]')
add_server unsupported 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' "$envs"
run_case unsupported-source 3 'reason=unsupported-value-source name=API_KEY'
expect_output unsupported-source-witness \
  'server=fixture-namespace/unsupported verdict=INCONCLUSIVE'

reset_fixture
add_server envfrom 'https://example.com/mcp' 'return 200 ok;' '[]'
jq '.spec.template.spec.containers[0].envFrom=[{configMapRef:{name:"fixture"}}]' \
  "$FIXTURE_ROOT/deployment-envfrom.json" >"$TEST_DIR/next"
mv "$TEST_DIR/next" "$FIXTURE_ROOT/deployment-envfrom.json"
run_case unsupported-envfrom 3 'reason=unsupported-value-source'
expect_output unsupported-envfrom-witness \
  'server=fixture-namespace/envfrom verdict=INCONCLUSIVE'

# --- other INCONCLUSIVE --------------------------------------------------
reset_fixture
add_server missingcm 'https://example.com/mcp' 'return 200 ok;' '[]'
rm -f "$FIXTURE_ROOT/configmap-missingcm-nginx-conf.json"
run_case missing-configmap 3 \
  'server=fixture-namespace/missingcm verdict=INCONCLUSIVE reason=no-configmap'

reset_fixture
add_server missingdeploy 'https://example.com/mcp' 'return 200 ok;' '[]'
rm -f "$FIXTURE_ROOT/deployment-missingdeploy.json"
run_case missing-deployment 3 \
  'server=fixture-namespace/missingdeploy verdict=INCONCLUSIVE reason=no-deployment'

reset_fixture
add_server missingsecret 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(secret_ref API_KEY)"
run_case missing-secret 3 \
  'server=fixture-namespace/missingsecret verdict=INCONCLUSIVE reason=secret-unreadable name=API_KEY'
printf '{"data":{}}\n' >"$FIXTURE_ROOT/secret-fixture-secret.json"
run_case missing-key 3 \
  'server=fixture-namespace/missingsecret verdict=INCONCLUSIVE reason=secret-unreadable name=API_KEY'
expect_output missing-key-summary 'VERDICT=INCONCLUSIVE checked=1 ok=0 rejected=0 inconclusive=1'

# --- no remote servers, kubectl failure, no-verdict child ----------------
reset_fixture
add_server disabled 'https://example.com/mcp' 'return 200 ok;' '[]'
set_server_flag disabled enabled false
add_server foreign 'https://example.com/mcp' 'return 200 ok;' '[]'
set_server_flag foreign managed false
run_case no-remote 4 'VERDICT=NO_REMOTE_SERVERS'

reset_fixture
: >"$FIXTURE_ROOT/fail-kubectl"
run_case kubectl-failure 2 'VERDICT=ERROR'
rm -f "$FIXTURE_ROOT/fail-kubectl"

# Usage: both variables are required, and a missing one is ERROR (exit 2), not
# a shell error or a silent default.
(
  unset CONTEXT
  "$SCRIPT"
) >"$TEST_DIR/output" 2>&1
usage_rc=$?
cat "$TEST_DIR/output" >>"$all_output"
if [ "$usage_rc" -eq 2 ] && grep -Fq 'VERDICT=ERROR' "$TEST_DIR/output"; then
  pass missing-context
else
  fail "missing-context (exit=$usage_rc)"
fi
(
  unset NAMESPACE
  "$SCRIPT"
) >"$TEST_DIR/output" 2>&1
usage_rc=$?
cat "$TEST_DIR/output" >>"$all_output"
if [ "$usage_rc" -eq 2 ] && grep -Fq 'VERDICT=ERROR' "$TEST_DIR/output"; then
  pass missing-namespace
else
  fail "missing-namespace (exit=$usage_rc)"
fi

reset_fixture
add_server noverdict 'https://example.com/mcp' 'return 200 ok;' '[]'
: >"$TEST_DIR/no-verdict"
run_case no-verdict-child 2 'VERDICT=ERROR'
expect_output no-verdict-server 'fixture-namespace/noverdict'

# --- m10 positive control: the no-value scan must catch a leaking copy -----
anchor='# resolved: value of one referenced name'
anchor_count=$(grep -Fc -- "$anchor" "$SCRIPT" 2>/dev/null || true)
if [ "$anchor_count" -ne 1 ]; then
  fail "m10-anchor (anchor count=$anchor_count, expected 1)"
else
  mkdir -p "$TEST_DIR/mutant/scripts/ops" "$TEST_DIR/mutant/nginx-egress-proxy"
  cp "$CHECK" "$TEST_DIR/mutant/nginx-egress-proxy/egress-proxy-template-check"
  inject='    echo "$epvp_value"'
  LC_ALL=C "$REAL_AWK" -v a="$anchor" -v ins="$inject" \
    'index($0, a) { print; print ins; next } { print }' "$SCRIPT" \
    >"$TEST_DIR/mutant/scripts/ops/egress-proxy-value-preflight.sh"
  chmod +x "$TEST_DIR/mutant/scripts/ops/egress-proxy-value-preflight.sh"
  reset_fixture
  add_server mutant 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
    "$(literal API_KEY 'TESTKEY-CLEAN-9482')"
  "$TEST_DIR/mutant/scripts/ops/egress-proxy-value-preflight.sh" \
    >"$TEST_DIR/mutant-output" 2>&1
  mutant_rc=$?
  if [ "$mutant_rc" -eq 0 ] &&
    grep -Fq 'server=fixture-namespace/mutant verdict=OK' "$TEST_DIR/mutant-output"; then
    pass mutant-witness
  else
    fail "mutant-witness (exit=$mutant_rc)"
  fi
  if grep -Fq 'TESTKEY-CLEAN-9482' "$TEST_DIR/mutant-output"; then
    pass leak-scan-positive-control
  else
    fail 'leak-scan-positive-control (the scan missed the mutated leak)'
  fi
fi

# --- query value class (spec §3.1 row 2, §3.4) ---------------------------
# The new query class accepts / = : @ and complete %XX; the rejection names the
# query context.
reset_fixture
add_server encoded 'https://example.com/mcp?q=${API_KEY}' \
  'proxy_pass https://example.com/mcp?q=${API_KEY};' "$(secret_ref API_KEY)"
secret_bytes 'TESTKEY-B64/def%2Bgh=='
run_case query-encoded-accept 0 'server=fixture-namespace/encoded verdict=OK'
expect_output query-encoded-summary 'VERDICT=CLEAN'

reset_fixture
add_server queryctx 'https://example.com/mcp?q=${API_KEY}' \
  'proxy_pass https://example.com/mcp?q=${API_KEY};' "$(secret_ref API_KEY)"
secret_bytes 'TESTKEY-B64/def+gh=='
run_case query-context 1 'server=fixture-namespace/queryctx verdict=REJECT'
expect_output query-context-witness 'the value of API_KEY is not allowed in an unquoted query value'

# --- corpus (spec §3.5 / §5.5): 90 query+quoted rows ----------------------
if [ ! -r "$CORPUS" ]; then
  fail "corpus-missing (the suite needs $CORPUS)"
else
  tab=$(printf '\t')
  rows=0
  query_rows=0
  quoted_rows=0
  while IFS= read -r row || [ -n "$row" ]; do
    case $row in
      '' | '#'*) continue ;;
    esac
    ctx=${row%%"$tab"*}
    [ "$ctx" = context ] && continue
    rest=${row#*"$tab"}
    label=${rest%%"$tab"*}
    rest=${rest#*"$tab"}
    bytes=${rest%%"$tab"*}
    expected=${rest#*"$tab"}
    { [ "$ctx" = query ] || [ "$ctx" = quoted ]; } || continue
    rows=$((rows + 1))
    if [ "$ctx" = query ]; then
      query_rows=$((query_rows + 1))
      corpus_template='proxy_pass https://example.com/mcp?q=${VALUE};'
    else
      quoted_rows=$((quoted_rows + 1))
      corpus_template='proxy_set_header X-Key "${VALUE}";'
    fi
    reset_fixture
    add_server corpus 'https://example.com/mcp' "$corpus_template" "$(secret_ref VALUE)"
    # The corpus value field is a POSIX printf format (spec §3.5).
    # shellcheck disable=SC2059
    encoded=$(printf -- "$bytes" | base64 | tr -d '\n')
    jq -n --arg v "$encoded" '{data:{credential:$v}}' \
      >"$FIXTURE_ROOT/secret-fixture-secret.json"
    case $expected in
      ACCEPT) run_case "corpus-$ctx-$label" 0 'server=fixture-namespace/corpus verdict=OK' ;;
      REJECT) run_case "corpus-$ctx-$label" 1 'the value of VALUE is not allowed in' ;;
      *) fail "corpus-$ctx-$label (invalid expected verdict: $expected)" ;;
    esac
  done <"$CORPUS"
  # A readable corpus that yields no row asserted nothing, so it fails loudly
  # instead of reporting a green run.
  if [ "$rows" -eq 0 ]; then
    fail 'corpus-total-zero (no query or quoted row was executed)'
  fi
  if [ "$rows" -eq 90 ] && [ "$query_rows" -eq 45 ] && [ "$quoted_rows" -eq 45 ]; then
    pass corpus-row-count
  else
    fail "corpus-row-count total=$rows query=$query_rows quoted=$quoted_rows"
  fi
fi

# --- SC-1 (spec §8.5): name lists parsed from the real sources ------------
sorted_words() {
  printf '%s\n' "$1" | LC_ALL=C "$REAL_AWK" '
    { n = split($0, field, " "); for (i = 1; i <= n; i++) if (field[i] != "") print field[i] }' |
    LC_ALL=C sort -u | tr '\n' ' '
}

sc1_section() {
  LC_ALL=C "$REAL_AWK" -F '\t' -v s="$1" '$1 == s { print $2 }' "$TEST_DIR/sc1-sets" |
    LC_ALL=C sort -u | tr '\n' ' '
}

sc1_script_list() {
  LC_ALL=C "$REAL_AWK" -v q="'" -v key="$1" '
    index($0, key "=" q) == 1 { split($0, part, q); found = found "X"; value = part[2] }
    END { if (found != "X") exit 1; print value }' "$SCRIPT"
}

if grep -Eq 'const[[:space:]]+ENVSUBST_PINNED_PROXY_ENV' "$HCC" &&
  grep -Eq '^(export[[:space:]]+)?NGINX_ENVSUBST_[A-Z_]+[[:space:]]*=' "$ENTRYPOINT"; then
  : >"$TEST_DIR/sc1-sets"
  LC_ALL=C "$REAL_AWK" -v q="'" '
    BEGIN { sec = "" }
    {
      line = $0
      next_sec = ""
      if (match(line, /^[ \t]*(export[ \t]+)?const[ \t]+ENVSUBST_PINNED_PROXY_ENV[ \t]*=[ \t]*new Set\(\[/)) next_sec = "pinned"
      else if (match(line, /^[ \t]*(export[ \t]+)?const[ \t]+RESOLVER_RESERVED_PROXY_ENV[ \t]*=[ \t]*new Set\(\[/)) next_sec = "resolver"
      else if (match(line, /^[ \t]*(export[ \t]+)?const[ \t]+FORBIDDEN_CRD_ENV_NAMES[ \t]*=[ \t]*new Set\(\[/)) next_sec = "forbidden"
      else if (match(line, /^[ \t]*(export[ \t]+)?const[ \t]+RESERVED_PROXY_ENV[ \t]*=[ \t]*new Set\(\[/)) next_sec = "union"
      if (next_sec != "") sec = next_sec
      if (sec == "union") {
        rest = line
        while (match(rest, /[.][.][.][A-Z][A-Z0-9_]*/)) {
          print "union\t" substr(rest, RSTART + 3, RLENGTH - 3)
          rest = substr(rest, RSTART + RLENGTH)
        }
      } else if (sec != "") {
        rest = line
        while (match(rest, q "[A-Z][A-Z0-9_]*" q)) {
          print sec "\t" substr(rest, RSTART + 1, RLENGTH - 2)
          rest = substr(rest, RSTART + RLENGTH)
        }
      }
      if (sec != "" && index(line, "])") > 0) sec = ""
    }' "$HCC" >"$TEST_DIR/sc1-sets"
  LC_ALL=C "$REAL_AWK" -F '=' '
    /^[ \t]*(export[ \t]+)?NGINX_ENVSUBST_[A-Z_]+[ \t]*=/ {
      name = $1
      sub(/^[ \t]*/, "", name)
      sub(/^export[ \t]+/, "", name)
      sub(/[ \t]+$/, "", name)
      print "image\t" name
    }' "$ENTRYPOINT" >>"$TEST_DIR/sc1-sets"
  pinned=$(sc1_section pinned)
  resolver=$(sc1_section resolver)
  forbidden=$(sc1_section forbidden)
  union=$(sc1_section union)
  image=$(sc1_section image)
  script_reserved=$(sc1_script_list RESERVED_NAMES) || script_reserved=''
  script_forbidden=$(sc1_script_list FORBIDDEN_NAMES) || script_forbidden=''
  word_count() { printf '%s\n' "$1" | wc -w | tr -d ' '; }
  if [ "$(word_count "$pinned")" -eq 6 ] && [ "$(word_count "$resolver")" -eq 2 ] &&
    [ "$(word_count "$forbidden")" -eq 9 ] &&
    [ "$(sorted_words "$union")" = "$(sorted_words 'ENVSUBST_PINNED_PROXY_ENV RESOLVER_RESERVED_PROXY_ENV')" ] &&
    [ "$(sorted_words "$image")" = "$(sorted_words "$pinned")" ] &&
    [ "$(sorted_words "$script_reserved")" = "$(sorted_words "$pinned $resolver")" ] &&
    [ "$(sorted_words "$script_forbidden")" = "$(sorted_words "$forbidden")" ]; then
    pass sc1-source-list-drift
  else
    fail 'sc1-source-list-drift (script name lists differ from the HCC sets or the image assignments)'
  fi
  if grep -Eq 'export (const )?\{[^}]*RESERVED_PROXY_ENV|export const RESERVED_PROXY_ENV' "$HCC" &&
    grep -Eq 'export (const )?\{[^}]*FORBIDDEN_CRD_ENV_NAMES|export const FORBIDDEN_CRD_ENV_NAMES' "$HCC"; then
    pass sc1-sets-exported
  else
    fail 'sc1-sets-exported (RESERVED_PROXY_ENV and FORBIDDEN_CRD_ENV_NAMES must be exported)'
  fi
elif [ ! -r "$HCC" ] || [ ! -r "$ENTRYPOINT" ]; then
  fail "sc1-source-list-drift (the suite needs $HCC and $ENTRYPOINT)"
else
  fail 'sc1-source-list-drift (the HCC sets or the image NGINX_ENVSUBST_* assignments are missing)'
fi

# --- every case's output, with a life witness ----------------------------
if [ "$(count_lines "$all_output" 'verdict=')" -gt 0 ] &&
  ! grep -Fq 'TESTKEY' "$all_output"; then
  pass no-values-on-output
else
  fail 'no-values-on-output (a fixture value reached stdout/stderr, or no verdict line was produced)'
fi

# Anti-vacuity: with no pending mode left, a run that asserted nothing must not
# look successful.
if [ $((passed + failed)) -eq 0 ]; then
  fail 'no-assertions-executed (the suite produced no PASS/FAIL line)'
fi

printf 'RESULT passed=%s failed=%s pending=%s\n' "$passed" "$failed" "$pending"
if [ "$failed" -ne 0 ]; then
  exit 1
fi
exit 0
