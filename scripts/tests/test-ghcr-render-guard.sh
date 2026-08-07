#!/usr/bin/env bash
set -u
FAIL=0

# scripts/ci/check-ghcr-render.mjs asserts that a ghcr-mode render actually
# resolved: no clerum/ image reference survives, and every resolved tag equals
# the pin in deploy/components/ghcr-images/kustomization.yaml.
#
# It matches FIELDS (`image:` and `value:`), not raw strings, because five
# clerum/ strings legitimately survive a correct render: two /etc/clerum/*
# mount paths (not image fields at all) and three documented prefix-allowlist
# or opt-in-local-build env values enumerated in the guard's EXCEPTIONS map.
# A naive "zero clerum/ strings" guard is unsatisfiable.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/ci/check-ghcr-render.mjs"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# Every case renders against a throwaway component file so the fixtures do not
# have to be re-edited each time the real pin moves.
make_component() {
  local d=$1 tag=$2
  mkdir -p "$d"
  cat > "$d/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
configurations:
  - imagetags.yaml
images:
  - name: clerum/control-api
    newName: ghcr.io/evenfire-ai/control-api
    newTag: $tag
EOF
}

# A minimal but REALISTIC clean render: a rewritten container image, a rewritten
# env-var image ref, and all three documented exceptions in their real form.
make_clean_render() {
  local f=$1 tag=$2
  cat > "$f" <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: control-api-config
data:
  CONTROL_API_ALLOWED_IMAGE_PREFIXES: ghcr.io/evenfire-ai/,mongodb/,mcr.microsoft.com/,clerum/
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: control-api
spec:
  template:
    spec:
      containers:
        - name: control-api
          image: ghcr.io/evenfire-ai/control-api:$tag
          volumeMounts:
            - mountPath: /etc/clerum/workflow-approval-request-reader
              name: targets
          env:
            - name: CONTEXT_MAPPER_GFSC_IMAGE
              value: ghcr.io/evenfire-ai/gfs-controller:$tag
            - name: CONTEXT_MAPPER_DESKTOP_IMAGE
              value: clerum/mcp-host-desktop:test
            - name: WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES
              value: 'clerum/workflow-custom-sdk-e2e:'
            - name: CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES
              value: ghcr.io/evenfire-ai/,mongodb/,mcr.microsoft.com/,clerum/
        - name: sidecar
          image: postgres:16-alpine
EOF
}

assert_a_clean_render_passes() {
  local d out rc
  d="$(mktemp -d)"
  make_component "$d/component" v0.6.0
  make_clean_render "$d/render.yaml" v0.6.0
  out="$(node "$GUARD" "$d/render.yaml" --component "$d/component/kustomization.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "a clean render with all three documented exceptions passes"
  else
    fail "clean render rejected (rc=$rc): $out"
  fi
  rm -rf "$d"
}

