#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OWNER_SCRIPT="${ROOT}/scripts/minikube/profile-owner.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-profile-owner.XXXXXX")"
trap 'rm -rf "${TMP_ROOT}"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

value_from() {
  local payload="$1" key="$2"
  awk -F= -v wanted="${key}" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' <<<"${payload}"
}

expect_failure() {
  local expected_code="$1" label="$2"
  shift 2
  local output status=0
  output="$("$@" 2>&1)" || status=$?
  [[ "${status}" -ne 0 ]] || fail "${label} unexpectedly passed"
  grep -Fq "${expected_code}" <<<"${output}" || {
    printf '%s\n' "${output}" >&2
    fail "${label} did not report ${expected_code}"
  }
}

write_ports() {
  local destination="$1" base="$2"
  cat >"${destination}" <<EOF_PORTS
PORT_BASE=${base}
CONTROL_UI_PORT=$((base + 0))
PROFILE_UI_PORT=$((base + 1))
CONTROL_API_PORT=$((base + 90))
EXTERNAL_REST_API_PORT=$((base + 91))
MEMBER_REGISTRATION_SERVICE_PORT=$((base + 92))
RPC_PROXY_PORT=$((base + 94))
REGISTRY_API_PORT=$((base + 85))
WORKFLOW_APPROVAL_READER_PORT=$((base + 98))
MCP_HOST_PORT=$((base + 80))
CONTROL_UI_URL=http://127.0.0.1:$((base + 0))
PROFILE_UI_URL=http://127.0.0.1:$((base + 1))
PROFILE_UI_BASE_URL=http://127.0.0.1:$((base + 1))
CONTROL_API_URL=http://127.0.0.1:$((base + 90))
EXTERNAL_REST_API_URL=http://127.0.0.1:$((base + 91))
MEMBER_REGISTRATION_SERVICE_URL=http://127.0.0.1:$((base + 92))
RPC_PROXY_URL=http://127.0.0.1:$((base + 94))
REGISTRY_API_URL=http://127.0.0.1:$((base + 85))
WORKFLOW_APPROVAL_READER_URL=http://127.0.0.1:$((base + 98))
MCP_HOST_URL=http://127.0.0.1:$((base + 80))
EOF_PORTS
}

write_v1_profile() {
  local destination="$1" profile="$2" repo="$3" branch="$4" created_short="$5"
  cat >"${destination}" <<EOF_PROFILE
PROFILE=${profile}
BRANCH=${branch}
SHA_SHORT=${created_short}
DIRTY=false
REPO_DIR=${repo}
EOF_PROFILE
}

write_v2_profile() {
  local destination="$1" profile="$2" repo="$3" branch="$4" created_head="$5"
  local identity worktree_id owner_id
  identity="$("${OWNER_SCRIPT}" identity --repo-dir "${repo}" --branch "${branch}" --created-head "${created_head}")"
  worktree_id="$(value_from "${identity}" WORKTREE_ID)"
  owner_id="$(value_from "${identity}" OWNER_ID)"
  cat >"${destination}" <<EOF_PROFILE
PROFILE_SCHEMA_VERSION=2
WORKTREE_ID=${worktree_id}
OWNER_ID=${owner_id}
CREATED_HEAD=${created_head}
PROFILE=${profile}
REPO_DIR=${repo}
BRANCH=${branch}
EOF_PROFILE
}

[[ -x "${OWNER_SCRIPT}" ]] || fail "profile-owner.sh is not executable"
bash -n "${OWNER_SCRIPT}"

repo_a="${TMP_ROOT}/worktree-a"
repo_b="${TMP_ROOT}/worktree-b"
mkdir -p "${repo_a}" "${repo_b}"
repo_a="$(cd -- "${repo_a}" && pwd -P)"
repo_b="$(cd -- "${repo_b}" && pwd -P)"
branch='fix/stable-profile-owner'
head_a='1111111111111111111111111111111111111111'
head_b='2222222222222222222222222222222222222222'

