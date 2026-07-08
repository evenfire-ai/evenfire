#!/usr/bin/env bash
set -u
FAIL=0

assert_fail_with() {
  local target="$1" expected_substring="$2"
  local out
  out="$(make "$target" 2>&1 || true)"
  if [[ "$out" == *"$expected_substring"* ]]; then
    echo "PASS: make $target contains '$expected_substring'"
  else
    echo "FAIL: make $target did not contain '$expected_substring'"
    echo "---"
    echo "$out"
    echo "---"
    FAIL=1
  fi
}

assert_succeeds_dry() {
  local target="$1"
  if make -n "$target" >/dev/null 2>&1; then
    echo "PASS: make -n $target parses"
  else
    echo "FAIL: make -n $target failed to parse"
    FAIL=1
  fi
}

assert_contains() {
  local target="$1" needle="$2"
  local out
  out="$(make -n "$target" 2>&1 || true)"
  if [[ "$out" == *"$needle"* ]]; then
    echo "PASS: make -n $target contains '$needle'"
  else
    echo "FAIL: make -n $target missing '$needle'"
    echo "---"
    echo "$out"
    echo "---"
    FAIL=1
  fi
}

# Retirement stubs: bare gcp-* targets must fail with a pointer
assert_fail_with gcp-deploy-all   "retired"
assert_fail_with gcp-deploy-all   "gcp-prod-"
assert_fail_with gcp-setup        "retired"
assert_fail_with gcp-build-push-all "retired"

# New namespaces must parse
assert_succeeds_dry gcp-prod-deploy-all
assert_succeeds_dry gcp-prod-status
assert_succeeds_dry gcp-prod-verify-networkpolicies

# Every gcp-prod-* kubectl/helm invocation must pin --context (Task 3)
assert_contains gcp-prod-deploy-all        "--context gke_${GCP_PROJECT}_us-central1-a_clerum"
assert_contains gcp-prod-deploy-instances  "--context gke_${GCP_PROJECT}_us-central1-a_clerum"
assert_contains gcp-prod-restart-all       "--context gke_${GCP_PROJECT}_us-central1-a_clerum"
assert_contains gcp-prod-status            "--context gke_${GCP_PROJECT}_us-central1-a_clerum"
assert_contains gcp-prod-deploy-crds       "--kube-context gke_${GCP_PROJECT}_us-central1-a_clerum"
assert_contains gcp-prod-bootstrap-rbac    "CONTEXT=gke_${GCP_PROJECT}_us-central1-a_clerum"
assert_contains gcp-prod-verify-networkpolicies "--overlay gcp-prod"
assert_contains gcp-prod-verify-networkpolicies "--context gke_${GCP_PROJECT}_us-central1-a_clerum"
assert_contains gcp-prod-deploy-all        "run-control-api-db-migration.sh"
assert_contains gcp-prod-deploy-service    "run-control-api-db-migration.sh"
assert_contains gcp-prod-deploy-all        "provision-gfs-runtime.sh"
assert_contains gcp-prod-deploy-all        "--allow-prod"

assert_confirm_gate() {
  local target="$1"
  local out
  out="$(make "$target" 2>&1 || true)"
  if [[ "$out" == *"CONFIRM=yes"* ]]; then
    echo "PASS: make $target refuses without CONFIRM=yes"
  else
    echo "FAIL: make $target missing CONFIRM gate"
    echo "---"
    echo "$out"
    echo "---"
    FAIL=1
  fi
}

assert_no_gate_on_readonly() {
  local target="$1"
  # A gated target's dry-run emits the `echo "REFUSED: ..."` line from the
  # confirm_prod define block. Absence of that echo means no gate in this target.
  # (Note: we check for "REFUSED:" rather than the literal "CONFIRM=yes" because
  # some ungated targets legitimately pass CONFIRM=yes to a sub-make, e.g.
  # gcp-dev-build-push delegating to gcp-prod-build-push.)
  local out
  out="$(make -n "$target" 2>&1 || true)"
  if [[ "$out" == *"REFUSED:"* ]]; then
    echo "FAIL: $target has a confirm_prod gate"
    FAIL=1
  else
    echo "PASS: $target has no CONFIRM gate"
  fi
}

