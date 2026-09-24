#!/usr/bin/env bash
set -euo pipefail

# Local Minikube E2E: control-api's answer when the apiserver refuses its OWN
# Secret read.
#
# The journey removes the `get` verb from the Secrets rule of control-api's
# Role in mcp-host. Every other verb in that rule stays granted, and the
# journey checks that `list` is still allowed. It then calls three real admin
# routes that read a Secret before writing:
#   - PUT  /api/v1/admin/secrets  {merge:true}   (merge read)
#   - PUT  /api/v1/admin/secrets                 (full-replace slot-gate read)
#   - POST /api/v1/admin/hosts    {secretRef}    (anti-spoofing read)
# Each must answer 502 `secret_read_failed` with the exact control-api message,
# without the ServiceAccount identity or apiserver headers, and without
# writing. The rule's verbs are then restored, the Role's `.rules` must equal
# the pre-E2E snapshot, and the same merge write must succeed.
#
# Requests run inside the control-api pod against its own listener, so the
# journey does not depend on host port-forwards (T2 refreshes those after this
# phase, before Health). Like NP08, the reviewed module executes in a deployed
# pod; unlike NP08, the module is passed as the `node -e` program because
# stdin carries the admin password and session cookie. Fixture Secret values
# are synthetic and never printed.
#
# Not a production/shared-cluster test: the context guard and the profile
# ownership check refuse any context outside the branch-owned Minikube lane.
# The cleanup trap restores the Role and deletes the fixtures on every exit,
# including SIGTERM/SIGINT; only a SIGKILL skips it.

usage() {
  cat >&2 <<'USAGE'
usage: scripts/e2e/e2e-control-api-secret-read-rbac.sh --context <branch-owned-minikube-context>
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"

context=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)
      context="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${context}" ]]; then
  usage
  exit 2
fi

profile="${MINIKUBE_PROFILE:-${context}}"
if [[ "${profile}" != "${context}" ]]; then
  echo "FAIL: MINIKUBE_PROFILE must equal --context for the secret-read RBAC gate" >&2
  exit 2
fi

case "${context}" in
  *gke*|*prod*|*staging*|clerum-test|default|minikube)
    echo "FAIL: refusing shared, protected, or non-local secret-read RBAC context" >&2
    exit 2
    ;;
