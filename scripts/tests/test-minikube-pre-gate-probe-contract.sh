#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="${ROOT}/scripts/minikube/pre-gate-runtime.sh"
PARENT="${ROOT}/scripts/minikube/pre-gate-sync.sh"
MANIFEST="${ROOT}/deploy/overlays/minikube/instances/host.yaml"
FAIL=0

pass() { printf 'PASS: %s\n' "$*"; }
fail_test() { printf 'FAIL: %s\n' "$*" >&2; FAIL=1; }
log() { :; }

if grep -A4 '^kind: Host$' "$MANIFEST" | grep -Fq 'name: chatllm' &&
   grep -A4 '^kind: Host$' "$MANIFEST" | grep -Fq 'namespace: mcp-host'; then
  pass "minikube overlay declares the versioned mcp-host/chatllm probe"
else
  fail_test "minikube overlay does not declare the versioned probe"
fi

unset HOST_CRD_SCHEMA_PROBE_REF
PROJECT_DIR="$ROOT" PROFILE=contract GATE_NAME=contract KC=true
# shellcheck source=scripts/minikube/pre-gate-runtime.sh
source "$HELPER"
if [ "$HOST_CRD_SCHEMA_PROBE_REF" = mcp-host/chatllm ] &&
   export -p | grep -Fq 'HOST_CRD_SCHEMA_PROBE_REF'; then
  pass "pre-gate runtime exports the manifest-backed default probe"
else
  fail_test "pre-gate runtime did not propagate the default probe"
fi

fake_kc() {
  [[ "$*" == 'get deployment host-context-controller -n control-plane' ]] && return 0
  [[ "$*" == 'get host chatllm -n mcp-host' ]] && return "${HOST_PRESENT:-1}"
  return 1
}
KC=fake_kc
HOST_PRESENT=0
preflight_host_lifecycle_probe || fail_test "existing manifest-backed probe was rejected"
HOST_PRESENT=1
if preflight_host_lifecycle_probe; then
  fail_test "missing probe did not fail before sync work"
else
  pass "missing manifest-backed probe fails closed"
fi

HOST_CRD_SCHEMA_PROBE_REF=invalid
if preflight_host_lifecycle_probe; then
  fail_test "invalid probe reference was accepted"
else
  pass "invalid probe reference fails closed"
fi

probe_line="$(grep -n '^preflight_host_lifecycle_probe$' "$PARENT" | cut -d: -f1)"
# The sync script fingerprints once for change detection and once again after
# generated profile inputs are settled.  This ordering contract only needs the
# first (preflight) occurrence; selecting it explicitly keeps the assertion
# scalar and avoids a false failure when the post-deploy recomputation exists.
fingerprint_line="$(grep -n 'cluster_fingerprint=.*pre_gate_marker_cluster_fingerprint' "$PARENT" | head -n 1 | cut -d: -f1)"
if [ -n "$probe_line" ] && [ -n "$fingerprint_line" ] && [ "$probe_line" -lt "$fingerprint_line" ]; then
  pass "probe preflight runs before package checks and cluster rebuild"
else
  fail_test "probe preflight is not ordered before expensive sync work"
fi

exit "$FAIL"