assert_confirm_gate gcp-prod-setup
assert_confirm_gate gcp-prod-teardown
assert_confirm_gate gcp-prod-build-push
assert_confirm_gate gcp-prod-build-push-all
assert_confirm_gate gcp-prod-deploy-crds
assert_confirm_gate gcp-prod-bootstrap-rbac
assert_confirm_gate gcp-prod-deploy-all
assert_confirm_gate gcp-prod-deploy-instances
assert_confirm_gate gcp-prod-deploy-service
assert_confirm_gate gcp-prod-deploy-release
assert_confirm_gate gcp-prod-gen-keys
assert_confirm_gate gcp-prod-sync-auth-key
assert_confirm_gate gcp-prod-apply-secrets
assert_confirm_gate gcp-prod-restart-all
assert_confirm_gate gcp-prod-db-reset

assert_no_gate_on_readonly gcp-prod-get-credentials
assert_no_gate_on_readonly gcp-prod-status
assert_no_gate_on_readonly gcp-prod-diff
assert_no_gate_on_readonly gcp-prod-logs
assert_no_gate_on_readonly gcp-prod-pf-control-ui
assert_no_gate_on_readonly gcp-prod-pf-desktop
assert_no_gate_on_readonly gcp-prod-pf-all

# ── Dev namespace ──
DEV_CTX="gke_${GCP_PROJECT}_us-central1-a_example-dev"

assert_contains gcp-dev-deploy-all       "--context $DEV_CTX"
assert_contains gcp-dev-deploy-all       "deploy/overlays/gcp-dev"
assert_contains gcp-dev-status           "--context $DEV_CTX"
assert_contains gcp-dev-restart-all      "--context $DEV_CTX"
assert_contains gcp-dev-deploy-crds      "--kube-context $DEV_CTX"
assert_contains gcp-dev-bootstrap-rbac   "CONTEXT=$DEV_CTX"
assert_contains gcp-dev-deploy-instances "deploy/overlays/gcp-dev"
assert_contains gcp-dev-deploy-all       "run-control-api-db-migration.sh"
assert_contains gcp-dev-deploy-service   "run-control-api-db-migration.sh"
assert_contains gcp-dev-deploy-all       "provision-gfs-runtime.sh"
assert_contains gcp-dev-sync-auth-key    "scripts/minikube/sync-auth-key.sh"

# Dev targets must NOT have the CONFIRM gate (from the dev user's POV).
assert_succeeds_dry gcp-dev-deploy-all
assert_succeeds_dry gcp-dev-restart-all
assert_succeeds_dry gcp-dev-status
assert_succeeds_dry gcp-dev-verify-networkpolicies
assert_no_gate_on_readonly gcp-dev-deploy-all
assert_no_gate_on_readonly gcp-dev-restart-all
assert_contains gcp-dev-verify-networkpolicies "--overlay gcp-dev"
assert_contains gcp-dev-verify-networkpolicies "--context $DEV_CTX"

# NOTE: gcp-dev-build-push{,-all} deliberately recurse into gcp-prod-build-push
# with CONFIRM=yes pre-set (documented in Makefile). `make -n` on a recursive
# make expands the inner recipe text, which includes the `echo "REFUSED: ..."`
# from the confirm_prod define — so assert_no_gate_on_readonly yields a false
# positive. Only assert that they parse; the runtime behavior (CONFIRM bypass
# is scoped to the push step) is covered by the inline Makefile comment above
# those targets.
assert_succeeds_dry gcp-dev-build-push
assert_succeeds_dry gcp-dev-build-push-all

exit $FAIL
