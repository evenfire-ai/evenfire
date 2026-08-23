#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
HANDOFF_HELPER="${ROOT}/scripts/minikube/t2-setup-handoff.sh"
T2_SCRIPT="${ROOT}/scripts/minikube/t2.sh"
PRE_GATE_SCRIPT="${ROOT}/scripts/minikube/pre-gate-sync.sh"
FULL_SETUP_SCRIPT="${ROOT}/scripts/minikube/full-setup.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-t2-setup-handoff-test.XXXXXX")"

cleanup() {
  rm -rf -- "${TEST_ROOT}"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

assert_no_file() {
  [[ ! -e "$1" && ! -L "$1" ]] || fail "unexpected path: $1"
}

PROJECT="${TEST_ROOT}/worktree"
mkdir -p "${PROJECT}"
git -C "${PROJECT}" init -q
git -C "${PROJECT}" checkout -q -b fix/t2-handoff-test
printf '.local-notes/\n' >"${PROJECT}/.gitignore"
printf 'fixture\n' >"${PROJECT}/tracked.txt"
git -C "${PROJECT}" add .gitignore tracked.txt
git -C "${PROJECT}" -c user.name='T2 Handoff Test' -c user.email='t2-handoff@example.invalid' \
  -c commit.gpgsign=false commit -q -m 'test fixture'

PROJECT="$(cd "${PROJECT}" && pwd -P)"
BRANCH="$(git -C "${PROJECT}" branch --show-current)"
HEAD="$(git -C "${PROJECT}" rev-parse --verify HEAD)"
WORKTREE_ID="$(printf '%s' "${PROJECT}" | shasum | awk '{print $1}')"
PROFILE=t2-handoff-profile
CONTEXT=${PROFILE}
TRANSITION=full-bootstrap
LOCK_TOKEN='raw-test-lock-token-must-never-be-persisted'
LOCK_KEY="$(printf '%s\0%s\0%s\0%s\0%s' \
  "${PROJECT}" "${BRANCH}" "${HEAD}" "${PROFILE}" "${CONTEXT}" | shasum | awk '{print $1}')"
MANIFEST="${PROJECT}/.local-notes/fixture/image-manifest.json"
STATE_ROOT="${PROJECT}/.local-notes/state/t2-setup-handoffs"
VERIFY_LOG="${TEST_ROOT}/verify.log"
export VERIFY_LOG

case_number=0
RUN_ID=""
HANDOFF_PATH=""
CONSUMED_PATH=""
CLAIM_PATH=""

new_case() {
  local label="$1"
  case_number=$((case_number + 1))
  RUN_ID="run-$(printf '%02d' "${case_number}")-${label}"
  HANDOFF_PATH="${STATE_ROOT}/${WORKTREE_ID}/${RUN_ID}/setup-complete.json"
  CONSUMED_PATH="${STATE_ROOT}/${WORKTREE_ID}/${RUN_ID}/setup-complete.consumed.json"
  CLAIM_PATH="${STATE_ROOT}/${WORKTREE_ID}/${RUN_ID}/setup-complete.consume.claim"
  mkdir -p "$(dirname "${MANIFEST}")"
  printf '{"imageSource":"local","images":{"control-api":"sha256:test"}}\n' >"${MANIFEST}"
}

run_handoff() {
  T2_PROJECT_DIR="${PROJECT}" T2_WORKTREE_ID="${WORKTREE_ID}" \
    T2_RUN_ID="${RUN_ID}" T2_PROFILE="${PROFILE}" T2_CONTEXT="${CONTEXT}" \
    T2_BRANCH="${BRANCH}" T2_HEAD="${HEAD}" T2_SKIP_LOCK=true \
    T2_LOCK_KEY="${LOCK_KEY}" T2_LOCK_TOKEN="${LOCK_TOKEN}" \
    T2_IMAGE_MANIFEST="${MANIFEST}" T2_SETUP_HANDOFF_ROOT="${STATE_ROOT}" \
    T2_SETUP_HANDOFF_TTL_SECONDS=300 \
    T2_SETUP_HANDOFF_TRANSITION="${TRANSITION}" \
      bash "${HANDOFF_HELPER}" "$@"
}

create_complete() {
  T2_SETUP_HANDOFF_SETUP_COMPLETE=true run_handoff create >/dev/null
}

verify_success() {
  # VERIFY_LOG expands in the verifier subprocess.
  # shellcheck disable=SC2016
  run_handoff consume -- bash -c 'printf "verified\n" >>"${VERIFY_LOG}"'
}

verify_count() {
  if [[ ! -f "${VERIFY_LOG}" ]]; then
    printf '0'
    return
  fi
  wc -l <"${VERIFY_LOG}" | tr -d '[:space:]'
}

mutate_string() {
  local field="$1" value="$2"
  python3 - "${HANDOFF_PATH}" "${field}" "${value}" <<'PY'
import json
import os
import sys

path, field, value = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    document = json.load(handle)
target = document
parts = field.split(".")
for part in parts[:-1]:
    target = target[part]
target[parts[-1]] = value
with open(path, "w", encoding="utf-8") as handle:
    json.dump(document, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
os.chmod(path, 0o600)
PY
}

mutate_incomplete() {
  python3 - "${HANDOFF_PATH}" <<'PY'
import json
import os
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    document = json.load(handle)
document["setupComplete"] = False
with open(path, "w", encoding="utf-8") as handle:
    json.dump(document, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
os.chmod(path, 0o600)
PY
}

mutate_stale() {
  python3 - "${HANDOFF_PATH}" <<'PY'
import json
import os
import sys
import time
from datetime import datetime, timezone

def stamp(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    document = json.load(handle)
issued = int(time.time()) - 900
expires = issued + document["ttlSeconds"]
document["issuedAtEpoch"] = issued
document["expiresAtEpoch"] = expires
document["issuedAt"] = stamp(issued)
document["expiresAt"] = stamp(expires)
with open(path, "w", encoding="utf-8") as handle:
    json.dump(document, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
os.chmod(path, 0o600)
PY
}

assert_rejected_plan() {
  INCREMENTAL_FULL_IMAGE_BUILD=false
  INCREMENTAL_FULL_DEPLOYMENT=false
  INCREMENTAL_TARGETS=(unsafe-target)
  t2_setup_handoff_apply_plan_result rejected
  [[ "${INCREMENTAL_FULL_IMAGE_BUILD}" == true ]] \
    || fail 'a rejected handoff did not restore the full image build'
  [[ "${INCREMENTAL_FULL_DEPLOYMENT}" == true ]] \
    || fail 'a rejected handoff did not restore the full deployment'
  [[ "${#INCREMENTAL_TARGETS[@]}" -eq 0 ]] \
    || fail 'a rejected handoff retained a partial target list'
}

expect_consume_rejected() {
  local expected_code="$1" label="$2" before after log_file
  before="$(verify_count)"
  log_file="${TEST_ROOT}/${label}.log"
  if verify_success >"${log_file}" 2>&1; then
    fail "${label}: consume unexpectedly succeeded"
  fi
  grep -Fq "T2_SETUP_HANDOFF_REJECTED=${expected_code}" "${log_file}" \
    || fail "${label}: expected rejection ${expected_code}"
  after="$(verify_count)"
  [[ "${after}" == "${before}" ]] || fail "${label}: image verifier ran before attestation acceptance"
  assert_file "${HANDOFF_PATH}"
  assert_no_file "${CONSUMED_PATH}"
  assert_rejected_plan
}

# shellcheck source=scripts/minikube/t2-setup-handoff.sh
source "${HANDOFF_HELPER}"

# The production integration must not retain the former ambient boolean.
if grep -Eq 'PRE_GATE_SYNC_SETUP_COMPLETE' \
  "${T2_SCRIPT}" "${PRE_GATE_SCRIPT}" "${FULL_SETUP_SCRIPT}"; then
  fail 'legacy PRE_GATE_SYNC_SETUP_COMPLETE optimization remains'
fi
grep -Fq 'T2_SETUP_HANDOFF_REQUIRED=true' "${T2_SCRIPT}" \
  || fail 'T2 does not require a strict handoff from full setup'
# These are literal production contracts.
# shellcheck disable=SC2016
grep -Fq 'T2_SETUP_HANDOFF_SETUP_COMPLETE="${all_ready}"' "${FULL_SETUP_SCRIPT}" \
  || fail 'full setup does not bind handoff publication to readiness'
grep -Fq 'if ! t2_deployment_check; then' "${FULL_SETUP_SCRIPT}" \
  || fail 'T2 full setup does not enforce the complete deployment inventory'
grep -Fq 't2-setup-handoff.sh" consume --' "${PRE_GATE_SCRIPT}" \
  || fail 'pre-gate does not consume the attested handoff'
# This is a literal production contract.
# shellcheck disable=SC2016
grep -Fq 't2_setup_handoff_apply_plan_result "${setup_handoff_result}"' "${PRE_GATE_SCRIPT}" \
  || fail 'pre-gate does not apply the fail-closed handoff plan result'

# A partial setup must not publish any handoff.
new_case partial-setup
partial_log="${TEST_ROOT}/partial-setup.log"
if T2_SETUP_HANDOFF_SETUP_COMPLETE=false run_handoff create >"${partial_log}" 2>&1; then
  fail 'partial setup unexpectedly created a handoff'
fi
grep -Fq 'T2_SETUP_HANDOFF_REJECTED=SETUP_INCOMPLETE' "${partial_log}" \
  || fail 'partial setup did not fail with SETUP_INCOMPLETE'
assert_no_file "${HANDOFF_PATH}"

# A valid handoff is private, omits the raw token, verifies once, and is
# consumed exactly once before the plan can be cleared.
new_case valid-exact-once
create_complete
assert_file "${HANDOFF_PATH}"
python3 - "${HANDOFF_PATH}" <<'PY'
import os
import stat
import sys

mode = stat.S_IMODE(os.stat(sys.argv[1], follow_symlinks=False).st_mode)
if mode != 0o600:
    raise SystemExit(f"handoff mode is {mode:o}, expected 600")
PY
if grep -Fq "${LOCK_TOKEN}" "${HANDOFF_PATH}"; then
  fail 'raw lock token was persisted in the handoff'
fi
verify_success >/dev/null
assert_no_file "${HANDOFF_PATH}"
assert_file "${CONSUMED_PATH}"
[[ -d "${CLAIM_PATH}" ]] || fail 'atomic consume claim is missing'
[[ "$(verify_count)" == 1 ]] || fail 'valid handoff did not verify exactly once'
if grep -Fq "${LOCK_TOKEN}" "${CONSUMED_PATH}"; then
  fail 'raw lock token was persisted in the consumed handoff'
fi
INCREMENTAL_FULL_IMAGE_BUILD=true
INCREMENTAL_FULL_DEPLOYMENT=true
INCREMENTAL_TARGETS=(full)
t2_setup_handoff_apply_plan_result consumed
[[ "${INCREMENTAL_FULL_IMAGE_BUILD}" == false ]] \
  || fail 'successful consume did not suppress the duplicate image build'
[[ "${INCREMENTAL_FULL_DEPLOYMENT}" == false ]] \
  || fail 'successful consume did not suppress the duplicate deployment'
[[ "${#INCREMENTAL_TARGETS[@]}" -eq 0 ]] \
  || fail 'successful consume retained a duplicate targeted deployment'
replay_log="${TEST_ROOT}/replay.log"
if verify_success >"${replay_log}" 2>&1; then
  fail 'consumed handoff was replayable'
fi
grep -Fq 'T2_SETUP_HANDOFF_REJECTED=HANDOFF_REPLAYED' "${replay_log}" \
  || fail 'replay did not fail with HANDOFF_REPLAYED'
[[ "$(verify_count)" == 1 ]] || fail 'replay invoked the image verifier'
assert_rejected_plan

# Missing and malformed handoffs retain/force the safe plan and never verify.
new_case missing
missing_log="${TEST_ROOT}/missing.log"
before="$(verify_count)"
if verify_success >"${missing_log}" 2>&1; then
  fail 'missing handoff unexpectedly succeeded'
fi
grep -Fq 'T2_SETUP_HANDOFF_REJECTED=HANDOFF_MISSING' "${missing_log}" \
  || fail 'missing handoff did not fail closed'
[[ "$(verify_count)" == "${before}" ]] || fail 'missing handoff invoked image verification'
assert_rejected_plan

new_case malformed
create_complete
printf '{malformed\n' >"${HANDOFF_PATH}"
chmod 600 "${HANDOFF_PATH}"
expect_consume_rejected HANDOFF_MALFORMED malformed

new_case stale
create_complete
mutate_stale
expect_consume_rejected HANDOFF_STALE stale

new_case unsafe-mode
create_complete
chmod 644 "${HANDOFF_PATH}"
expect_consume_rejected HANDOFF_UNSAFE_MODE unsafe-mode

new_case incomplete-record
create_complete
mutate_incomplete
expect_consume_rejected SETUP_INCOMPLETE incomplete-record

# Every attested identity field is exact. None of these mismatches may reach
# image verification or clear the build/deploy plan.
new_case wrong-profile
create_complete
mutate_string profile wrong-profile
expect_consume_rejected PROFILE_MISMATCH wrong-profile

new_case wrong-context
create_complete
mutate_string context wrong-context
expect_consume_rejected CONTEXT_MISMATCH wrong-context

new_case wrong-worktree-id
create_complete
mutate_string worktree.id 0000000000000000000000000000000000000000
expect_consume_rejected WORKTREE_ID_MISMATCH wrong-worktree-id

new_case wrong-worktree-path
create_complete
mutate_string worktree.path "${PROJECT}/elsewhere"
expect_consume_rejected WORKTREE_PATH_MISMATCH wrong-worktree-path

new_case wrong-branch
create_complete
mutate_string branch fix/another-branch
expect_consume_rejected BRANCH_MISMATCH wrong-branch

new_case wrong-head
create_complete
mutate_string head 1111111111111111111111111111111111111111
expect_consume_rejected HEAD_MISMATCH wrong-head

new_case wrong-run
create_complete
mutate_string runId another-run
expect_consume_rejected RUN_ID_MISMATCH wrong-run

new_case wrong-lock-identity
create_complete
mutate_string lock.identity 2222222222222222222222222222222222222222
expect_consume_rejected LOCK_IDENTITY_MISMATCH wrong-lock-identity

new_case wrong-lock-token
create_complete
mutate_string lock.tokenSha256 3333333333333333333333333333333333333333333333333333333333333333
expect_consume_rejected LOCK_TOKEN_MISMATCH wrong-lock-token

new_case wrong-transition
create_complete
mutate_string transition full-reconcile
expect_consume_rejected TRANSITION_MISMATCH wrong-transition

new_case wrong-manifest-path
create_complete
mutate_string imageManifest.path "${PROJECT}/.local-notes/fixture/other.json"
expect_consume_rejected IMAGE_MANIFEST_PATH_MISMATCH wrong-manifest-path

new_case wrong-recorded-digest
create_complete
mutate_string imageManifest.sha256 4444444444444444444444444444444444444444444444444444444444444444
expect_consume_rejected IMAGE_MANIFEST_DIGEST_MISMATCH wrong-recorded-digest

new_case manifest-tamper
create_complete
printf 'tampered\n' >>"${MANIFEST}"
expect_consume_rejected IMAGE_MANIFEST_DIGEST_MISMATCH manifest-tamper

# Verification failure happens after attestation validation but before the
# atomic claim. It must leave the handoff unconsumed and force full reconcile.
new_case verify-failure
create_complete
verify_failure_log="${TEST_ROOT}/verify-failure.log"
before="$(verify_count)"
# VERIFY_LOG expands in the verifier subprocess.
# shellcheck disable=SC2016
if run_handoff consume -- bash -c 'printf "verified\n" >>"${VERIFY_LOG}"; exit 23' \
  >"${verify_failure_log}" 2>&1; then
  fail 'failed image verification unexpectedly consumed the handoff'
fi
grep -Fq 'T2_SETUP_HANDOFF_REJECTED=IMAGE_VERIFICATION_FAILED' "${verify_failure_log}" \
  || fail 'verify failure did not fail closed'
[[ "$(verify_count)" -eq $((before + 1)) ]] || fail 'verify-failure seam did not execute once'
assert_file "${HANDOFF_PATH}"
assert_no_file "${CONSUMED_PATH}"
assert_no_file "${CLAIM_PATH}"
assert_rejected_plan

# Publication itself is one-shot for a run; it cannot overwrite an existing
# or consumed attestation.
new_case duplicate-create
create_complete
duplicate_log="${TEST_ROOT}/duplicate-create.log"
if T2_SETUP_HANDOFF_SETUP_COMPLETE=true run_handoff create >"${duplicate_log}" 2>&1; then
  fail 'duplicate handoff publication unexpectedly succeeded'
fi
grep -Fq 'T2_SETUP_HANDOFF_REJECTED=HANDOFF_ALREADY_EXISTS' "${duplicate_log}" \
  || fail 'duplicate publication did not fail closed'

# Even a symlink that resolves back inside the worktree is not an acceptable
# local-state boundary: replacing it between validation and publication could
# redirect a supposedly local-only attestation.
new_case symlinked-local-notes
mv "${PROJECT}/.local-notes" "${PROJECT}/.local-notes.real"
ln -s "${PROJECT}/.local-notes.real" "${PROJECT}/.local-notes"
symlinked_state_log="${TEST_ROOT}/symlinked-local-notes.log"
if T2_SETUP_HANDOFF_SETUP_COMPLETE=true run_handoff create >"${symlinked_state_log}" 2>&1; then
  fail 'symlinked .local-notes unexpectedly accepted a handoff publication'
fi
grep -Fq 'T2_SETUP_HANDOFF_REJECTED=STATE_ROOT_INVALID' "${symlinked_state_log}" \
  || fail 'symlinked .local-notes did not fail with STATE_ROOT_INVALID'
rm "${PROJECT}/.local-notes"
mv "${PROJECT}/.local-notes.real" "${PROJECT}/.local-notes"

printf 'PASS: Minikube T2 setup-complete handoff is strict, attested, and exact-once\n'
