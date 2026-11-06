#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# test-egress-cdn-rotation-cleanup.sh — hermetic, cluster-free contract
# test for the cleanup half of scripts/e2e/e2e-egress-cdn-rotation.sh.
#
# It sources the real harness (whose execution guard keeps sourcing from
# starting any phase) and drives its real helpers against a fake
# KUBECTL_BIN. The fake binary — not stubbed shell functions — is what every
# path reaches, including `hcc_rollout_status`, which spawns "$KUBECTL_BIN"
# through scripts/minikube/run-with-deadline.mjs.
#
# Covered contracts (docs/testing/egress-cdn-rotation.md):
#   - the pod-side resolver snippet prints one structured JSON line and
#     exits 0 even when DNS itself errors, so the DNS code survives;
#   - the real c-ares error codes (ENODATA/ESERVFAIL/ENOTFOUND on the GONE
#     side, EREFUSED on the UNKNOWN side) against an in-process DNS server,
#     not a stub (§1b);
#   - record_dns_witness keeps the raw structured line for phase-2 failure
#     diagnosis, never an empty file (§2b);
#   - the served-DNS witness classifies GONE / PRESENT / UNKNOWN exactly as
#     the literal matrix says, and records the last state in
#     dns-override-witness.txt;
#   - cleanup restores HCC only on GONE, never on PRESENT or UNKNOWN, and
#     its warnings distinguish "still served" from "could not ask";
#   - the sample-file consumers drain their producers (no SIGPIPE 141 under
#     pipefail), with >5000 samples so the pipe buffer is really exceeded;
#   - on_exit ignores SIGPIPE during the restore and a closed stdout cannot
#     rewrite the verdict exit code.
# Every negative assertion is paired with a life witness in the same case
# (the fake kubectl log proves the exec/patch calls really happened).
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

HARNESS_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

for tool in jq node python3 awk; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'FAIL: required host tool %s is missing; zero checks would be a false green\n' "$tool" >&2
    exit 1
  }
done

TMP_DIR="$(mktemp -d)"
harness_teardown() { rm -rf -- "$TMP_DIR"; }
trap harness_teardown EXIT

TESTS_RUN=0
TESTS_FAILED=0
note_pass() { TESTS_RUN=$((TESTS_RUN + 1)); printf 'ok %d - %s\n' "$TESTS_RUN" "$1"; }
note_fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'not ok %d - %s\n' "$TESTS_RUN" "$1" >&2
}
assert_eq() { # <name> <want> <got>
  if [ "$2" = "$3" ]; then note_pass "$1"; else note_fail "$1 (want [$2] got [$3])"; fi
}
assert_contains() { # <name> <file> <fixed-string>
  if [ -f "$2" ] && grep -F -q -- "$3" "$2"; then
    note_pass "$1"
  else
    note_fail "$1 ([$3] not found in $2)"
  fi
}
assert_not_contains() { # <name> <file> <fixed-string> — callers add a life witness
  if [ -f "$2" ] && grep -F -q -- "$3" "$2"; then
    note_fail "$1 ([$3] unexpectedly present in $2)"
  else
    note_pass "$1"
  fi
}

# ── Fake kubectl (the KUBECTL_BIN every path reaches) ──────────────────
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/cases"
cat >"$TMP_DIR/bin/kubectl" <<'FAKEEOF'
#!/usr/bin/env bash
# Logs every invocation, then answers from fixture files. State lives in
# files (not variables) because the deadline runner spawns fresh processes.
printf '%s\n' "$*" >>"$FAKE_KUBECTL_LOG"
args=("$@")
if [ "${args[0]:-}" = "--context" ]; then args=("${args[@]:2}"); fi
cmd="${args[0]:-}"
joined=" ${args[*]} "
case "$cmd" in
  exec)
    if [ "${FAKE_DNS_EXEC_RC:-0}" != "0" ]; then
      echo "fake kubectl: simulated exec transport failure" >&2
      exit "$FAKE_DNS_EXEC_RC"
    fi
    cat "$FAKE_DNS_RESPONSE_FILE"
    ;;
  rollout)
    echo "deployment \"host-context-controller\" successfully rolled out (fake)"
    ;;
  patch)
    payload="" prev=""
    for a in "${args[@]}"; do
      if [ "$prev" = "-p" ]; then payload="$a"; fi
      prev="$a"
    done
    case "$joined" in
      *" configmap coredns "*)
        printf '%s' "$payload" | jq -j '.data.Corefile' >"$FAKE_COREFILE_STATE" || {
          echo "fake kubectl: coredns patch carried no data.Corefile" >&2
          exit 1
        }
        ;;
    esac
    ;;
  annotate | delete)
    ;;
  get)
    case "$joined" in
      *" configmap coredns "*)
        jq -cn --rawfile cf "$FAKE_COREFILE_STATE" \
          '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:"coredns",namespace:"kube-system",annotations:{}},data:{Corefile:$cf}}'
        ;;
      *" deployment host-context-controller "*)
        jq -cn --argjson env "$(cat "$FAKE_HCC_ENV_FILE")" \
          '{apiVersion:"apps/v1",kind:"Deployment",metadata:{name:"host-context-controller",namespace:"control-plane",annotations:{}},spec:{template:{spec:{containers:[{name:"host-context-controller",env:$env}]}}}}'
        ;;
      *" networkpolicy "*" -l "*)
        ;; # label sweep: an empty -o name list
      *)
        printf 'Error from server (NotFound): fake %s "%s" not found\n' "${args[1]:-}" "${args[2]:-}" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "fake kubectl: unhandled invocation: $*" >&2
    exit 1
    ;;
