#!/usr/bin/env bash
# The recovery path must apply a complete rendered object, never the
# strategic-merge patch that omits the control-plane podSelector.
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
HELPER="$ROOT/scripts/minikube/validate-k8s-api-egress-policy.rb"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-k8s-api-policy.XXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
pass() {
  printf 'PASS: %s\n' "$1"
}

cat >"$TMP_DIR/rendered.yaml" <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: unrelated-policy
  namespace: control-plane
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress: []
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-k8s-api-egress-control-plane
  namespace: control-plane
  labels:
    clerum.io/policy-type: infrastructure
spec:
  podSelector:
    matchExpressions:
      - key: app
        operator: In
        values: [host-context-controller, workflow-recipes, control-api, trace-maintenance-worker]
  policyTypes: [Egress]
  egress:
    - ports:
        - port: 443
          protocol: TCP
        - port: 8443
          protocol: TCP
      to:
        - ipBlock:
            cidr: 172.17.0.3/32
YAML

RUBYOPT=--disable=gems ruby "$HELPER" --extract 172.17.0.3/32 <"$TMP_DIR/rendered.yaml" >"$TMP_DIR/complete.yaml"
grep -Fq 'name: allow-k8s-api-egress-control-plane' "$TMP_DIR/complete.yaml" ||
  fail 'complete extraction omitted the target identity'
grep -Fq 'matchExpressions:' "$TMP_DIR/complete.yaml" ||
  fail 'complete extraction omitted the inherited podSelector'
! grep -Fq 'name: unrelated-policy' "$TMP_DIR/complete.yaml" ||
  fail 'complete extraction emitted an unrelated object'
pass 'rendered extraction emits one complete control-plane policy'

RUBYOPT=--disable=gems ruby -rjson -ryaml -e 'puts JSON.generate(YAML.load_stream(File.read(ARGV.fetch(0))).first)' \
  "$TMP_DIR/complete.yaml" >"$TMP_DIR/complete.json"
RUBYOPT=--disable=gems ruby "$HELPER" --check-live 172.17.0.3/32 <"$TMP_DIR/complete.json" | grep -Fxq MATCH ||
  fail 'complete live policy was not recognized as matching'
pass 'complete live policy matches the current endpoint and ports'

RUBYOPT=--disable=gems ruby -rjson -ryaml -e '
  value = YAML.load_stream(File.read(ARGV.fetch(0))).first
  value.fetch("spec").fetch("egress").first.fetch("to").first.fetch("ipBlock")["cidr"] = "172.17.0.5/32"
  puts JSON.generate(value)
' "$TMP_DIR/complete.yaml" >"$TMP_DIR/stale.json"
stale_status=0
RUBYOPT=--disable=gems ruby "$HELPER" --check-live 172.17.0.3/32 <"$TMP_DIR/stale.json" >"$TMP_DIR/stale.out" || stale_status=$?
[[ "$stale_status" -eq 1 ]] || fail 'stale endpoint did not return the drift status'
grep -Fxq DRIFT "$TMP_DIR/stale.out" || fail 'stale endpoint was not classified as drift'
pass 'stale endpoint policy is classified as a repairable drift'

RUBYOPT=--disable=gems ruby -rjson -ryaml -e '
  value = YAML.load_stream(File.read(ARGV.fetch(0))).first
  value.fetch("spec")["podSelector"] = {}
  puts JSON.generate(value)
' "$TMP_DIR/complete.yaml" >"$TMP_DIR/broad.json"
broad_status=0
RUBYOPT=--disable=gems ruby "$HELPER" --check-live 172.17.0.3/32 <"$TMP_DIR/broad.json" >"$TMP_DIR/broad.out" 2>"$TMP_DIR/broad.err" || broad_status=$?
[[ "$broad_status" -eq 2 ]] || fail 'broad all-pods selector was accepted for recovery'
grep -Fq 'complete control-plane writer selector' "$TMP_DIR/broad.err" ||
  fail 'broad selector failure was not explicit'
pass 'broad selectors fail closed instead of being overwritten'

cat >"$TMP_DIR/strategic-patch.yaml" <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-k8s-api-egress-control-plane
  namespace: control-plane
spec:
  egress:
    - to:
        - ipBlock:
            cidr: 172.17.0.3/32
      ports:
        - port: 443
          protocol: TCP
        - port: 8443
          protocol: TCP
YAML
patch_status=0
RUBYOPT=--disable=gems ruby "$HELPER" --extract 172.17.0.3/32 <"$TMP_DIR/strategic-patch.yaml" >"$TMP_DIR/unsafe.out" 2>"$TMP_DIR/unsafe.err" || patch_status=$?
[[ "$patch_status" -eq 2 ]] || fail 'strategic-merge patch without inherited selector was accepted'
pass 'strategic-merge patch is rejected unless the rendered object is complete'

printf 'PASS: Minikube Kubernetes API egress policy contract\n'