esac
if [[ ! "${context}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo "FAIL: secret-read RBAC context is not a valid local Minikube identifier" >&2
  exit 2
fi

for command_name in kubectl jq git shasum awk python3; do
  command -v "${command_name}" >/dev/null || {
    echo "FAIL: required command missing: ${command_name}" >&2
    exit 1
  }
done

kctl() {
  kubectl --context="${context}" "$@"
}

# shellcheck source=scripts/minikube/pre-gate-marker.sh
source "${PROJECT_DIR}/scripts/minikube/pre-gate-marker.sh"
# shellcheck source=scripts/minikube/image-mode.sh
source "${PROJECT_DIR}/scripts/minikube/image-mode.sh"
# shellcheck source=scripts/e2e/_lib/np08-provenance.sh
source "${SCRIPT_DIR}/_lib/np08-provenance.sh"
# shellcheck source=scripts/e2e/load-dotenv.sh
source "${SCRIPT_DIR}/load-dotenv.sh"
# shellcheck source=scripts/e2e/admin-credentials.sh
source "${SCRIPT_DIR}/admin-credentials.sh"

SYNC_CONFIGMAP="${CLERUM_PRE_GATE_SYNC_CONFIGMAP:-clerum-pre-gate-sync-state}"
PORTS_ENV="${CLERUM_PROFILE_PORTS_ENV:-${HOME}/.cache/clerum/minikube-profiles/${profile}/ports.env}"

verify_profile_ownership() {
  [[ -f "${PORTS_ENV}" ]] || {
    echo "FAIL: branch profile ports.env is missing: ${PORTS_ENV}" >&2
    exit 1
  }
  local profile_dir profile_env profile_name profile_repo profile_branch profile_dirty current_branch
  profile_dir="${PORTS_ENV%/ports.env}"
  profile_env="${profile_dir}/profile.env"
  [[ -f "${profile_env}" ]] || {
    echo "FAIL: branch profile metadata is missing: ${profile_env}" >&2
    exit 1
  }
  profile_name="$(awk -F= '$1 == "PROFILE" { print substr($0, index($0, "=") + 1); exit }' "${profile_env}")"
  profile_repo="$(awk -F= '$1 == "REPO_DIR" { print substr($0, index($0, "=") + 1); exit }' "${profile_env}")"
  profile_branch="$(awk -F= '$1 == "BRANCH" { print substr($0, index($0, "=") + 1); exit }' "${profile_env}")"
  profile_dirty="$(awk -F= '$1 == "DIRTY" { print substr($0, index($0, "=") + 1); exit }' "${profile_env}")"
  current_branch="$(git -C "${PROJECT_DIR}" branch --show-current)"
  [[ "${profile_name}" == "${profile}" ]] || {
    echo "FAIL: profile marker belongs to '${profile_name:-unknown}', not ${profile}" >&2
    exit 1
  }
  [[ "${profile_dirty}" == "false" ]] || {
    echo "FAIL: profile marker is dirty; refuse stale-profile E2E" >&2
    exit 1
  }
  [[ -n "${profile_repo}" && "$(cd -- "${profile_repo}" 2>/dev/null && pwd -P)" == "${PROJECT_DIR}" ]] || {
    echo "FAIL: profile marker belongs to another worktree: ${profile_repo:-unknown}" >&2
    exit 1
  }
  [[ -n "${current_branch}" && "${profile_branch}" == "${current_branch}" ]] || {
    echo "FAIL: profile marker belongs to another branch" >&2
    exit 1
  }
}

# The deployed control-api must be the image built from this exact HEAD, or a
# pass would certify some other revision's error handling.
verify_clean_and_sync_marker() {
  local head worktree_id marker_json
  local expected_cluster expected_infra expected_image_source expected_image_tag
  local expected_images_generated_at
  [[ -z "$(git -C "${PROJECT_DIR}" status --porcelain)" ]] || {
    echo "FAIL: worktree is dirty; commit or restore before the secret-read RBAC E2E" >&2
    exit 1
  }
  head="$(git -C "${PROJECT_DIR}" rev-parse --verify HEAD)"
  worktree_id="$(printf '%s' "${PROJECT_DIR}" | shasum | awk '{print $1}')"
  marker_json="$(np08_read_sync_marker control-plane "${SYNC_CONFIGMAP}")" || {
    echo "FAIL: pre-gate marker is missing: control-plane/${SYNC_CONFIGMAP}" >&2
    exit 1
  }
  expected_cluster="$(pre_gate_marker_cluster_fingerprint "${PROJECT_DIR}")" || {
    echo "FAIL: unable to compute current cluster fingerprint" >&2
    exit 1
  }
  expected_infra="$(pre_gate_marker_infra_fingerprint "${PROJECT_DIR}")" || {
    echo "FAIL: unable to compute current infrastructure fingerprint" >&2
    exit 1
  }
  expected_image_source="$(image_mode_source "${PROJECT_DIR}")" || {
    echo "FAIL: unable to resolve current image source" >&2
    exit 1
  }
  expected_image_tag="$(image_mode_tag "${PROJECT_DIR}")" || {
    echo "FAIL: unable to resolve current image tag" >&2
    exit 1
  }
  expected_images_generated_at="$(image_mode_images_generated_at "${PROJECT_DIR}")" || {
    echo "FAIL: unable to resolve current image acquisition timestamp" >&2
    exit 1
  }
  np08_verify_sync_marker \
    "${worktree_id}" "${head}" \
    "${expected_cluster}" "${expected_infra}" \
    "${expected_image_source}" "${expected_image_tag}" \
    "${expected_images_generated_at}" "${marker_json}"
}

CONTROL_NS='control-plane'
SECRETS_NS='mcp-host'
ROLE='control-api-hosts-and-secrets'
CONTROL_API_SA="system:serviceaccount:${CONTROL_NS}:control-api"
RUN_ID="${SRR_E2E_RUN_ID:-$(date -u +%Y%m%d%H%M%S)-$$}"
FIXTURE_SECRET="srr-e2e-${RUN_ID}"
FIXTURE_HOST="srr-e2e-${RUN_ID}"
OWNER_LABEL_KEY='e2e.evenfire/owner'
OWNER_LABEL_VALUE='control-api-secret-read-rbac'
HOST_SECRET_LABEL_KEY='clerum.io/host-secret'
CAN_I_ATTEMPTS=30

verify_profile_ownership
verify_clean_and_sync_marker

role_revoked=0
fixture_created=0
role_uid=''
role_rules_snapshot=''
secrets_rule_index=''
original_verbs=''
revoked_verbs=''

# Prints `yes`, `no`, or `error: <kubectl stderr>`. `kubectl auth can-i` exits
# 1 both for a "no" answer and for a failed request, so the answer is read
# from stdout and a missing yes/no is reported with its stderr.
can_i() {
  local verb="$1" resource="$2" stdout stderr_file stderr_text
  stderr_file="$(mktemp)"
  stdout="$(kctl auth can-i "${verb}" "${resource}" --as="${CONTROL_API_SA}" -n "${SECRETS_NS}" 2>"${stderr_file}")" || true
  stderr_text="$(tr '\n' ' ' <"${stderr_file}")"
  rm -f "${stderr_file}"
  case "${stdout%%[[:space:]]*}" in
    yes) echo yes ;;
    no) echo no ;;
    *) echo "error: ${stderr_text:-no answer on stdout}" ;;
  esac
}

