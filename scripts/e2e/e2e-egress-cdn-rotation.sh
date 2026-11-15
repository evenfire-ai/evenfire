#!/usr/bin/env bash
# shellcheck disable=SC2329  # helpers are invoked indirectly via wait_until "$@" and the traps
# ═══════════════════════════════════════════════════════════════════════
# e2e-egress-cdn-rotation.sh — issue #549 CDN answer-set rotation proof.
#
# MANUAL gate. It is NOT part of T0/T1/T2 and NOT part of CI: it rewrites
# cluster DNS, restarts the host-context-controller (HCC) and needs Internet.
#
# WHAT IT PROVES
#   With real Calico, a real HCC, the branch egress-proxy image and real TLS
#   against CloudFront, when `mcp.airtable.com` (CDN_HOST) switches to a
#   different four-address answer set and the old set is pruned from the
#   exact-host NetworkPolicy:
#     - the branch proxy (`server <host>:443 resolve;`) keeps serving through
#       CloudFront without the pod restarting, and
#     - a control proxy rendered from the same HCC ConfigMap but with one
#       verified transformation (`proxy_pass https://remote_upstream…;` →
#       `proxy_pass https://<host>…;`, the `dev` template shape) stops serving
#       while its pinned set is outside the policy and recovers when the set
#       returns, without restarting.
#   The control is the causality witness: same host, same policy, same image,
#   only the template differs. Phases 3 and 4 validate B and A first (the
#   branch starts on B, the control starts on A), so a branch failure with the
#   policy exactly equal to the new set is a product failure (exit 1), never
#   "B may be invalid".
#
# TEST-ONLY CHANGES (all restored and re-verified on exit)
#   (1) HCC Deployment `control-plane/host-context-controller`:
#       HCC_EXTERNAL_EGRESS_OVERLAP_SEC=60, HCC_EXTERNAL_EGRESS_RESYNC_SEC=10
#       (valid: 10 >= floor 5 and 2 x 10 <= 60). The original container `env`
#       is saved as one JSON array and restored exactly.
#   (2) CoreDNS ConfigMap `kube-system/coredns`: four `<ip> <CDN_HOST>` rows and
#       `ttl 5` are added to the single existing `hosts` block. CoreDNS reloads
#       itself (`reload` plugin); it is never restarted. The whole Corefile is
#       saved and restored byte for byte.
#   Both objects carry `clerum.io/e2e-temporary-override: e2e-egress-cdn-rotation`
#   in `metadata.annotations` (never in the pod template) while the override
#   lasts. If any restoration step fails the run exits 4 even if it passed, and
#   prints the exact manual repair commands.
#
# SIDE EFFECTS WHILE IT RUNS
#   - `ttl 5` applies to every row of the `hosts` block, including
#     `host.minikube.internal`.
#   - With overlap 60, every exact-host egress binding of the profile uses the
#     short window for the duration; phase 0 lists them in the evidence.
#   - HCC's effective re-resolution cadence with TTL 5 is 5 s
#     (externalEgressResyncDelayMs clamps to min(configured, TTL/2) with a 5 s
#     floor), although its startup log always says "every 10s".
#
# HOW TO RUN
#   It must run under the canonical branch-profile mutation lease; the first
#   step is scripts/minikube/require-t2-mutation-lock.sh.
#
#     CONTEXT=<branch-scoped minikube context>
#     MINIKUBE_PROFILE="$CONTEXT" CONTROL_API_REAL_PG_CONTEXT="$CONTEXT" \
#     KUBECONTEXT="$CONTEXT" \
#     CDN_SET_A="<ip1> <ip2> <ip3> <ip4>" \
#     CDN_SET_B="<ip1> <ip2> <ip3> <ip4>" \
#     E2E_CDN_EVIDENCE_DIR=.local-notes/infra/runs/egress-cdn-rotation/$(date +%Y%m%dT%H%M%S) \
#       bash scripts/minikube/with-t2-mutation-lock.sh -- \
#         bash scripts/e2e/e2e-egress-cdn-rotation.sh
#
#   CDN_SET_A and CDN_SET_B are required: CloudFront answers age out. Collect
#   two complete, disjoint four-address answers of CDN_HOST (default
#   mcp.airtable.com) from a public resolver, for example:
#
#     while true; do date +%T; dig +short A mcp.airtable.com @1.1.1.1 | sort; sleep 30; done
#
#   Observed on 2026-10-30:
#     A = 18.154.48.13 18.154.48.20 18.154.48.43 18.154.48.50
#     B = 18.172.153.11 18.172.153.14 18.172.153.41 18.172.153.115
#
# INPUTS
#   KUBECONTEXT          required, branch-scoped (`clerum-…-<8 hex>`), equal to
#                        MINIKUBE_PROFILE and CONTROL_API_REAL_PG_CONTEXT.
#   CDN_SET_A, CDN_SET_B required, four distinct public IPv4 each, disjoint.
#   CDN_HOST             default mcp.airtable.com.
#   E2E_CDN_MUTATION     empty (normal run) | control-uses-fixed-template |
#                        branch-probe-reads-control.
#   E2E_CDN_EVIDENCE_DIR evidence directory; alternatively the first argument.
#                        Required: this script writes no ephemeral fallback.
#
# EXIT CODES / LAST LINE
#   0 PASS — the branch proxy rotated and the control failed then recovered.
#   1 FAIL — a product assertion failed (branch pinned/restarted, control did
#            not fail or did not recover, transition budget exceeded).
#   2 PRECONDITION — inputs, ownership, lease, cluster prerequisites, leftovers
#            or a harness witness were wrong; nothing was measured.
#   3 INCONCLUSIVE — B or A could not be validated (DNS/HCC/policy timing,
#            upstream 403/429, probe unavailable, `interrupted`,
#            `unexpected-error`). Not a product verdict. The complete REASON
#            list lives in docs/testing/egress-cdn-rotation.md; this header
#            only names the exit classes so the two cannot drift apart.
#   4 RESTORE_FAILED — the profile was not restored; takes precedence over any
#            other code and prints the manual repair commands.
#   The last stdout line is always:
#     E2E_CDN_ROTATION_VERDICT=<PASS|FAIL|PRECONDITION|INCONCLUSIVE|RESTORE_FAILED> EXIT=<n> REASON=<id>
#   Read the verdict from that line, not from the wrapper's exit status.
#
# CLEANUP RESTORE CONTRACT (written before the code that implements it)
#   HCC is restored if and only if `restore_corefile` proved its readback
#   AND the served-DNS witness is GONE. The witness classifies one
#   `resolve4`-with-TTL answer from inside the HCC pod into three states:
#
#     Observation                                            State   Action
#     -----------------------------------------------------  ------  ------------
#     Non-empty answer that is NOT "address set ⊆ A ∪ B    GONE    Restore HCC
#       and every ttl <= 5" — including real A/B answers
#       with some ttl > 5
#     ENOTFOUND, ENODATA or ESERVFAIL                      GONE    Restore HCC
#     ok answer with records: []                           GONE    Restore HCC
#       (belt row: Node normally reports NODATA by code)
#     Non-empty subset of A ∪ B — either set, part of      PRESENT Wait; do not
#       one, or a mix of both — with every ttl <= 5                restore
#     exec ≠ 0, ETIMEOUT, any other DNS code, malformed    UNKNOWN Do not restore;
#       or sentinel-less answer, non-numeric ttl                   warn "could
#                                                                    not ask"
#
#   SERVFAIL counts as GONE because of CoreDNS plugin order, not Corefile
#   text order: the authoritative `hosts` plugin answers before `forward`,
#   and the positive `dns_is` witnesses of phases 2/4 prove that when the
#   hosts block is loaded it does answer. So once the restored Corefile is
#   read back, a SERVFAIL can only come from the forwarded upstream — the
#   test rows are no longer what CoreDNS serves. A real upstream that
#   happened to serve only addresses drawn from A ∪ B with ttl <= 5 would
#   read as PRESENT and merely delay the HCC restore until the bounded wait ends:
#   a declared fail-safe residual, not a guaranteed self-heal. Restoring
#   HCC on UNKNOWN is forbidden. The last classification is recorded in
#   `dns-override-witness.txt` in the evidence directory.
#
# PHASES
#   0 preconditions + lease. 1 HCC env. 2 CoreDNS = B. 3 McpServer, policy = B.
#   4 CoreDNS = A, policy = A, control starts on A. 5 A→B. 6 B→A.
#   7 cleanup and restoration (CoreDNS first, then HCC).
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"

# shellcheck source=/dev/null  # e2e-lib.sh is a source library, not a shellcheck input
source "${SCRIPT_DIR}/e2e-lib.sh"

# ── Fixed topology ─────────────────────────────────────────────────────
HCC_NS="control-plane"
HCC_DEPLOY="host-context-controller"
HCC_CONTAINER="host-context-controller"
DNS_NS="kube-system"
DNS_CONFIGMAP="coredns"
RECIPE_NS="${RECIPE_NS:-mcp-server}"
SERVER="e2e-cdn-rotation"
CONTROL="e2e-cdn-rotation-dev-control"
TRANSPORT_PORT=3000
# The egress binding port: HCC names the exact-host policy
# ext-egress-<server>-<dns>-<binding port> (networkPolicyReconciler.ts).
UPSTREAM_PORT=443
OVERRIDE_ANNOTATION="clerum.io/e2e-temporary-override"
OVERRIDE_VALUE="e2e-egress-cdn-rotation"
# Phase 1's accelerated overlap. deploy/base declares the key with its production
# value, so only this value marks a leftover override.
HCC_TEST_OVERLAP_SEC=60
STATE_ANNOTATION="clerum.io/egress-fqdn-state"

# ── Bounded waits (seconds unless the suffix says otherwise) ───────────
PROBE_INTERVAL=10
POLICY_INTERVAL=5
PROBE_MAX_TIME=15
DNS_VISIBLE_TIMEOUT=150
POLICY_CONVERGE_MS=90000
PROXY_UPSTREAM_TIMEOUT=120
CONTROL_FAIL_TIMEOUT=120
CONTROL_RECOVER_TIMEOUT=60
WINDOW_MAX_DELTA_MS=65000
HCC_ROLLOUT_TIMEOUT=600
WORKLOAD_READY_TIMEOUT=180
RESOURCE_DELETE_TIMEOUT=180

# ── Run state (read by the EXIT trap; keep every name defined) ─────────
EXIT_CODE=0
REASON=none
EVIDENCE_DIR=""
CDN_HOST="${CDN_HOST:-mcp.airtable.com}"
MUTATION="${E2E_CDN_MUTATION:-}"
SET_A=()
SET_B=()
CSV_A=""
CSV_B=""
EXPECTED_A_CIDRS=""
EXPECTED_B_CIDRS=""
EXPECTED_A_JSON="[]"
EXPECTED_B_JSON="[]"
POLICY_NAME=""
HCC_ENV_INDEX=0
HCC_ENV_ORIGINAL=""
HCC_ENV_TOUCHED=0
COREFILE_TOUCHED=0
RESOURCES_CREATED=0
BRANCH_POD=""
BRANCH_UID=""
BRANCH_STARTED=""
BRANCH_RESTARTS=""
CONTROL_POD=""
CONTROL_UID=""
CONTROL_STARTED=""
CONTROL_RESTARTS=""
BRANCH_READY_MS=0
CONTROL_READY_MS=0
T_MCPSERVER_MS=0
T_PATCH_MS=0
T_POLICY_MS=0
BRANCH_LOOP_PID=""
CONTROL_LOOP_PID=""
POLICY_LOOP_PID=""
BRANCH_SAMPLES=""
CONTROL_SAMPLES=""
POLICY_SAMPLES=""
BRANCH_REDIRECT_FILE=""
ORIGINAL_COREFILE=""
# Last tri-state classification of the served-DNS cleanup witness
# (GONE | PRESENT | UNKNOWN) and its detail (DNS code or answer summary).
DNS_WITNESS_STATE=UNKNOWN
DNS_WITNESS_DETAIL="never-asked"

usage() {
  cat <<'EOF'
usage: e2e-egress-cdn-rotation.sh [EVIDENCE_DIR]

Required environment: KUBECONTEXT, CDN_SET_A, CDN_SET_B.
Optional: CDN_HOST (default mcp.airtable.com), E2E_CDN_MUTATION (empty,
control-uses-fixed-template, branch-probe-reads-control), E2E_CDN_EVIDENCE_DIR.
Read the header of this script for the full contract.
EOF
}

