#!/usr/bin/env bash
set -u
FAIL=0

# Focused test for deploy/scripts/minikube-detect-cluster-cidrs.sh.
#
# The script renders deploy/overlays/minikube/patches/llm-egress-cluster-cidrs.yaml
# from its .template with the live cluster's pod + Service CIDRs (and node CIDRs).
# HCC treats those CIDRs as a security input and is fail-closed, so the render
# must fail-closed too: abort (exit 1, no patch written) when a required CIDR is
# missing or malformed, never ship a partial/inert range.
#
# kubectl is stubbed on PATH so the reads resolve without a running cluster; each
# case installs the stub behaviour it needs.

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/scripts/minikube-detect-cluster-cidrs.sh"
TEMPLATE="$REPO_ROOT/deploy/overlays/minikube/patches/llm-egress-cluster-cidrs.yaml.template"

# Builds a throwaway overlay dir carrying the tracked template and a kubectl stub
# whose apiserver / controller-manager / nodes / endpoints answers are supplied
# by the caller (nodes + endpoint default to a single minikube node). Also stubs
# `docker` as absent-but-present-on-PATH returning nothing, so the optional
# docker-subnet read is exercised without depending on the host's docker.
# Echoes the dir path.
make_case_dir() {
  # Use ${3-...} / ${4-...} (no colon) so an explicitly empty arg stays empty —
  # case (v) passes "" to assert the no-node abort.
  local apiserver_cmd="$1" kcm_cmd="$2" nodes="${3-192.168.49.2}" endpoints="${4-192.168.49.2}"
  local d; d="$(mktemp -d)"
  mkdir -p "$d/bin" "$d/overlay/patches"
  cp "$TEMPLATE" "$d/overlay/patches/llm-egress-cluster-cidrs.yaml.template"
  cat > "$d/bin/kubectl" <<STUB
#!/usr/bin/env bash
case "\$*" in
  *"component=kube-apiserver"*) printf '%s\n' "$apiserver_cmd" ;;
  *"component=kube-controller-manager"*) printf '%s\n' "$kcm_cmd" ;;
  *"get nodes"*) printf '%s' "$nodes" ;;
  *"get endpoints kubernetes"*) printf '%s' "$endpoints" ;;
esac
exit 0
STUB
  chmod +x "$d/bin/kubectl"
  # docker stub: answers no subnets, proving the node CIDRs come from kubectl.
  cat > "$d/bin/docker" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$d/bin/docker"
  printf '%s\n' "$d"
}

run_script() {
  # $1 = case dir; remaining args become the environment (KEY=VALUE ...).
  local d="$1"; shift
  PATH="$d/bin:$PATH" OVERLAY_DIR="$d/overlay" CONTEXT=fake-context \
    env "$@" bash "$SCRIPT" >/dev/null 2>&1
}

# (i) Only the Service CIDR is detectable (no --cluster-cidr on the
#     controller-manager) → abort, no patch. This is the regression: before the
#     fix the script concatenated whatever it found and exited 0.
assert_aborts_without_pod_cidr() {
  local d rc
  d="$(make_case_dir \
    "kube-apiserver --service-cluster-ip-range=10.96.0.0/12" \
    "kube-controller-manager --allocate-node-cidrs=true")"
  run_script "$d"; rc=$?
  if [ "$rc" -ne 0 ] && [ ! -f "$d/overlay/patches/llm-egress-cluster-cidrs.yaml" ]; then
    pass "aborts (exit 1) and writes no patch when the pod CIDR is missing"
  else
    fail "expected abort + no patch when --cluster-cidr is absent (rc=$rc, patch exists: $([ -f "$d/overlay/patches/llm-egress-cluster-cidrs.yaml" ] && echo yes || echo no))"
  fi
  rm -rf "$d"
}

# (ii) Both CIDRs present → patch rendered with pod,Service order.
assert_renders_both_cidrs() {
  local d rc patch
  d="$(make_case_dir \
    "kube-apiserver --service-cluster-ip-range=10.96.0.0/12" \
    "kube-controller-manager --cluster-cidr=10.244.0.0/16")"
  run_script "$d"; rc=$?
  patch="$d/overlay/patches/llm-egress-cluster-cidrs.yaml"
  if [ "$rc" -eq 0 ] && [ -f "$patch" ] \
     && grep -q 'value: "10.244.0.0/16,10.96.0.0/12"' "$patch" \
     && ! grep -q '__CLUSTER_INTERNAL_CIDRS__' "$patch"; then
    pass "renders pod + Service CIDRs into the patch when both are detected"
  else
    fail "expected rendered internal-CIDR patch (rc=$rc); got: $(grep -n 'CLUSTER_INTERNAL_CIDRS\|value:' "$patch" 2>/dev/null | tr '\n' '|')"
  fi
  rm -rf "$d"
}

