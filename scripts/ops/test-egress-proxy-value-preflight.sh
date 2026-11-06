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
# Captured before PATH is modified: the argv-logging wrappers below
# delegate to these real binaries.
REAL_JQ=$(command -v jq)
REAL_BASE64=$(command -v base64)
REAL_OD=$(command -v od)
REAL_GREP=$(command -v grep)
REAL_SORT=$(command -v sort)
REAL_ENV=$(command -v env)
REAL_RM=$(command -v rm)
REAL_CP=$(command -v cp)
REAL_DIRNAME=$(command -v dirname)

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
mkdir -p "$TEST_DIR/bin" "$TEST_DIR/fixtures" \
  "$TEST_DIR/disk-snapshots" "$TEST_DIR/bounded-tmp"
export FIXTURE_ROOT="$TEST_DIR/fixtures"
export CONTEXT=fixture-context NAMESPACE=fixture-namespace
export PATH="$TEST_DIR/bin:$PATH"
# Read by the kubectl stub: while the flag file exists, every wrapped tool
# appends one `name [arg]...` line per invocation to the log. The flag is
# raised only around a traced run of the script under test, because this
# harness itself puts fixture values in argv (jq --arg in literal(), the
# direct-check env line, the assertion greps); logging all the time would
# flag leaks of the harness, not of the script.
export EPVP_ARGV_FLAG="$TEST_DIR/argv-log-on"
export EPVP_ARGV_LOG="$TEST_DIR/argv-log"

