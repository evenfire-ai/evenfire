#!/usr/bin/env bash
# Contract for scripts/minikube/sync-external-rest-api-cors-origin.sh.
#
# Review item C-8 / owner decision OD-8: a branch profile serves Profile UI on a
# generated port, so EXTERNAL_REST_API_CORS_ORIGIN must be the Profile UI origin
# on the profile's external-rest-api or every cookie-bearing login POST is
# rejected by the browser mutation guard. This suite drives the real script with
# a PATH kubectl stub: no cluster, no context, no credentials.
#
# Every negative assertion is paired with a positive witness proving the path
# under test actually ran (the stub call log and the captured patch payload).
# The stub logs the raw argv, so every call is also checked for the profile's
# --context: dropping it from the script must turn this suite red.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="${ROOT}/scripts/minikube/sync-external-rest-api-cors-origin.sh"
MANIFEST="${ROOT}/deploy/base/profiles/external-rest-api.yaml"
GUARD="${ROOT}/external-rest-api/src/middleware/browserMutationGuard.ts"

for file in "${SCRIPT}" "${MANIFEST}" "${GUARD}"; do
  [[ -f "${file}" ]] || { printf 'FAIL: missing file under test: %s\n' "${file}" >&2; exit 1; }
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/external-rest-api-cors-origin.XXXXXX")"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

STUB_BIN="${TMP_DIR}/bin"
STATE_DIR="${TMP_DIR}/state"
LOG_FILE="${TMP_DIR}/kubectl.log"
OUT_DIR="${TMP_DIR}/out"
PORTS_ENV="${TMP_DIR}/ports.env"
mkdir -p "${STUB_BIN}" "${STATE_DIR}" "${OUT_DIR}"

PROFILE="clerum-feat-cors-1234abcd"
EXPECTED_ORIGIN="http://127.0.0.1:23118"

cat >"${STUB_BIN}/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

# Log the raw argv first, --context included, so the contract proves every call
# targeted the profile under test.
printf '%s\n' "$*" >>"${TEST_KUBECTL_LOG}"

while [[ "${1:-}" == --context* ]]; do
  if [[ "${1}" == "--context" ]]; then
    shift 2
  else
    shift
  fi
done

if [[ "${1:-}" == "get" && "${2:-}" == "deployment" && "${3:-}" == "external-rest-api" ]]; then
  if printf '%s\n' "$@" | grep -q '^jsonpath='; then
    [[ "${TEST_MISSING_DEPLOYMENT:-false}" != "true" ]] || exit 1
    printf '%s' "${TEST_CURRENT_ORIGIN:-}"
    exit 0
  fi
  if [[ "${TEST_MISSING_DEPLOYMENT:-false}" == "true" ]]; then
    echo 'Error from server (NotFound): deployments.apps "external-rest-api" not found' >&2
    exit 1
  fi
  exit 0
fi

if [[ "${1:-}" == "patch" && "${2:-}" == "deployment" && "${3:-}" == "external-rest-api" ]]; then
  next_is_patch=false
  for arg in "$@"; do
    if [[ "${next_is_patch}" == "true" ]]; then
      printf '%s' "${arg}" >"${TEST_STATE_DIR}/last-patch.json"
      exit 0
    fi
    if [[ "${arg}" == "--patch" || "${arg}" == "-p" ]]; then
      next_is_patch=true
    elif [[ "${arg}" == --patch=* || "${arg}" == -p=* ]]; then
      printf '%s' "${arg#*=}" >"${TEST_STATE_DIR}/last-patch.json"
      exit 0
    fi
  done
  echo 'patch invoked without a payload' >&2
  exit 98
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "status" && "${3:-}" == "deployment/external-rest-api" ]]; then
  printf '%s\n' "$*" >"${TEST_STATE_DIR}/rollout-status"
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 99
SH
chmod +x "${STUB_BIN}/kubectl"

cat >"${PORTS_ENV}" <<'EOF'
PORT_BASE=23117
PROFILE_UI_PORT=23118
EXTERNAL_REST_API_PORT=23208
PROFILE_UI_URL=http://127.0.0.1:23118
PROFILE_UI_BASE_URL=http://127.0.0.1:23118
EXTERNAL_REST_API_URL=http://127.0.0.1:23208
EOF

