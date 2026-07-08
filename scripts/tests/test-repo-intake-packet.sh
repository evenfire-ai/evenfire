#!/usr/bin/env bash
set -u

FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRIPT="${ROOT}/scripts/dev/repo-intake-packet.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/clerum-intake-test.XXXXXX")"
TMP_ROOT="$(cd "${TMP_ROOT}" && pwd -P)"

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
    "${SCRIPT}"
  )
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
assert_not_contains "${PRIMARY_OUTPUT}" "SENSITIVE_MARKER_DO_NOT_PRINT" "primary output does not print file contents"
assert_not_contains "${PRIMARY_OUTPUT}" "local-sensitive.txt" "primary output does not print local sensitive filenames"
assert_not_contains "${PRIMARY_OUTPUT}" "unbound variable" "primary output has no shell unbound-variable warnings"

git -C "${MAIN_REPO}" worktree add -q --detach "${DETACHED_WT}" HEAD
DETACHED_OUTPUT="$(run_packet "${DETACHED_WT}" 2>&1)"
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
