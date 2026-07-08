#!/usr/bin/env bash
#
# E2E test for the ValidatingAdmissionPolicy that restricts WorkflowRecipe CRDs
# to the 'sandbox-recipes' namespace.
#
# Test A (negative): applying a recipe to 'control-plane' MUST be denied.
# Test B (positive): applying a recipe to 'sandbox-recipes' MUST succeed.
set -u

CONTEXT="${CONTEXT:-clerum-test}"
E2E_ALLOWED_CONTEXTS="${E2E_ALLOWED_CONTEXTS:-minikube,clerum-test}"
case ",${E2E_ALLOWED_CONTEXTS}," in
  *",${CONTEXT},"*) ;;
  *)
    echo "FAIL: refusing to run against context '${CONTEXT}' (allowed: ${E2E_ALLOWED_CONTEXTS})"
    exit 1
    ;;
esac
KC=(kubectl --context "$CONTEXT")

TMP_NEG="$(mktemp /tmp/vap-neg.XXXXXX.yaml)"
TMP_POS="$(mktemp /tmp/vap-pos.XXXXXX.yaml)"
TMP_OWNER="$(mktemp /tmp/vap-ownerref.XXXXXX.yaml)"
TMP_UPDATE_PARENT="$(mktemp /tmp/vap-ownerref-update-parent.XXXXXX.yaml)"
TMP_UPDATE_CHILD="$(mktemp /tmp/vap-ownerref-update-child.XXXXXX.yaml)"
TMP_WRC_PARENT="$(mktemp /tmp/vap-ownerref-wrc-parent.XXXXXX.yaml)"
TMP_WRC_CHILD="$(mktemp /tmp/vap-ownerref-wrc-child.XXXXXX.yaml)"

cleanup() {
  local cleanup_rc=0
  rm -f "$TMP_NEG" "$TMP_POS" "$TMP_OWNER" "$TMP_UPDATE_PARENT" "$TMP_UPDATE_CHILD" "$TMP_WRC_PARENT" "$TMP_WRC_CHILD"
  "${KC[@]}" delete workflowrecipe/vap-negative-test -n control-plane --ignore-not-found >/dev/null 2>&1 || cleanup_rc=1
  "${KC[@]}" delete workflowrecipe/vap-positive-test -n sandbox-recipes --ignore-not-found >/dev/null 2>&1 || cleanup_rc=1
  "${KC[@]}" delete workflowrecipe/vap-ownerref-test -n sandbox-recipes --ignore-not-found >/dev/null 2>&1 || cleanup_rc=1
  "${KC[@]}" delete workflowrecipe/vap-ownerref-update-child -n sandbox-recipes --ignore-not-found >/dev/null 2>&1 || cleanup_rc=1
  "${KC[@]}" delete workflowrecipe/vap-ownerref-update-parent -n sandbox-recipes --ignore-not-found >/dev/null 2>&1 || cleanup_rc=1
  "${KC[@]}" delete workflowrecipe/vap-ownerref-wrc-child -n sandbox-recipes --ignore-not-found >/dev/null 2>&1 || cleanup_rc=1
  "${KC[@]}" delete workflowrecipe/vap-ownerref-wrc-parent -n sandbox-recipes --ignore-not-found >/dev/null 2>&1 || cleanup_rc=1
  return "$cleanup_rc"
}

on_exit() {
  local rc=$?
  if ! cleanup; then
    if [ "$rc" -eq 0 ]; then
      echo "FAIL: cleanup left VAP E2E resources behind"
      exit 1
    fi
    echo "WARN: cleanup left VAP E2E resources behind" >&2
  fi
  exit "$rc"
}
trap on_exit EXIT

cat > "$TMP_NEG" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: vap-negative-test
  namespace: control-plane
spec:
  workloads:
    - id: evil
      type: deployment
      image: nginx:1.30.1-alpine
YAML

cat > "$TMP_POS" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: vap-positive-test
  namespace: sandbox-recipes
spec:
  workloads:
    - id: sleeper
      type: deployment
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
YAML

cat > "$TMP_OWNER" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: vap-ownerref-test
  namespace: sandbox-recipes
  ownerReferences:
    - apiVersion: clerum.io/v1alpha1
      kind: WorkflowRecipe
      name: victim-recipe
      uid: "00000000-0000-0000-0000-000000000000"
      controller: true
spec:
  steps:
    - id: noop
      instruction: "noop"
YAML

cat > "$TMP_UPDATE_PARENT" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: vap-ownerref-update-parent
  namespace: sandbox-recipes
spec:
  steps:
    - id: noop
      instruction: "noop"
YAML

cat > "$TMP_UPDATE_CHILD" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: vap-ownerref-update-child
  namespace: sandbox-recipes
spec:
  steps:
    - id: noop
      instruction: "noop"
YAML

cat > "$TMP_WRC_PARENT" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: vap-ownerref-wrc-parent
  namespace: sandbox-recipes
spec:
  steps:
    - id: noop
      instruction: "noop"
YAML

echo "=== TEST A (negative) — recipe in control-plane must be DENIED ==="
NEG_OUT="$("${KC[@]}" apply -f "$TMP_NEG" 2>&1)"
NEG_RC=$?
echo "$NEG_OUT"
if [ "$NEG_RC" -eq 0 ]; then
  echo "FAIL: namespace=control-plane was ACCEPTED (expected denial)"
  exit 1
fi
if ! echo "$NEG_OUT" | grep -qi "namespace"; then
  echo "FAIL: denial did not mention namespace — VAP may not be enforcing"
  exit 1
fi
echo "PASS: denied as expected"
echo