assert_an_unrewritten_container_image_fails() {
  local d out rc
  d="$(mktemp -d)"
  make_component "$d/component" v0.6.0
  make_clean_render "$d/render.yaml" v0.6.0
  printf '        - name: leftover\n          image: clerum/control-api:test\n' >> "$d/render.yaml"
  out="$(node "$GUARD" "$d/render.yaml" --component "$d/component/kustomization.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -q "clerum/control-api:test" <<< "$out"; then
    pass "an unrewritten container image is rejected and named"
  else
    fail "expected a failure naming clerum/control-api:test; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# The independent-observation property (spec section 9): the guard reads the
# tag the overlay actually produced, not the field the writer wrote. A render
# left on the previous release must fail even though nothing says clerum/.
assert_a_stale_resolved_tag_fails() {
  local d out rc
  d="$(mktemp -d)"
  make_component "$d/component" v0.6.0
  make_clean_render "$d/render.yaml" v0.5.0
  out="$(node "$GUARD" "$d/render.yaml" --component "$d/component/kustomization.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -q "v0.5.0" <<< "$out" && grep -q "v0.6.0" <<< "$out"; then
    pass "a resolved tag that disagrees with the pin is rejected, naming both tags"
  else
    fail "expected a failure naming v0.5.0 and v0.6.0; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# An undocumented clerum/ env value is the exact regression the EXCEPTIONS map
# exists to catch: it means an image ref stopped being rewritten. The grep
# also requires the guard's "is not a documented exception" wording (not just
# the env var name), because the sibling "value drifted" branch also names
# the env var in ITS message -- checking only the name would pass even if the
# "undocumented" branch were dead code and the "drifted" branch's undefined
# !== value fallthrough silently covered for it.
assert_an_undocumented_clerum_env_value_fails() {
  local d out rc
  d="$(mktemp -d)"
  make_component "$d/component" v0.6.0
  make_clean_render "$d/render.yaml" v0.6.0
  printf '            - name: SOME_NEW_IMAGE\n              value: clerum/some-new-image:test\n' >> "$d/render.yaml"
  out="$(node "$GUARD" "$d/render.yaml" --component "$d/component/kustomization.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -q "SOME_NEW_IMAGE" <<< "$out" && grep -q "not a documented exception" <<< "$out"; then
    pass "an undocumented clerum/ env value is rejected, naming the env var and the reason"
  else
    fail "expected a failure naming SOME_NEW_IMAGE and 'not a documented exception'; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# An exception is pinned to its EXACT value, not just its env-var name. If
# CONTEXT_MAPPER_DESKTOP_IMAGE ever changed to a different clerum image, the
# blanket-by-name form would wave it through. The grep also requires the
# guard's "value drifted" wording, distinguishing this from the sibling
# "undocumented" branch's message, which also names the env var.
assert_an_exception_with_a_drifted_value_fails() {
  local d out rc
  d="$(mktemp -d)"
  make_component "$d/component" v0.6.0
  make_clean_render "$d/render.yaml" v0.6.0
  sed -i.bak 's#value: clerum/mcp-host-desktop:test#value: clerum/mcp-host-desktop:other#' "$d/render.yaml"
  out="$(node "$GUARD" "$d/render.yaml" --component "$d/component/kustomization.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -q "CONTEXT_MAPPER_DESKTOP_IMAGE" <<< "$out" && grep -q "value drifted" <<< "$out"; then
    pass "a documented exception whose value drifted is rejected"
  else
    fail "expected a failure naming CONTEXT_MAPPER_DESKTOP_IMAGE and 'value drifted'; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# The anti-vacuous-pass rule. A guard that scanned nothing is broken, not green.
assert_a_render_with_no_ghcr_refs_fails() {
  local d out rc
  d="$(mktemp -d)"
  make_component "$d/component" v0.6.0
  printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: empty\n' > "$d/render.yaml"
  out="$(node "$GUARD" "$d/render.yaml" --component "$d/component/kustomization.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -qi "zero" <<< "$out"; then
    pass "a render containing zero ghcr refs is rejected rather than passing vacuously"
  else
    fail "expected a failure about zero ghcr refs; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# A component with ZERO newTag: lines. This exercises tags.length === 0
# specifically -- distinct from a component whose newTag: lines DISAGREE
# (assert_a_component_with_mixed_newtag_values_fails_loudly below), which is
# a different failure mode with its own distinct.length > 1 check. The two
# checks compare tags.length === 0 vs distinct.length > 1 (not !== 1)
# precisely so they are DISJOINT: with zero tags, distinct.length is also 0,
# and 0 > 1 is false, so only the first check can ever fire for this fixture.
assert_an_unparseable_component_fails_loudly() {
  local d out rc
  d="$(mktemp -d)"
  mkdir -p "$d/component"
  printf 'apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\n' > "$d/component/kustomization.yaml"
  make_clean_render "$d/render.yaml" v0.6.0
  out="$(node "$GUARD" "$d/render.yaml" --component "$d/component/kustomization.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -q "has no \`newTag:\` lines" <<< "$out"; then
    pass "a component with no newTag: fails loudly instead of comparing against undefined"
  else
    fail "expected a failure naming 'has no \`newTag:\` lines'; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# The sibling case: newTag: lines are PRESENT but DISAGREE (a bad merge, a
# partial edit). tags.length is 2, not 0, so the check above cannot fire --
# only distinct.length > 1 can, making this test the independent proof that
# THAT check, not just the empty-tags one, is load-bearing.
assert_a_component_with_mixed_newtag_values_fails_loudly() {
  local d out rc
  d="$(mktemp -d)"
  mkdir -p "$d/component"
  cat > "$d/component/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
configurations:
  - imagetags.yaml
images:
  - name: clerum/control-api
    newName: ghcr.io/evenfire-ai/control-api
    newTag: v0.6.0
  - name: clerum/control-ui
    newName: ghcr.io/evenfire-ai/control-ui
    newTag: v0.6.1
EOF
  make_clean_render "$d/render.yaml" v0.6.0
  out="$(node "$GUARD" "$d/render.yaml" --component "$d/component/kustomization.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && grep -q "mixed newTag values" <<< "$out" && grep -q "v0.6.1" <<< "$out"; then
    pass "a component whose newTag: lines disagree fails loudly, naming the mismatch"
  else
    fail "expected a failure naming 'mixed newTag values' including v0.6.1; got rc=$rc out='$out'"
  fi
  rm -rf "$d"
}

# The real thing. Renders both committed ghcr overlays with the repo's own
# kubectl and runs the guard over them, so a real overlay regression fails here
# and not only in the CI job Task 8 adds.
assert_both_committed_ghcr_overlays_render_clean() {
  if ! command -v kubectl >/dev/null 2>&1; then
    pass "SKIPPED (no kubectl on PATH): committed ghcr overlay render"
    return 0
  fi
  local d out rc
  d="$(mktemp -d)"
  cp -R "$REPO_ROOT/deploy" "$d/deploy"
  sed 's#__K8S_API_IP__#10.96.0.1#g' \
    "$d/deploy/overlays/minikube/patches/k8s-api-ip.yaml.template" \
    > "$d/deploy/overlays/minikube/patches/k8s-api-ip.yaml"
  if ! kubectl kustomize "$d/deploy/overlays/minikube-ghcr" > "$d/a.yaml" 2>"$d/err-a"; then
    fail "minikube-ghcr did not render: $(cat "$d/err-a")"; rm -rf "$d"; return 0
  fi
  if ! kubectl kustomize "$d/deploy/overlays/minikube-no-uis-ghcr" > "$d/b.yaml" 2>"$d/err-b"; then
    fail "minikube-no-uis-ghcr did not render: $(cat "$d/err-b")"; rm -rf "$d"; return 0
  fi
  out="$(node "$GUARD" "$d/a.yaml" "$d/b.yaml" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "both committed ghcr overlays render with no surviving clerum/ image ref and the pinned tag throughout"
  else
    fail "committed ghcr overlay render rejected: $out"
  fi
  rm -rf "$d"
}

assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-ghcr-render-guard.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_a_clean_render_passes
assert_an_unrewritten_container_image_fails
assert_a_stale_resolved_tag_fails
assert_an_undocumented_clerum_env_value_fails
assert_an_exception_with_a_drifted_value_fails
assert_a_render_with_no_ghcr_refs_fails
assert_an_unparseable_component_fails_loudly
assert_a_component_with_mixed_newtag_values_fails_loudly
assert_both_committed_ghcr_overlays_render_clean
assert_every_defined_case_is_invoked

exit $FAIL