# ── Small helpers ──────────────────────────────────────────────────────
ms_now() { python3 -c 'import time; print(int(time.time() * 1000))'; }

finish() { # <exit-code> <reason-id>
  EXIT_CODE=$1
  REASON=$2
  exit "$1"
}

wait_until() { # <timeout-s> <description> <command...>
  local timeout=$1 description=$2
  shift 2
  local deadline
  deadline=$(( $(date +%s) + timeout ))
  while :; do
    if "$@"; then return 0; fi
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 1
  done
  printf 'timed out after %ss waiting for %s\n' "$timeout" "$description" >&2
  return 1
}

count_substr() { # <needle> ; reads stdin
  awk -v needle="$1" 'index($0, needle) { n++ } END { print n + 0 }'
}

exists() { kctl get "$@" --request-timeout=20s >/dev/null 2>&1; }

# FAIL-CLOSED absence predicate: true ONLY when the API server positively
# answered `(NotFound)` for that exact object. A successful get means present;
# any other failure (RBAC, request timeout, apiserver/proxy error, unusable
# kubeconfig) is "absence not proven" and must never satisfy a leftover or a
# restore check. Anchored on the API-server reason so a kubeconfig-level
# `context "…" not found` can never read as a confirmed absence.
resource_absent() { # <kind> <name> [kubectl args, e.g. -n <namespace>]
  local err
  err="$(kctl get "$@" --request-timeout=20s 2>&1 >/dev/null)" && return 1
  [[ "$err" == *"(NotFound)"* ]]
}

