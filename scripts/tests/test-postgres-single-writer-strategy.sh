#!/usr/bin/env bash
# Regression test for deploy/scripts/validate-postgres-single-writer-strategy.sh
#
# Captures the [R4-D] fix: a Deployment this repo DEFINES (deploy/base/<ns>/
# exists) that is ABSENT from a rendered overlay must FAIL LOUDLY, not be
# NOTICE-and-skipped. Before the fix the validator skipped any absent deploy,
# so a local overlay that stopped rendering control-plane/host-context-controller
# validated the single-writer rollout invariant over an empty set and still
# printed "validation passed" (a fail-open / false green).
#
# The CI step "Validate single-writer rollout invariant on rendered overlays"
# already runs the validator against the real minikube overlay (a happy-path
# check). This test is complementary: it fabricates the absent-deploy condition
# in a hermetic fixture so the fail-loud behavior itself is under test.
#
# The test builds a hermetic fixture ROOT_DIR, copies the validator into it so
# its ROOT_DIR ($(dirname)/../..) resolves to the fixture, and renders overlays
# OFFLINE with `kubectl kustomize` — the same path the validator uses. No cluster.
#
# Fail-loud / fail-fast: every assertion fails the suite immediately, and the
# reporter refuses to pass unless a non-zero number of assertions actually ran.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR="${REPO_ROOT}/deploy/scripts/validate-postgres-single-writer-strategy.sh"

for tool in kubectl yq jq; do
  command -v "${tool}" >/dev/null 2>&1 ||
    { echo "FAIL: required tool '${tool}' is missing" >&2; exit 1; }
done
[ -f "${VALIDATOR}" ] ||
  { echo "FAIL: validator not found at ${VALIDATOR}" >&2; exit 1; }

TESTS_RUN=0
FAILURES=0
pass() { TESTS_RUN=$((TESTS_RUN + 1)); echo "ok   - $1"; }
fail() { TESTS_RUN=$((TESTS_RUN + 1)); FAILURES=$((FAILURES + 1)); echo "FAIL - $1" >&2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/single-writer-test.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

ROOT="${WORK}/repo"
mkdir -p "${ROOT}/deploy/scripts"
cp "${VALIDATOR}" "${ROOT}/deploy/scripts/"
FIXTURE_VALIDATOR="${ROOT}/deploy/scripts/$(basename "${VALIDATOR}")"

# control-plane is a namespace this fixture repo DEFINES (base tree present).
# registry is intentionally NOT defined here -> it is FOREIGN (NOTICE-and-skip).
mkdir -p "${ROOT}/deploy/base/control-plane"
: >"${ROOT}/deploy/base/control-plane/.keep"

write_kustomization() { # dir, resource-file...
  local dir="$1"; shift
  {
    echo 'apiVersion: kustomize.config.k8s.io/v1beta1'
    echo 'kind: Kustomization'
    echo 'resources:'
    local r
    for r in "$@"; do echo "  - ${r}"; done
  } >"${dir}/kustomization.yaml"
}

write_control_postgres() { # dir  (valid stateful DB deploy: PVC + Recreate + replicas 1)
  cat >"$1/control-postgres.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: control-postgres
  namespace: control-plane
spec:
  replicas: 1
  strategy:
    type: Recreate
  template:
    spec:
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: control-postgres-data
YAML
}

write_hcc() { # dir  (valid single-writer deploy: replicas 1 + Recreate)
  cat >"$1/host-context-controller.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: host-context-controller
  namespace: control-plane
spec:
  replicas: 1
  strategy:
    type: Recreate
  template:
    spec:
      containers:
        - name: host-context-controller
          image: example/hcc:test
YAML
}

# --- Overlay A: LOCAL single-writer deploy ABSENT (the fail-open trigger) ---
# Renders a valid control-postgres but OMITS host-context-controller.
OV_MISSING="${ROOT}/deploy/overlays/local-missing"
mkdir -p "${OV_MISSING}"
write_control_postgres "${OV_MISSING}"
write_kustomization "${OV_MISSING}" control-postgres.yaml

# --- Overlay B: every LOCAL deploy PRESENT and valid (foreign still skipped) ---
OV_OK="${ROOT}/deploy/overlays/all-local-present"
mkdir -p "${OV_OK}"
write_control_postgres "${OV_OK}"
write_hcc "${OV_OK}"
write_kustomization "${OV_OK}" control-postgres.yaml host-context-controller.yaml

run_validator() { # overlays-value ; prints combined output, returns exit code
  SINGLE_WRITER_OVERLAYS="$1" bash "${FIXTURE_VALIDATOR}" 2>&1
}

# 1) A locally-defined single-writer deploy absent from a rendered overlay MUST
#    fail loudly (this is exactly what the pre-fix NOTICE-and-skip let pass).
out="$(run_validator "deploy/overlays/local-missing")"; rc=$?
if [ "${rc}" -ne 0 ] && printf '%s' "${out}" |
     grep -q "renders no Deployment control-plane/host-context-controller"; then
  pass "absent locally-defined single-writer deploy fails loudly (exit ${rc})"
else
  fail "absent local single-writer deploy did NOT fail loudly (exit ${rc}); output: ${out}"
fi

# 2) With every locally-defined deploy present and valid, a still-absent FOREIGN
#    deploy (registry/registry-postgres) is NOTICE-and-skipped, and the script
#    passes — the fix must not over-fail on foreign deploys.
out="$(run_validator "deploy/overlays/all-local-present")"; rc=$?
if [ "${rc}" -eq 0 ] &&
     printf '%s' "${out}" | grep -q "Single-writer rollout strategy validation passed" &&
     printf '%s' "${out}" | grep -q "does not render foreign Deployment registry/registry-postgres"; then
  pass "all local deploys present -> passes; absent foreign deploy is skipped"
else
  fail "expected pass with foreign-skip (exit ${rc}); output: ${out}"
fi

# 3) Zero overlays must not pass vacuously.
out="$(run_validator "   ")"; rc=$?
if [ "${rc}" -ne 0 ] && printf '%s' "${out}" | grep -q "zero overlays"; then
  pass "whitespace-only overlay set fails loudly (no vacuous pass)"
else
  fail "empty overlay set did not fail loudly (exit ${rc}); output: ${out}"
fi

# --- Reporter (fail-loud / zero-tests-is-never-success) ---
echo "1..${TESTS_RUN}"
if [ "${TESTS_RUN}" -lt 3 ]; then
  echo "FAIL: expected at least 3 assertions, ran ${TESTS_RUN}" >&2
  exit 1
fi
if [ "${FAILURES}" -ne 0 ]; then
  echo "FAIL: ${FAILURES}/${TESTS_RUN} assertions failed" >&2
  exit 1
fi
echo "All ${TESTS_RUN} single-writer validator assertions passed"