echo "=== TEST B (positive) — recipe in sandbox-recipes must be ACCEPTED ==="
POS_OUT="$("${KC[@]}" apply -f "$TMP_POS" 2>&1)"
POS_RC=$?
echo "$POS_OUT"
if [ "$POS_RC" -ne 0 ]; then
  echo "FAIL: namespace=sandbox-recipes was REJECTED (expected acceptance)"
  exit 1
fi
echo "PASS: accepted as expected"
echo

echo "=== TEST C (negative) — client-authored ownerReferences must be DENIED ==="
OWNER_OUT="$("${KC[@]}" apply -f "$TMP_OWNER" 2>&1)"
OWNER_RC=$?
echo "$OWNER_OUT"
if [ "$OWNER_RC" -eq 0 ]; then
  echo "FAIL: client-authored ownerReferences were ACCEPTED (expected denial)"
  exit 1
fi
if ! echo "$OWNER_OUT" | grep -qi "ownerReferences"; then
  echo "FAIL: denial did not mention ownerReferences — VAP may not be enforcing ownerRef guard"
  exit 1
fi
echo "PASS: ownerReferences denied as expected"
echo

echo "=== TEST D (negative) — ownerReferences added by UPDATE with a live parent UID must be DENIED ==="
if ! "${KC[@]}" apply -f "$TMP_UPDATE_PARENT" >/dev/null; then
  echo "FAIL: could not create live parent fixture for ownerReference update test"
  exit 1
fi
if ! "${KC[@]}" apply -f "$TMP_UPDATE_CHILD" >/dev/null; then
  echo "FAIL: could not create child fixture for ownerReference update test"
  exit 1
fi
if ! "${KC[@]}" get workflowrecipe/vap-ownerref-update-child -n sandbox-recipes >/dev/null 2>&1; then
  echo "FAIL: child fixture does not exist before ownerReference update test"
  exit 1
fi
if ! UPDATE_PARENT_UID="$("${KC[@]}" get workflowrecipe/vap-ownerref-update-parent -n sandbox-recipes -o jsonpath='{.metadata.uid}' 2>/dev/null)"; then
  echo "FAIL: could not read live parent UID for ownerReference update test"
  exit 1
fi
if [ -z "$UPDATE_PARENT_UID" ]; then
  echo "FAIL: live parent UID is empty before ownerReference update test"
  exit 1
fi
PATCH_OUT="$("${KC[@]}" patch workflowrecipe/vap-ownerref-update-child -n sandbox-recipes --type=merge -p "{\"metadata\":{\"ownerReferences\":[{\"apiVersion\":\"clerum.io/v1alpha1\",\"kind\":\"WorkflowRecipe\",\"name\":\"vap-ownerref-update-parent\",\"uid\":\"${UPDATE_PARENT_UID}\",\"controller\":true}]}}" 2>&1)"
PATCH_RC=$?
echo "$PATCH_OUT"
if [ "$PATCH_RC" -eq 0 ]; then
  echo "FAIL: client update added ownerReferences with a live parent UID (expected denial)"
  exit 1
fi
if ! echo "$PATCH_OUT" | grep -qi "ownerReferences"; then
  echo "FAIL: update denial did not mention ownerReferences — VAP may not be enforcing update guard"
  exit 1
fi
CHILD_OWNER_REFS="$("${KC[@]}" get workflowrecipe/vap-ownerref-update-child -n sandbox-recipes -o jsonpath='{.metadata.ownerReferences}' 2>/dev/null || true)"
if [ -n "$CHILD_OWNER_REFS" ]; then
  echo "FAIL: denied ownerReferences were persisted on vap-ownerref-update-child"
  exit 1
fi
echo "PASS: ownerReferences update denied and not persisted"
echo

echo "=== TEST E (positive) — workflow-recipes ServiceAccount can set controller ownerReferences ==="
if ! "${KC[@]}" apply -f "$TMP_WRC_PARENT" >/dev/null; then
  echo "FAIL: could not create live parent fixture for workflow-recipes ServiceAccount test"
  exit 1
fi
if ! WRC_PARENT_UID="$("${KC[@]}" get workflowrecipe/vap-ownerref-wrc-parent -n sandbox-recipes -o jsonpath='{.metadata.uid}' 2>/dev/null)"; then
  echo "FAIL: could not read live parent UID for workflow-recipes ServiceAccount test"
  exit 1
fi
if [ -z "$WRC_PARENT_UID" ]; then
  echo "FAIL: live parent UID is empty before workflow-recipes ServiceAccount test"
  exit 1
fi
cat > "$TMP_WRC_CHILD" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: vap-ownerref-wrc-child
  namespace: sandbox-recipes
  ownerReferences:
    - apiVersion: clerum.io/v1alpha1
      kind: WorkflowRecipe
      name: vap-ownerref-wrc-parent
      uid: "$WRC_PARENT_UID"
      controller: true
spec:
  steps:
    - id: noop
      instruction: "noop"
YAML
WRC_OUT="$("${KC[@]}" --as=system:serviceaccount:control-plane:workflow-recipes apply -f "$TMP_WRC_CHILD" 2>&1)"
WRC_RC=$?
echo "$WRC_OUT"
if [ "$WRC_RC" -ne 0 ]; then
  echo "FAIL: workflow-recipes ServiceAccount could not create controller ownerReferences"
  exit 1
fi
WRC_CHILD_UID="$("${KC[@]}" get workflowrecipe/vap-ownerref-wrc-child -n sandbox-recipes -o jsonpath='{.metadata.ownerReferences[0].uid}')"
if [ "$WRC_CHILD_UID" != "$WRC_PARENT_UID" ]; then
  echo "FAIL: workflow-recipes ServiceAccount ownerReference did not persist with the live parent UID"
  exit 1
fi
echo "PASS: workflow-recipes ServiceAccount ownerReferences accepted and persisted"
echo

echo "=== ALL VAP TESTS PASSED ==="