is_public_ipv4() {
  local ip=$1 a b c d
  # Canonical dotted decimal only: no leading zeros, so the token is also the
  # form CoreDNS and nginx `resolve` report back in the live comparisons.
  [[ "$ip" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
  a=$((10#${BASH_REMATCH[1]}))
  b=$((10#${BASH_REMATCH[2]}))
  c=$((10#${BASH_REMATCH[3]}))
  d=$((10#${BASH_REMATCH[4]}))
  [ "$a" -le 255 ] && [ "$b" -le 255 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ] || return 1
  case "$a" in
    0|10|127) return 1 ;;
    100) [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 1 ;;
    169) [ "$b" -eq 254 ] && return 1 ;;
    172) [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 1 ;;
    192)
      [ "$b" -eq 168 ] && return 1
      [ "$b" -eq 0 ] && { [ "$c" -eq 2 ] || [ "$c" -eq 0 ]; } && return 1
      ;;
    198)
      { [ "$b" -eq 18 ] || [ "$b" -eq 19 ]; } && return 1
      [ "$b" -eq 51 ] && [ "$c" -eq 100 ] && return 1
      ;;
    203) [ "$b" -eq 0 ] && [ "$c" -eq 113 ] && return 1 ;;
  esac
  [ "$a" -ge 224 ] && return 1
  return 0
}

normalize_set() { # <raw> -> four distinct public IPv4 in canonical dotted decimal, space separated
  local raw=$1 ip out="" n=0
  # shellcheck disable=SC2086  # word splitting is the parser here
  for ip in ${raw//,/ }; do
    is_public_ipv4 "$ip" || return 1
    case "${out} " in *" ${ip} "*) return 1 ;; esac
    out="${out} ${ip}"
    n=$((n + 1))
  done
  [ "$n" -eq 4 ] || return 1
  printf '%s\n' "${out# }"
}

csv_of() { # <word...>
  local item
  for item in "$@"; do printf '%s\n' "$item"; done | sort | paste -sd, -
}

cidrs_of() { # <word...>
  local item
  for item in "$@"; do printf '%s/32\n' "$item"; done | sort | paste -sd, -
}

sets_disjoint() {
  local a b
  for a in "${SET_A[@]}"; do
    for b in "${SET_B[@]}"; do
      [ "$a" = "$b" ] && return 1
    done
  done
  return 0
}

# ── Kubernetes helpers (every call names --context through kctl) ───────
ready_pod() { # <namespace> <label-selector>
  kctl get pods -n "$1" -l "$2" --request-timeout=20s -o json 2>/dev/null | jq -r '
    [.items[]
     | select(.metadata.deletionTimestamp == null and .status.phase == "Running")
     | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))
     | .metadata.name]
    | if length == 1 then .[0] else "" end'
}

pod_identity() { # <namespace> <pod> -> uid \t startedAt \t restartCount
  kctl get pod "$2" -n "$1" --request-timeout=20s -o json 2>/dev/null | jq -r '
    .metadata.uid as $uid
    | ([.status.containerStatuses[]? | select(.name == "egress-proxy")] | first) as $cs
    | [$uid, ($cs.state.running.startedAt // ""), (($cs.restartCount // -1) | tostring)]
    | @tsv'
}

policy_cidrs() {
  kctl get networkpolicy "$POLICY_NAME" -n "$RECIPE_NS" --request-timeout=20s -o json 2>/dev/null |
    jq -r '[.spec.egress[]?.to[]?.ipBlock.cidr?]
      | map(select(. != null)) | unique | sort | join(",")'
}

policy_state_json() {
  kctl get networkpolicy "$POLICY_NAME" -n "$RECIPE_NS" --request-timeout=20s -o json 2>/dev/null |
    jq -r --arg key "$STATE_ANNOTATION" '.metadata.annotations[$key] // empty'
}

hcc_pod() { ready_pod "$HCC_NS" "app=${HCC_DEPLOY}"; }

# The pod-side resolver snippet always exits 0 when Node itself ran and
# prints exactly one structured JSON line: {ok:true,records:[{address,ttl}]}
# or {ok:false,code:"<dns error code>"}. That keeps `kubectl exec` ≠ 0
# meaning transport (RBAC, API, pod gone) and preserves the DNS error code,
# which is the only evidence that separates "authoritatively gone" from
# "could not ask" in the cleanup contract in the header.
DNS_RESOLVER_SNIPPET='require("dns").promises.resolve4(process.argv[1],{ttl:true}).then(r=>console.log(JSON.stringify({ok:true,records:r}))).catch(e=>console.log(JSON.stringify({ok:false,code:(e&&e.code)||"ERR"})))'

# One raw structured answer from inside the HCC pod. Fails only on transport:
# a DNS-level answer (including an error code) is data, not a failure.
dns_exec_raw() {
  kctl exec "deployment/${HCC_DEPLOY}" -n "$HCC_NS" -c "$HCC_CONTAINER" --request-timeout=40s -- \
    node -e "$DNS_RESOLVER_SNIPPET" "$CDN_HOST"
}

# Positive witness for phases 2/4/5/6: a non-empty records array of
# {address, ttl}. Fails on transport, on any DNS error code and on a
# malformed or empty answer, so no caller can mistake an executor/RBAC
# error — or a resolver that stopped answering — for the expected set.
dns_ttl_records() {
  local raw
  raw="$(dns_exec_raw)" || return 1
  printf '%s' "$raw" | jq -e '.ok == true and (.records | type) == "array" and (.records | length) > 0' >/dev/null || return 1
  printf '%s' "$raw" | jq -c '.records'
}

dns_actual_set() { # prints the sorted address CSV, or fails
  dns_ttl_records | jq -er '
    select(all(.[]; (.ttl | type) == "number" and .ttl <= 5))
    | map(.address) | sort | join(",")'
}

# The cleanup witness, implementing the header contract literally. One query
# is classified as GONE (CoreDNS authoritatively no longer serves the test
# rows), PRESENT (it still serves a non-empty subset of A ∪ B — either set,
# part of one, or a mix of both — with every ttl <= 5) or UNKNOWN (the
# question could not be asked or the answer cannot be trusted).
# The classification always succeeds — UNKNOWN is a result, not an error —
# and the last state/detail are kept in DNS_WITNESS_* and in
# `dns-override-witness.txt` so cleanup can warn truthfully after a timeout.
dns_refresh_witness() {
  local raw classified test_json
  DNS_WITNESS_STATE=UNKNOWN
  if ! raw="$(dns_exec_raw)"; then
    DNS_WITNESS_DETAIL="transport: kubectl exec failed"
  else
    test_json="$(jq -cn '$ARGS.positional' --args "${SET_A[@]}" "${SET_B[@]}")"
    # jq's own parse noise stays off stderr: this runs once a second inside
    # the bounded wait, and the failure is already recorded as the detail.
    classified="$(printf '%s' "$raw" | jq -r --argjson testset "$test_json" 2>/dev/null '
      if (type != "object") or ((.ok | type) != "boolean") then
        ["UNKNOWN", "malformed answer (no structured ok sentinel)"]
      elif .ok == false then
        if (.code | type) != "string" then
          ["UNKNOWN", "DNS error without a code"]
        elif .code == "ENOTFOUND" or .code == "ENODATA" or .code == "ESERVFAIL" then
          ["GONE", ("code=" + .code)]
        else
          ["UNKNOWN", ("code=" + .code)]
        end
      elif (.records | type) != "array" then
        ["UNKNOWN", "records is not an array"]
      elif (.records | length) == 0 then
        ["GONE", "code=EMPTY records=[]"]
      elif any(.records[]; ((.address | type) != "string") or ((.ttl | type) != "number")) then
        ["UNKNOWN", "record without a string address or with a non-numeric ttl"]
      elif all(.records[]; .ttl <= 5 and (.address as $a | ($testset | index($a)) != null)) then
        ["PRESENT", ("addresses=" + ([.records[].address] | sort | join(",")))]
      else
        ["GONE", ("addresses=" + ([.records[].address] | sort | join(",")))]
      end | @tsv')" || classified=""
    if [ -z "$classified" ]; then
      DNS_WITNESS_DETAIL="malformed answer (not structured JSON)"
    else
      DNS_WITNESS_STATE="${classified%%$'\t'*}"
      DNS_WITNESS_DETAIL="${classified#*$'\t'}"
    fi
  fi
  if [ -n "$EVIDENCE_DIR" ] && [ -d "$EVIDENCE_DIR" ]; then
    printf 'state=%s detail=%s host=%s\n' \
      "$DNS_WITNESS_STATE" "$DNS_WITNESS_DETAIL" "$CDN_HOST" \
      >"${EVIDENCE_DIR}/dns-override-witness.txt" 2>/dev/null || :
  fi
  return 0
}

dns_override_state() { # prints GONE | PRESENT | UNKNOWN
  dns_refresh_witness
  printf '%s\n' "$DNS_WITNESS_STATE"
}

# wait_until predicate for cleanup: true only on GONE. PRESENT keeps waiting
# because the override is still served; UNKNOWN keeps waiting because
# restoring HCC on "could not ask" is forbidden by the contract.
dns_override_gone() {
  dns_refresh_witness
  [ "$DNS_WITNESS_STATE" = GONE ]
}

dns_is() { # <expected-csv>
  local actual
  actual="$(dns_actual_set)" || return 1
  [ "$actual" = "$1" ]
}

# Phase-2 timeout diagnostic only: never a verdict input. Records the raw
# structured resolver line so the DNS error code survives in the evidence —
# the filtered dns_actual_set prints nothing exactly when DNS is broken,
# which is when that code is the only useful clue. A transport failure is
# recorded as itself, never as an empty file. Always succeeds.
record_dns_witness() {
  local raw
  if raw="$(dns_exec_raw)"; then
    printf '%s\n' "$raw" >>"${EVIDENCE_DIR}/dns-witness.txt" || :
  else
    printf 'transport: kubectl exec failed\n' >>"${EVIDENCE_DIR}/dns-witness.txt" || :
  fi
  return 0
}

observed_at() { # <ips-json> <from-ms> -> first lastObservedAt of a target address
  # lastObservedAt is written by HCC on the minikube clock; `from` is a host
  # clock timestamp (ms_now). A large host/pod skew only moves the deadlines
  # below (towards INCONCLUSIVE when the pod clock lags): every verdict still
  # requires the policy to equal the exact expected address set.
  local state
  state="$(policy_state_json || :)" || return 1
  [ -n "$state" ] || return 1
  printf '%s' "$state" | jq -er --argjson ips "$1" --argjson from "$2" '
    [ .[] | select(.ip as $ip | $ips | index($ip)) | select(.lastObservedAt >= $from) | .lastObservedAt ]
    | if length > 0 then min else empty end'
}

hcc_log_has_resync() {
  local pod
  pod="$(hcc_pod)" || return 1
  [ -n "$pod" ] || return 1
  # No grep -q here: under pipefail it closes the pipe on the first match and
  # kubectl dies with SIGPIPE (141), reporting "not found" for a present line.
  kctl logs "$pod" -n "$HCC_NS" -c "$HCC_CONTAINER" --tail=5000 --request-timeout=30s 2>/dev/null |
    grep -F 'periodic DNS resync enabled (every 10s' >/dev/null
}

hcc_env_json() {
  kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" --request-timeout=20s -o json |
    jq -c --argjson i "$HCC_ENV_INDEX" '.spec.template.spec.containers[$i].env'
}

# Every `rollout status` of the HCC Deployment runs under a finite external
# deadline. kubectl's --timeout bounds the API-side wait, but a hung client, a
# stuck credential plugin or a lost connection can outlive it; the repository
# runner adds a wall-clock bound above HCC_ROLLOUT_TIMEOUT plus a finite
# heartbeat and kill grace, and records both in the evidence log. The runner
# execs `"$KUBECTL_BIN" --context …` directly because kctl is a shell function
# and cannot be spawned.
hcc_rollout_status() {
  local log="${EVIDENCE_DIR}/hcc-rollout-deadline.log"
  [ -n "$EVIDENCE_DIR" ] || log=/dev/null
  node "${ROOT}/scripts/minikube/run-with-deadline.mjs" \
    --timeout-seconds "$((HCC_ROLLOUT_TIMEOUT + 60))" \
    --heartbeat-seconds 20 --kill-grace-seconds 5 \
    --label e2e-cdn-rotation-hcc-rollout -- \
    "$KUBECTL_BIN" --context "$E2E_KUBECONTEXT" rollout status "deployment/${HCC_DEPLOY}" \
    -n "$HCC_NS" --timeout="${HCC_ROLLOUT_TIMEOUT}s" \
    >>"$log" 2>&1
}

# ── Probe loop (one independent loop per pod, plus one for the policy) ─
proxy_port() { # <namespace> <pod> ; the egress-proxy container port the Deployment declares
  local port
  port="$(kctl get pod "$2" -n "$1" \
    -o jsonpath='{.spec.containers[?(@.name=="egress-proxy")].ports[0].containerPort}')" || return 1
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$port"
}

probe_pod() { # <namespace> <pod> <max-time> ; prints the raw curl transcript
  # The probe runs inside the pod against the container port its Deployment
  # declares, so only the proxy -> upstream hop crosses the network.
  local port
  # A port that cannot be read is an executor error (no PROBE_BEGIN), never a
  # network failure of the proxy.
  port="$(proxy_port "$1" "$2")" || { printf 'PROBE_PORT_UNAVAILABLE\n'; return 0; }
  # shellcheck disable=SC2016  # $?, $1 and $2 belong to the pod-side shell
  kctl exec "$2" -n "$1" -c egress-proxy --request-timeout=40s -- sh -c '
    printf "PROBE_BEGIN\n"
    curl -sS -o /dev/null -D - -w "\n%{http_code}\n" --max-time "$1" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      --data-binary "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"e2e-egress-cdn-rotation\",\"version\":\"1.0.0\"}}}" \
      "http://127.0.0.1:$2/mcp"
    printf "CURL_EXIT=%s\n" "$?"
  ' -- "$3" "$port" 2>&1
}

classify_probe() { # reads the transcript
  awk '
    /^PROBE_BEGIN$/ { seen = 1; next }
    /^CURL_EXIT=/ { split($0, part, "="); curl = part[2]; next }
    {
      line = tolower($0)
      if (line ~ /^[0-9][0-9][0-9]$/) { code = line; next }
      if (line ~ /^x-amz-cf-id:/) { cloudfront = 1 }
      if (line ~ /^via:/ && line ~ /cloudfront/) { cloudfront = 1 }
    }
    END {
      if (seen != 1 || curl == "") { print "exec-error\t000"; exit }
      if (code == "") { code = "000" }
      if (cloudfront == 1) { print "upstream\t" code } else { print "fail\t" code }
    }'
}

probe_loop() { # <kind> <identity-label> <exec-label> <file>
  local kind=$1 identity_label=$2 exec_label=$3 out=$4
  local start end target exec_target identity uid started restarts raw parsed outcome code
  while :; do
    start="$(ms_now)"
    if [ "$kind" = branch ] && [ -f "$BRANCH_REDIRECT_FILE" ]; then
      exec_label="app=${CONTROL}"
    fi
    target="$(ready_pod "$RECIPE_NS" "$identity_label")" || target=""
    identity=""
    if [ -n "$target" ]; then
      identity="$(pod_identity "$RECIPE_NS" "$target")" || identity=""
    fi
    if [ -z "$identity" ]; then
      uid="-"
      started="-"
      restarts="-"
    else
      IFS=$'\t' read -r uid started restarts <<<"$identity"
    fi
    exec_target=""
    if [ -n "$target" ]; then
      if [ "$exec_label" = "$identity_label" ]; then
        exec_target=$target
      else
        exec_target="$(ready_pod "$RECIPE_NS" "$exec_label")" || exec_target=""
      fi
    fi
    if [ -z "$exec_target" ]; then
      outcome=exec-error
      code=000
      end="$(ms_now)"
    else
      raw="$(probe_pod "$RECIPE_NS" "$exec_target" "$PROBE_MAX_TIME" || :)"
      parsed="$(printf '%s' "$raw" | classify_probe)"
      outcome="${parsed%%$'\t'*}"
      code="${parsed#*$'\t'}"
      end="$(ms_now)"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$start" "$end" "$outcome" "$code" "$uid" "$started" "$restarts" >>"$out"
    sleep "$PROBE_INTERVAL"
  done
}

policy_loop() { # <file>
  local cidrs
  while :; do
    cidrs="$(policy_cidrs)" || cidrs=""
    [ -n "$cidrs" ] || cidrs="-"
    printf '%s\t%s\n' "$(ms_now)" "$cidrs" >>"$1"
    sleep "$POLICY_INTERVAL"
  done
}

start_loops() {
  if [ -z "$BRANCH_LOOP_PID" ] && [ -n "$BRANCH_UID" ]; then
    probe_loop branch "app=${SERVER}" "app=${SERVER}" "$BRANCH_SAMPLES" &
    BRANCH_LOOP_PID=$!
  fi
  if [ -z "$CONTROL_LOOP_PID" ] && [ -n "$CONTROL_UID" ]; then
    probe_loop control "app=${CONTROL}" "app=${CONTROL}" "$CONTROL_SAMPLES" &
    CONTROL_LOOP_PID=$!
  fi
}

stop_loops() {
  local pid
  for pid in "${BRANCH_LOOP_PID:-}" "${CONTROL_LOOP_PID:-}" "${POLICY_LOOP_PID:-}"; do
    [ -n "$pid" ] || continue
    if kill "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || :
    fi
  done
  BRANCH_LOOP_PID=""
  CONTROL_LOOP_PID=""
  POLICY_LOOP_PID=""
}

# ── Sample-file assertions ─────────────────────────────────────────────
samples_between() { # <file> <from-ms> <to-ms> ; to = -1 means open
  awk -F'\t' -v from="$2" -v to="$3" '($1 + 0) >= from && (to < 0 || ($1 + 0) < to)' "$1"
}

count_failures() { # <file> <from-ms> <to-ms>
  samples_between "$1" "$2" "$3" | awk -F'\t' '$3 == "fail" { n++ } END { print n + 0 }'
}

# Pipe rule for every helper below: under `set -o pipefail`, no consumer may
# stop reading early (`grep -q`, `awk '{print; exit}'`, `head`) while a
# producer is still writing into the same pipe. The consumer's early exit
# SIGPIPEs the producer (141), pipefail surfaces 141 as the pipeline status,
# and `set -e` then aborts with a raw status that on_exit can only report as
# `unexpected-error`. Consumers that need "the first match" therefore read
# to EOF, remember the first hit and print it from END. Masking the pipeline
# with `|| :` is not an alternative: it would also hide a missing sample
# file or a broken awk and turn either into a silent false negative.
first_failure() { # <file> <from-ms> <to-ms>
  samples_between "$1" "$2" "$3" | awk -F'\t' '
    $3 == "fail" && !seen { line = $0; seen = 1 }
    END { if (seen) print line }'
}

has_upstream_since() { # <file> <from-ms>
  awk -F'\t' -v from="$2" '($1 + 0) >= from && $3 == "upstream" { found = 1; exit }
    END { exit(found ? 0 : 1) }' "$1"
}

has_result_since() { # <file> <from-ms> ; a network result, not an executor error
  awk -F'\t' -v from="$2" '($1 + 0) >= from && ($3 == "upstream" || $3 == "fail") { found = 1; exit }
    END { exit(found ? 0 : 1) }' "$1"
}

streak_of_failures() { # <file> <from-ms> <limit-ms> <needed>
  awk -F'\t' -v from="$2" -v limit="$3" -v needed="$4" '
    ($1 + 0) >= from && ($1 + 0) <= from + limit {
      if ($3 == "fail") { n++; if (n >= needed) { found = 1; exit } }
      else if ($3 == "upstream") { n = 0 }
    }
    END { exit(found ? 0 : 1) }' "$1"
}

identity_mismatch() { # <file> <uid> <started-at> <restart-count>
  awk -F'\t' -v uid="$2" -v started="$3" -v restarts="$4" '
    NF >= 7 && $5 != "-" && ($5 != uid || $6 != started || ($7 + 0) != (restarts + 0)) { print; exit }' "$1"
}

assert_no_rate_limit() { # <from-ms> <to-ms>
  local hit
  # Consume-all consumer (see the pipe rule above): both producers must be
  # drained even when the first sample already carries the 403/429, or the
  # second one dies with SIGPIPE and the run reports `unexpected-error`
  # instead of `upstream-rate-limited`.
  hit="$(
    {
      samples_between "$BRANCH_SAMPLES" "$1" "$2"
      samples_between "$CONTROL_SAMPLES" "$1" "$2"
    } | awk -F'\t' '
      $3 == "upstream" && ($4 == "403" || $4 == "429") && !seen { line = $0; seen = 1 }
      END { if (seen) print line }'
  )"
  [ -z "$hit" ] && return 0
  printf '%s\n' "$hit" >>"${EVIDENCE_DIR}/upstream-rate-limit.txt"
  fail "the upstream rejected an unauthenticated probe (rate limit or block)"
  finish 3 upstream-rate-limited
}

sample_time_for_set() { # <file> <expected-csv> <from-ms>
  awk -F'\t' -v want="$2" -v from="$3" '($1 + 0) >= from && $2 == want { print $1; exit }' "$1"
}

# ── Cleanup and restoration (CoreDNS first, then HCC) ──────────────────
print_manual_repair() {
  [ -n "$EVIDENCE_DIR" ] && [ -d "$EVIDENCE_DIR" ] || return 0
  local ctx=${KUBECONTEXT:-}
  {
    echo "MANUAL REPAIR REQUIRED — the profile is still modified:"
    # CoreDNS first, then HCC, for the same reason as cleanup: a restored HCC
    # that reconciles while the override Corefile is still served can persist
    # the test answer set and `ttl 5` into the profile's egress bindings.
    echo "  kubectl --context=${ctx} -n ${DNS_NS} patch configmap ${DNS_CONFIGMAP} --type=merge \\"
    echo "    -p \"\$(jq -cn --rawfile cf ${EVIDENCE_DIR}/corefile-original.txt '{data:{Corefile:\$cf},metadata:{annotations:{\"${OVERRIDE_ANNOTATION}\":null}}}')\""
    echo "  kubectl --context=${ctx} -n ${HCC_NS} patch deployment ${HCC_DEPLOY} --type=json \\"
    echo "    -p \"\$(cat ${EVIDENCE_DIR}/hcc-env-restore.json)\""
    echo "  kubectl --context=${ctx} -n ${HCC_NS} annotate deployment ${HCC_DEPLOY} ${OVERRIDE_ANNOTATION}-"
    echo "  kubectl --context=${ctx} -n ${RECIPE_NS} delete mcpserver,deployment,service ${SERVER} --ignore-not-found"
    echo "  kubectl --context=${ctx} -n ${RECIPE_NS} delete configmap ${SERVER}-nginx-conf --ignore-not-found"
    echo "  kubectl --context=${ctx} -n ${RECIPE_NS} delete networkpolicy ${POLICY_NAME} --ignore-not-found"
    echo "  kubectl --context=${ctx} -n ${RECIPE_NS} delete deployment,configmap ${CONTROL} --ignore-not-found"
  } | tee -a "${EVIDENCE_DIR}/manual-repair.txt" >&2
}

# The label sweep is fail-closed too: a failed `kubectl get` is not an empty
# list, so it must never report "no labelled policies left". The status is what
# decides; stderr stays quiet because cleanup polls this predicate every second.
no_labelled_policies() {
  local names
  names="$(kctl get networkpolicy -n "$RECIPE_NS" -l "clerum.io/mcpserver=${SERVER}" \
    --request-timeout=20s -o name 2>/dev/null)" || return 1
  [ -z "$names" ]
}

# Everything phase 3 and phase 4 create, directly or through HCC: the McpServer,
# its HCC-owned Deployment/Service/rendered ConfigMap, the exact-host policy, any
# leftover policy labelled with the server, and the control fixture. Every
# absence is confirmed by resource_absent, so an unreadable API fails the check
# instead of passing as "nothing left".
resources_gone() {
  resource_absent mcpserver "$SERVER" -n "$RECIPE_NS" &&
    resource_absent deployment "$SERVER" -n "$RECIPE_NS" &&
    resource_absent service "$SERVER" -n "$RECIPE_NS" &&
    resource_absent configmap "${SERVER}-nginx-conf" -n "$RECIPE_NS" &&
    resource_absent networkpolicy "$POLICY_NAME" -n "$RECIPE_NS" &&
    no_labelled_policies &&
    resource_absent deployment "$CONTROL" -n "$RECIPE_NS" &&
    resource_absent configmap "$CONTROL" -n "$RECIPE_NS"
}

restore_hcc() {
  local restored="${EVIDENCE_DIR}/hcc-deployment-restored.json"
  kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=json --request-timeout=20s \
    -p "$(cat "${EVIDENCE_DIR}/hcc-env-restore.json")" >/dev/null || return 1
  kctl annotate deployment "$HCC_DEPLOY" -n "$HCC_NS" --request-timeout=20s "${OVERRIDE_ANNOTATION}-" >/dev/null || return 1
  hcc_rollout_status || return 1
  # Read the Deployment once and derive both checks from that read, so a failed
  # read cannot pass as "env restored and annotation absent".
  kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" --request-timeout=20s -o json >"$restored" || {
    warn "the restored HCC Deployment could not be read back"
    return 1
  }
  jq -e --argjson i "$HCC_ENV_INDEX" --argjson original "$HCC_ENV_ORIGINAL" \
    '.spec.template.spec.containers[$i].env == $original' "$restored" >/dev/null || return 1
  jq -e --arg key "$OVERRIDE_ANNOTATION" '(.metadata.annotations[$key] // "") == ""' "$restored" >/dev/null ||
    return 1
  return 0
}

restore_corefile() {
  local patch restored="${EVIDENCE_DIR}/coredns-restored.json"
  patch="$(jq -cn --rawfile cf "${EVIDENCE_DIR}/corefile-original.txt" \
    --arg key "$OVERRIDE_ANNOTATION" \
    '{data:{Corefile:$cf},metadata:{annotations:{($key):null}}}')"
  kctl patch configmap "$DNS_CONFIGMAP" -n "$DNS_NS" --type=merge --request-timeout=20s -p "$patch" >/dev/null || {
    warn "the CoreDNS ConfigMap patch was rejected"
    return 1
  }
  # Read the ConfigMap once and derive both checks from that read: the restore is
  # proven by what this script wrote and can read back deterministically. That
  # read cannot prove what CoreDNS *serves* (kubelet refreshes the mounted file
  # and the `reload` plugin picks it up later), so cleanup adds a separate,
  # bounded served witness (dns_override_gone) after this step. The two checks
  # are complementary: this one must hold before HCC is restarted at all.
  kctl get configmap "$DNS_CONFIGMAP" -n "$DNS_NS" --request-timeout=20s -o json >"$restored" || {
    warn "the restored ConfigMap could not be read back"
    return 1
  }
  jq -j '.data.Corefile' "$restored" >"${EVIDENCE_DIR}/corefile-restored.txt" || {
    warn "the restored Corefile could not be read out of the ConfigMap"
    return 1
  }
  cmp -s "${EVIDENCE_DIR}/corefile-original.txt" "${EVIDENCE_DIR}/corefile-restored.txt" || {
    warn "the Corefile differs from the saved original"
    return 1
  }
  jq -e --arg key "$OVERRIDE_ANNOTATION" '(.metadata.annotations[$key] // "") == ""' "$restored" >/dev/null || {
    warn "the CoreDNS override annotation is still present"
    return 1
  }
  return 0
}

cleanup() {
  local status=0 touched=0 dns_restored=1
  stop_loops
  if [ "$RESOURCES_CREATED" = 1 ]; then
    touched=1
    kctl delete mcpserver "$SERVER" -n "$RECIPE_NS" --ignore-not-found --wait=false --request-timeout=20s >/dev/null 2>&1 || {
      warn "could not delete McpServer ${SERVER}"
      status=1
    }
    kctl delete deployment "$CONTROL" -n "$RECIPE_NS" --ignore-not-found --wait=false --request-timeout=20s >/dev/null 2>&1 || {
      warn "could not delete Deployment ${CONTROL}"
      status=1
    }
    kctl delete configmap "$CONTROL" -n "$RECIPE_NS" --ignore-not-found --wait=false --request-timeout=20s >/dev/null 2>&1 || {
      warn "could not delete ConfigMap ${CONTROL}"
      status=1
    }
    if ! wait_until "$RESOURCE_DELETE_TIMEOUT" "test resources and their policy to disappear" resources_gone; then
      status=1
    fi
  fi
  # CoreDNS first, then HCC. restore_hcc Recreates HCC and waits for the new pod
  # to be Ready; during that rollout HCC's initial reconciliation re-resolves
  # every exact-host binding of the profile. If the override Corefile were still
  # in place, that restored (production-cadence) HCC could persist the test
  # answer set and `ttl 5` into those bindings' egress-fqdn-state. The two
  # restores have no other dependency on each other, so the safer order is
  # CoreDNS first.
  #
  # Writing the restored ConfigMap is not proof that CoreDNS serves it: kubelet
  # must refresh the mounted file and the `reload` plugin must pick it up, which
  # took 23-99 s on the 2026-10-30 runs. So the restarted HCC waits for a
  # bounded served witness (dns_override_gone) first. If the witness cannot be
  # proven, HCC is deliberately left untouched: restarting it while the override
  # is still served is exactly the contamination this order prevents.
  if [ "$COREFILE_TOUCHED" = 1 ]; then
    touched=1
    if ! restore_corefile; then
      warn "the CoreDNS restore did not complete (see the reason above)"
      status=1
      dns_restored=0
    elif ! wait_until "$DNS_VISIBLE_TIMEOUT" \
      "CoreDNS to stop serving the ${CDN_HOST} test rows" dns_override_gone; then
      # Truthful warning: PRESENT means the override was still being served
      # when the wait ended; UNKNOWN means the last query never got a
      # trustworthy answer ("could not ask"), which says nothing about what
      # CoreDNS serves. Either way HCC is deliberately not restored: GONE is
      # the only state that may restart it (see the header contract).
      if [ "$DNS_WITNESS_STATE" = PRESENT ]; then
        warn "CoreDNS still served the ${CDN_HOST} test rows after ${DNS_VISIBLE_TIMEOUT}s; HCC was not restarted on purpose"
      else
        warn "could not ask CoreDNS whether it stopped serving the ${CDN_HOST} test rows after ${DNS_VISIBLE_TIMEOUT}s (${DNS_WITNESS_DETAIL}); HCC was not restarted on purpose"
      fi
      status=1
      dns_restored=0
    fi
  fi
  if [ "$HCC_ENV_TOUCHED" = 1 ]; then
    touched=1
    if [ "$dns_restored" = 0 ]; then
      warn "skipping the host-context-controller restore: the CoreDNS override is not proven gone"
      status=1
    elif ! restore_hcc; then
      warn "the host-context-controller env/annotation was not restored exactly"
      status=1
    fi
  fi
  if [ "$status" -eq 0 ]; then
    [ "$touched" -eq 0 ] ||
      ok "profile restored: HCC env JSON identical, Corefile byte-identical and no longer served, no test resources or policies left"
    return 0
  fi
  print_manual_repair
  return 1
}

on_exit() {
  local status=$? verdict
  # A second INT/TERM/HUP must not kill the restore halfway. From here on the
  # only writer is cleanup(), whose steps are bounded by their own timeouts.
  # kubectl children inherit the ignored disposition, so a retried signal cannot
  # reopen the window while the Corefile is being restored. The bounded HCC
  # rollout goes through the Node deadline runner, which installs its own signal
  # handlers: a retried signal stops that one command, and cleanup then reports
  # RESTORE_FAILED instead of claiming a restore it did not verify.
  # PIPE is ignored for the same reason: if the caller closed the stdout pipe
  # (a wrapper that stopped reading, a `| head`), a progress write must not
  # kill the restore either. Ignoring the signal alone is not enough — the
  # final verdict printf below still has to be guarded, or its EPIPE failure
  # status would replace the exit code this run actually earned.
  trap - EXIT
  trap '' INT TERM HUP PIPE
  if [ "$status" -ne "$EXIT_CODE" ]; then
    # Only `finish` may hand a verdict to the exit trap. A raw exit status
    # (set -e abort, a failed child command, a stray exit) is not a product
    # verdict: map it to INCONCLUSIVE instead of reporting FAIL, PRECONDITION
    # or RESTORE_FAILED from a status the script never chose. A cleanup failure
    # below still overrides this with 4/restore-failed.
    EXIT_CODE=3
    REASON=unexpected-error
  fi
  case "$EXIT_CODE" in
    0|1|2|3|4) ;;
    *)
      EXIT_CODE=3
      REASON=unexpected-error
      ;;
  esac
  if ! cleanup; then
    EXIT_CODE=4
    REASON=restore-failed
  fi
  case "$EXIT_CODE" in
    0) verdict=PASS ;;
    1) verdict=FAIL ;;
    2) verdict=PRECONDITION ;;
    3) verdict=INCONCLUSIVE ;;
    *) verdict=RESTORE_FAILED ;;
  esac
  local line
  line="$(printf 'E2E_CDN_ROTATION_VERDICT=%s EXIT=%s REASON=%s' "$verdict" "$EXIT_CODE" "$REASON")"
  if [ -n "$EVIDENCE_DIR" ] && [ -d "$EVIDENCE_DIR" ]; then
    printf '%s\n' "$line" >"${EVIDENCE_DIR}/verdict.txt" 2>/dev/null || :
  fi
  # Guarded on purpose (see the PIPE note above): with stdout already closed,
  # an unguarded printf fails and — under `set -e` in the EXIT trap — its
  # status would replace EXIT_CODE. The verdict file above already recorded
  # the line; losing the stdout copy must not rewrite the verdict.
  printf '%s\n' "$line" || :
  exit "$EXIT_CODE"
}