export TEST_KUBECTL_LOG="${LOG_FILE}"
export TEST_STATE_DIR="${STATE_DIR}"
export PATH="${STUB_BIN}:${PATH}"
# The default profile cache must never resolve to the operator's real profiles.
export CLERUM_PROFILE_CACHE_ROOT="${TMP_DIR}/cache-root"
unset MINIKUBE_PROFILE KUBECONTEXT CLERUM_PROFILE_PORTS_ENV PROFILE_UI_URL

ASSERTIONS=0
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  if [[ -n "${CASE_OUT:-}" && -f "${CASE_OUT}" ]]; then
    printf -- '--- %s ---\n' "${CASE_OUT##*/}" >&2
    sed -n '1,40p' "${CASE_OUT}" >&2
  fi
  printf -- '--- kubectl stub log ---\n' >&2
  sed -n '1,40p' "${LOG_FILE}" >&2 2>/dev/null || true
  exit 1
}
ok() { ASSERTIONS=$((ASSERTIONS + 1)); }

CASE_RC=0
CASE_OUT=""
reset_case() {
  CASE_RC=0
  : >"${LOG_FILE}"
  rm -rf "${STATE_DIR}"
  mkdir -p "${STATE_DIR}"
}

run_sync() {
  local name="$1"
  shift
  CASE_OUT="${OUT_DIR}/${name}.out"
  reset_case
  PATH="${STUB_BIN}:${PATH}" bash "${SCRIPT}" "$@" >"${CASE_OUT}" 2>&1 || CASE_RC=$?
}

run_sync_env() {
  local name="$1" assignment="$2"
  shift 2
  CASE_OUT="${OUT_DIR}/${name}.out"
  reset_case
  PATH="${STUB_BIN}:${PATH}" env "${assignment}" bash "${SCRIPT}" "$@" >"${CASE_OUT}" 2>&1 || CASE_RC=$?
}

assert_rc() {
  local expected="$1" label="$2"
  [[ "${CASE_RC}" == "${expected}" ]] || fail "${label}: expected exit ${expected}, got ${CASE_RC}"
  ok
}

assert_out_has() {
  local needle="$1" label="$2"
  grep -Fq -- "${needle}" "${CASE_OUT}" || fail "${label}: output lacks '${needle}'"
  ok
}

assert_patch_has() {
  local needle="$1" label="$2"
  [[ -f "${STATE_DIR}/last-patch.json" ]] || fail "${label}: no patch payload was captured"
  grep -Fq -- "${needle}" "${STATE_DIR}/last-patch.json" || {
    printf 'FAIL: %s: patch payload lacks %s\n' "${label}" "${needle}" >&2
    cat "${STATE_DIR}/last-patch.json" >&2
    exit 1
  }
  ok
}

assert_patch_lacks() {
  local needle="$1" label="$2"
  [[ -f "${STATE_DIR}/last-patch.json" ]] || fail "${label}: no patch payload was captured"
  if grep -Fq -- "${needle}" "${STATE_DIR}/last-patch.json"; then
    fail "${label}: patch payload must not contain '${needle}'"
  fi
  ok
}

assert_no_patch() {
  local label="$1"
  [[ ! -f "${STATE_DIR}/last-patch.json" ]] || fail "${label}: unexpected patch payload"
  ok
}

assert_no_kubectl_calls() {
  local label="$1"
  if [[ -s "${LOG_FILE}" ]]; then
    fail "${label}: kubectl must not be called"
  fi
  ok
}

assert_log_has() {
  local needle="$1" label="$2"
  grep -Fq -- "${needle}" "${LOG_FILE}" || fail "${label}: kubectl log lacks '${needle}'"
  ok
}

# Every recorded call must target the profile under test, and no call may carry
# a second, different --context. The stub logs the raw argv for this.
assert_every_call_used_context() {
  local label="$1" line rest calls=0
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    calls=$((calls + 1))
    rest="${line#--context=${PROFILE}}"
    [[ "${line}" == "--context=${PROFILE} "* && "${rest}" != *"--context="* ]] ||
      fail "${label}: kubectl call did not target --context=${PROFILE}: ${line}"
  done <"${LOG_FILE}"
  [[ "${calls}" -gt 0 ]] || fail "${label}: no kubectl call was recorded to witness the context"
  ok
}