cat >"$TEST_DIR/bin/kubectl" <<'STUB'
#!/bin/bash
set -u
if [ -n "${EPVP_ARGV_FLAG:-}" ] && [ -e "$EPVP_ARGV_FLAG" ]; then
  { printf 'kubectl'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >> "$EPVP_ARGV_LOG"
fi
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
# runs the check is `env -i`, so it has no PATH. The two failure flags are
# selective so each keeps a single meaning: no-verdict fails only the awk that
# runs the template check (-f .../egress-proxy-template-check), and
# fail-static-awk fails only the awk program that prints the s2q findings.
# While the traced-run flag exists it also appends its argv to the argv log,
# with both paths baked in so the log line survives `env -i`.
{
  printf '#!/bin/bash\n'
  printf 'if [ -e %q ]; then case "$*" in *egress-proxy-template-check*) exit 1 ;; esac; fi\n' "$TEST_DIR/no-verdict"
  printf 'if [ -e %q ]; then case "$*" in *s2q*) exit 1 ;; esac; fi\n' "$TEST_DIR/fail-static-awk"
  printf 'if [ -e %q ]; then { printf "%%s" %q; for a in "$@"; do printf " [%%s]" "$a"; done; printf "\\n"; } >> %q; fi\n' \
    "$TEST_DIR/argv-log-on" 'awk' "$TEST_DIR/argv-log"
  printf 'epvp_seen_line=""\n'
  printf 'for epvp_seen_name in $(compgen -e); do epvp_seen_line="$epvp_seen_line $epvp_seen_name"; done\n'
  printf 'printf "%%s\\n" "$epvp_seen_line" >> %q\n' "$TEST_DIR/awk-names"
  printf 'exec %q "$@"\n' "$REAL_AWK"
} >"$TEST_DIR/bin/awk"
chmod +x "$TEST_DIR/bin/awk"

# argv-logging wrappers for every other bare external the preflight runs
# (kubectl and awk are covered above; bash is resolved by absolute path in
# the script and mktemp only ever receives a name pattern, so neither is
# wrapped). Bodies use only builtins, like the awk wrapper: a wrapper must
# never depend on resolving a command, because the check child runs under
# `env -i` without PATH. Each wrapper appends `name [arg]...` to the argv
# log while the flag file exists, then execs the real binary. `rm` also
# snapshots the preflight's work directory before delegating, so the disk
# state is observable before the script's EXIT trap removes it; only the
# `egress-proxy-value-preflight.*` mktemp shape matches, never this
# suite's own TEST_DIR.
make_argv_wrapper() { # NAME REAL_BINARY
  {
    printf '#!/bin/bash\n'
    printf 'if [ -e %q ]; then { printf "%%s" %q; for a in "$@"; do printf " [%%s]" "$a"; done; printf "\\n"; } >> %q; fi\n' \
      "$TEST_DIR/argv-log-on" "$1" "$TEST_DIR/argv-log"
    printf 'exec %q "$@"\n' "$2"
  } >"$TEST_DIR/bin/$1"
  chmod +x "$TEST_DIR/bin/$1"
}
make_argv_wrapper jq "$REAL_JQ"
make_argv_wrapper base64 "$REAL_BASE64"
make_argv_wrapper od "$REAL_OD"
make_argv_wrapper grep "$REAL_GREP"
make_argv_wrapper sort "$REAL_SORT"
make_argv_wrapper env "$REAL_ENV"
make_argv_wrapper dirname "$REAL_DIRNAME"
{
  printf '#!/bin/bash\n'
  printf 'if [ -e %q ]; then\n' "$TEST_DIR/argv-log-on"
  printf '  { printf "%%s" %q; for a in "$@"; do printf " [%%s]" "$a"; done; printf "\\n"; } >> %q\n' \
    'rm' "$TEST_DIR/argv-log"
  printf '  for a in "$@"; do\n'
  printf '    case $a in\n'
  printf '      */egress-proxy-value-preflight.*) %q -R "$a" %q/"${a##*/}" 2>/dev/null || true ;;\n' \
    "$REAL_CP" "$TEST_DIR/disk-snapshots"
  printf '    esac\n'
  printf '  done\n'
  printf 'fi\n'
  printf 'exec %q "$@"\n' "$REAL_RM"
} >"$TEST_DIR/bin/rm"
chmod +x "$TEST_DIR/bin/rm"

passed=0
failed=0
pending=0
all_output="$TEST_DIR/all-output"
: >"$all_output"

pass() { printf 'PASS %s\n' "$*"; passed=$((passed + 1)); }
fail() { printf 'FAIL %s\n' "$*"; failed=$((failed + 1)); }

reset_fixture() {
  rm -f -- "$FIXTURE_ROOT"/* "$TEST_DIR/awk-names" "$TEST_DIR/no-verdict" \
    "$TEST_DIR/fail-static-awk"
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

# add_server_template_file NAME URL TEMPLATE_FILE ENV_JSON [HEADERS_JSON]
# Like add_server, but the ConfigMap template bytes come from a versioned
# fixture file via jq --rawfile, never from text copied into this suite.
add_server_template_file() {
  local name=$1 url=$2 template_file=$3 env_json=$4 headers=${5:-[]}
  jq --arg n "$name" --arg u "$url" --argjson h "$headers" \
    '.items += [{metadata:{name:$n},spec:{remote:{baseUrl:$u,authHeaders:$h}}}]' \
    "$FIXTURE_ROOT/servers.json" >"$TEST_DIR/servers-next"
  mv "$TEST_DIR/servers-next" "$FIXTURE_ROOT/servers.json"
  jq -n --rawfile t "$template_file" '{data:{"default.conf.template":$t}}' \
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

# run_traced [EXECUTABLE]: run the script with argv/disk tracing on and a
# bounded TMPDIR, so its mktemp work directory (and the rm wrapper's
# pre-trap snapshot of it) stays inside this suite's tree.
run_traced() {
  local executable=${1:-$SCRIPT} rc
  rm -f -- "$TEST_DIR/argv-log"
  rm -rf -- "$TEST_DIR/disk-snapshots" "$TEST_DIR/bounded-tmp"
  mkdir -p "$TEST_DIR/disk-snapshots" "$TEST_DIR/bounded-tmp"
  : >"$TEST_DIR/argv-log-on"
  TMPDIR="$TEST_DIR/bounded-tmp" "$executable" >"$TEST_DIR/output" 2>&1
  rc=$?
  rm -f -- "$TEST_DIR/argv-log-on"
  cat "$TEST_DIR/output" >>"$all_output"
  return "$rc"
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

# A NUL byte never survives command substitution, so it has to be judged on
# the decoded bytes before any variable holds them: both value classes refuse
# 0x00. In each case the same server without the NUL is the life witness that
# the whole path ran and only the NUL decided the verdict.
reset_fixture
add_server nulquery 'https://example.com/mcp?q=${API_KEY}' \
  'proxy_pass https://example.com/mcp?q=${API_KEY};' "$(secret_ref API_KEY)"
secret_bytes 'TESTKEY-NULQ\000END'
run_case nul-query 1 \
  'server=fixture-namespace/nulquery verdict=REJECT reason=nul-byte name=API_KEY'
expect_output nul-query-witness 'the value of API_KEY holds a NUL byte'
expect_output nul-query-summary 'VERDICT=VALUES_REJECTED checked=1 ok=0 rejected=1'
secret_bytes 'TESTKEY-NULQEND'
run_case nul-query-clean-witness 0 'server=fixture-namespace/nulquery verdict=OK'
expect_output nul-query-clean-summary \
  'VERDICT=CLEAN checked=1 ok=1 rejected=0 inconclusive=0'

reset_fixture
add_server nulquoted 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(secret_ref API_KEY)"
secret_bytes 'TESTKEY-NULH\000END'
run_case nul-quoted 1 \
  'server=fixture-namespace/nulquoted verdict=REJECT reason=nul-byte name=API_KEY'
expect_output nul-quoted-witness 'the value of API_KEY holds a NUL byte'
secret_bytes 'TESTKEY-NULHEND'
run_case nul-quoted-clean-witness 0 'server=fixture-namespace/nulquoted verdict=OK'
expect_output nul-quoted-clean-summary 'VERDICT=CLEAN'

# The literal branch reaches the same loss point through jq -jr: a JSON escape
# for U+0000 is a raw NUL byte there. ([0] | implode builds that escape in the
# fixture JSON without a NUL ever entering a shell variable of this suite.)
reset_fixture
envs=$(jq -cn '[{name:"API_KEY",value:("TESTKEY-NULL" + ([0] | implode) + "END")}]')
add_server nullit 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' "$envs"
run_case nul-literal 1 \
  'server=fixture-namespace/nullit verdict=REJECT reason=nul-byte name=API_KEY'
expect_output nul-literal-witness 'the value of API_KEY holds a NUL byte'
reset_fixture
add_server nullit 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY 'TESTKEY-NULLEND')"
run_case nul-literal-clean-witness 0 'server=fixture-namespace/nullit verdict=OK'
expect_output nul-literal-clean-summary 'VERDICT=CLEAN'

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
# `$` belongs to neither value class, so the literal itself is refused, not
# left unjudged; the remediation advice stays.
reset_fixture
add_server dependent 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY '$(TESTKEY_OTHER)')"
run_case dependent-env-reference 1 \
  'server=fixture-namespace/dependent verdict=REJECT reason=dependent-env-reference name=API_KEY'
expect_output dependent-advice 'advice: Kubernetes expands $(NAME)'
expect_output dependent-summary 'VERDICT=VALUES_REJECTED checked=1 ok=0 rejected=1'
# Life witness: the same server with the final value stored is CLEAN.
reset_fixture
add_server dependent 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY 'TESTKEY-CLEAN-9482')"
run_case dependent-clean-witness 0 'server=fixture-namespace/dependent verdict=OK'
expect_output dependent-clean-summary \
  'VERDICT=CLEAN checked=1 ok=1 rejected=0 inconclusive=0'

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

# Remote follows HCC's !!baseUrl: an empty baseUrl is not remote, so the
# server is never selected instead of surfacing later as no-configmap. Its
# ConfigMap is removed so the unaligned predicate would have been caught:
# checked=1 with the witness server OK is the life witness for the absence.
reset_fixture
add_server emptyurl '' 'return 200 ok;' '[]'
rm -f "$FIXTURE_ROOT/configmap-emptyurl-nginx-conf.json"
add_server emptywitness 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY 'TESTKEY-CLEAN-9482')"
run_case empty-baseurl-not-remote 0 'server=fixture-namespace/emptywitness verdict=OK'
expect_output empty-baseurl-summary \
  'VERDICT=CLEAN checked=1 ok=1 rejected=0 inconclusive=0'
expect_absent empty-baseurl-absent 'emptyurl'

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

# A failed static-findings awk is an ERROR, never a silent skip of S1/S2:
# judged with empty findings, this same fixture would report CLEAN.
reset_fixture
add_server staticfail 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY 'TESTKEY-CLEAN-9482')"
: >"$TEST_DIR/fail-static-awk"
run_case static-awk-failure 2 'VERDICT=ERROR'
expect_output static-awk-failure-server 'fixture-namespace/staticfail'
rm -f "$TEST_DIR/fail-static-awk"
run_case static-awk-failure-witness 0 'server=fixture-namespace/staticfail verdict=OK'

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

# --- no value in argv or on disk (traced runs) ----------------------------
# m10 pins the output streams. These traced runs pin the other two channels
# of the preflight's value-handling contract: while the flag file exists,
# every wrapped external records its argv and the rm wrapper snapshots the
# script's work directory before the EXIT trap removes it. Limits of this
# pin, by construction: a command invoked by absolute path bypasses the
# PATH wrappers; a builtin redirection is visible only when it writes
# under the work directory or the bounded TMPDIR; stdin handed to an
# external is not recorded; the environment of the env -i check child
# holds the values by design (its names are pinned by check_ran_with and
# its argv is in the log); mktemp is not wrapped because it only receives
# a name pattern. Only the traced runs below are pinned, not every case in
# this suite. The templates of the traced cases never contain the TESTKEY
# marker: the rendered template legitimately reaches the snapshot as CRD
# text, so a marker there would read as a false positive.
reset_fixture
add_server tracedsecret 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(secret_ref API_KEY)"
secret_bytes 'TESTKEY-ARGV-SECRET1'
run_traced
traced_rc=$?
if [ "$traced_rc" -eq 0 ] &&
  grep -Fq 'server=fixture-namespace/tracedsecret verdict=OK' "$TEST_DIR/output"; then
  pass traced-secret-verdict
else
  fail "traced-secret-verdict (exit=$traced_rc)"
fi
if [ -s "$TEST_DIR/argv-log" ] && grep -Fq 'jq [' "$TEST_DIR/argv-log" &&
  grep -Fq 'base64 [-d]' "$TEST_DIR/argv-log" &&
  grep -Fq 'env [-i]' "$TEST_DIR/argv-log"; then
  pass traced-secret-argv-witness
else
  fail 'traced-secret-argv-witness (the argv log missed the jq, base64 -d or env -i calls)'
fi
if grep -R -Fq 'proxy_set_header' "$TEST_DIR/disk-snapshots"; then
  pass traced-secret-disk-witness
else
  fail 'traced-secret-disk-witness (no snapshot held the rendered template)'
fi
if grep -Fq 'TESTKEY' "$TEST_DIR/argv-log"; then
  fail 'traced-secret-no-value-in-argv (a fixture value reached argv)'
else
  pass traced-secret-no-value-in-argv
fi
if grep -R -Fq 'TESTKEY' "$TEST_DIR/disk-snapshots" ||
  grep -R -Fq 'TESTKEY' "$TEST_DIR/bounded-tmp"; then
  fail 'traced-secret-no-value-on-disk (a fixture value reached disk)'
else
  pass traced-secret-no-value-on-disk
fi

reset_fixture
add_server tracedliteral 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
  "$(literal API_KEY 'TESTKEY-ARGV-LITERAL1')"
run_traced
traced_rc=$?
if [ "$traced_rc" -eq 0 ] &&
  grep -Fq 'server=fixture-namespace/tracedliteral verdict=OK' "$TEST_DIR/output"; then
  pass traced-literal-verdict
else
  fail "traced-literal-verdict (exit=$traced_rc)"
fi
if [ -s "$TEST_DIR/argv-log" ] && grep -Fq 'jq [' "$TEST_DIR/argv-log"; then
  pass traced-literal-argv-witness
else
  fail 'traced-literal-argv-witness (the argv log missed the jq calls)'
fi
if grep -R -Fq 'proxy_set_header' "$TEST_DIR/disk-snapshots"; then
  pass traced-literal-disk-witness
else
  fail 'traced-literal-disk-witness (no snapshot held the rendered template)'
fi
if grep -Fq 'TESTKEY' "$TEST_DIR/argv-log"; then
  fail 'traced-literal-no-value-in-argv (a fixture value reached argv)'
else
  pass traced-literal-no-value-in-argv
fi
if grep -R -Fq 'TESTKEY' "$TEST_DIR/disk-snapshots" ||
  grep -R -Fq 'TESTKEY' "$TEST_DIR/bounded-tmp"; then
  fail 'traced-literal-no-value-on-disk (a fixture value reached disk)'
else
  pass traced-literal-no-value-on-disk
fi

# Positive controls: each channel must turn red when a mutated copy of the
# script leaks through it. The injections reuse m10's anchor, where the
# resolved value is in scope, and each mutated tree carries its own copy
# of the checker because the script resolves it relative to $0.
if [ "$anchor_count" -ne 1 ]; then
  fail "traced-control-anchor (anchor count=$anchor_count, expected 1)"
else
  mkdir -p "$TEST_DIR/mutant-argv/scripts/ops" \
    "$TEST_DIR/mutant-argv/nginx-egress-proxy" \
    "$TEST_DIR/mutant-disk/scripts/ops" \
    "$TEST_DIR/mutant-disk/nginx-egress-proxy"
  cp "$CHECK" "$TEST_DIR/mutant-argv/nginx-egress-proxy/egress-proxy-template-check"
  cp "$CHECK" "$TEST_DIR/mutant-disk/nginx-egress-proxy/egress-proxy-template-check"
  inject='    printf x | grep -F -- "$epvp_value" >/dev/null 2>&1 || true'
  LC_ALL=C "$REAL_AWK" -v a="$anchor" -v ins="$inject" \
    'index($0, a) { print; print ins; next } { print }' "$SCRIPT" \
    >"$TEST_DIR/mutant-argv/scripts/ops/egress-proxy-value-preflight.sh"
  chmod +x "$TEST_DIR/mutant-argv/scripts/ops/egress-proxy-value-preflight.sh"
  inject='    printf "%s" "$epvp_value" >"$epvp_work/leak-$epvp_index"'
  LC_ALL=C "$REAL_AWK" -v a="$anchor" -v ins="$inject" \
    'index($0, a) { print; print ins; next } { print }' "$SCRIPT" \
    >"$TEST_DIR/mutant-disk/scripts/ops/egress-proxy-value-preflight.sh"
  chmod +x "$TEST_DIR/mutant-disk/scripts/ops/egress-proxy-value-preflight.sh"

  reset_fixture
  add_server argvmutant 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
    "$(literal API_KEY 'TESTKEY-CLEAN-9482')"
  run_traced "$TEST_DIR/mutant-argv/scripts/ops/egress-proxy-value-preflight.sh"
  traced_rc=$?
  if [ "$traced_rc" -eq 0 ] &&
    grep -Fq 'server=fixture-namespace/argvmutant verdict=OK' "$TEST_DIR/output"; then
    pass argv-control-witness
  else
    fail "argv-control-witness (exit=$traced_rc)"
  fi
  if grep -Fq 'TESTKEY-CLEAN-9482' "$TEST_DIR/argv-log"; then
    pass argv-scan-positive-control
  else
    fail 'argv-scan-positive-control (the argv log missed the mutated leak)'
  fi

  reset_fixture
  add_server diskmutant 'https://example.com/mcp' 'proxy_set_header X-Key "${API_KEY}";' \
    "$(literal API_KEY 'TESTKEY-CLEAN-9482')"
  run_traced "$TEST_DIR/mutant-disk/scripts/ops/egress-proxy-value-preflight.sh"
  traced_rc=$?
  if [ "$traced_rc" -eq 0 ] &&
    grep -Fq 'server=fixture-namespace/diskmutant verdict=OK' "$TEST_DIR/output"; then
    pass disk-control-witness
  else
    fail "disk-control-witness (exit=$traced_rc)"
  fi
  if grep -R -Fq 'TESTKEY-CLEAN-9482' "$TEST_DIR/disk-snapshots"; then
    pass disk-scan-positive-control
  else
    fail 'disk-scan-positive-control (the snapshot missed the mutated leak)'
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

# --- golden-fixed-refs: the golden templates carry no other fixed refs ---
# The golden files are the renderer's own output for three deterministic
# remote shapes (see egressProxyTemplateGolden.test.ts). Subtracting the
# two dynamic names must leave exactly the five fixed references (four
# NGINX variables plus the bare $NGINX_LOCAL_RESOLVERS of the resolver
# directive), and the real template check must accept each golden with a
# clean value.
# A missing golden is a hard failure, never a skip.
golden_dir="$ROOT/host-context-controller/src/__tests__/fixtures/egress-proxy-template"
# Both dynamic names carry the suite's one clean marker value, supplied
# through the environment from this single variable.
golden_clean_value='TESTKEY-CLEAN-9482'
golden_total_refs=0
golden_union=''
golden_plain_fixed=0
for golden_shape in plain query-header oauth; do
  golden_file="$golden_dir/$golden_shape.default.conf.template"
  if [ ! -r "$golden_file" ]; then
    fail "golden-fixed-refs-$golden_shape-readable (the suite needs $golden_file)"
    continue
  fi
  pass "golden-fixed-refs-$golden_shape-readable"
  LC_ALL=C "$REAL_AWK" '
    {
      line = $0
      while (match(line, /[$]([{][A-Za-z_][A-Za-z0-9_]*[}]|[A-Za-z_][A-Za-z0-9_]*)/)) {
        token = substr(line, RSTART + 1, RLENGTH - 1)
        if (substr(token, 1, 1) == "{") token = substr(token, 2, length(token) - 2)
        print token
        line = substr(line, RSTART + RLENGTH)
      }
    }' "$golden_file" >"$TEST_DIR/golden-refs-$golden_shape"
  golden_ref_count=$(wc -l <"$TEST_DIR/golden-refs-$golden_shape" | tr -d ' ')
  golden_total_refs=$((golden_total_refs + golden_ref_count))
  golden_fixed=$(LC_ALL=C "$REAL_AWK" '$0 != "API_KEY" && $0 != "UPSTREAM_TOKEN"' \
    "$TEST_DIR/golden-refs-$golden_shape" | LC_ALL=C sort -u | tr '\n' ' ')
  golden_union="$golden_union $golden_fixed"
  if [ "$golden_shape" = plain ]; then
    golden_plain_fixed=$(printf '%s\n' "$golden_fixed" | wc -w | tr -d ' ')
  fi
  LC_ALL=C env "API_KEY=$golden_clean_value" "UPSTREAM_TOKEN=$golden_clean_value" \
    "$REAL_AWK" -f "$CHECK" "$golden_file" >/dev/null 2>&1
  golden_check_rc=$?
  if [ "$golden_check_rc" -eq 0 ]; then
    pass "golden-fixed-refs-$golden_shape-checker"
  else
    fail "golden-fixed-refs-$golden_shape-checker (exit=$golden_check_rc expected=0)"
  fi
done
if [ "$golden_total_refs" -gt 0 ]; then
  pass golden-fixed-refs-total-nonempty
else
  fail 'golden-fixed-refs-total-nonempty (no reference was extracted)'
fi
if [ "$golden_plain_fixed" -eq 4 ]; then
  pass golden-fixed-refs-plain-four
else
  fail "golden-fixed-refs-plain-four (plain contributed $golden_plain_fixed fixed refs, expected 4)"
fi
if [ "$(sorted_words "$golden_union")" = \
  "$(sorted_words 'NGINX_LOCAL_RESOLVERS http_authorization proxy_add_x_forwarded_for remote_addr scheme')" ]; then
  pass golden-fixed-refs-union
else
  fail 'golden-fixed-refs-union (the fixed references differ from the expected five)'
fi

# --- golden template through the full preflight ---------------------------
# The section above runs the checker directly on the fixture files. These
# cases run the versioned query-header golden through the whole preflight
# (kubectl fixtures, Secret resolution, the env -i check child), so the
# transport is pinned against the renderer's real output. The env JSON is
# hand-written but reproduces the names and order the golden TS test pins
# for the egress-proxy container (egressProxyTemplateGolden.test.ts):
# API_KEY and UPSTREAM_TOKEN by secretKeyRef, then
# NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 and NGINX_ENVSUBST_FILTER empty last.
# Both secretKeyRef entries share the stub Secret, so one secret_bytes
# value drives the query and quoted contexts together. Neither of the
# two NGINX_* env entries is referenced by the template, so the
# preflight never resolves them; their entries pin only the Deployment
# shape.
golden_envs=$(jq -cn '[{name:"API_KEY",valueFrom:{secretKeyRef:{name:"fixture-secret",key:"credential"}}},
  {name:"UPSTREAM_TOKEN",valueFrom:{secretKeyRef:{name:"fixture-secret",key:"credential"}}},
  {name:"NGINX_ENTRYPOINT_LOCAL_RESOLVERS",value:"1"},
  {name:"NGINX_ENVSUBST_FILTER",value:""}]')
golden_headers='[{"header":"Authorization","valueTemplate":"Bearer ${UPSTREAM_TOKEN}"}]'
reset_fixture
add_server_template_file goldenqh 'https://upstream.example/mcp?apikey=${API_KEY}' \
  "$golden_dir/query-header.default.conf.template" "$golden_envs" "$golden_headers"
secret_bytes 'TESTKEY-CLEAN-9482'
run_case golden-query-header-clean 0 'server=fixture-namespace/goldenqh verdict=OK'
expect_output golden-query-header-clean-summary \
  'VERDICT=CLEAN checked=1 ok=1 rejected=0 inconclusive=0'
if [ "$(check_ran_with API_KEY)" = yes ] &&
  [ "$(check_ran_with UPSTREAM_TOKEN)" = yes ]; then
  pass golden-query-header-clean-resolution
else
  fail 'golden-query-header-clean-resolution (the check child did not see both names)'
fi
# '+' is outside the unquoted query class but inside the quoted class, so
# the shared Secret value rejects only API_KEY.
secret_bytes 'TESTKEY-B64/def+gh=='
run_case golden-query-header-reject 1 'server=fixture-namespace/goldenqh verdict=REJECT'
expect_output golden-query-header-reject-witness \
  'the value of API_KEY is not allowed in an unquoted query value'
expect_output golden-query-header-reject-summary \
  'VERDICT=VALUES_REJECTED checked=1 ok=0 rejected=1'
expect_absent golden-query-header-reject-quoted-clean \
  'the value of UPSTREAM_TOKEN is not allowed'

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