# ── Phase 0: inputs, ownership, lease, prerequisites ───────────────────
phase0() {
  header "Phase 0 — Preconditions and lease"

  if [ "$#" -gt 1 ] || { [ -n "${E2E_CDN_EVIDENCE_DIR:-}" ] && [ -n "${1:-}" ] &&
    [ "$E2E_CDN_EVIDENCE_DIR" != "$1" ]; }; then
    usage >&2
    finish 2 usage
  fi
  EVIDENCE_DIR="${1:-${E2E_CDN_EVIDENCE_DIR:-}}"
  [ -n "$EVIDENCE_DIR" ] || {
    usage >&2
    fail "an evidence directory is required (argument or E2E_CDN_EVIDENCE_DIR)"
    finish 2 usage
  }
  mkdir -p -- "$EVIDENCE_DIR" || {
    fail "cannot create the evidence directory ${EVIDENCE_DIR}"
    finish 2 usage
  }
  EVIDENCE_DIR="$(cd -- "$EVIDENCE_DIR" && pwd -P)" || {
    fail "cannot resolve the evidence directory"
    finish 2 usage
  }
  BRANCH_SAMPLES="${EVIDENCE_DIR}/branch-samples.tsv"
  CONTROL_SAMPLES="${EVIDENCE_DIR}/control-samples.tsv"
  POLICY_SAMPLES="${EVIDENCE_DIR}/policy-cidrs.tsv"
  BRANCH_REDIRECT_FILE="${EVIDENCE_DIR}/branch-probe-reads-control"
  ORIGINAL_COREFILE="${EVIDENCE_DIR}/corefile-original.txt"
  : >"$BRANCH_SAMPLES"
  : >"$CONTROL_SAMPLES"
  : >"$POLICY_SAMPLES"
  rm -f "$BRANCH_REDIRECT_FILE"

  for tool in jq node python3; do
    command -v "$tool" >/dev/null 2>&1 || {
      fail "required host tool '${tool}' is missing"
      finish 2 tooling-missing
    }
  done

  case "$MUTATION" in
    ""|control-uses-fixed-template|branch-probe-reads-control) ;;
    *)
      fail "E2E_CDN_MUTATION='${MUTATION}' is not one of the supported mutations"
      finish 2 usage
      ;;
  esac

  if [ -z "$CDN_HOST" ] || ! [[ "$CDN_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
    fail "CDN_HOST='${CDN_HOST}' is not a plain lower-case hostname"
    finish 2 usage
  fi

  local normalized_a normalized_b
  if [ -z "${CDN_SET_A:-}" ] || [ -z "${CDN_SET_B:-}" ]; then
    fail "CDN_SET_A and CDN_SET_B are required (they expire; there is no default)"
    finish 2 usage
  fi
  normalized_a="$(normalize_set "$CDN_SET_A")" || {
    fail "CDN_SET_A must list four distinct public IPv4 addresses in dotted decimal without leading zeros"
    finish 2 usage
  }
  normalized_b="$(normalize_set "$CDN_SET_B")" || {
    fail "CDN_SET_B must list four distinct public IPv4 addresses in dotted decimal without leading zeros"
    finish 2 usage
  }
  read -r -a SET_A <<<"$normalized_a"
  read -r -a SET_B <<<"$normalized_b"
  sets_disjoint || {
    fail "CDN_SET_A and CDN_SET_B must be disjoint answer sets"
    finish 2 usage
  }
  CSV_A="$(csv_of "${SET_A[@]}")"
  CSV_B="$(csv_of "${SET_B[@]}")"
  EXPECTED_A_CIDRS="$(cidrs_of "${SET_A[@]}")"
  EXPECTED_B_CIDRS="$(cidrs_of "${SET_B[@]}")"
  EXPECTED_A_JSON="$(jq -cn '$ARGS.positional' --args "${SET_A[@]}")"
  EXPECTED_B_JSON="$(jq -cn '$ARGS.positional' --args "${SET_B[@]}")"
  POLICY_NAME="ext-egress-${SERVER}-${CDN_HOST}-${UPSTREAM_PORT}"
  ok "inputs accepted: host ${CDN_HOST}, set A ${CSV_A}, set B ${CSV_B}"

  if [ -z "${KUBECONTEXT:-}" ] || [ "$KUBECONTEXT" != "$E2E_KUBECONTEXT" ]; then
    fail "KUBECONTEXT must be set and must be the context this run targets"
    finish 2 context-not-owned
  fi
  is_branch_scoped_e2e_context "$KUBECONTEXT" || {
    fail "context '${KUBECONTEXT}' is not a generated branch-scoped context"
    finish 2 context-not-owned
  }
  [ "${MINIKUBE_PROFILE:-}" = "$KUBECONTEXT" ] || {
    fail "MINIKUBE_PROFILE must be ${KUBECONTEXT}"
    finish 2 context-not-owned
  }
  [ "${CONTROL_API_REAL_PG_CONTEXT:-}" = "$KUBECONTEXT" ] || {
    fail "CONTROL_API_REAL_PG_CONTEXT must be ${KUBECONTEXT}"
    finish 2 context-not-owned
  }
  require_safe_kube_context || finish 2 context-not-owned

  # The lease must be inherited before the first Kubernetes write.
  bash "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh" >/dev/null 2>&1 || {
    fail "the canonical branch-profile mutation lease is not held; launch through scripts/minikube/with-t2-mutation-lock.sh"
    finish 2 lock-not-held
  }
  ok "canonical branch-profile mutation lease inherited"

  exists deployment "$HCC_DEPLOY" -n "$HCC_NS" || {
    fail "deployment ${HCC_NS}/${HCC_DEPLOY} is missing"
    finish 2 cluster-prerequisites
  }
  exists configmap "$DNS_CONFIGMAP" -n "$DNS_NS" || {
    fail "configmap ${DNS_NS}/${DNS_CONFIGMAP} is missing"
    finish 2 cluster-prerequisites
  }
  exists crd mcpservers.clerum.io || {
    fail "CRD mcpservers.clerum.io is missing"
    finish 2 cluster-prerequisites
  }
  kctl get networkpolicy deny-all-mcp-server -n "$RECIPE_NS" --request-timeout=20s -o json 2>/dev/null |
    jq -e '.spec.podSelector == {} and ((.spec.policyTypes // []) | index("Egress") != null)' >/dev/null ||
    {
      fail "networkpolicy ${RECIPE_NS}/deny-all-mcp-server is missing its empty podSelector + Egress default deny"
      finish 2 cluster-prerequisites
    }
  ok "HCC, CoreDNS, the McpServer CRD and default-deny egress are present"

  kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" --request-timeout=20s -o json >"${EVIDENCE_DIR}/hcc-deployment-original.json" ||
    finish 2 cluster-prerequisites
  HCC_ENV_INDEX="$(
    jq -er --arg name "$HCC_CONTAINER" '
      .spec.template.spec.containers | to_entries[] | select(.value.name == $name) | .key' \
      "${EVIDENCE_DIR}/hcc-deployment-original.json"
  )" || {
    fail "container ${HCC_CONTAINER} not found in ${HCC_NS}/${HCC_DEPLOY}"
    finish 2 cluster-prerequisites
  }
  HCC_ENV_ORIGINAL="$(
    jq -c --argjson i "$HCC_ENV_INDEX" '.spec.template.spec.containers[$i].env' \
      "${EVIDENCE_DIR}/hcc-deployment-original.json"
  )"
  printf '%s\n' "${HCC_ENV_ORIGINAL:-null}" >"${EVIDENCE_DIR}/hcc-env-original.json"
  if [ "$HCC_ENV_ORIGINAL" = null ]; then
    jq -cn --argjson i "$HCC_ENV_INDEX" \
      '[{op:"remove", path:("/spec/template/spec/containers/" + ($i | tostring) + "/env")}]' \
      >"${EVIDENCE_DIR}/hcc-env-restore.json"
  else
    jq -cn --argjson env "$HCC_ENV_ORIGINAL" --argjson i "$HCC_ENV_INDEX" \
      '[{op:"replace", path:("/spec/template/spec/containers/" + ($i | tostring) + "/env"), value:$env}]' \
      >"${EVIDENCE_DIR}/hcc-env-restore.json"
  fi

  # Save the CoreDNS ConfigMap once, before any write. Every later read of the
  # original Corefile and of its override annotation comes from this snapshot,
  # so a failed read aborts as `cluster-prerequisites` instead of an empty
  # string (or an empty Corefile) passing as "nothing to see".
  kctl get configmap "$DNS_CONFIGMAP" -n "$DNS_NS" --request-timeout=20s -o json \
    >"${EVIDENCE_DIR}/coredns-configmap-original.json" || {
    fail "configmap ${DNS_NS}/${DNS_CONFIGMAP} could not be read back"
    finish 2 cluster-prerequisites
  }

  # Leftovers from an aborted run are a precondition failure, never adopted.
  # Both annotation checks read the JSON saved above, so a failed read cannot
  # leave the annotation empty and pass as "no override".
  if hcc_env_has_test_overlap "$HCC_ENV_ORIGINAL" ||
     jq -e --arg key "$OVERRIDE_ANNOTATION" --arg value "$OVERRIDE_VALUE" \
       '.metadata.annotations[$key] == $value' \
       "${EVIDENCE_DIR}/hcc-deployment-original.json" >/dev/null ||
     jq -e --arg key "$OVERRIDE_ANNOTATION" --arg value "$OVERRIDE_VALUE" \
       '.metadata.annotations[$key] == $value' \
       "${EVIDENCE_DIR}/coredns-configmap-original.json" >/dev/null; then
    fail "a previous run left a test override on HCC or CoreDNS; restore it before retrying"
    finish 2 leftover-state
  fi
  # resources_gone is the same fail-closed predicate cleanup verifies, and it
  # covers every object phase 3/phase 4 create: the McpServer ${SERVER}, its
  # HCC-owned Deployment, Service and rendered ${SERVER}-nginx-conf ConfigMap,
  # the exact-host ${POLICY_NAME}, any policy labelled `clerum.io/mcpserver`,
  # and the control Deployment/ConfigMap. It is also the HCC-owned side of an
  # aborted run; without it a stale policy could be adopted by phase 3 before it
  # is re-rendered. A failed `kubectl get` never reads as "nothing left".
  if ! resources_gone; then
    fail "a previous run left a test or HCC-owned resource for ${SERVER}/${CONTROL}, or its absence could not be proven"
    finish 2 leftover-state
  fi
  ok "no leftover override or test resource from an aborted run"

  jq -j '.data.Corefile' "${EVIDENCE_DIR}/coredns-configmap-original.json" >"$ORIGINAL_COREFILE" ||
    finish 2 cluster-prerequisites
  [ -s "$ORIGINAL_COREFILE" ] || {
    fail "the CoreDNS Corefile is empty"
    finish 2 corefile-unexpected
  }
  [ "$(count_substr 'hosts {' <"$ORIGINAL_COREFILE")" -eq 1 ] || {
    fail "the Corefile must contain exactly one 'hosts {' block"
    finish 2 corefile-unexpected
  }
  if awk -v host="$CDN_HOST" '
      /^[[:space:]]*hosts[[:space:]]*\{[[:space:]]*$/ { inblock = 1; next }
      inblock && /^[[:space:]]*\}[[:space:]]*$/ { inblock = 0; next }
      inblock && index($0, host) { found = 1 }
      END { exit(found ? 0 : 1) }' "$ORIGINAL_COREFILE"; then
    fail "the Corefile hosts block already carries a ${CDN_HOST} row"
    finish 2 leftover-state
  fi
  ok "Corefile saved and shaped as expected (one hosts block, no override row)"

  local marker_json marker_head marker_worktree drift untracked
  marker_json="$(kctl get configmap clerum-pre-gate-sync-state -n "$HCC_NS" --request-timeout=20s -o json 2>/dev/null || :)"
  marker_head="$(printf '%s' "$marker_json" | jq -r '.data.gitHead // ""')"
  marker_worktree="$(printf '%s' "$marker_json" | jq -r '.data.worktreeId // ""')"
  if ! [[ "$marker_head" =~ ^[0-9a-f]{40}$ ]]; then
    fail "the pre-gate sync marker has no usable gitHead; run the branch pre-gate sync first"
    finish 2 marker-missing
  fi
  printf '%s\n' "$marker_head" >"${EVIDENCE_DIR}/marker-git-head.txt"
  # Compare the marker against the real worktree, not against HEAD: `git diff
  # <marker> HEAD` cannot see a dirty checkout, so uncommitted edits under these
  # paths would certify code the pods never ran. `git diff <marker>` compares the
  # marker tree with the working tree (staged and unstaged content alike);
  # untracked files are listed separately because `git diff` cannot see them.
  drift="$(git -C "$ROOT" diff --name-only "$marker_head" -- \
    host-context-controller nginx-egress-proxy packages/network-policy-core)" || {
    fail "could not compare the worktree with the pre-gate marker ${marker_head}"
    finish 2 source-drift
  }
  untracked="$(git -C "$ROOT" ls-files --others --exclude-standard -- \
    host-context-controller nginx-egress-proxy packages/network-policy-core)" || {
    fail "could not list untracked files under the code under test"
    finish 2 source-drift
  }
  if [ -n "$drift" ] || [ -n "$untracked" ]; then
    {
      [ -z "$drift" ] || awk '{ print "modified " $0 }' <<<"$drift"
      [ -z "$untracked" ] || awk '{ print "untracked " $0 }' <<<"$untracked"
    } >"${EVIDENCE_DIR}/source-drift.txt"
    fail "host-context-controller, nginx-egress-proxy or packages/network-policy-core differ from ${marker_head} in the worktree"
    finish 2 source-drift
  fi
  ok "the worktree under test matches the deployed pre-gate marker ${marker_head:0:12} (no uncommitted or untracked source)"

  # Side-effect evidence: every exact-host binding of the profile uses the short window.
  kctl get networkpolicy -n "$RECIPE_NS" -l clerum.io/policy-type=external-egress \
    --request-timeout=20s -o json 2>/dev/null |
    jq -r '.items[].metadata.name' >"${EVIDENCE_DIR}/existing-exact-host-bindings.txt" || :
  printf 'gitHead=%s\nworktreeId=%s\ncontext=%s\nhost=%s\nsetA=%s\nsetB=%s\noverlapSec=60\nresyncSec=10\neffectiveCadenceSec=5\nmutation=%s\n' \
    "$marker_head" "$marker_worktree" "$KUBECONTEXT" "$CDN_HOST" "$CDN_SET_A" "$CDN_SET_B" "${MUTATION:-none}" \
    >"${EVIDENCE_DIR}/run-context.txt"
  kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json |
    jq -r '.spec.template.spec.containers[]? | select(.name == "host-context-controller") | "hccImage=\(.image)"' \
      >>"${EVIDENCE_DIR}/run-context.txt" || :
  local hcc_pod_name
  hcc_pod_name="$(hcc_pod)"
  if [ -n "$hcc_pod_name" ]; then
    kctl get pod "$hcc_pod_name" -n "$HCC_NS" -o json |
      jq -r '.status.containerStatuses[]? | select(.name == "host-context-controller") | "hccImageID=\(.imageID)"' \
        >>"${EVIDENCE_DIR}/run-context.txt" || :
  fi

  POLICY_LOOP_PID=""
  policy_loop "$POLICY_SAMPLES" >/dev/null 2>&1 &
  POLICY_LOOP_PID=$!
}