# (iii) Override entry without a prefix → abort.
assert_override_without_prefix_aborts() {
  local d rc
  d="$(make_case_dir "unused" "unused")"
  run_script "$d" "CLUSTER_INTERNAL_CIDRS=10.96.0.0"; rc=$?
  if [ "$rc" -ne 0 ] && [ ! -f "$d/overlay/patches/llm-egress-cluster-cidrs.yaml" ]; then
    pass "aborts on a malformed override (missing /prefix)"
  else
    fail "expected abort on override '10.96.0.0' (rc=$rc)"
  fi
  rm -rf "$d"
}

# (iv) Override carrying a shell/regex metacharacter → abort on format; and a
#      valid override renders verbatim (literal splice, not sed's & expansion).
assert_override_metachar_aborts_and_valid_renders_literal() {
  local d rc patch
  d="$(make_case_dir "unused" "unused")"
  run_script "$d" 'CLUSTER_INTERNAL_CIDRS=10.96.0.0/12&evil'; rc=$?
  if [ "$rc" -ne 0 ] && [ ! -f "$d/overlay/patches/llm-egress-cluster-cidrs.yaml" ]; then
    pass "aborts on an override containing a metacharacter"
  else
    fail "expected abort on override with '&' (rc=$rc)"
  fi
  rm -rf "$d"

  d="$(make_case_dir "unused" "unused")"
  run_script "$d" "CLUSTER_INTERNAL_CIDRS=10.1.2.0/24,10.96.0.0/12"; rc=$?
  patch="$d/overlay/patches/llm-egress-cluster-cidrs.yaml"
  if [ "$rc" -eq 0 ] && grep -q 'value: "10.1.2.0/24,10.96.0.0/12"' "$patch"; then
    pass "renders a valid override verbatim"
  else
    fail "expected verbatim render of a valid override (rc=$rc)"
  fi
  rm -rf "$d"
}

# (v) No node InternalIP → abort (the node category is fail-closed too: a
#     missing node range would let HCC accept the node IP as a LAN target).
assert_aborts_without_node_ip() {
  local d rc
  d="$(make_case_dir \
    "kube-apiserver --service-cluster-ip-range=10.96.0.0/12" \
    "kube-controller-manager --cluster-cidr=10.244.0.0/16" \
    "" "192.168.49.2")"
  run_script "$d"; rc=$?
  if [ "$rc" -ne 0 ] && [ ! -f "$d/overlay/patches/llm-egress-cluster-cidrs.yaml" ]; then
    pass "aborts (exit 1) and writes no patch when no node InternalIP is found"
  else
    fail "expected abort + no patch when node InternalIPs are empty (rc=$rc)"
  fi
  rm -rf "$d"
}

# (vi) Node InternalIP and apiserver endpoint are the same address → rendered as
#      a single /32 (dedup), and the node placeholder is fully substituted.
assert_node_cidrs_deduped_as_slash32() {
  local d rc patch node_value
  d="$(make_case_dir \
    "kube-apiserver --service-cluster-ip-range=10.96.0.0/12" \
    "kube-controller-manager --cluster-cidr=10.244.0.0/16" \
    "192.168.49.2" "192.168.49.2")"
  run_script "$d"; rc=$?
  patch="$d/overlay/patches/llm-egress-cluster-cidrs.yaml"
  # The node env value line must be the single deduped /32 — a non-deduped render
  # would be value: "192.168.49.2/32,192.168.49.2/32". (grep over the whole file
  # would also hit the template's doc comment, which is irrelevant here.)
  node_value="$(grep -E 'value: "192.168.49.2/32"' "$patch" 2>/dev/null)"
  if [ "$rc" -eq 0 ] \
     && [ -n "$node_value" ] \
     && ! grep -q '192.168.49.2/32,192.168.49.2/32' "$patch"; then
    pass "renders node + endpoint IP as a single deduped /32"
  else
    fail "expected one 192.168.49.2/32 in the node env (rc=$rc)"
  fi
  rm -rf "$d"
}

assert_aborts_without_pod_cidr
assert_renders_both_cidrs
assert_override_without_prefix_aborts
assert_override_metachar_aborts_and_valid_renders_literal
assert_aborts_without_node_ip
assert_node_cidrs_deduped_as_slash32

exit $FAIL
