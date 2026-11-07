#!/usr/bin/env bash
# Cluster-free contract for deploy/scripts/np-preflight-inventory.rb, the
# namespace derivation np-enforce-preflight.sh runs on a rendered overlay.
#
# The preflight must read HCC's namespace variables the way HCC does: an absent
# entry means HCC's code default, an explicit value (including "") overrides
# it, the last of duplicated env entries applies, and the HCC container is
# found by name. A value the render cannot show (valueFrom, envFrom), a missing
# HCC Deployment and an explicitly empty runtime list are refused: an empty
# runtime list would make the preflight skip the runtime namespaces' checks and
# still report them as passed.
#
# Case g compares the helper's default constants with the literals in
# host-context-controller/src/config.ts, so the two copies cannot drift apart.
#
# Cases m, n and o run np-enforce-preflight.sh itself against a stub kubectl placed
# first on PATH, so no real kubectl runs. The stub serves `kustomize` and refuses
# everything else, so in m and n the wrapper stops at its cluster check. In o it also
# answers `get nodes`, so the wrapper walks its checks over the derived namespaces.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INV="$ROOT/deploy/scripts/np-preflight-inventory.rb"
HCC_CONFIG="$ROOT/host-context-controller/src/config.ts"
EXPECTED_PASSES=15
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSES=0
FAIL=0
pass() { echo "PASS: $1"; PASSES=$((PASSES + 1)); }
fail() { echo "FAIL: $1"; FAIL=1; }

command -v ruby >/dev/null 2>&1 || { echo "FAIL: ruby is required"; exit 1; }
[ -f "$INV" ] || { echo "FAIL: missing $INV"; exit 1; }

RUNTIME_BASE='            - name: CONTEXT_MAPPER_RUNTIME_NAMESPACES
              value: mcp-server,sandbox-recipes,rpc-proxy,sandbox-ui'
MINIMAL_BASE='            - name: CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES
              value: sandbox-ui'
MINIMAL_EMPTY='            - name: CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES
              value: ""'
RUNTIME_EMPTY='            - name: CONTEXT_MAPPER_RUNTIME_NAMESPACES
              value: ""'
RUNTIME_SHADOWED='            - name: CONTEXT_MAPPER_RUNTIME_NAMESPACES
              value: shadowed-only'
RUNTIME_VALUE_FROM='            - name: CONTEXT_MAPPER_RUNTIME_NAMESPACES
              valueFrom:
                configMapKeyRef:
                  name: hcc-namespaces
                  key: runtime'
ENV_FROM='          envFrom:
            - configMapRef:
                name: hcc-extra-env'

# fixture <out> <hcc|no-hcc> <extra-container-yaml...>
# Writes the Clerum Namespaces, one static allow-k8s-api-egress policy and,
# unless no-hcc, the HCC Deployment with the given env entries / envFrom.
fixture() {
  local out="$1" mode="$2" ns
  shift 2
  : >"$out"
  for ns in channels control-plane mcp-host mcp-server rpc-proxy sandbox-recipes sandbox-ui; do
    cat >>"$out" <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: $ns
  labels:
    app.kubernetes.io/part-of: clerum
---
YAML
  done
  cat >>"$out" <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-k8s-api-egress-channels
  namespace: channels
spec:
  podSelector: {}
  policyTypes: [Egress]
YAML
  [ "$mode" = "hcc" ] || [ "$mode" = "hcc-sidecar" ] || return 0
  cat >>"$out" <<'YAML'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: host-context-controller
  namespace: control-plane
spec:
  template:
    spec:
      containers:
YAML
  # A sidecar listed before HCC, carrying its own copy of the runtime variable.
  [ "$mode" = "hcc-sidecar" ] && cat >>"$out" <<'YAML'
        - name: proxy-sidecar
          image: proxy:test
          env:
            - name: CONTEXT_MAPPER_RUNTIME_NAMESPACES
              value: sidecar-only
YAML
  cat >>"$out" <<'YAML'
        - name: host-context-controller
          image: host-context-controller:test
          env:
            - name: CONTEXT_MAPPER_HOST_IMAGE
              value: mcp-host:test
YAML
  local block
  for block in "$@"; do
    printf '%s\n' "$block" >>"$out"
  done
}

# derive <fixture>: sets OUT, ERR and RC from one run of the helper.
derive() {
  OUT="$(RUBYOPT=--disable=gems ruby -ryaml "$INV" <"$1" 2>"$TMP/stderr")"
  RC=$?
  ERR="$(cat "$TMP/stderr")"
}

value_of() {
  printf '%s\n' "$OUT" | sed -n "s/^$1='\(.*\)'\$/\1/p"
}