# ── Phase 1: accelerate HCC (test-only) ────────────────────────────────
phase1() {
  header "Phase 1 — HCC overlap 60 s / resync 10 s"
  HCC_ENV_TOUCHED=1
  kctl annotate deployment "$HCC_DEPLOY" -n "$HCC_NS" \
    "${OVERRIDE_ANNOTATION}=${OVERRIDE_VALUE}" --overwrite >/dev/null || {
    fail "could not annotate ${HCC_NS}/${HCC_DEPLOY} with the temporary override"
    finish 2 hcc-env-not-applied
  }
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" -c "$HCC_CONTAINER" \
    "HCC_EXTERNAL_EGRESS_OVERLAP_SEC=${HCC_TEST_OVERLAP_SEC}" HCC_EXTERNAL_EGRESS_RESYNC_SEC=10 >/dev/null || {
    fail "could not set the HCC egress window environment"
    finish 2 hcc-env-not-applied
  }
  if ! hcc_rollout_status; then
    fail "HCC did not become Ready with the accelerated window"
    finish 2 hcc-env-not-applied
  fi
  if ! hcc_env_json | jq -e --arg overlap "$HCC_TEST_OVERLAP_SEC" '
    any(.[]?; .name == "HCC_EXTERNAL_EGRESS_OVERLAP_SEC" and .value == $overlap) and
    any(.[]?; .name == "HCC_EXTERNAL_EGRESS_RESYNC_SEC" and .value == "10")' >/dev/null; then
    fail "HCC does not carry OVERLAP=60 and RESYNC=10"
    finish 2 hcc-env-not-applied
  fi
  if ! wait_until 120 "the HCC startup resync log line" hcc_log_has_resync; then
    fail "HCC did not log 'periodic DNS resync enabled (every 10s…'; the window witness is absent"
    finish 2 hcc-env-not-applied
  fi
  ok "HCC runs with overlap 60 s / resync 10 s (effective cadence 5 s with TTL 5)"
}