esac
FAKEEOF
chmod +x "$TMP_DIR/bin/kubectl"

# Node preload that stubs require("dns") so the exact pod-side snippet can
# be executed locally and its output contract asserted byte for byte.
cat >"$TMP_DIR/dns-stub.cjs" <<'STUBEOF'
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'dns') {
    return {
      promises: {
        resolve4: async () => {
          if (process.env.STUB_DNS_ERROR) {
            const err = new Error('stub resolver failure');
            err.code = process.env.STUB_DNS_ERROR;
            throw err;
          }
          return JSON.parse(process.env.STUB_DNS_RECORDS || '[]');
        },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
STUBEOF

export KUBECONTEXT="clerum-boundary-1234abcd"
export KUBECTL_BIN="$TMP_DIR/bin/kubectl"
export FAKE_KUBECTL_LOG="$TMP_DIR/kubectl.log"
export FAKE_DNS_RESPONSE_FILE="$TMP_DIR/dns-response.json"
export FAKE_DNS_EXEC_RC=0
export FAKE_COREFILE_STATE="$TMP_DIR/corefile-state.txt"
export FAKE_HCC_ENV_FILE="$TMP_DIR/hcc-env.json"
printf '[{"name":"HCC_TEST_ENV","value":"original"}]' >"$FAKE_HCC_ENV_FILE"
printf '{"ok":true,"records":[]}' >"$FAKE_DNS_RESPONSE_FILE"
printf 'stale override corefile\n' >"$FAKE_COREFILE_STATE"
: >"$FAKE_KUBECTL_LOG"

# Source the real harness for its helpers only (execution guard). The
# globals assigned below (timeouts, sample paths, restore flags, witness
# state) are read by that sourced file, not by this one.
# shellcheck source=scripts/e2e/e2e-egress-cdn-rotation.sh
source "$HARNESS_ROOT/scripts/e2e/e2e-egress-cdn-rotation.sh"

# Short bounds: CI cannot pay the production 150 s witness wait per row.
DNS_VISIBLE_TIMEOUT=3
RESOURCE_DELETE_TIMEOUT=5
HCC_ROLLOUT_TIMEOUT=10

RUN_OUT=""
RUN_ERR=""
LAST_RC=0
# Run a command in a subshell with `set -e` genuinely active (the way the
# phases call these helpers), capturing stdout/stderr and the exit code.
# This must be invoked as a plain statement: wrapping it in `|| rc=$?` would
# put the subshell in a tested context, where bash ignores `-e` throughout
# and the SIGPIPE regression below becomes invisible.
run_strict() {
  set +e
  ( set -euo pipefail; "$@" ) >"$RUN_OUT" 2>"$RUN_ERR"
  LAST_RC=$?
  set -e
}

CAP_OUT=""
CAP_RC=0
run_capture() {
  set +e
  CAP_OUT="$("$@" 2>"$TMP_DIR/capture.err")"
  CAP_RC=$?
  set -e
}

nap() { python3 -c 'import sys, time; time.sleep(float(sys.argv[1]))' "$1"; }

setup_case() { # <case-name>
  local case_dir="$TMP_DIR/cases/$1"
  mkdir -p "$case_dir/evidence"
  EVIDENCE_DIR="$case_dir/evidence"
  RUN_OUT="$case_dir/stdout.txt"
  RUN_ERR="$case_dir/stderr.txt"
  BRANCH_SAMPLES="$case_dir/branch-samples.tsv"
  CONTROL_SAMPLES="$case_dir/control-samples.tsv"
  POLICY_SAMPLES="$case_dir/policy-cidrs.tsv"
  BRANCH_REDIRECT_FILE="$case_dir/branch-probe-reads-control"
  : >"$BRANCH_SAMPLES"
  : >"$CONTROL_SAMPLES"
  : >"$POLICY_SAMPLES"
  SET_A=(18.154.48.13 18.154.48.20 18.154.48.43 18.154.48.50)
  SET_B=(18.172.153.11 18.172.153.14 18.172.153.41 18.172.153.115)
  CSV_A="$(csv_of "${SET_A[@]}")"
  CSV_B="$(csv_of "${SET_B[@]}")"
  POLICY_NAME="ext-egress-${SERVER}-${CDN_HOST}-${UPSTREAM_PORT}"
  # Fixtures cleanup requires, with the exact names phase 0 writes.
  cat >"${EVIDENCE_DIR}/corefile-original.txt" <<'COREEOF'
.:53 {
    hosts {
        127.0.0.1 host.minikube.internal
        fallthrough
    }
    forward . /etc/resolv.conf
}
COREEOF
  jq -cn --argjson env "$(cat "$FAKE_HCC_ENV_FILE")" \
    '[{op:"replace",path:"/spec/template/spec/containers/0/env",value:$env}]' \
    >"${EVIDENCE_DIR}/hcc-env-restore.json"
  HCC_ENV_ORIGINAL="$(cat "$FAKE_HCC_ENV_FILE")"
  HCC_ENV_INDEX=0
  COREFILE_TOUCHED=1
  HCC_ENV_TOUCHED=1
  RESOURCES_CREATED=1
  BRANCH_LOOP_PID=""
  CONTROL_LOOP_PID=""
  POLICY_LOOP_PID=""
  EXIT_CODE=0
  REASON=none
  DNS_WITNESS_STATE=UNKNOWN
  DNS_WITNESS_DETAIL="never-asked"
  printf 'override corefile still in the ConfigMap (fake)\n' >"$FAKE_COREFILE_STATE"
  printf '{"ok":true,"records":[]}' >"$FAKE_DNS_RESPONSE_FILE"
  FAKE_DNS_EXEC_RC=0
  : >"$FAKE_KUBECTL_LOG"
}

set_dns_response() { printf '%s' "$1" >"$FAKE_DNS_RESPONSE_FILE"; }
records_json() { # <ttl> <ip...> -> structured ok answer
  local ttl=$1
  shift
  jq -cn --argjson ttl "$ttl" \
    '{ok:true,records:[$ARGS.positional[] | {address:.,ttl:$ttl}]}' --args "$@"
}

# ── 1. The resolver snippet itself ─────────────────────────────────────
setup_case snippet
export STUB_DNS_RECORDS='[{"address":"1.2.3.4","ttl":5}]'
unset STUB_DNS_ERROR || true
run_capture node --require "$TMP_DIR/dns-stub.cjs" -e "$DNS_RESOLVER_SNIPPET" example.invalid
assert_eq "snippet exits 0 on a DNS answer" 0 "$CAP_RC"
assert_eq "snippet prints the structured ok line" \
  '{"ok":true,"records":[{"address":"1.2.3.4","ttl":5}]}' "$CAP_OUT"
export STUB_DNS_ERROR=ESERVFAIL
run_capture node --require "$TMP_DIR/dns-stub.cjs" -e "$DNS_RESOLVER_SNIPPET" example.invalid
assert_eq "snippet still exits 0 on a DNS error (exec != 0 means transport)" 0 "$CAP_RC"
assert_eq "snippet preserves the DNS error code" \
  '{"ok":false,"code":"ESERVFAIL"}' "$CAP_OUT"
unset STUB_DNS_ERROR STUB_DNS_RECORDS

# ── 1b. Real c-ares error codes (in-process DNS server, no stub) ───────
# §1 proves the snippet preserves whatever code `dns` hands it; the cleanup
# contract then trusts three exact code strings — ENODATA, ESERVFAIL,
# ENOTFOUND — as GONE and every other code as UNKNOWN. A stub cannot prove
# those strings are what real c-ares produces, so this probe runs an
# in-process `dgram` DNS server that answers by rcode (NOERROR with no
# answers, SERVFAIL, NXDOMAIN, REFUSED) and points the real resolver at it
# with `dns.setServers`. A positive control pins the {address, ttl} shape
# of a real answer. ETIMEOUT is deliberately not probed: an unresponsive
# server costs ~27 s of c-ares retries and the SERVFAIL/REFUSED pair
# already pins one code per side of the contract. Codes asserted as
# observed on Node 24 (the repository CI/runtime major); if the runner
# major ever changes, re-verify these c-ares mappings first.
cat >"$TMP_DIR/cares-probe.cjs" <<'PROBEEOF'
'use strict';
const dgram = require('node:dgram');
const dns = require('node:dns');

const RCODE_BY_LABEL = { nodata: 0, servfail: 2, nxdomain: 3, refused: 5, ok: 0 };

function buildResponse(query) {
  const qEnd = query.indexOf(0, 12);
  const question = query.subarray(12, qEnd + 1 + 4);
  const labelLen = query[12];
  const label = query.subarray(13, 13 + labelLen).toString('ascii');
  const rcode = RCODE_BY_LABEL[label];
  if (rcode === undefined) return null;
  const isOk = label === 'ok';
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  const flags = 0x8000 | 0x0400 | (query.readUInt16BE(2) & 0x0100) | 0x0080 | rcode;
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(isOk ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  if (!isOk) return Buffer.concat([header, question]);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(5, 6);
  answer.writeUInt16BE(4, 10);
  Buffer.from([1, 2, 3, 4]).copy(answer, 12);
  return Buffer.concat([header, question, answer]);
}

async function main() {
  const server = dgram.createSocket('udp4');
  server.on('message', (msg, rinfo) => {
    const resp = buildResponse(msg);
    if (resp) server.send(resp, rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const { port } = server.address();
  console.log('node ' + process.version + ' server 127.0.0.1:' + port);
  dns.setServers(['127.0.0.1:' + port]);
  let allOk = true;
  const cases = [
    ['nodata.test', 'ENODATA'],
    ['servfail.test', 'ESERVFAIL'],
    ['nxdomain.test', 'ENOTFOUND'],
    ['refused.test', 'EREFUSED'],
  ];
  for (const [host, expected] of cases) {
    try {
      const records = await dns.promises.resolve4(host, { ttl: true });
      console.log('MISMATCH ' + host + ' resolved ' + JSON.stringify(records) + ' expected ' + expected);
      allOk = false;
    } catch (err) {
      const code = (err && err.code) || 'ERR';
      if (code === expected) {
        console.log('OK ' + host + ' ' + code);
      } else {
        console.log('MISMATCH ' + host + ' got ' + code + ' expected ' + expected);
        allOk = false;
      }
    }
  }
  try {
    const records = await dns.promises.resolve4('ok.test', { ttl: true });
    if (records.length === 1 && records[0].address === '1.2.3.4' && records[0].ttl === 5) {
      console.log('OK ok.test ' + JSON.stringify(records));
    } else {
      console.log('MISMATCH ok.test got ' + JSON.stringify(records));
      allOk = false;
    }
  } catch (err) {
    console.log('MISMATCH ok.test threw ' + ((err && err.code) || err));
    allOk = false;
  }
  server.close();
  process.exitCode = allOk ? 0 : 1;
}
main();
PROBEEOF
run_capture node "$TMP_DIR/cares-probe.cjs"
printf '%s\n' "$CAP_OUT" >"$TMP_DIR/cares-probe.out"
assert_eq "c-ares probe exits 0 (every rcode mapped as expected)" 0 "$CAP_RC"
CARES_OK_LINES="$(grep -c '^OK ' "$TMP_DIR/cares-probe.out" || true)"
if [ "$CARES_OK_LINES" -ge 3 ]; then
  note_pass "c-ares probe reported at least 3 OK lines (got $CARES_OK_LINES)"
else
  note_fail "c-ares probe reported at least 3 OK lines (got $CARES_OK_LINES)"
  printf '%s\n' "$CAP_OUT" >&2
fi
assert_contains "real c-ares maps NOERROR/no-answers to ENODATA" \
  "$TMP_DIR/cares-probe.out" "OK nodata.test ENODATA"
assert_contains "real c-ares maps SERVFAIL to ESERVFAIL" \
  "$TMP_DIR/cares-probe.out" "OK servfail.test ESERVFAIL"
assert_contains "real c-ares maps NXDOMAIN to ENOTFOUND" \
  "$TMP_DIR/cares-probe.out" "OK nxdomain.test ENOTFOUND"
assert_contains "real c-ares maps REFUSED to EREFUSED (the UNKNOWN class)" \
  "$TMP_DIR/cares-probe.out" "OK refused.test EREFUSED"
assert_contains "c-ares probe life: a real A answer round-tripped with its ttl" \
  "$TMP_DIR/cares-probe.out" 'OK ok.test [{"address":"1.2.3.4","ttl":5}]'
assert_not_contains "c-ares probe reported no mismatches" \
  "$TMP_DIR/cares-probe.out" "MISMATCH"

# ── 2. The tri-state witness matrix (literal) ──────────────────────────
expect_state() { # <name> <want-state>
  local got
  got="$(dns_override_state)"
  assert_eq "$1" "$2" "$got"
  # Life witness for the same case: a real exec of the resolver happened,
  # and the classification was recorded to the witness file.
  assert_contains "$1: kubectl exec witnessed" "$FAKE_KUBECTL_LOG" \
    "exec deployment/${HCC_DEPLOY} -n ${HCC_NS}"
  assert_contains "$1: witness file recorded" \
    "${EVIDENCE_DIR}/dns-override-witness.txt" "state=$2"
  : >"$FAKE_KUBECTL_LOG"
}

setup_case matrix
set_dns_response "$(records_json 300 93.184.216.34)"
expect_state "non-test answer with ttl 300 is GONE" GONE
set_dns_response "$(jq -cn '{ok:true,records:[{address:"18.154.48.13",ttl:5},{address:"18.154.48.20",ttl:60}]}')"
expect_state "test addresses with one ttl > 5 are GONE" GONE
set_dns_response "$(records_json 5 "${SET_A[@]}" 93.184.216.34)"
expect_state "test set plus a foreign address (not a subset) is GONE" GONE
set_dns_response '{"ok":false,"code":"ENOTFOUND"}'
expect_state "ENOTFOUND is GONE" GONE
assert_contains "ENOTFOUND detail kept" "${EVIDENCE_DIR}/dns-override-witness.txt" "code=ENOTFOUND"
set_dns_response '{"ok":false,"code":"ENODATA"}'
expect_state "ENODATA is GONE" GONE
set_dns_response '{"ok":false,"code":"ESERVFAIL"}'
expect_state "ESERVFAIL is GONE" GONE
assert_contains "ESERVFAIL detail kept" "${EVIDENCE_DIR}/dns-override-witness.txt" "code=ESERVFAIL"
set_dns_response '{"ok":true,"records":[]}'
expect_state "ok with records: [] is GONE" GONE
set_dns_response "$(records_json 5 "${SET_A[@]}")"
expect_state "full set A with every ttl <= 5 is PRESENT" PRESENT
set_dns_response "$(records_json 3 "${SET_B[0]}" "${SET_B[1]}")"
expect_state "subset of set B with every ttl <= 5 is PRESENT" PRESENT
FAKE_DNS_EXEC_RC=1
expect_state "exec failure (transport) is UNKNOWN" UNKNOWN
FAKE_DNS_EXEC_RC=0
set_dns_response '{"ok":false,"code":"ETIMEOUT"}'
expect_state "ETIMEOUT is UNKNOWN" UNKNOWN
set_dns_response '{"ok":false,"code":"EREFUSED"}'
expect_state "any other DNS code is UNKNOWN" UNKNOWN
set_dns_response 'this is not json'
expect_state "malformed answer is UNKNOWN" UNKNOWN
set_dns_response '[{"address":"18.154.48.13","ttl":5}]'
expect_state "sentinel-less (bare array) answer is UNKNOWN" UNKNOWN
set_dns_response '{"ok":true,"records":[{"address":"18.154.48.13","ttl":"5"}]}'
expect_state "non-numeric ttl is UNKNOWN" UNKNOWN

# The wait_until predicate agrees with the classifier on both sides.
set_dns_response '{"ok":false,"code":"ESERVFAIL"}'
if dns_override_gone; then
  note_pass "dns_override_gone is true on GONE"
else
  note_fail "dns_override_gone is true on GONE"
fi
assert_contains "predicate life: exec witnessed" "$FAKE_KUBECTL_LOG" "exec deployment/${HCC_DEPLOY}"
: >"$FAKE_KUBECTL_LOG"
set_dns_response "$(records_json 5 "${SET_A[@]}")"
if dns_override_gone; then
  note_fail "dns_override_gone is false on PRESENT"
else
  note_pass "dns_override_gone is false on PRESENT"
fi
assert_contains "predicate life: exec witnessed (PRESENT)" "$FAKE_KUBECTL_LOG" "exec deployment/${HCC_DEPLOY}"
: >"$FAKE_KUBECTL_LOG"

# The positive witness of phases 2/4/5/6 keeps its observable semantics on
# top of the structured answer: only the exact set with every ttl <= 5
# satisfies dns_is; a DNS error is never read as the expected set.
set_dns_response "$(records_json 5 "${SET_B[@]}")"
if dns_is "$CSV_B"; then
  note_pass "dns_is accepts the exact set with every ttl <= 5"
else
  note_fail "dns_is accepts the exact set with every ttl <= 5"
fi
assert_contains "dns_is life: exec witnessed" "$FAKE_KUBECTL_LOG" "exec deployment/${HCC_DEPLOY}"
: >"$FAKE_KUBECTL_LOG"
if dns_is "$CSV_A"; then
  note_fail "dns_is rejects the other test set"
else
  note_pass "dns_is rejects the other test set"
fi
set_dns_response "$(records_json 300 "${SET_B[@]}")"
if dns_is "$CSV_B"; then
  note_fail "dns_is rejects the exact set when ttl > 5"
else
  note_pass "dns_is rejects the exact set when ttl > 5"
fi
set_dns_response '{"ok":false,"code":"ESERVFAIL"}'
if dns_is "$CSV_B"; then
  note_fail "dns_is rejects a DNS error (never a set match)"
else
  note_pass "dns_is rejects a DNS error (never a set match)"
fi
assert_contains "dns_is life: exec witnessed (error case)" "$FAKE_KUBECTL_LOG" \
  "exec deployment/${HCC_DEPLOY}"
: >"$FAKE_KUBECTL_LOG"

# ── 2b. record_dns_witness: raw line, never an empty diagnostic ────────
# Phase 2's failure branch records the raw structured answer: the DNS error
# code is the whole point of the file, so it must survive verbatim. The old
# dns_actual_set diagnostic printed nothing on exactly this input.
setup_case record-witness
set_dns_response '{"ok":false,"code":"ENOTFOUND"}'
record_dns_witness
assert_contains "record_dns_witness keeps the raw structured error line" \
  "${EVIDENCE_DIR}/dns-witness.txt" '{"ok":false,"code":"ENOTFOUND"}'
assert_contains "record_dns_witness life: exec witnessed" "$FAKE_KUBECTL_LOG" \
  "exec deployment/${HCC_DEPLOY} -n ${HCC_NS}"
: >"$FAKE_KUBECTL_LOG"
rm -f "${EVIDENCE_DIR}/dns-witness.txt"
FAKE_DNS_EXEC_RC=1
record_dns_witness
assert_contains "record_dns_witness records transport instead of an empty file" \
  "${EVIDENCE_DIR}/dns-witness.txt" "transport: kubectl exec failed"
assert_contains "record_dns_witness life: exec attempted (transport case)" \
  "$FAKE_KUBECTL_LOG" "exec deployment/${HCC_DEPLOY} -n ${HCC_NS}"
FAKE_DNS_EXEC_RC=0
: >"$FAKE_KUBECTL_LOG"

# ── 3. cleanup() obeys the contract: HCC restored iff GONE ─────────────
# DNS is down after the Corefile readback (ESERVFAIL): HCC must be restored.
setup_case cleanup-gone
set_dns_response '{"ok":false,"code":"ESERVFAIL"}'
run_strict cleanup
assert_eq "cleanup succeeds when the witness is GONE (ESERVFAIL)" 0 "$LAST_RC"
assert_contains "cleanup deleted the test McpServer" "$FAKE_KUBECTL_LOG" \
  "delete mcpserver ${SERVER}"
assert_contains "cleanup patched the CoreDNS ConfigMap back" "$FAKE_KUBECTL_LOG" \
  "patch configmap ${DNS_CONFIGMAP}"
assert_contains "cleanup restored HCC by patching its Deployment" "$FAKE_KUBECTL_LOG" \
  "patch deployment ${HCC_DEPLOY}"
assert_contains "the HCC rollout went through the deadline runner to the fake binary" \
  "$FAKE_KUBECTL_LOG" "rollout status deployment/${HCC_DEPLOY}"
assert_contains "GONE witness recorded with its code" \
  "${EVIDENCE_DIR}/dns-override-witness.txt" "state=GONE detail=code=ESERVFAIL"
if cmp -s "${EVIDENCE_DIR}/corefile-original.txt" "$FAKE_COREFILE_STATE"; then
  note_pass "the fake ConfigMap holds the restored Corefile byte for byte"
else
  note_fail "the fake ConfigMap holds the restored Corefile byte for byte"
fi

# The override is still served (PRESENT): HCC must NOT be restored, and the
# warning must say the rows are still served — nothing else.
setup_case cleanup-present
set_dns_response "$(records_json 5 "${SET_A[@]}")"
run_strict cleanup
assert_eq "cleanup fails when the witness stays PRESENT" 1 "$LAST_RC"
assert_contains "PRESENT life: the witness really asked (exec)" "$FAKE_KUBECTL_LOG" \
  "exec deployment/${HCC_DEPLOY}"
assert_contains "PRESENT life: the Corefile restore really ran first" "$FAKE_KUBECTL_LOG" \
  "patch configmap ${DNS_CONFIGMAP}"
assert_not_contains "HCC is not restored while PRESENT" "$FAKE_KUBECTL_LOG" \
  "patch deployment ${HCC_DEPLOY}"
assert_contains "PRESENT warning says the rows are still served" "$RUN_OUT" \
  "CoreDNS still served the ${CDN_HOST} test rows"
assert_not_contains "PRESENT warning does not claim could-not-ask" "$RUN_OUT" \
  "could not ask CoreDNS"
assert_contains "PRESENT witness recorded" \
  "${EVIDENCE_DIR}/dns-override-witness.txt" "state=PRESENT"

# The question cannot even be asked (UNKNOWN, exec transport): HCC must NOT
# be restored either, and the warning must not pretend CoreDNS "still
# served" anything.
setup_case cleanup-unknown
FAKE_DNS_EXEC_RC=1
run_strict cleanup
assert_eq "cleanup fails when the witness stays UNKNOWN" 1 "$LAST_RC"
assert_contains "UNKNOWN life: the witness really asked (exec)" "$FAKE_KUBECTL_LOG" \
  "exec deployment/${HCC_DEPLOY}"
assert_contains "UNKNOWN life: the Corefile restore really ran first" "$FAKE_KUBECTL_LOG" \
  "patch configmap ${DNS_CONFIGMAP}"
assert_not_contains "HCC is not restored on UNKNOWN (restoring would be forbidden)" \
  "$FAKE_KUBECTL_LOG" "patch deployment ${HCC_DEPLOY}"
assert_contains "UNKNOWN warning says could-not-ask" "$RUN_OUT" \
  "could not ask CoreDNS whether it stopped serving"
assert_not_contains "UNKNOWN warning does not claim still-served" "$RUN_OUT" \
  "still served the ${CDN_HOST} test rows after"
assert_contains "UNKNOWN witness recorded with the transport detail" \
  "${EVIDENCE_DIR}/dns-override-witness.txt" "state=UNKNOWN detail=transport:"
FAKE_DNS_EXEC_RC=0

# ── 4. Sample consumers drain their producers (SIGPIPE regression) ─────
# More than 5000 samples per file so the producer cannot finish into the
# pipe buffer before a (broken) early-exit consumer would close the pipe.
gen_samples() { # <file> <first-start> <first-outcome> <first-code> <filler-count>
  awk -v start="$2" -v outcome="$3" -v code="$4" -v n="$5" 'BEGIN {
    printf "%s\t%s\t%s\t%s\tuid-1\t2026-01-01T00:00:00Z\t0\n", start, start + 1, outcome, code
    for (i = 0; i < n; i++) print "2000\t2001\tupstream\t200\tuid-1\t2026-01-01T00:00:00Z\t0"
  }' >"$1"
}
samples_life() { # <name> <file>
  local lines
  lines="$(wc -l <"$2")"
  if [ "$lines" -gt 5000 ]; then
    note_pass "$1 (life: $lines samples really in the file)"
  else
    note_fail "$1 (life: only $lines samples in the file)"
  fi
}

# Drive assert_no_rate_limit the way a phase does: under the real EXIT trap,
# so `finish` hands EXIT_CODE/REASON to on_exit, which records the verdict
# line in verdict.txt. REASON itself cannot survive the run_strict subshell,
# so verdict.txt is the observable pin for it. setup_case leaves the fake
# DNS answer at records: [] (GONE), so the cleanup inside on_exit succeeds
# and must not override the rate-limit verdict with restore-failed.
run_rate_limit_under_on_exit() {
  trap on_exit EXIT
  assert_no_rate_limit 0 -1
}

# 429 as the very first branch sample, 20000 innocent samples behind it and
# another full producer after that.
setup_case ratelimit-first-file
gen_samples "$BRANCH_SAMPLES" 1000 upstream 429 20000
gen_samples "$CONTROL_SAMPLES" 3000 upstream 200 20000
samples_life "first-file samples exceed the pipe buffer" "$BRANCH_SAMPLES"
run_strict run_rate_limit_under_on_exit
assert_eq "429 in the first file exits 3, not 141" 3 "$LAST_RC"
assert_eq "429 in the first file ends REASON=upstream-rate-limited" \
  "E2E_CDN_ROTATION_VERDICT=INCONCLUSIVE EXIT=3 REASON=upstream-rate-limited" \
  "$(cat "${EVIDENCE_DIR}/verdict.txt")"
assert_eq "the exact 429 sample was recorded" \
  "$(printf '1000\t1001\tupstream\t429\tuid-1\t2026-01-01T00:00:00Z\t0')" \
  "$(cat "${EVIDENCE_DIR}/upstream-rate-limit.txt")"

# 429 only in the second producer's file: the first producer must be fully
# drained before the hit, the second fully drained after it.
setup_case ratelimit-second-file
gen_samples "$BRANCH_SAMPLES" 3000 upstream 200 20000
gen_samples "$CONTROL_SAMPLES" 777000 upstream 429 20000
samples_life "second-file samples exceed the pipe buffer" "$CONTROL_SAMPLES"
run_strict run_rate_limit_under_on_exit
assert_eq "429 only in the second file exits 3, not 141" 3 "$LAST_RC"
assert_eq "429 only in the second file ends REASON=upstream-rate-limited" \
  "E2E_CDN_ROTATION_VERDICT=INCONCLUSIVE EXIT=3 REASON=upstream-rate-limited" \
  "$(cat "${EVIDENCE_DIR}/verdict.txt")"
assert_eq "the exact second-file 429 sample was recorded" \
  "$(printf '777000\t777001\tupstream\t429\tuid-1\t2026-01-01T00:00:00Z\t0')" \
  "$(cat "${EVIDENCE_DIR}/upstream-rate-limit.txt")"

# No 403/429 anywhere: the same pipeline must return cleanly.
setup_case ratelimit-none
gen_samples "$BRANCH_SAMPLES" 1000 upstream 200 6000
gen_samples "$CONTROL_SAMPLES" 3000 upstream 200 6000
samples_life "clean samples exceed the pipe buffer" "$BRANCH_SAMPLES"
run_strict assert_no_rate_limit 0 -1
assert_eq "no 403/429 returns 0" 0 "$LAST_RC"
if [ -e "${EVIDENCE_DIR}/upstream-rate-limit.txt" ]; then
  note_fail "no rate-limit evidence file is written on a clean run"
else
  note_pass "no rate-limit evidence file is written on a clean run"
fi

# first_failure: same early-exit shape, same fix. A failure as the first of
# 20001 samples must be printed exactly, with exit 0 — not 141.
setup_case first-failure
gen_samples "$BRANCH_SAMPLES" 1000 fail 502 20000
samples_life "first_failure samples exceed the pipe buffer" "$BRANCH_SAMPLES"
run_strict first_failure "$BRANCH_SAMPLES" 0 -1
assert_eq "first_failure exits 0 with the hit first of 20001 samples" 0 "$LAST_RC"
assert_eq "first_failure prints the exact first failure" \
  "$(printf '1000\t1001\tfail\t502\tuid-1\t2026-01-01T00:00:00Z\t0')" \
  "$(cat "$RUN_OUT")"
# And a missing sample file is a loud error, never a masked empty success:
# this is what forbids "fixing" the consumer with `|| :`.
run_strict first_failure "$TMP_DIR/cases/first-failure/absent.tsv" 0 -1
if [ "$LAST_RC" -ne 0 ]; then
  note_pass "first_failure on a missing file fails loud (rc=$LAST_RC)"
else
  note_fail "first_failure on a missing file fails loud (rc=0 means it was masked)"
fi
assert_contains "the missing-file error names the absent file" "$RUN_ERR" "absent.tsv"

# ── 5. on_exit under a broken pipe ─────────────────────────────────────
# SIGPIPE delivered while cleanup is mid-restore must not kill it: the
# restore finishes, reports RESTORE_FAILED (witness PRESENT) and exits 4.
setup_case onexit-sigpipe
DNS_VISIBLE_TIMEOUT=8
set_dns_response "$(records_json 5 "${SET_A[@]}")"
( EXIT_CODE=0; REASON=none; on_exit ) >"$RUN_OUT" 2>"$RUN_ERR" &
onexit_pid=$!
witness_seen=0
for _ in $(seq 1 40); do
  if [ -f "${EVIDENCE_DIR}/dns-override-witness.txt" ]; then witness_seen=1; break; fi
  nap 0.2
done
assert_eq "on_exit reached the witness wait (trap already installed)" 1 "$witness_seen"
if kill -0 "$onexit_pid" 2>/dev/null; then
  note_pass "on_exit still running when SIGPIPE is delivered (life)"
  kill -PIPE "$onexit_pid"
else
  note_fail "on_exit still running when SIGPIPE is delivered (life)"
fi
set +e
wait "$onexit_pid"
onexit_rc=$?
set -e
assert_eq "SIGPIPE during cleanup does not kill the restore (exit 4, not 141)" 4 "$onexit_rc"
assert_contains "the verdict line survived the SIGPIPE" "$RUN_OUT" \
  "E2E_CDN_ROTATION_VERDICT=RESTORE_FAILED EXIT=4 REASON=restore-failed"
assert_contains "the SIGPIPE case was a real PRESENT wait" \
  "${EVIDENCE_DIR}/dns-override-witness.txt" "state=PRESENT"
DNS_VISIBLE_TIMEOUT=3

# A fully closed stdout: the final verdict printf fails, but the earned
# exit code (0, nothing touched) and the verdict file must survive.
setup_case onexit-closed-stdout
COREFILE_TOUCHED=0
HCC_ENV_TOUCHED=0
RESOURCES_CREATED=0
on_exit_closed_stdout() {
  EXIT_CODE=0
  REASON=none
  exec 1>&-
  on_exit
}
run_strict on_exit_closed_stdout
assert_eq "closed stdout does not rewrite the verdict exit code" 0 "$LAST_RC"
assert_contains "the verdict file recorded PASS despite the closed stdout" \
  "${EVIDENCE_DIR}/verdict.txt" "E2E_CDN_ROTATION_VERDICT=PASS EXIT=0 REASON=none"

# ── Summary: zero executed checks is never a pass ──────────────────────
printf 'egress-cdn-rotation-cleanup: %d checks, %d failed\n' "$TESTS_RUN" "$TESTS_FAILED"
[ "$TESTS_RUN" -gt 0 ] || { echo "FAIL: zero checks executed" >&2; exit 1; }
[ "$TESTS_FAILED" -eq 0 ]