expect_inventory() {
  local label="$1" want_runtime="$2" want_k8s="$3" got_runtime got_k8s got_all
  if [ "$RC" -ne 0 ]; then
    fail "$label: exit $RC, stderr: $ERR"
    return
  fi
  got_runtime="$(value_of RUNTIME_NAMESPACES)"
  got_k8s="$(value_of K8S_API_NAMESPACES)"
  got_all="$(value_of ALL_NAMESPACES)"
  if [ "$got_runtime" != "$want_runtime" ]; then
    fail "$label: RUNTIME_NAMESPACES='$got_runtime', want '$want_runtime'"
  elif [ "$got_k8s" != "$want_k8s" ]; then
    fail "$label: K8S_API_NAMESPACES='$got_k8s', want '$want_k8s'"
  elif [ "$got_all" != "channels control-plane mcp-host mcp-server rpc-proxy sandbox-recipes sandbox-ui" ]; then
    fail "$label: ALL_NAMESPACES='$got_all'"
  else
    pass "$label (RUNTIME_NAMESPACES='$got_runtime' K8S_API_NAMESPACES='$got_k8s')"
  fi
}

expect_refusal() {
  local label="$1" want_err="$2"
  if [ "$RC" -eq 0 ]; then
    fail "$label: exit 0 with output '$OUT'; it must refuse"
  elif [ -n "$OUT" ]; then
    fail "$label: exit $RC but printed '$OUT'; a refusal must print no assignments"
  elif [[ "$ERR" != *"$want_err"* ]]; then
    fail "$label: exit $RC, stderr '$ERR' does not name '$want_err'"
  else
    pass "$label (exit $RC: $ERR)"
  fi
}

DEFAULT_RUNTIME="mcp-server sandbox-recipes rpc-proxy sandbox-ui"
DEFAULT_K8S="channels mcp-server rpc-proxy sandbox-recipes"

fixture "$TMP/a.yaml" hcc
derive "$TMP/a.yaml"
expect_inventory "a. both variables absent: HCC code defaults apply" "$DEFAULT_RUNTIME" "$DEFAULT_K8S"

fixture "$TMP/b.yaml" hcc "$RUNTIME_BASE" "$MINIMAL_BASE"
derive "$TMP/b.yaml"
expect_inventory "b. deploy/base shape (both explicit)" "$DEFAULT_RUNTIME" "$DEFAULT_K8S"

fixture "$TMP/c.yaml" hcc "$RUNTIME_BASE" "$MINIMAL_EMPTY"
derive "$TMP/c.yaml"
expect_inventory "c. explicit empty minimal list gives sandbox-ui the K8s API check" \
  "$DEFAULT_RUNTIME" "channels mcp-server rpc-proxy sandbox-recipes sandbox-ui"

fixture "$TMP/d.yaml" hcc "$RUNTIME_VALUE_FROM" "$MINIMAL_BASE"
derive "$TMP/d.yaml"
expect_refusal "d. runtime list from valueFrom is refused" \
  "CONTEXT_MAPPER_RUNTIME_NAMESPACES uses valueFrom"

fixture "$TMP/e.yaml" hcc "$MINIMAL_BASE" "$ENV_FROM"
derive "$TMP/e.yaml"
expect_refusal "e. runtime list absent with envFrom present is refused" \
  "CONTEXT_MAPPER_RUNTIME_NAMESPACES may come from envFrom"

fixture "$TMP/f.yaml" no-hcc
derive "$TMP/f.yaml"
expect_refusal "f. render without the HCC Deployment is refused" \
  "has no Deployment host-context-controller"

fixture "$TMP/h.yaml" hcc "$RUNTIME_EMPTY" "$MINIMAL_BASE"
derive "$TMP/h.yaml"
expect_refusal "h. explicitly empty runtime list is refused (HCC would read [\"\"])" \
  "CONTEXT_MAPPER_RUNTIME_NAMESPACES is set but lists no namespace"

fixture "$TMP/i.yaml" hcc-sidecar "$RUNTIME_BASE" "$MINIMAL_BASE"
derive "$TMP/i.yaml"
expect_inventory "i. HCC is picked by container name, not position" "$DEFAULT_RUNTIME" "$DEFAULT_K8S"

fixture "$TMP/j.yaml" hcc "$RUNTIME_SHADOWED" "$RUNTIME_BASE" "$MINIMAL_BASE"
derive "$TMP/j.yaml"
expect_inventory "j. a duplicated env entry resolves to the last one, as Kubernetes does" \
  "$DEFAULT_RUNTIME" "$DEFAULT_K8S"

sed 's/- name: host-context-controller$/- name: renamed-container/' "$TMP/a.yaml" >"$TMP/k.yaml"
derive "$TMP/k.yaml"
expect_refusal "k. a Deployment without the HCC container is refused" \
  "has no container host-context-controller"

: >"$TMP/l.yaml"
derive "$TMP/l.yaml"
expect_refusal "l. an empty render is refused as empty, not as a missing Deployment" \
  "the render is empty"

STUB="$TMP/stub"
mkdir -p "$STUB"
cat >"$STUB/kubectl" <<'SH'
#!/bin/sh
if [ "$1" = "kustomize" ] && [ -n "${STUB_RENDER:-}" ]; then
  cat "$STUB_RENDER"
  exit 0