# ── CoreDNS helpers ────────────────────────────────────────────────────
render_corefile() { # <source> <output> <ip...>
  python3 - "$1" "$2" "$CDN_HOST" "${@:3}" <<'PY'
import sys

source, out, host = sys.argv[1], sys.argv[2], sys.argv[3]
ips = sys.argv[4:]
with open(source, 'r', encoding='utf-8') as handle:
    lines = handle.read().split('\n')

starts = [i for i, line in enumerate(lines) if line.strip() == 'hosts {']
if len(starts) != 1:
    sys.exit(3)
start = starts[0]
end = None
for i in range(start + 1, len(lines)):
    if lines[i].strip() == '}':
        end = i
        break
if end is None:
    sys.exit(4)

block = lines[start + 1:end]
if any(host in line for line in block):
    sys.exit(5)

rows = []
ttl_written = False
for line in block:
    if line.strip().startswith('ttl '):
        if not ttl_written:
            rows.append('    ttl 5')
            ttl_written = True
        continue
    rows.append(line)
if not ttl_written:
    rows.insert(0, '    ttl 5')
# CoreDNS's hosts plugin only accepts inline entries before `fallthrough`;
# an entry after it is an "unknown property" and the reload keeps the old
# Corefile without failing.
new_rows = ['    %s %s' % (ip, host) for ip in ips]
fall = [i for i, line in enumerate(rows) if line.strip().split()[:1] == ['fallthrough']]
at = fall[0] if fall else len(rows)
rows[at:at] = new_rows

lines[start + 1:end] = rows
with open(out, 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(lines))
PY
}

apply_corefile() { # <rendered-file> <ip...>
  local file=$1
  shift
  local patch ip
  patch="$(jq -cn --rawfile cf "$file" --arg key "$OVERRIDE_ANNOTATION" --arg value "$OVERRIDE_VALUE" \
    '{data:{Corefile:$cf},metadata:{annotations:{($key):$value}}}')"
  # Set before the request: an interrupted patch may still have been applied.
  COREFILE_TOUCHED=1
  kctl patch configmap "$DNS_CONFIGMAP" -n "$DNS_NS" --type=merge -p "$patch" >/dev/null
  T_PATCH_MS="$(ms_now)"
  # Read back: the ConfigMap must now hold exactly the rendered Corefile.
  kctl get configmap "$DNS_CONFIGMAP" -n "$DNS_NS" --request-timeout=20s -o json |
    jq -j '.data.Corefile' >"${EVIDENCE_DIR}/corefile-applied.txt"
  cmp -s "$file" "${EVIDENCE_DIR}/corefile-applied.txt" || return 1
  for ip in "$@"; do
    [ "$(count_substr "    ${ip} ${CDN_HOST}" <"$file")" -eq 1 ] || return 1
  done
  [ "$(count_substr 'ttl 5' <"$file")" -ge 1 ] || return 1
  kctl get configmap "$DNS_CONFIGMAP" -n "$DNS_NS" --request-timeout=20s -o json |
    jq -e --arg key "$OVERRIDE_ANNOTATION" --arg value "$OVERRIDE_VALUE" \
      '.metadata.annotations[$key] == $value' >/dev/null || return 1
  return 0
}

# On a DNS-switch timeout, keep CoreDNS's own reload errors as evidence: an
# override CoreDNS refused to load is invisible from the ConfigMap.
capture_coredns_reload_errors() {
  local out="${EVIDENCE_DIR}/coredns-reload.log" lines
  kctl logs "deployment/coredns" -n "$DNS_NS" --since=10m >"${out}.raw" 2>&1 || {
    warn "could not read the CoreDNS log"
    return 0
  }
  grep -E 'Reloading|reload failed|Restart failed|Error during parsing' "${out}.raw" >"$out" || :
  rm -f "${out}.raw"
  # `|| :` keeps an empty grep under pipefail: a grep with no match exits 1 and
  # would otherwise abort this evidence capture with a raw status instead of the
  # phase's own INCONCLUSIVE reason.
  lines="$({ grep -E 'reload failed|Error during parsing' "$out" || :; } | tail -n 2)"
  [ -z "$lines" ] || warn "CoreDNS refused the override Corefile: ${lines}"
}

switch_dns() { # <A|B> <phase-prefix>
  local label=$1 prefix=$2 file
  local -a ips
  file="${EVIDENCE_DIR}/corefile-${label}.txt"
  if [ "$label" = A ]; then
    ips=("${SET_A[@]}")
  else
    ips=("${SET_B[@]}")
  fi
  render_corefile "$ORIGINAL_COREFILE" "$file" "${ips[@]}" || return 1
  apply_corefile "$file" "${ips[@]}" || return 1
  printf '%s %s\n' "$T_PATCH_MS" "$prefix" >>"${EVIDENCE_DIR}/dns-switches.txt"
  # Writing the ConfigMap is not proof that CoreDNS serves it: the reload
  # plugin keeps the old Corefile if the new one does not parse. HCC's own
  # resolver (dns_actual_set) is the witness that the switch took effect.
  echo "  Corefile with set ${label} written to the ConfigMap (ttl 5); waiting for CoreDNS to reload it"
}

# ── Phase 2: CoreDNS = B ───────────────────────────────────────────────
phase2() {
  header "Phase 2 — DNS answers set B"
  switch_dns B phase2 || {
    fail "could not apply the CoreDNS override for set B"
    finish 2 corefile-not-applied
  }
  if ! wait_until "$DNS_VISIBLE_TIMEOUT" "HCC's resolver to answer set B" dns_is "$CSV_B"; then
    fail "HCC did not see set B within ${DNS_VISIBLE_TIMEOUT}s"
    capture_coredns_reload_errors
    record_dns_witness
    finish 3 phase2-dns-set-b-not-visible
  fi
  ok "HCC resolves ${CDN_HOST} to exactly set B (ttl <= 5)"
}

# ── Phase 3: McpServer, policy = B, branch serves B ────────────────────
create_server() {
  kctl apply -f - >/dev/null <<YAML
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${SERVER}
  namespace: ${RECIPE_NS}
  labels:
    e2e.clerum.io/suite: egress-cdn-rotation
spec:
  image: clerum/nginx-egress-proxy:0.1.0
  transport:
    type: streamableHttp
    url: http://${SERVER}.${RECIPE_NS}.svc.cluster.local:${TRANSPORT_PORT}/mcp
    port: ${TRANSPORT_PORT}
  remote:
    baseUrl: https://${CDN_HOST}/mcp
  egressBindings:
    - dns: ${CDN_HOST}
      port: ${UPSTREAM_PORT}
      protocol: TCP
YAML
}

policy_ready() {
  policy_state_json 2>/dev/null | jq -e 'type == "array" and length > 0' >/dev/null 2>&1
}

assert_window_witness() {
  local state deltas
  state="$(policy_state_json || :)"
  [ -n "$state" ] || {
    fail "the ${STATE_ANNOTATION} annotation of ${POLICY_NAME} could not be read back"
    finish 2 window-witness
  }
  deltas="$(printf '%s' "$state" | jq -r --argjson max "$WINDOW_MAX_DELTA_MS" '
    [ .[] | select((.expiresAt - .lastObservedAt) > $max) | {ip, delta:(.expiresAt - .lastObservedAt)} ]
    | if length == 0 then empty else . end')"
  if [ -n "$deltas" ]; then
    printf '%s\n' "$deltas" >"${EVIDENCE_DIR}/window-witness-violation.json"
    fail "an egress window entry kept a longer overlap than 65 s (${deltas})"
    finish 2 window-witness
  fi
  printf '%s\n' "$state" >"${EVIDENCE_DIR}/policy-state-phase3.json"
  ok "every egress window entry satisfies expiresAt - lastObservedAt <= 65 s"
}

wait_policy_until() { # <expected-cidrs> <deadline-ms>
  while :; do
    [ "$(policy_cidrs)" = "$1" ] && return 0
    [ "$(ms_now)" -lt "$2" ] || return 1
    sleep "$POLICY_INTERVAL"
  done
}