identity_a="$("${OWNER_SCRIPT}" identity --repo-dir "${repo_a}" --branch "${branch}" --created-head "${head_a}")"
identity_b="$("${OWNER_SCRIPT}" identity --repo-dir "${repo_a}" --branch "${branch}" --created-head "${head_b}")"
profile_a="$(value_from "${identity_a}" PROFILE)"
profile_b="$(value_from "${identity_b}" PROFILE)"
owner_a="$(value_from "${identity_a}" OWNER_ID)"
owner_b="$(value_from "${identity_b}" OWNER_ID)"
[[ "${profile_a}" == "${profile_b}" ]] || fail 'HEAD A -> B changed the stable profile name'
[[ "${owner_a}" == "${owner_b}" ]] || fail 'HEAD A -> B changed the owner ID'
[[ "$(value_from "${identity_a}" CREATED_HEAD)" == "${head_a}" ]] || fail 'identity omitted CREATED_HEAD A'
[[ "$(value_from "${identity_b}" CREATED_HEAD)" == "${head_b}" ]] || fail 'identity omitted CREATED_HEAD B'

repo_alias="${TMP_ROOT}/worktree-a-alias"
ln -s "${repo_a}" "${repo_alias}"
identity_alias="$("${OWNER_SCRIPT}" identity --repo-dir "${repo_alias}" --branch "${branch}" --created-head "${head_a}")"
[[ "$(value_from "${identity_alias}" OWNER_ID)" == "${owner_a}" ]] || fail 'canonical-path alias changed the owner ID'

identity_other_worktree="$("${OWNER_SCRIPT}" identity --repo-dir "${repo_b}" --branch "${branch}" --created-head "${head_a}")"
[[ "$(value_from "${identity_other_worktree}" OWNER_ID)" != "${owner_a}" ]] || fail 'same branch in another worktree reused the owner ID'
[[ "$(value_from "${identity_other_worktree}" PROFILE)" != "${profile_a}" ]] || fail 'same branch in another worktree reused the profile name'

identity_other_branch="$("${OWNER_SCRIPT}" identity --repo-dir "${repo_a}" --branch 'fix/other-branch' --created-head "${head_a}")"
[[ "$(value_from "${identity_other_branch}" OWNER_ID)" != "${owner_a}" ]] || fail 'branch switch reused the owner ID'
[[ "$(value_from "${identity_other_branch}" PROFILE)" != "${profile_a}" ]] || fail 'branch switch reused the profile name'