# A dry run may probe the deployment at most; an empty log is also valid.
assert_log_get_only() {
  local label="$1" line
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    [[ "${line}" == "--context=${PROFILE} get deployment external-rest-api "* ]] ||
      fail "${label}: dry run must not call kubectl beyond a deployment probe: ${line}"
  done <"${LOG_FILE}"
  ok
}

# ---- The contract this change is built on ----------------------------------
# The env var must be the one the manifest and the guard already use; a rename
# upstream has to break this suite, not silently disable the reconcile.
grep -Fq 'name: EXTERNAL_REST_API_CORS_ORIGIN' "${MANIFEST}" || {
  printf 'FAIL: base manifest no longer sets EXTERNAL_REST_API_CORS_ORIGIN\n' >&2
  exit 1
}
ok
grep -Fq 'configuredOrigins().has(origin)' "${GUARD}" || {
  printf 'FAIL: browser mutation guard no longer checks the configured origin\n' >&2
  exit 1
}
ok
grep -Fq 'EXTERNAL_REST_API_CORS_ORIGIN' "${ROOT}/external-rest-api/src/config.ts" || {
  printf 'FAIL: external-rest-api config no longer reads EXTERNAL_REST_API_CORS_ORIGIN\n' >&2
  exit 1
}
ok

ports_hash_before="$(shasum -a 256 "${PORTS_ENV}" | awk '{print $1}')"

# ---- 1. Drift: the shared manifest origin is replaced by the profile origin --
export TEST_CURRENT_ORIGIN='http://localhost:3001'
run_sync drift --context "${PROFILE}" --ports-env "${PORTS_ENV}"
assert_rc 0 'drift'
assert_out_has "Profile UI origin: ${EXPECTED_ORIGIN}" 'drift'
assert_patch_has "\"name\":\"EXTERNAL_REST_API_CORS_ORIGIN\",\"value\":\"${EXPECTED_ORIGIN}\"" 'drift'
assert_patch_lacks 'localhost:3001' 'drift'
assert_log_has 'get deployment external-rest-api -n profiles' 'drift probes the profile deployment'
assert_log_has 'patch deployment external-rest-api -n profiles --type=strategic' 'drift patches the profile deployment'
assert_log_has 'rollout status deployment/external-rest-api -n profiles' 'drift waits for the rollout'
assert_every_call_used_context 'drift'

# ---- 2. Idempotent: a matching value performs no mutation -------------------
export TEST_CURRENT_ORIGIN="${EXPECTED_ORIGIN}"
run_sync steady --context "${PROFILE}" --ports-env "${PORTS_ENV}"
assert_rc 0 'steady'
assert_out_has 'already matches' 'steady'
assert_log_has 'get deployment external-rest-api -n profiles' 'steady probes the profile deployment'
assert_no_patch 'steady'
[[ ! -f "${STATE_DIR}/rollout-status" ]] || fail 'steady: unexpected rollout wait'
assert_every_call_used_context 'steady'
ok

# ---- 3. Derived from PROFILE_UI_PORT when the URL line is absent ------------
cat >"${TMP_DIR}/ports-minimal.env" <<'EOF'
PROFILE_UI_PORT=24007
EOF
export TEST_CURRENT_ORIGIN=''
run_sync derived --context "${PROFILE}" --ports-env "${TMP_DIR}/ports-minimal.env"
assert_rc 0 'derived'
assert_patch_has '"value":"http://127.0.0.1:24007"' 'derived'
assert_every_call_used_context 'derived'

# ---- 4. Non-branch profile: a plain no-op with zero kubectl calls ----------
run_sync non-branch --context 'clerum-feature-noports'
assert_rc 0 'non-branch'
assert_out_has 'nothing to sync' 'non-branch'
assert_no_kubectl_calls 'non-branch'

# ---- 5. Branch-scoped name without ports: fail loud, never silently skip ----
run_sync missing-ports --context "${PROFILE}"
assert_rc 1 'missing-ports'
assert_out_has 'PROFILE_PORTS_MISSING' 'missing-ports'
assert_no_kubectl_calls 'missing-ports'