# The policy loop samples every 5 s. Its first sample that already holds the
# target set is an upper bound of the transition, so every sample that starts
# at or after it is unambiguously post-transition.
wait_policy_sample() { # <expected-cidrs> <from-ms>
  local elapsed=0
  while [ "$elapsed" -lt 20 ]; do
    T_POLICY_MS="$(sample_time_for_set "$POLICY_SAMPLES" "$1" "$2")"
    [ -n "$T_POLICY_MS" ] && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

capture_baseline_identity() { # <branch|control> <pod>
  local identity uid started restarts
  identity="$(pod_identity "$RECIPE_NS" "$2")" || return 1
  IFS=$'\t' read -r uid started restarts <<<"$identity"
  [ -n "$uid" ] && [ "$uid" != "-" ] || return 1
  if [ "$1" = branch ]; then
    BRANCH_UID=$uid
    BRANCH_STARTED=$started
    BRANCH_RESTARTS=$restarts
  else
    CONTROL_UID=$uid
    CONTROL_STARTED=$started
    CONTROL_RESTARTS=$restarts
  fi
  printf '%s\n' "$identity" >"${EVIDENCE_DIR}/${1}-identity-baseline.txt"
}

check_pod_curl() { # <pod>
  kctl exec "$1" -n "$RECIPE_NS" -c egress-proxy --request-timeout=30s -- curl --version >/dev/null 2>&1
}

ready_branch() {
  local pod
  pod="$(ready_pod "$RECIPE_NS" "app=${SERVER}")"
  [ -n "$pod" ] || return 1
  BRANCH_POD=$pod
}

ready_control() {
  local pod
  pod="$(ready_pod "$RECIPE_NS" "app=${CONTROL}")"
  [ -n "$pod" ] || return 1
  CONTROL_POD=$pod
}

phase3() {
  header "Phase 3 — McpServer, policy = B, branch serves B"
  RESOURCES_CREATED=1
  T_MCPSERVER_MS="$(ms_now)"
  create_server || {
    fail "could not apply McpServer ${SERVER}"
    finish 3 phase3-policy-b-not-converged
  }
  if ! wait_until 60 "the ${SERVER} external-egress policy with its state annotation" policy_ready; then
    fail "HCC did not write ${POLICY_NAME} with ${STATE_ANNOTATION}"
    finish 2 window-witness
  fi
  assert_window_witness

  if ! wait_policy_until "$EXPECTED_B_CIDRS" "$((T_MCPSERVER_MS + POLICY_CONVERGE_MS))"; then
    fail "the policy did not become exactly set B within 90 s"
    policy_cidrs >"${EVIDENCE_DIR}/policy-at-phase3-timeout.txt" 2>&1 || :
    finish 3 phase3-policy-b-not-converged
  fi
  if ! wait_policy_sample "$EXPECTED_B_CIDRS" "$T_MCPSERVER_MS"; then
    fail "the policy sample loop did not record set B"
    finish 3 policy-loop-missing
  fi
  ok "policy ${POLICY_NAME} is exactly set B"

  if ! wait_until "$WORKLOAD_READY_TIMEOUT" "the branch proxy pod to become Ready" ready_branch; then
    fail "the branch proxy pod did not become Ready"
    finish 3 phase3-branch-not-ready
  fi
  BRANCH_READY_MS="$(ms_now)"
  check_pod_curl "$BRANCH_POD" || {
    fail "curl is missing in the branch proxy pod"
    finish 2 curl-missing
  }
  capture_baseline_identity branch "$BRANCH_POD" || {
    fail "could not read the branch proxy baseline identity"
    finish 3 phase3-branch-not-ready
  }
  kctl get pod "$BRANCH_POD" -n "$RECIPE_NS" -o json |
    jq -r '.status.containerStatuses[]? | select(.name=="egress-proxy") | .imageID' \
      >"${EVIDENCE_DIR}/branch-image.txt" || :
  start_loops

  if ! wait_until "$PROXY_UPSTREAM_TIMEOUT" "the branch proxy to answer through CloudFront" \
    has_upstream_since "$BRANCH_SAMPLES" "$BRANCH_READY_MS"; then
    fail "the branch proxy never produced a CloudFront response with policy = B"
    tail -n 5 "$BRANCH_SAMPLES" >&2 || :
    finish 3 phase3-branch-not-serving-b
  fi
  ok "the branch proxy serves correctly with set B (first upstream response recorded)"
}

# ── Control fixture ────────────────────────────────────────────────────
build_control_configmap() {
  local template transformed literal
  template="$(kctl get configmap "${SERVER}-nginx-conf" -n "$RECIPE_NS" --request-timeout=20s -o json |
    jq -er '.data["default.conf.template"]')" || return 1
  printf '%s\n' "$template" >"${EVIDENCE_DIR}/control-source-template.txt"
  if [ "$MUTATION" = control-uses-fixed-template ]; then
    transformed=$template
  else
    transformed="$(printf '%s\n' "$template" | awk -v host="$CDN_HOST" '
      /proxy_pass https:\/\/remote_upstream/ {
        n++
        sub(/proxy_pass https:\/\/remote_upstream/, "proxy_pass https://" host)
      }
      { print }
      END { if (n != 1) exit 3 }')" || return 3
  fi
  printf '%s\n' "$transformed" >"${EVIDENCE_DIR}/control-rendered-template.txt"
  literal="proxy_pass https://${CDN_HOST}/mcp;"
  if [ "$MUTATION" = control-uses-fixed-template ]; then
    [ "$(printf '%s\n' "$transformed" | count_substr 'proxy_pass https://remote_upstream/mcp;')" -eq 1 ] || return 3
    [ "$(printf '%s\n' "$transformed" | count_substr "$literal")" -eq 0 ] || return 3
  else
    [ "$(printf '%s\n' "$transformed" | count_substr "$literal")" -eq 1 ] || return 3
    [ "$(printf '%s\n' "$transformed" | count_substr 'proxy_pass https://remote_upstream')" -eq 0 ] || return 3
  fi
  jq -cn --arg name "$CONTROL" --arg namespace "$RECIPE_NS" --arg template "$transformed" \
    '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:$name,namespace:$namespace},
      data:{"default.conf.template":$template}}' | kctl apply -f - >/dev/null || return 1
}

build_control_deployment() {
  local pod_spec
  pod_spec="$(kctl get deployment "$SERVER" -n "$RECIPE_NS" --request-timeout=20s -o json |
    jq -c --arg cm "$CONTROL" '
      .spec.template.spec
      | .volumes = ((.volumes // []) | map(if .configMap then .configMap.name = $cm else . end))')" || return 1
  jq -cn --arg name "$CONTROL" --arg namespace "$RECIPE_NS" --arg server "$SERVER" \
    --argjson podspec "$pod_spec" '
    {apiVersion:"apps/v1",kind:"Deployment",
     metadata:{name:$name,namespace:$namespace},
     spec:{replicas:1,selector:{matchLabels:{app:$name}},
       template:{metadata:{labels:{app:$name,"clerum.io/mcpserver":$server}},spec:$podspec}}}' |
    kctl apply -f - >/dev/null || return 1
  kctl get deployment "$SERVER" -n "$RECIPE_NS" -o json |
    jq -r '.spec.template.spec.containers[]? | "controlSourceImage=\(.image)"' \
      >"${EVIDENCE_DIR}/control-image.txt" || :
}

assert_control_template() {
  local rendered literal remote
  rendered="$(kctl exec "$CONTROL_POD" -n "$RECIPE_NS" -c egress-proxy --request-timeout=30s -- \
    cat /etc/nginx/conf.d/default.conf)" || return 3
  printf '%s\n' "$rendered" >"${EVIDENCE_DIR}/control-default.conf"
  literal="proxy_pass https://${CDN_HOST}/mcp;"
  remote="proxy_pass https://remote_upstream"
  if [ "$MUTATION" = control-uses-fixed-template ]; then
    [ "$(printf '%s\n' "$rendered" | count_substr 'proxy_pass https://remote_upstream/mcp;')" -eq 1 ] &&
      [ "$(printf '%s\n' "$rendered" | count_substr "$literal")" -eq 0 ]
  else
    [ "$(printf '%s\n' "$rendered" | count_substr "$literal")" -eq 1 ] &&
      [ "$(printf '%s\n' "$rendered" | count_substr "$remote")" -eq 0 ]
  fi
}

# Returns: 0 ok, 1 not ready, 2 curl missing, 3 template witness, 4 identity.
create_control() {
  build_control_configmap || return "$?"
  build_control_deployment || return 1
  wait_until "$WORKLOAD_READY_TIMEOUT" "the control proxy pod to become Ready" ready_control || return 1
  CONTROL_READY_MS="$(ms_now)"
  check_pod_curl "$CONTROL_POD" || return 2
  assert_control_template || return 3
  capture_baseline_identity control "$CONTROL_POD" || return 4
  kctl get pod "$CONTROL_POD" -n "$RECIPE_NS" -o json |
    jq -r '.status.containerStatuses[]? | select(.name=="egress-proxy") | .imageID' \
      >"${EVIDENCE_DIR}/control-pod-image.txt" || :
  start_loops
  return 0
}

assert_branch_identity() {
  local bad
  bad="$(identity_mismatch "$BRANCH_SAMPLES" "$BRANCH_UID" "$BRANCH_STARTED" "$BRANCH_RESTARTS")"
  [ -z "$bad" ] && return 0
  printf '%s\n' "$bad" >"${EVIDENCE_DIR}/branch-identity-change.txt"
  fail "the branch proxy pod UID, container start time or restart count changed"
  finish 1 branch-pod-replaced
}

assert_control_identity() {
  local bad
  bad="$(identity_mismatch "$CONTROL_SAMPLES" "$CONTROL_UID" "$CONTROL_STARTED" "$CONTROL_RESTARTS")"
  [ -z "$bad" ] && return 0
  printf '%s\n' "$bad" >"${EVIDENCE_DIR}/control-identity-change.txt"
  fail "the control proxy restarted or was replaced (its evidence cannot be used)"
  finish 3 control-pod-replaced
}

# ── Phase 4: DNS = A, policy = A, control validates A ──────────────────
phase4() {
  header "Phase 4 — DNS answers set A; control validates A"
  switch_dns A phase4 || {
    fail "could not apply the CoreDNS override for set A"
    finish 2 corefile-not-applied
  }
  local patch_ms=$T_PATCH_MS t_dns="" rc=0
  if ! wait_until "$DNS_VISIBLE_TIMEOUT" "HCC's resolver to answer set A" dns_is "$CSV_A"; then
    fail "HCC did not see set A within ${DNS_VISIBLE_TIMEOUT}s"
    capture_coredns_reload_errors
    finish 3 phase4-dns-set-a-not-visible
  fi
  ok "HCC resolves ${CDN_HOST} to exactly set A (ttl <= 5)"

  if ! t_dns="$(wait_until "$DNS_VISIBLE_TIMEOUT" "the first observed A address in the window state" \
    observed_at "$EXPECTED_A_JSON" "$patch_ms")"; then
    fail "HCC never recorded an A address as observed"
    finish 3 phase4-policy-a-not-converged
  fi
  if ! [[ "$t_dns" =~ ^[0-9]+$ ]]; then
    fail "t_dns is not a millisecond timestamp"
    finish 3 phase4-policy-a-not-converged
  fi
  printf '%s\n' "$t_dns" >"${EVIDENCE_DIR}/t-dns-phase4.txt"

  if ! wait_policy_until "$EXPECTED_A_CIDRS" "$((t_dns + POLICY_CONVERGE_MS))"; then
    fail "the policy did not become exactly set A within ${POLICY_CONVERGE_MS} ms of t_dns"
    policy_cidrs >"${EVIDENCE_DIR}/policy-at-phase4-timeout.txt" 2>&1 || :
    finish 3 phase4-policy-a-not-converged
  fi
  if ! wait_policy_sample "$EXPECTED_A_CIDRS" "$patch_ms"; then
    fail "the policy sample loop did not record set A"
    finish 3 policy-loop-missing
  fi
  ok "policy ${POLICY_NAME} is exactly set A"

  create_control || rc=$?
  case "$rc" in
    0) ;;
    1) finish 3 phase4-control-not-ready ;;
    2) finish 2 curl-missing ;;
    3)
      fail "the control's rendered default.conf does not have the expected proxy_pass form"
      finish 2 control-template-witness
      ;;
    *)
      fail "could not read the control proxy baseline identity"
      finish 3 phase4-control-not-ready
      ;;
  esac
  ok "control proxy mounted the transformed ConfigMap with the dev proxy_pass form"

  if ! wait_until "$PROXY_UPSTREAM_TIMEOUT" "the control proxy to answer through CloudFront" \
    has_upstream_since "$CONTROL_SAMPLES" "$CONTROL_READY_MS"; then
    fail "the control proxy never answered through CloudFront; set A is not validated"
    finish 3 phase4-control-not-serving-a
  fi
  ok "the control validates set A (upstream response with policy = A)"
  assert_no_rate_limit "$patch_ms" -1

  # 3 has precedence over 1: only now are the branch samples evaluated.
  assert_control_identity
  if ! wait_until "$PROXY_UPSTREAM_TIMEOUT" "a branch probe result with policy = A" \
    has_result_since "$BRANCH_SAMPLES" "$T_POLICY_MS"; then
    fail "the branch probe produced no network result with policy = A; the 0-failure claim has no witness"
    finish 3 probe-unavailable
  fi
  assert_branch_identity
  local post_failures transition_failures
  post_failures="$(count_failures "$BRANCH_SAMPLES" "$T_POLICY_MS" -1)"
  if [ "$post_failures" -gt 0 ]; then
    first_failure "$BRANCH_SAMPLES" "$T_POLICY_MS" -1 >"${EVIDENCE_DIR}/branch-failure-phase4.txt"
    fail "the branch proxy failed ${post_failures} time(s) with the policy exactly set A: it is pinned to B"
    finish 1 branch-pinned-old-set
  fi
  transition_failures="$(count_failures "$BRANCH_SAMPLES" "$patch_ms" "$T_POLICY_MS")"
  if [ "$transition_failures" -gt 1 ]; then
    fail "the branch proxy failed ${transition_failures} times during the B→A transition (budget: 1)"
    finish 1 branch-transition-failures
  fi
  ok "the branch proxy followed B→A without a restart (${transition_failures} transition failure, 0 after)"
}