fi
if [ "$*" = "--context stub-context get nodes -o name" ] && [ -n "${STUB_NODES:-}" ]; then
  exit 0
fi
echo "stub kubectl refused: $*" >&2
exit 1
SH
chmod +x "$STUB/kubectl"

# wrapper [render]: sets OUT, ERR and RC from one run of np-enforce-preflight.sh.
wrapper() {
  OUT="$(CONTEXT=stub-context OVERLAY=minikube STUB_RENDER="${1:-}" PATH="$STUB:$PATH" \
    bash "$ROOT/deploy/scripts/np-enforce-preflight.sh" 2>"$TMP/stderr")"
  RC=$?
  ERR="$(cat "$TMP/stderr")"
}

wrapper
if [ "$RC" -eq 2 ] && [[ "$ERR" == *"stub kubectl refused: kustomize"* ]] &&
  [[ "$ERR" == *"failed to derive namespace inventory"* ]] && [[ "$ERR" != *"has no Deployment"* ]]; then
  pass "m. a failed render shows its own error and stops the wrapper"
else
  fail "m. failed render: exit $RC, stderr: $ERR"
fi

wrapper "$TMP/b.yaml"
if [[ "$OUT" == *"[static] Rendered NetworkPolicy lint"* ]] && [ "$RC" -eq 2 ] &&
  [[ "$ERR" == *"cannot reach cluster for context 'stub-context'"* ]]; then
  pass "n. the wrapper derives the inventory through the helper and goes on"
else
  fail "n. good render: exit $RC, stdout: $OUT, stderr: $ERR"
fi

# The wrapper's checks walk the namespaces this render derives, not its hard-coded fallback
# lists. Each list has a witness only the render can supply; webhook-ingress is only in the
# fallback. The stub refuses the reads, so every per-namespace check reports a failure.
RUNTIME_WITNESS='            - name: CONTEXT_MAPPER_RUNTIME_NAMESPACES
              value: mcp-server,runtime-witness'
fixture "$TMP/o.yaml" hcc "$RUNTIME_WITNESS" "$MINIMAL_BASE"
cat >>"$TMP/o.yaml" <<'YAML'
---
apiVersion: v1
kind: Namespace
metadata:
  name: all-witness
  labels:
    app.kubernetes.io/part-of: clerum
YAML
STUB_NODES=1 wrapper "$TMP/o.yaml"
if [ "$RC" -eq 1 ] &&
  [[ "$OUT" == *"FAIL  all-witness: cannot validate DNS egress"* ]] &&
  [[ "$OUT" == *"FAIL  runtime-witness: allow-k8s-api-egress-runtime-witness not found"* ]] &&
  [[ "$OUT" == *"no RBAC-empowered pod is missing the label in: mcp-server runtime-witness"* ]] &&
  [[ "$OUT" != *"webhook-ingress"* ]]; then
  pass "o. the wrapper's checks walk the inventory the helper derived"
else
  fail "o. derived lists not used: exit $RC, stdout: $OUT, stderr: $ERR"
fi

# shellcheck disable=SC2016 # Ruby source; $PROGRAM_NAME is a Ruby global.
if drift="$(RUBYOPT=--disable=gems ruby -ryaml -e '
  load ARGV.fetch(0) # $PROGRAM_NAME is -e here, so the helper prints nothing
  src = File.read(ARGV.fetch(1), encoding: "UTF-8")
  literal = lambda do |name|
    found = src[/getEnv\(\s*\x27#{name}\x27,\s*\x27([^\x27]*)\x27\s*\)/m, 1]
    abort("no getEnv(\x27#{name}\x27, <literal>) default in #{ARGV[1]}") if found.nil?
    found.split(",").map(&:strip).reject(&:empty?)
  end
  pairs = {
    "CONTEXT_MAPPER_RUNTIME_NAMESPACES" => HCC_DEFAULT_RUNTIME_NAMESPACES,
    "CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES" => HCC_DEFAULT_MINIMAL_INFRA_NAMESPACES,
  }
  pairs.each do |name, constant|
    hcc = literal.call(name)
    abort("#{name}: config.ts default #{hcc.inspect} != helper default #{constant.inspect}") unless hcc == constant
    puts "#{name}=#{hcc.join(",")}"
  end
' "$INV" "$HCC_CONFIG" 2>&1)"; then
  pass "g. helper defaults equal the HCC config.ts defaults ($(printf '%s' "$drift" | tr '\n' ' '))"
else
  fail "g. default drift: $drift"
fi

echo "NP_PREFLIGHT_INVENTORY_PASSES=$PASSES/$EXPECTED_PASSES"
if [ "$FAIL" -ne 0 ] || [ "$PASSES" -ne "$EXPECTED_PASSES" ]; then
  echo "NP_PREFLIGHT_INVENTORY_FAIL"
  exit 1
fi
echo "NP_PREFLIGHT_INVENTORY_PASS"
