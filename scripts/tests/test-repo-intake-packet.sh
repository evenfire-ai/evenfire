#!/usr/bin/env bash
set -u

FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="${ROOT}/scripts/dev/repo-intake-packet.sh"
OWNER_SCRIPT="${ROOT}/scripts/minikube/profile-owner.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/clerum-intake-test.XXXXXX")"
TMP_ROOT="$(cd "${TMP_ROOT}" && pwd -P)"
PROFILE_ROOT="${TMP_ROOT}/profiles"
mkdir -p "${PROFILE_ROOT}"

cleanup() {
  chmod -R u+w "${TMP_ROOT}" 2>/dev/null || true
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

pass() { echo "PASS: $1"; }

fail() {
  echo "FAIL: $1"
  FAIL=1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq -- "${needle}" <<<"${haystack}"; then
    pass "${label}"
  else
    fail "${label}"
    echo "missing: ${needle}"
    echo "--- output ---"
    echo "${haystack}"
    echo "--------------"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq -- "${needle}" <<<"${haystack}"; then
    fail "${label}"
    echo "unexpected: ${needle}"
    echo "--- output ---"
    echo "${haystack}"
    echo "--------------"
  else
    pass "${label}"
  fi
}

run_packet() {
  local cwd="$1"
  (
    cd "${cwd}" || exit 1
    REPO_INTAKE_PROFILE_ROOT="${2:-${PROFILE_ROOT}}" "${SCRIPT}"
  )
}

run_packet_with_profile() {
  local cwd="$1" profile_root="$2" profile="$3"
  (
    cd "${cwd}" || exit 1
    REPO_INTAKE_PROFILE_ROOT="${profile_root}" MINIKUBE_PROFILE="${profile}" "${SCRIPT}"
  )
}

payload_value() {
  local payload="$1" key="$2"
  awk -F= -v wanted="${key}" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' <<<"${payload}"
}

write_ports() {
  local destination="$1" base="$2"
  cat >"${destination}" <<EOF_PORTS
PORT_BASE=${base}
CONTROL_API_PORT=$((base + 90))
CONTROL_API_URL=http://127.0.0.1:$((base + 90))
EOF_PORTS
}

if bash -n "${SCRIPT}"; then
  pass "repo intake packet has valid bash syntax"
else
  fail "repo intake packet has valid bash syntax"
  exit "${FAIL}"
fi

MAIN_REPO="${TMP_ROOT}/main"
DETACHED_WT="${TMP_ROOT}/detached"

mkdir -p "${MAIN_REPO}"
git init -q "${MAIN_REPO}"
git -C "${MAIN_REPO}" checkout -q -b dev
git -C "${MAIN_REPO}" config user.email "test@example.invalid"
git -C "${MAIN_REPO}" config user.name "Clerum Test"

printf '{"scripts":{"test":"true"}}\n' >"${MAIN_REPO}/package.json"
mkdir -p "${MAIN_REPO}/.local-notes/minikube-profiles"
printf '# test helper\n' >"${MAIN_REPO}/.local-notes/minikube-profiles/branch.mk"
git -C "${MAIN_REPO}" add package.json
git -C "${MAIN_REPO}" commit -q -m "initial"
git -C "${MAIN_REPO}" update-ref refs/remotes/origin/dev HEAD

printf 'SENSITIVE_MARKER_DO_NOT_PRINT\n' >"${MAIN_REPO}/local-sensitive.txt"
PRIMARY_OUTPUT="$(run_packet "${MAIN_REPO}" 2>&1)"
PRIMARY_STATUS=$?

if [[ "${PRIMARY_STATUS}" -eq 0 || "${PRIMARY_STATUS}" -eq 2 ]]; then
  pass "repo intake packet runs in primary checkout"
else
  fail "repo intake packet runs in primary checkout"
  echo "${PRIMARY_OUTPUT}"
fi

assert_contains "${PRIMARY_OUTPUT}" "repo_root:" "primary output includes repo root label"
assert_contains "${PRIMARY_OUTPUT}" "${MAIN_REPO}" "primary output includes primary repo path"
assert_contains "${PRIMARY_OUTPUT}" "branch:" "primary output includes branch label"
assert_contains "${PRIMARY_OUTPUT}" "dev" "primary output reports branch"
assert_contains "${PRIMARY_OUTPUT}" "profile_helper_exists:" "primary output includes profile helper label"
assert_contains "${PRIMARY_OUTPUT}" "yes" "primary output finds profile helper"
assert_contains "${PRIMARY_OUTPUT}" "profile_owner_resolver:" "primary output includes profile owner resolver label"
assert_contains "${PRIMARY_OUTPUT}" "profile_cache_state:" "primary output includes profile cache state"
assert_contains "${PRIMARY_OUTPUT}" "absent" "primary output reports an uninitialized isolated profile root"
assert_not_contains "${PRIMARY_OUTPUT}" "SENSITIVE_MARKER_DO_NOT_PRINT" "primary output does not print file contents"
assert_not_contains "${PRIMARY_OUTPUT}" "local-sensitive.txt" "primary output does not print local sensitive filenames"
assert_not_contains "${PRIMARY_OUTPUT}" "unbound variable" "primary output has no shell unbound-variable warnings"

CREATION_SHORT="$(git -C "${MAIN_REPO}" rev-parse --short=8 HEAD)"
LEGACY_PROFILE="clerum-dev-${CREATION_SHORT}"
LEGACY_DIR="${PROFILE_ROOT}/${LEGACY_PROFILE}"
mkdir -p "${LEGACY_DIR}"
cat >"${LEGACY_DIR}/profile.env" <<EOF_PROFILE
PROFILE=${LEGACY_PROFILE}
BRANCH=dev
SHA_SHORT=${CREATION_SHORT}
DIRTY=false
REPO_DIR=${MAIN_REPO}
EOF_PROFILE
write_ports "${LEGACY_DIR}/ports.env" 28000

printf 'advanced head\n' >"${MAIN_REPO}/tracked-after-profile.txt"
git -C "${MAIN_REPO}" add tracked-after-profile.txt
git -C "${MAIN_REPO}" commit -q -m "advance after profile creation"
HISTORICAL_OUTPUT="$(run_packet "${MAIN_REPO}" 2>&1)"
HISTORICAL_STATUS=$?
if [[ "${HISTORICAL_STATUS}" -eq 0 ]]; then
  pass "historical v1 profile remains valid after HEAD advances"
else
  fail "historical v1 profile remains valid after HEAD advances"
  echo "${HISTORICAL_OUTPUT}"
fi
assert_contains "${HISTORICAL_OUTPUT}" "resolved_profile:" "historical output includes resolved profile"
assert_contains "${HISTORICAL_OUTPUT}" "${LEGACY_PROFILE}" "historical output preserves the legacy profile name"
assert_contains "${HISTORICAL_OUTPUT}" "profile_cache_schema:" "historical output includes source schema"
assert_contains "${HISTORICAL_OUTPUT}" "profile_cache_creation_head:" "historical output treats SHA_SHORT as creation metadata"
assert_contains "${HISTORICAL_OUTPUT}" "${CREATION_SHORT}" "historical output reports the legacy creation SHA"
assert_contains "${HISTORICAL_OUTPUT}" "profile_cache_sha_match:" "historical output retains the compatibility label"
assert_contains "${HISTORICAL_OUTPUT}" "not_applicable" "historical output does not compare creation SHA to HEAD"
assert_not_contains "${HISTORICAL_OUTPUT}" "profile_cache_sha_mismatch" "historical profile does not become a blocker"

V2_ROOT="${TMP_ROOT}/v2-profiles"
CURRENT_HEAD="$(git -C "${MAIN_REPO}" rev-parse HEAD)"
V2_IDENTITY="$("${OWNER_SCRIPT}" identity --repo-dir "${MAIN_REPO}" --branch dev --created-head "${CURRENT_HEAD}")"
V2_PROFILE="$(payload_value "${V2_IDENTITY}" PROFILE)"
V2_DIR="${V2_ROOT}/${V2_PROFILE}"
mkdir -p "${V2_DIR}"
cat >"${V2_DIR}/profile.env" <<EOF_PROFILE
PROFILE_SCHEMA_VERSION=2
WORKTREE_ID=$(payload_value "${V2_IDENTITY}" WORKTREE_ID)
OWNER_ID=$(payload_value "${V2_IDENTITY}" OWNER_ID)
CREATED_HEAD=${CURRENT_HEAD}
PROFILE=${V2_PROFILE}
REPO_DIR=${MAIN_REPO}
BRANCH=dev
EOF_PROFILE
write_ports "${V2_DIR}/ports.env" 29000
V2_OUTPUT="$(run_packet "${MAIN_REPO}" "${V2_ROOT}" 2>&1)"
V2_STATUS=$?
if [[ "${V2_STATUS}" -eq 0 ]]; then
  pass "repo intake consumes schema-v2 profile metadata"
else
  fail "repo intake consumes schema-v2 profile metadata"
  echo "${V2_OUTPUT}"
fi
assert_contains "${V2_OUTPUT}" "${V2_PROFILE}" "schema-v2 intake resolves the stable owner profile"
assert_contains "${V2_OUTPUT}" "profile_cache_schema:          2" "schema-v2 intake reports schema 2"

AMBIGUOUS_ROOT="${TMP_ROOT}/ambiguous-profiles"
for suffix in aaaaaaaa bbbbbbbb; do
  candidate="clerum-dev-${suffix}"
  mkdir -p "${AMBIGUOUS_ROOT}/${candidate}"
  cat >"${AMBIGUOUS_ROOT}/${candidate}/profile.env" <<EOF_PROFILE
PROFILE=${candidate}
BRANCH=dev
SHA_SHORT=${suffix}
DIRTY=false
REPO_DIR=${MAIN_REPO}
EOF_PROFILE
  write_ports "${AMBIGUOUS_ROOT}/${candidate}/ports.env" $((30000 + ${#suffix}))
done
AMBIGUOUS_OUTPUT="$(run_packet "${MAIN_REPO}" "${AMBIGUOUS_ROOT}" 2>&1)"
AMBIGUOUS_STATUS=$?
if [[ "${AMBIGUOUS_STATUS}" -eq 2 ]]; then
  pass "ambiguous profile selection blocks intake"
else
  fail "ambiguous profile selection blocks intake"
fi
assert_contains "${AMBIGUOUS_OUTPUT}" "profile_selection_ambiguous" "ambiguous intake reports the stable blocker"

EXPLICIT_OUTPUT="$(run_packet_with_profile "${MAIN_REPO}" "${AMBIGUOUS_ROOT}" clerum-dev-aaaaaaaa 2>&1)"
EXPLICIT_STATUS=$?
if [[ "${EXPLICIT_STATUS}" -eq 0 ]]; then
  pass "explicit profile disambiguates intake"
else
  fail "explicit profile disambiguates intake"
  echo "${EXPLICIT_OUTPUT}"
fi
assert_contains "${EXPLICIT_OUTPUT}" "clerum-dev-aaaaaaaa" "explicit intake preserves selected profile"

MISSING_PORTS_ROOT="${TMP_ROOT}/missing-ports-profile"
mkdir -p "${MISSING_PORTS_ROOT}/${LEGACY_PROFILE}"
cp "${LEGACY_DIR}/profile.env" "${MISSING_PORTS_ROOT}/${LEGACY_PROFILE}/profile.env"
MISSING_PORTS_OUTPUT="$(run_packet_with_profile "${MAIN_REPO}" "${MISSING_PORTS_ROOT}" "${LEGACY_PROFILE}" 2>&1)"
MISSING_PORTS_STATUS=$?
if [[ "${MISSING_PORTS_STATUS}" -eq 2 ]]; then
  pass "missing persisted ports block intake"
else
  fail "missing persisted ports block intake"
fi
assert_contains "${MISSING_PORTS_OUTPUT}" "profile_ports_missing" "missing ports report the stable blocker"

git -C "${MAIN_REPO}" worktree add -q --detach "${DETACHED_WT}" HEAD
DETACHED_ROOT="${TMP_ROOT}/detached-profiles"
mkdir -p "${DETACHED_ROOT}"
DETACHED_OUTPUT="$(run_packet "${DETACHED_WT}" "${DETACHED_ROOT}" 2>&1)"
DETACHED_STATUS=$?

if [[ "${DETACHED_STATUS}" -eq 0 || "${DETACHED_STATUS}" -eq 2 ]]; then
  pass "repo intake packet runs in detached worktree"
else
  fail "repo intake packet runs in detached worktree"
  echo "${DETACHED_OUTPUT}"
fi

assert_contains "${DETACHED_OUTPUT}" "repo_root:" "detached output includes repo root label"
assert_contains "${DETACHED_OUTPUT}" "${DETACHED_WT}" "detached output uses current worktree root"
assert_contains "${DETACHED_OUTPUT}" "primary_checkout:" "detached output includes primary checkout label"
assert_contains "${DETACHED_OUTPUT}" "${MAIN_REPO}" "detached output resolves primary checkout"
assert_contains "${DETACHED_OUTPUT}" "detached:" "detached output includes detached label"
assert_contains "${DETACHED_OUTPUT}" "yes" "detached output reports detached state"
assert_contains "${DETACHED_OUTPUT}" "profile_helper_local:" "detached output includes local helper label"
assert_contains "${DETACHED_OUTPUT}" "no" "detached output tolerates missing local .local-notes"
assert_contains "${DETACHED_OUTPUT}" "profile_helper_primary:" "detached output includes primary helper label"
assert_contains "${DETACHED_OUTPUT}" "yes" "detached output finds primary .local-notes helper"
assert_not_contains "${DETACHED_OUTPUT}" "unbound variable" "detached output has no shell unbound-variable warnings"

exit "${FAIL}"