# `kubectl auth can-i --as` sends a SubjectAccessReview, which the apiserver
# answers with the same RBAC authorizer that evaluates control-api's requests.
# Waiting on it after a Role patch keeps the journey from sending requests
# before the authorizer has picked up the change.
wait_for_can_i() {
  local verb="$1" resource="$2" expected="$3" attempt answer=''
  for ((attempt = 1; attempt <= CAN_I_ATTEMPTS; attempt++)); do
    answer="$(can_i "${verb}" "${resource}")"
    if [[ "${answer}" == "${expected}" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL: can-i ${verb} ${resource} as control-api is '${answer}', expected '${expected}' after ${CAN_I_ATTEMPTS} attempts" >&2
  return 1
}

# Idempotent: the cleanup trap calls it again after a failed first attempt, so
# it patches only while the rule still holds the revoked verbs, only verifies
# when the original verbs are already back, and refuses any other state.
restore_role() {
  local current_json current_uid current_verbs restore_patch current_rules
  current_json="$(kctl -n "${SECRETS_NS}" get role "${ROLE}" -o json)" || return 1
  current_uid="$(jq -r '.metadata.uid' <<<"${current_json}")" || return 1
  if [[ "${current_uid}" != "${role_uid}" ]]; then
    echo "FAIL: Role ${ROLE} was replaced during the E2E (uid changed)" >&2
    return 1
  fi
  current_verbs="$(jq -c --argjson i "${secrets_rule_index}" '.rules[$i].verbs' <<<"${current_json}")" || return 1
  if [[ "${current_verbs}" == "${revoked_verbs}" ]]; then
    restore_patch="$(jq -cn --argjson i "${secrets_rule_index}" \
      --argjson revoked "${revoked_verbs}" --argjson original "${original_verbs}" \
      '[{op:"test", path:"/rules/\($i)/verbs", value:$revoked},
        {op:"replace", path:"/rules/\($i)/verbs", value:$original}]')"
    kctl -n "${SECRETS_NS}" patch role "${ROLE}" --type=json -p "${restore_patch}" >/dev/null || return 1
  elif [[ "${current_verbs}" != "${original_verbs}" ]]; then
    echo "FAIL: Role ${ROLE} in unexpected state: Secrets rule verbs are ${current_verbs}, expected ${revoked_verbs} (revoked) or ${original_verbs} (original)" >&2
    return 1
  fi
  wait_for_can_i get secrets yes || return 1
  current_rules="$(kctl -n "${SECRETS_NS}" get role "${ROLE}" -o json | jq -cS '.rules')" || return 1
  if [[ "${current_rules}" != "${role_rules_snapshot}" ]]; then
    echo "FAIL: Role ${ROLE} rules differ from the pre-E2E snapshot after restore" >&2
    return 1
  fi
  role_revoked=0
}

cleanup() {
  local status=$?
  local cleanup_status=0
  set +e
  if [[ "${role_revoked}" == 1 ]]; then
    if ! restore_role; then
      echo "FAIL: could not restore Role ${SECRETS_NS}/${ROLE}; control-api cannot read Secrets there until deploy/base/mcp-host/rbac.yaml is re-applied" >&2
      echo 'CONTROL_API_SECRET_READ_RBAC_ROLE_RESTORE_FAILED' >&2
      cleanup_status=1
    fi
  fi
  if ! kctl -n "${SECRETS_NS}" delete hosts.clerum.io "${FIXTURE_HOST}" --ignore-not-found --wait=false >/dev/null 2>&1; then
    echo "FAIL: could not delete fixture Host ${FIXTURE_HOST}" >&2
    cleanup_status=1
  fi
  if [[ "${fixture_created}" == 1 ]]; then
    if ! kctl -n "${SECRETS_NS}" delete secret "${FIXTURE_SECRET}" --ignore-not-found >/dev/null 2>&1; then
      echo "FAIL: could not delete fixture Secret ${FIXTURE_SECRET}" >&2
      cleanup_status=1
    fi
  fi
  if [[ "${status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT
# The deadline runner ends a timed-out journey with SIGTERM (SIGINT on an
# operator interrupt). Converting the signal into a normal exit runs the EXIT
# trap once and hands cleanup the signal's status instead of 0.
trap 'exit 130' INT
trap 'exit 143' TERM

admin_password="$(e2e_resolve_admin_password "${PROJECT_DIR}")" || {
  echo "FAIL: no admin password resolved from the canonical .env or the environment" >&2
  exit 1
}
admin_username="${E2E_ADMIN_USERNAME:-admin}"

# One in-pod node process per request, running the reviewed module
# scripts/e2e/_lib/control-api-secret-read-runtime.mjs (unit-tested by
# scripts/tests/test-control-api-secret-read-runtime.mjs). The module source is
# the argv program; the credential-bearing input (NUL-separated fields) goes
# over stdin only. Output: "<status>\t<cookie pair or single-line JSON body>".
RUNTIME_MODULE="${SCRIPT_DIR}/_lib/control-api-secret-read-runtime.mjs"
[[ -f "${RUNTIME_MODULE}" ]] || {
  echo "FAIL: runtime module is missing: ${RUNTIME_MODULE}" >&2
  exit 1
}
runtime_source="$(<"${RUNTIME_MODULE}")"

in_pod() {
  kctl -n "${CONTROL_NS}" exec -i deploy/control-api -- \
    env SECRET_READ_RBAC_RUNTIME=run node --input-type=module -e "${runtime_source}"
}

session_cookie=''
login() {
  local response
  response="$(printf '%s\0%s\0%s' login "${admin_username}" "${admin_password}" | in_pod)" || {
    echo "FAIL: admin login inside the control-api pod failed (see the runtime error above)" >&2
    exit 1
  }
  session_cookie="${response#*$'\t'}"
  if [[ "${response%%$'\t'*}" != 200 || "${session_cookie}" != control_ui_admin_session=* ]]; then
    echo "FAIL: admin login returned no session cookie" >&2
    exit 1
  fi
}

# admin_request METHOD PATH BODY -> sets RESPONSE_STATUS and RESPONSE_BODY
admin_request() {
  local response
  response="$(printf '%s\0%s\0%s\0%s\0%s' request "${session_cookie}" "$1" "$2" "$3" | in_pod)" || {
    echo "FAIL: $1 $2 could not run inside the control-api pod" >&2
    exit 1
  }
  RESPONSE_STATUS="${response%%$'\t'*}"
  RESPONSE_BODY="${response#*$'\t'}"
}

fixture_resource_version() {
  kctl -n "${SECRETS_NS}" get secret "${FIXTURE_SECRET}" -o jsonpath='{.metadata.resourceVersion}'
}

EXPECTED_MESSAGE="control-api could not read Secret \"${FIXTURE_SECRET}\" in namespace \"${SECRETS_NS}\": the Kubernetes API server rejected control-api's own access (HTTP 403). Your session is not the cause; check the control-api RBAC for that namespace."

assert_rejected_read() {
  local label="$1"
  if [[ "${RESPONSE_STATUS}" != 502 ]]; then
    echo "FAIL: ${label} answered HTTP ${RESPONSE_STATUS}, expected 502 secret_read_failed" >&2
    printf '%s\n' "${RESPONSE_BODY}" | jq -c '{error, message}' >&2 || true
    exit 1
  fi
  if [[ "$(jq -r '.error' <<<"${RESPONSE_BODY}")" != secret_read_failed ]]; then
    echo "FAIL: ${label} error code is not secret_read_failed" >&2
    exit 1
  fi
  if [[ "$(jq -r '.message' <<<"${RESPONSE_BODY}")" != "${EXPECTED_MESSAGE}" ]]; then
    echo "FAIL: ${label} message differs from the control-api contract" >&2
    jq -r '.message' <<<"${RESPONSE_BODY}" >&2
    exit 1
  fi
  if grep -Fq 'system:serviceaccount' <<<"${RESPONSE_BODY}" || grep -Fqi 'audit-id' <<<"${RESPONSE_BODY}"; then
    echo "FAIL: ${label} response leaks the apiserver Status or headers" >&2
    exit 1
  fi
  echo "PASS: ${label} -> 502 secret_read_failed with the control-api message, no ServiceAccount identity or headers"
}

# ─── Fixture ────────────────────────────────────────────────────────────────

kctl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${FIXTURE_SECRET}
  namespace: ${SECRETS_NS}
  labels:
    ${OWNER_LABEL_KEY}: ${OWNER_LABEL_VALUE}
    ${HOST_SECRET_LABEL_KEY}: "true"
type: Opaque
stringData:
  openai-api-key: srr-e2e-synthetic-${RUN_ID}
EOF
fixture_created=1
fixture_rv_before="$(fixture_resource_version)"
[[ -n "${fixture_rv_before}" ]] || {
  echo "FAIL: fixture Secret ${FIXTURE_SECRET} has no resourceVersion" >&2
  exit 1
}

# Log in while RBAC is intact.
login

# ─── Snapshot and revoke only `get` on Secrets ──────────────────────────────

role_json="$(kctl -n "${SECRETS_NS}" get role "${ROLE}" -o json)"
role_uid="$(jq -r '.metadata.uid' <<<"${role_json}")"
role_rules_snapshot="$(jq -cS '.rules' <<<"${role_json}")"
secrets_rule_index="$(jq -r '[.rules | to_entries[]
  | select((.value.apiGroups // []) == [""] and (.value.resources // []) == ["secrets"]) | .key]
  | if length == 1 then .[0] else "ambiguous" end' <<<"${role_json}")"
if [[ ! "${secrets_rule_index}" =~ ^[0-9]+$ ]]; then
  echo "FAIL: Role ${ROLE} does not have exactly one core-group Secrets rule" >&2
  exit 1
fi
original_verbs="$(jq -c --argjson i "${secrets_rule_index}" '.rules[$i].verbs' <<<"${role_json}")"
if [[ "$(jq -r 'index("get") != null and index("list") != null' <<<"${original_verbs}")" != true ]]; then
  echo "FAIL: Role ${ROLE} Secrets rule does not grant get and list: ${original_verbs}" >&2
  exit 1
fi
revoked_verbs="$(jq -c 'map(select(. != "get"))' <<<"${original_verbs}")"
wait_for_can_i get secrets yes

revoke_patch="$(jq -cn --argjson i "${secrets_rule_index}" \
  --argjson original "${original_verbs}" --argjson revoked "${revoked_verbs}" \
  '[{op:"test", path:"/rules/\($i)/resources", value:["secrets"]},
    {op:"test", path:"/rules/\($i)/verbs", value:$original},
    {op:"replace", path:"/rules/\($i)/verbs", value:$revoked}]')"
role_revoked=1
kctl -n "${SECRETS_NS}" patch role "${ROLE}" --type=json -p "${revoke_patch}" >/dev/null
wait_for_can_i get secrets no
wait_for_can_i list secrets yes
echo "PASS: control-api lost get on ${SECRETS_NS}/secrets and kept list (Role ${ROLE}, rule ${secrets_rule_index})"

# ─── Journeys under the revocation ──────────────────────────────────────────

admin_request PUT /api/v1/admin/secrets \
  "$(jq -cn --arg n "${FIXTURE_SECRET}" '{name:$n, merge:true, stringData:{"openai-api-key":"srr-e2e-merge"}}')"
assert_rejected_read 'PUT /admin/secrets merge'

admin_request PUT /api/v1/admin/secrets \
  "$(jq -cn --arg n "${FIXTURE_SECRET}" '{name:$n, stringData:{"openai-api-key":"srr-e2e-replace"}}')"
assert_rejected_read 'PUT /admin/secrets full-replace'

admin_request POST /api/v1/admin/hosts \
  "$(jq -cn --arg h "${FIXTURE_HOST}" --arg s "${FIXTURE_SECRET}" \
    '{metadata:{name:$h}, spec:{contextRef:"context1", secretRef:$s}}')"
assert_rejected_read 'POST /admin/hosts secretRef'

# ─── Restore, then prove nothing was written ────────────────────────────────

restore_role
echo "PASS: Role ${ROLE} restored; rules equal the pre-E2E snapshot and control-api can get Secrets again"

if [[ -n "$(kctl -n "${SECRETS_NS}" get hosts.clerum.io "${FIXTURE_HOST}" --ignore-not-found -o name)" ]]; then
  echo "FAIL: POST /admin/hosts created Host ${FIXTURE_HOST} despite the rejected secretRef read" >&2
  exit 1
fi
fixture_rv_after="$(fixture_resource_version)"
if [[ "${fixture_rv_after}" != "${fixture_rv_before}" ]]; then
  echo "FAIL: fixture Secret changed during the revocation (resourceVersion ${fixture_rv_before} -> ${fixture_rv_after})" >&2
  exit 1
fi
echo 'PASS: no Host was created and the fixture Secret was not written under the revocation'

# Positive control for the merge route only: the same merge succeeds once the
# Role is back, so its 502 was caused by the revocation and not by the fixture,
# the session, or the route. The full-replace and Host routes are not re-run
# here; their success paths are covered by the control-api route tests.
admin_request PUT /api/v1/admin/secrets \
  "$(jq -cn --arg n "${FIXTURE_SECRET}" '{name:$n, merge:true, stringData:{"openai-api-key":"srr-e2e-merge"}}')"
if [[ "${RESPONSE_STATUS}" != 200 ]]; then
  echo "FAIL: control merge after restore answered HTTP ${RESPONSE_STATUS}, expected 200" >&2
  exit 1
fi
if [[ "$(fixture_resource_version)" == "${fixture_rv_before}" ]]; then
  echo "FAIL: control merge answered 200 but the fixture Secret was not written" >&2
  exit 1
fi
echo 'PASS: the same merge answers 200 and writes the Secret once the Role is restored'
echo 'CONTROL_API_SECRET_READ_RBAC_PASS'