# ---- 6. A branch ports file never lands on a shared or protected context ----
run_sync shared-context --context 'clerum-dev' --ports-env "${PORTS_ENV}"
assert_rc 1 'shared-context'
assert_out_has 'refusing shared or protected context' 'shared-context'
assert_no_kubectl_calls 'shared-context'

# ---- 7. That barrier folds case, exactly like branch-profile.sh -------------
for shared_name in 'CLERUM-DEV' 'GKE_proj_zone_cluster'; do
  run_sync shared-context-fold --context "${shared_name}" --ports-env "${PORTS_ENV}"
  assert_rc 1 "shared-context ${shared_name}"
  assert_out_has 'refusing shared or protected context' "shared-context ${shared_name}"
  assert_no_kubectl_calls "shared-context ${shared_name}"
done

# ---- 8. The profile file owns the origin; an ambient value never wins ------
export TEST_CURRENT_ORIGIN='http://localhost:3001'
run_sync_env ambient-mismatch 'PROFILE_UI_URL=http://evil.example:8080' \
  --context "${PROFILE}" --ports-env "${PORTS_ENV}"
assert_rc 1 'ambient-mismatch'
assert_out_has 'refusing ambient PROFILE_UI_URL' 'ambient-mismatch'
assert_no_kubectl_calls 'ambient-mismatch'
assert_no_patch 'ambient-mismatch'

# The matching value is tolerated and the file's origin is what gets written.
run_sync_env ambient-match "PROFILE_UI_URL=${EXPECTED_ORIGIN}" \
  --context "${PROFILE}" --ports-env "${PORTS_ENV}"
assert_rc 0 'ambient-match'
assert_patch_has "\"value\":\"${EXPECTED_ORIGIN}\"" 'ambient-match'
assert_every_call_used_context 'ambient-match'

# ---- 9. Unusable origins are refused before any cluster call --------------
for bad in '*' 'http://127.0.0.1:23118/login' 'http://127.0.0.1:23118,http://evil.test'; do
  cat >"${TMP_DIR}/ports-bad.env" <<EOF
PROFILE_UI_URL=${bad}
EOF
  unset TEST_CURRENT_ORIGIN
  run_sync bad-origin --context "${PROFILE}" --ports-env "${TMP_DIR}/ports-bad.env"
  assert_rc 1 "bad-origin ${bad}"
  assert_out_has 'refusing an unusable browser origin' "bad-origin ${bad}"
  assert_no_patch "bad-origin ${bad}"
  assert_no_kubectl_calls "bad-origin ${bad}"
done

# ---- 10. Missing deployment is a loud failure, not a silent success --------
export TEST_CURRENT_ORIGIN='http://localhost:3001'
export TEST_MISSING_DEPLOYMENT=true
run_sync missing-deployment --context "${PROFILE}" --ports-env "${PORTS_ENV}"
assert_rc 1 'missing-deployment'
assert_out_has 'apply the minikube overlay before syncing' 'missing-deployment'
assert_log_has 'get deployment external-rest-api -n profiles' 'missing-deployment probes the profile deployment'
assert_no_patch 'missing-deployment'
assert_every_call_used_context 'missing-deployment'
export TEST_MISSING_DEPLOYMENT=false

# ---- 11. Dry run never mutates -------------------------------------------
run_sync dry-run --context "${PROFILE}" --ports-env "${PORTS_ENV}" --dry-run
assert_rc 0 'dry-run'
assert_out_has "Profile UI origin: ${EXPECTED_ORIGIN}" 'dry-run'
assert_out_has 'Dry run complete; cluster unchanged' 'dry-run'
assert_no_patch 'dry-run'
assert_log_get_only 'dry-run'

# ---- 12. An explicit ports path must exist ------------------------------
run_sync explicit-missing --context "${PROFILE}" --ports-env "${TMP_DIR}/does-not-exist.env"
assert_rc 1 'explicit-missing'
assert_out_has 'profile ports file does not exist' 'explicit-missing'
assert_no_kubectl_calls 'explicit-missing'

ports_hash_after="$(shasum -a 256 "${PORTS_ENV}" | awk '{print $1}')"
[[ "${ports_hash_before}" == "${ports_hash_after}" ]] || fail 'persisted ports.env was rewritten'
ok

printf 'PASS: external REST browser origin follows the branch profile Profile UI (%s assertions)\n' "${ASSERTIONS}"