v2_root="${TMP_ROOT}/v2-cache"
v2_dir="${v2_root}/${profile_a}"
mkdir -p "${v2_dir}"
write_v2_profile "${v2_dir}/profile.env" "${profile_a}" "${repo_a}" "${branch}" "${head_a}"
write_ports "${v2_dir}/ports.env" 24000
ports_before="$(shasum "${v2_dir}/ports.env" | awk '{print $1}')"
v2_resolved="$("${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" --profile-root "${v2_root}")"
[[ "$(value_from "${v2_resolved}" PROFILE_SCHEMA_VERSION)" == 2 ]] || fail 'schema-v2 profile did not resolve as v2'
[[ "$(value_from "${v2_resolved}" PROFILE)" == "${profile_a}" ]] || fail 'schema-v2 profile resolved the wrong profile'
[[ "$(value_from "${v2_resolved}" OWNER_ID)" == "${owner_a}" ]] || fail 'schema-v2 profile resolved the wrong owner'
[[ "$(shasum "${v2_dir}/ports.env" | awk '{print $1}')" == "${ports_before}" ]] || fail 'read-only resolution rewrote ports.env'

corrupt_metadata_root="${TMP_ROOT}/corrupt-metadata"
corrupt_metadata_dir="${corrupt_metadata_root}/${profile_a}"
mkdir -p "${corrupt_metadata_dir}"
cp "${v2_dir}/profile.env" "${corrupt_metadata_dir}/profile.env"
printf 'BRANCH=%s\n' "${branch}" >>"${corrupt_metadata_dir}/profile.env"
write_ports "${corrupt_metadata_dir}/ports.env" 24500
expect_failure PROFILE_METADATA_INVALID 'auto-selected corrupt metadata' \
  "${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" --profile-root "${corrupt_metadata_root}"

bad_owner_env="${TMP_ROOT}/bad-owner.env"
cp "${v2_dir}/profile.env" "${bad_owner_env}"
sed -i.bak 's/^OWNER_ID=.*/OWNER_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' "${bad_owner_env}"
expect_failure PROFILE_OWNERSHIP_MISMATCH 'mismatched schema-v2 owner' \
  "${OWNER_SCRIPT}" validate --repo-dir "${repo_a}" --branch "${branch}" \
  --profile "${profile_a}" --profile-env "${bad_owner_env}" --ports-env "${v2_dir}/ports.env"

v1_root="${TMP_ROOT}/v1-cache"
legacy_profile='clerum-fix-stable-profile-owner-deadbeef'
legacy_dir="${v1_root}/${legacy_profile}"
mkdir -p "${legacy_dir}"
write_v1_profile "${legacy_dir}/profile.env" "${legacy_profile}" "${repo_a}" "${branch}" deadbeef
write_ports "${legacy_dir}/ports.env" 25000
v1_resolved="$("${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" --profile-root "${v1_root}")"
[[ "$(value_from "${v1_resolved}" PROFILE_SCHEMA_VERSION)" == 1 ]] || fail 'legacy profile did not resolve as schema v1'
[[ "$(value_from "${v1_resolved}" PROFILE)" == "${legacy_profile}" ]] || fail 'legacy profile was renamed during adoption'
[[ "$(value_from "${v1_resolved}" CREATED_HEAD)" == deadbeef ]] || fail 'legacy SHA_SHORT was not retained as creation metadata'
[[ "$(value_from "${v1_resolved}" OWNER_ID)" == "${owner_a}" ]] || fail 'legacy adoption did not derive the stable owner ID'

second_legacy='clerum-fix-stable-profile-owner-cafebabe'
second_dir="${v1_root}/${second_legacy}"
mkdir -p "${second_dir}"
write_v1_profile "${second_dir}/profile.env" "${second_legacy}" "${repo_a}" "${branch}" cafebabe
write_ports "${second_dir}/ports.env" 26000
expect_failure PROFILE_SELECTION_AMBIGUOUS 'ambiguous legacy adoption' \
  "${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" --profile-root "${v1_root}"

explicit_legacy="$("${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" \
  --profile-root "${v1_root}" --profile "${legacy_profile}")"
[[ "$(value_from "${explicit_legacy}" PROFILE)" == "${legacy_profile}" ]] || fail 'explicit profile did not disambiguate selection'

ports_only_legacy="$("${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" \
  --profile-root "${v1_root}" --ports-env "${legacy_dir}/ports.env")"
[[ "$(value_from "${ports_only_legacy}" PROFILE)" == "${legacy_profile}" ]] || fail 'explicit ports.env did not bind to its sibling profile metadata'

missing_ports_root="${TMP_ROOT}/missing-ports"
missing_ports_dir="${missing_ports_root}/${legacy_profile}"
mkdir -p "${missing_ports_dir}"
write_v1_profile "${missing_ports_dir}/profile.env" "${legacy_profile}" "${repo_a}" "${branch}" deadbeef
expect_failure PROFILE_PORTS_MISSING 'missing persisted ports' \
  "${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" --profile-root "${missing_ports_root}"

printf 'PORT_BASE=not-a-port\n' >"${missing_ports_dir}/ports.env"
expect_failure PROFILE_PORTS_INVALID 'corrupt persisted ports' \
  "${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" --profile-root "${missing_ports_root}"

symlink_ports_root="${TMP_ROOT}/symlink-ports"
symlink_ports_dir="${symlink_ports_root}/${legacy_profile}"
mkdir -p "${symlink_ports_dir}"
write_v1_profile "${symlink_ports_dir}/profile.env" "${legacy_profile}" "${repo_a}" "${branch}" deadbeef
ln -s "${legacy_dir}/ports.env" "${symlink_ports_dir}/ports.env"
expect_failure PROFILE_PORTS_MISSING 'symlinked persisted ports' \
  "${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" --profile-root "${symlink_ports_root}"

missing_metadata_root="${TMP_ROOT}/missing-metadata"
mkdir -p "${missing_metadata_root}/${legacy_profile}"
write_ports "${missing_metadata_root}/${legacy_profile}/ports.env" 27000
expect_failure PROFILE_METADATA_MISSING 'explicit profile without metadata' \
  "${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" \
  --profile-root "${missing_metadata_root}" --profile "${legacy_profile}"

missing_stable_metadata_root="${TMP_ROOT}/missing-stable-metadata"
mkdir -p "${missing_stable_metadata_root}/${profile_a}"
write_ports "${missing_stable_metadata_root}/${profile_a}/ports.env" 27500
expect_failure PROFILE_METADATA_MISSING 'stable profile directory without metadata' \
  "${OWNER_SCRIPT}" resolve --repo-dir "${repo_a}" --branch "${branch}" \
  --profile-root "${missing_stable_metadata_root}"

printf 'PASS: stable Minikube profile ownership and v1/v2 resolution\n'