# ── Phase 5: A→B, control must fail ────────────────────────────────────
phase5() {
  header "Phase 5 — DNS answers set B; the control loses its pinned set"
  switch_dns B phase5 || {
    fail "could not apply the CoreDNS override for set B"
    finish 2 corefile-not-applied
  }
  local patch_ms=$T_PATCH_MS t_dns=""
  # The branch-probe-reads-control mutation starts here, once A is validated.
  if [ "$MUTATION" = branch-probe-reads-control ]; then
    : >"$BRANCH_REDIRECT_FILE"
  fi

  if ! wait_until "$DNS_VISIBLE_TIMEOUT" "HCC's resolver to answer set B" dns_is "$CSV_B"; then
    fail "HCC did not see set B within ${DNS_VISIBLE_TIMEOUT}s"
    capture_coredns_reload_errors
    finish 3 phase5-dns-set-b-not-visible
  fi
  ok "HCC resolves ${CDN_HOST} to exactly set B (ttl <= 5)"

  if ! t_dns="$(wait_until "$DNS_VISIBLE_TIMEOUT" "the first observed B address in the window state" \
    observed_at "$EXPECTED_B_JSON" "$patch_ms")"; then
    fail "HCC never recorded a B address as observed"
    finish 3 phase5-policy-b-not-converged
  fi
  if ! [[ "$t_dns" =~ ^[0-9]+$ ]]; then
    fail "t_dns is not a millisecond timestamp"
    finish 3 phase5-policy-b-not-converged
  fi
  printf '%s\n' "$t_dns" >"${EVIDENCE_DIR}/t-dns-phase5.txt"

  if ! wait_policy_until "$EXPECTED_B_CIDRS" "$((t_dns + POLICY_CONVERGE_MS))"; then
    fail "the policy did not become exactly set B within ${POLICY_CONVERGE_MS} ms of t_dns"
    policy_cidrs >"${EVIDENCE_DIR}/policy-at-phase5-timeout.txt" 2>&1 || :
    finish 3 phase5-policy-b-not-converged
  fi
  if ! wait_policy_sample "$EXPECTED_B_CIDRS" "$patch_ms"; then
    fail "the policy sample loop did not record set B"
    finish 3 policy-loop-missing
  fi
  ok "policy ${POLICY_NAME} is exactly set B (set A pruned)"
  assert_no_rate_limit "$patch_ms" -1

  # Both probes are observed over the same policy = B window, which lasts until the control has failed three
  # times in a row or CONTROL_FAIL_TIMEOUT has passed. The branch verdict is still reported first.
  local control_failed=0
  if wait_until "$CONTROL_FAIL_TIMEOUT" "the control to fail three times in a row" \
    streak_of_failures "$CONTROL_SAMPLES" "$T_POLICY_MS" "$((CONTROL_FAIL_TIMEOUT * 1000))" 3; then
    control_failed=1
  fi

  assert_branch_identity
  local post_failures transition_failures
  if ! has_result_since "$BRANCH_SAMPLES" "$T_POLICY_MS"; then
    fail "the branch probe produced no network result with policy = B; the 0-failure claim has no witness"
    finish 3 probe-unavailable
  fi
  post_failures="$(count_failures "$BRANCH_SAMPLES" "$T_POLICY_MS" -1)"
  if [ "$post_failures" -gt 0 ]; then
    first_failure "$BRANCH_SAMPLES" "$T_POLICY_MS" -1 >"${EVIDENCE_DIR}/branch-failure-phase5.txt"
    fail "the branch proxy failed ${post_failures} time(s) with the policy exactly set B"
    finish 1 branch-failed-after-prune
  fi
  transition_failures="$(count_failures "$BRANCH_SAMPLES" "$patch_ms" "$T_POLICY_MS")"
  if [ "$transition_failures" -gt 1 ]; then
    fail "the branch proxy failed ${transition_failures} times during the A→B transition (budget: 1)"
    finish 1 branch-transition-failures
  fi
  ok "the branch proxy followed A→B without a restart (${transition_failures} transition failure, 0 after)"

  assert_control_identity
  # Control: at least three consecutive failures within CONTROL_FAIL_TIMEOUT of the prune.
  if [ "$control_failed" -ne 1 ]; then
    if ! has_result_since "$CONTROL_SAMPLES" "$T_POLICY_MS"; then
      fail "the control probe produced no network result after the prune; the failure claim has no witness"
      finish 3 probe-unavailable
    fi
    fail "the control kept serving through CloudFront after set A was pruned"
    fail "with E2E_CDN_MUTATION=control-uses-fixed-template this is the expected vacuity failure"
    finish 1 control-did-not-fail
  fi
  ok "the control failed at least three times in a row while pinned to set A"
}

# ── Phase 6: B→A, control recovers ─────────────────────────────────────
phase6() {
  header "Phase 6 — DNS answers set A; the control recovers"
  switch_dns A phase6 || {
    fail "could not apply the CoreDNS override for set A"
    finish 2 corefile-not-applied
  }
  local patch_ms=$T_PATCH_MS t_dns=""
  if ! wait_until "$DNS_VISIBLE_TIMEOUT" "HCC's resolver to answer set A" dns_is "$CSV_A"; then
    fail "HCC did not see set A within ${DNS_VISIBLE_TIMEOUT}s"
    capture_coredns_reload_errors
    finish 3 phase6-dns-set-a-not-visible
  fi
  ok "HCC resolves ${CDN_HOST} to exactly set A (ttl <= 5)"

  if ! t_dns="$(wait_until "$DNS_VISIBLE_TIMEOUT" "the first observed A address in the window state" \
    observed_at "$EXPECTED_A_JSON" "$patch_ms")"; then
    fail "HCC never recorded an A address as observed"
    finish 3 phase6-policy-a-not-converged
  fi
  if ! [[ "$t_dns" =~ ^[0-9]+$ ]]; then
    fail "t_dns is not a millisecond timestamp"
    finish 3 phase6-policy-a-not-converged
  fi
  printf '%s\n' "$t_dns" >"${EVIDENCE_DIR}/t-dns-phase6.txt"

  if ! wait_policy_until "$EXPECTED_A_CIDRS" "$((t_dns + POLICY_CONVERGE_MS))"; then
    fail "the policy did not become exactly set A within ${POLICY_CONVERGE_MS} ms of t_dns"
    policy_cidrs >"${EVIDENCE_DIR}/policy-at-phase6-timeout.txt" 2>&1 || :
    finish 3 phase6-policy-a-not-converged
  fi
  if ! wait_policy_sample "$EXPECTED_A_CIDRS" "$patch_ms"; then
    fail "the policy sample loop did not record set A"
    finish 3 policy-loop-missing
  fi
  ok "policy ${POLICY_NAME} is exactly set A again"
  assert_no_rate_limit "$patch_ms" -1
  assert_control_identity

  if ! wait_until "$CONTROL_RECOVER_TIMEOUT" "the control to recover through CloudFront" \
    has_upstream_since "$CONTROL_SAMPLES" "$T_POLICY_MS"; then
    if ! has_result_since "$CONTROL_SAMPLES" "$T_POLICY_MS"; then
      fail "the control probe produced no network result after the recovery; nothing was observed"
      finish 3 probe-unavailable
    fi
    fail "the control did not recover within ${CONTROL_RECOVER_TIMEOUT}s of policy = A"
    finish 1 control-did-not-recover
  fi
  ok "the control recovered through CloudFront without restarting"

  # The control can recover on its first sample after the policy change, before the branch has sampled at all.
  if ! wait_until "$PROXY_UPSTREAM_TIMEOUT" "a branch probe result with policy = A" \
    has_result_since "$BRANCH_SAMPLES" "$T_POLICY_MS"; then
    fail "the branch probe produced no network result with policy = A; the 0-failure claim has no witness"
    finish 3 probe-unavailable
  fi
  assert_branch_identity
  local post_failures transition_failures
  post_failures="$(count_failures "$BRANCH_SAMPLES" "$T_POLICY_MS" -1)"
  if [ "$post_failures" -gt 0 ]; then
    first_failure "$BRANCH_SAMPLES" "$T_POLICY_MS" -1 >"${EVIDENCE_DIR}/branch-failure-phase6.txt"
    fail "the branch proxy failed ${post_failures} time(s) with the policy exactly set A after recovery"
    finish 1 branch-failed-after-recovery
  fi
  transition_failures="$(count_failures "$BRANCH_SAMPLES" "$patch_ms" "$T_POLICY_MS")"
  if [ "$transition_failures" -gt 1 ]; then
    fail "the branch proxy failed ${transition_failures} times during the B→A transition (budget: 1)"
    finish 1 branch-transition-failures
  fi
  ok "the branch proxy followed B→A without a restart (${transition_failures} transition failure, 0 after)"
}

# ── Evidence capture before cleanup deletes the pods ───────────────────
capture_proxy_logs() {
  if [ -n "$BRANCH_POD" ]; then
    kctl logs "$BRANCH_POD" -n "$RECIPE_NS" -c egress-proxy --tail=200 --request-timeout=30s \
      >"${EVIDENCE_DIR}/branch-proxy.log" 2>&1 || :
  fi
  if [ -n "$CONTROL_POD" ]; then
    kctl logs "$CONTROL_POD" -n "$RECIPE_NS" -c egress-proxy --tail=200 --request-timeout=30s \
      >"${EVIDENCE_DIR}/control-proxy.log" 2>&1 || :
  fi
}

# hcc_env_has_test_overlap <env-json>: 0 when the HCC env carries phase 1's overlap.
hcc_env_has_test_overlap() {
  printf '%s' "$1" | jq -e --arg value "$HCC_TEST_OVERLAP_SEC" \
    'any(.[]?; .name == "HCC_EXTERNAL_EGRESS_OVERLAP_SEC" and .value == $value)' >/dev/null
}

# ── Main ───────────────────────────────────────────────────────────────
# Execution guard: the hermetic cleanup harness
# (scripts/tests/test-egress-cdn-rotation-cleanup.sh) sources this file to
# reach the helpers above. Sourcing must define functions and state only —
# never install the traps or start a phase.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  trap on_exit EXIT
  trap 'finish 3 interrupted' INT
  trap 'finish 3 interrupted' TERM
  trap 'finish 3 interrupted' HUP

  phase0 "$@"
  phase1
  phase2
  phase3
  phase4
  phase5
  phase6
  header "Phase 7 — Cleanup and restore"
  capture_proxy_logs
  finish 0 none
fi
