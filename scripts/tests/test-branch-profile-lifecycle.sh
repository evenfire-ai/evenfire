#!/usr/bin/env bash
# Behaviour scenarios for scripts/minikube-profiles/branch-profile.sh.
#
# The real script runs against a fixture Git repository. kubectl, minikube,
# helm, docker and curl are PATH stubs that append every call to a log, and
# CACHE_ROOT is a temporary directory, so no cluster, Docker daemon or shared
# kubeconfig is touched. A port-forward stub process presents the exact kubectl
# argv to ps(1) (exec -a) so the ownership library can record and stop it.
#
# Every scenario asserts the exit code, the stub call log and the pidfile state.
# Every negative assertion is paired with a positive witness proving the path
# under test actually ran.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# BRANCH_PROFILE_LIFECYCLE_SCRIPT lets a mutation run point this suite at a
# modified copy of the script; by default the checked-in script is tested.
BRANCH_PROFILE="${BRANCH_PROFILE_LIFECYCLE_SCRIPT:-${ROOT}/scripts/minikube-profiles/branch-profile.sh}"
[[ -f "${BRANCH_PROFILE}" ]] || { printf 'FAIL: script under test is missing: %s\n' "${BRANCH_PROFILE}" >&2; exit 1; }

# Ambient selectors from the caller's shell must not leak into the fixture.
unset MINIKUBE_PROFILE BRANCH_PROFILE_PROFILE HOST CONFIRM_DELETE CONFIRM_PROFILE \
  ARGS KUBECONFIG ALLOWED_CONTEXTS CONTEXT DOCKER_CONTEXT PF_STARTUP_DELAY

tmp="$(mktemp -d "${TMPDIR:-/tmp}/branch-profile-lifecycle.XXXXXX")"
tmp="$(cd -- "${tmp}" && pwd -P)"
state="${tmp}/state"
stub_bin="${tmp}/bin"
cache_root="${tmp}/cache"
out_dir="${tmp}/out"
mkdir -p "${state}" "${stub_bin}" "${cache_root}" "${out_dir}"

kill_recorded_processes() {
  local file pid
  for file in "${state}/pf-pids" "${state}/foreign-pids"; do
    [[ -f "${file}" ]] || continue
    while IFS= read -r pid; do
      [[ "${pid}" =~ ^[0-9]+$ ]] || continue
      kill -KILL "${pid}" 2>/dev/null || true
      # Reap our own children quietly; kubectl stubs are not children here.
      wait "${pid}" 2>/dev/null || true
    done <"${file}"
  done
}
cleanup() {
  kill_recorded_processes
  rm -rf "${tmp}"
}
trap cleanup EXIT

ASSERTIONS=0
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  if [[ -n "${BP_OUT:-}" && -f "${BP_OUT}" ]]; then
    printf -- '--- last branch-profile output (%s, rc=%s) ---\n' "${BP_OUT##*/}" "${BP_RC:-?}" >&2
    sed -n '1,60p' "${BP_OUT}" >&2
  fi
  if [[ -f "${state}/calls.log" ]]; then
    printf -- '--- stub call log ---\n' >&2
    sed -n '1,60p' "${state}/calls.log" >&2
  fi
  exit 1
}
ok() { ASSERTIONS=$((ASSERTIONS + 1)); }

assert_rc() {
  local expected="$1" label="$2"
  [[ "${BP_RC}" == "${expected}" ]] || fail "${label}: expected exit ${expected}, got ${BP_RC}"
  ok
}
assert_rc_nonzero() {
  local label="$1"
  [[ "${BP_RC}" != 0 ]] || fail "${label}: expected a non-zero exit, got 0"
  ok
}
assert_output_has() {
  local needle="$1" label="$2"
  grep -Fq -- "${needle}" "${BP_OUT}" || fail "${label}: output lacks '${needle}'"
  ok
}
assert_output_lacks() {
  local needle="$1" label="$2"
  if grep -Fq -- "${needle}" "${BP_OUT}"; then fail "${label}: output unexpectedly has '${needle}'"; fi
  ok
}
assert_log_has() {
  local needle="$1" label="$2"
  grep -Fq -- "${needle}" "${state}/calls.log" || fail "${label}: stub log lacks '${needle}'"
  ok
}
assert_log_lacks() {
  local needle="$1" label="$2"
  if grep -Fq -- "${needle}" "${state}/calls.log"; then fail "${label}: stub log unexpectedly has '${needle}'"; fi
  ok
}
assert_log_count() {
  local needle="$1" expected="$2" label="$3" actual
  actual="$(grep -Fc -- "${needle}" "${state}/calls.log" || true)"
  [[ "${actual}" == "${expected}" ]] || fail "${label}: expected ${expected} '${needle}' calls, got ${actual}"
  ok
}
assert_file() {
  local path="$1" label="$2"
  [[ -f "${path}" ]] || fail "${label}: missing ${path}"
  ok
}
assert_no_file() {
  local path="$1" label="$2"
  [[ ! -e "${path}" && ! -L "${path}" ]] || fail "${label}: unexpectedly present ${path}"
  ok
}
assert_alive() {
  local pid="$1" label="$2"
  kill -0 "${pid}" 2>/dev/null || fail "${label}: pid ${pid} is not alive"
  ok
}
assert_dead() {
  local pid="$1" label="$2" index
  for ((index = 0; index < 50; index += 1)); do
    kill -0 "${pid}" 2>/dev/null || { ok; return 0; }
    sleep 0.05
  done
  fail "${label}: pid ${pid} is still alive"
}

# --- PATH stubs ---------------------------------------------------------------
cat >"${stub_bin}/kubectl" <<'EOF_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
state="${BRANCH_PROFILE_STUB_STATE:?stub state directory is required}"
printf 'kubectl %s\n' "$*" >>"${state}/calls.log"
if [[ "${1:-}" == config ]]; then
  case "${2:-}" in
    current-context)
      [[ -s "${state}/current-context" ]] || exit 1
      cat "${state}/current-context"
      exit 0
      ;;
    use-context)
      printf '%s\n' "${3:?use-context needs a name}" >"${state}/current-context"
      exit 0
      ;;
    # kube-contexts holds one "<context> <server>" line per kubeconfig context.
    get-contexts)
      [[ "$*" == 'config get-contexts -o name' ]] || {
        printf 'kubectl stub: unsupported config call: %s\n' "$*" >&2
        exit 64
      }
      awk '{ print $1 }' "${state}/kube-contexts"
      exit 0
      ;;
    view)
      wanted=""
      for arg in "$@"; do
        case "${arg}" in --context=*) wanted="${arg#--context=}" ;; esac
      done
      # Only the local, minified server read that t2_context_check also makes.
      [[ "$*" == "config view --raw --minify --context=${wanted} -o jsonpath={.clusters[0].cluster.server}" ]] || {
        printf 'kubectl stub: unsupported config call: %s\n' "$*" >&2
        exit 64
      }
      server="$(awk -v wanted="${wanted}" '$1 == wanted { print $2; exit }' "${state}/kube-contexts")"
      [[ -n "${server}" ]] || {
        printf 'error: context was not found for specified context: %s\n' "${wanted}" >&2
        exit 1
      }
      printf '%s' "${server}"
      exit 0
      ;;
  esac
  printf 'kubectl stub: unsupported config call: %s\n' "$*" >&2
  exit 64
fi
original="$*"
context=""
namespace=""
output=""
verb=""
kind=""
name=""
while (( $# > 0 )); do
  case "$1" in
    --context=*) context="${1#--context=}"; shift ;;
    --request-timeout=* | --address=* | --ignore-not-found | -A) shift ;;
    -n) namespace="$2"; shift 2 ;;
    -o) output="$2"; shift 2 ;;
    *)
      if [[ -z "${verb}" ]]; then verb="$1"
      elif [[ -z "${kind}" ]]; then kind="$1"
      elif [[ -z "${name}" ]]; then name="$1"
      fi
      shift
      ;;
  esac
done
case "${verb}" in
  cluster-info)
    [[ -e "${state}/reachable" ]] || { printf 'stub: cluster unreachable\n' >&2; exit 1; }
    printf 'stub control plane\n'
    ;;
  get)
    case "${kind}" in
      svc)
        if grep -Fqx "${namespace}/${name}" "${state}/services"; then
          printf 'service/%s\n' "${name}"
        fi
        ;;
      nodes)
        if [[ "${output}" == json ]]; then
          # The node carries the minikube.k8s.io/name label of the context it
          # was asked through, unless node-label names another cluster.
          label="${context}"
          [[ ! -s "${state}/node-label" ]] || label="$(cat "${state}/node-label")"
          printf '{"items":[{"metadata":{"labels":{"minikube.k8s.io/name":"%s"}},"status":{"addresses":[{"type":"InternalIP","address":"%s"}]}}]}\n' \
            "${label}" "$(cat "${state}/minikube-ip")"
        else
          printf 'stub nodes\n'
        fi
        ;;
      deploy | sts)
        [[ ! -e "${state}/fail-get-${kind}" ]] || { printf 'stub: get %s failed\n' "${kind}" >&2; exit 1; }
        printf 'stub %s\n' "${kind}"
        ;;
      *) printf 'kubectl stub: unsupported get: %s\n' "${original}" >&2; exit 64 ;;
    esac
    ;;
  port-forward)
    printf '%s\n' "$$" >>"${state}/pf-pids"
    if [[ -e "${state}/pf-ignores-term" ]]; then trap '' TERM; fi
    # Present exactly "<path>/kubectl <original argv>" to ps(1) and block
    # until signalled; the FIFO is opened read-write so cat never sees EOF.
    exec -a "$0 ${original}" cat 0<>"${state}/pf.fifo"
    ;;
  *) printf 'kubectl stub: unsupported call: %s\n' "${original}" >&2; exit 64 ;;
esac
EOF_KUBECTL

cat >"${stub_bin}/minikube" <<'EOF_MINIKUBE'
#!/usr/bin/env bash
set -euo pipefail
state="${BRANCH_PROFILE_STUB_STATE:?stub state directory is required}"
profile=""
previous=""
for arg in "$@"; do
  [[ "${previous}" == -p ]] && profile="${arg}"
  previous="${arg}"
done
pidfiles=0
if [[ -n "${profile}" && -d "${CACHE_ROOT}/${profile}/pids" ]]; then
  pidfiles="$(find "${CACHE_ROOT}/${profile}/pids" -name '*.pid' | wc -l | tr -d ' ')"
fi
# pidfiles= records how many port-forward records still existed when minikube
# was called, which pins the clear-records-before-stop ordering.
printf 'minikube %s pidfiles=%s\n' "$*" "${pidfiles}" >>"${state}/calls.log"
case " $* " in
  # minikube-profile-list holds the JSON `minikube profile list -o json` prints.
  *" profile list "*)
    [[ "$*" == 'profile list -o json' ]] || {
      printf 'minikube stub: unsupported profile call: %s\n' "$*" >&2
      exit 64
    }
    [[ ! -e "${state}/minikube-profile-list-fails" ]] || {
      printf 'stub: minikube profile list failed\n' >&2
      exit 5
    }
    cat "${state}/minikube-profile-list"
    ;;
  *" start "*)
    if [[ -e "${state}/start-switches-context" ]]; then
      printf '%s\n' "${profile}" >"${state}/current-context"
    fi
    ;;
  *" status "*) exit "$(cat "${state}/minikube-status-rc")" ;;
  *" ip "*) cat "${state}/minikube-ip" ;;
  *" stop "*) [[ ! -e "${state}/minikube-stop-fails" ]] || exit 9 ;;
  *" delete "*) [[ ! -e "${state}/minikube-delete-fails" ]] || exit 11 ;;
esac
EOF_MINIKUBE

cat >"${stub_bin}/docker" <<'EOF_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"${BRANCH_PROFILE_STUB_STATE:?}/calls.log"
case "$*" in
  info) ;;
  # docker-cli-env.sh verifies the pinned endpoint through the isolated config.
  'context inspect --format {{.Endpoints.docker.Host}} default') printf '%s\n' "${DOCKER_HOST:?}" ;;
  *) printf 'docker stub: unsupported call: %s\n' "$*" >&2; exit 64 ;;
esac
EOF_DOCKER

cat >"${stub_bin}/helm" <<'EOF_HELM'
#!/usr/bin/env bash
set -euo pipefail
printf 'helm %s\n' "$*" >>"${BRANCH_PROFILE_STUB_STATE:?}/calls.log"
EOF_HELM

cat >"${stub_bin}/curl" <<'EOF_CURL'
#!/usr/bin/env bash
set -euo pipefail
state="${BRANCH_PROFILE_STUB_STATE:?stub state directory is required}"
printf 'curl %s\n' "$*" >>"${state}/calls.log"
url="${*: -1}"
if [[ -f "${state}/curl-fail" ]] && grep -Fqx "${url}" "${state}/curl-fail"; then exit 7; fi
EOF_CURL
chmod +x "${stub_bin}"/*
mkfifo "${state}/pf.fifo"

# --- fixture repository -------------------------------------------------------
# shellcheck source=scripts/tests/lib/minikube-fixture-repo.sh
. "${ROOT}/scripts/tests/lib/minikube-fixture-repo.sh"
minikube_test_fixture_repo_init "${ROOT}" "${tmp}/fixture"
repo="${MINIKUBE_TEST_PROJECT_DIR}"
mkdir -p "${repo}/scripts" "${repo}/deploy/minikube"
cp -R "${ROOT}/scripts/minikube" "${repo}/scripts/minikube"
printf 'fixture deploy file\n' >"${repo}/deploy/minikube/fixture.txt"
other_worktree="${tmp}/other-worktree"
mkdir -p "${other_worktree}"

# shellcheck source=scripts/minikube/port-forward-owner.sh
. "${ROOT}/scripts/minikube/port-forward-owner.sh"

reset_state() {
  : >"${state}/calls.log"
  printf '0\n' >"${state}/minikube-status-rc"
  printf 'other-session-context\n' >"${state}/current-context"
  printf '%s\n' control-plane/control-ui control-plane/control-api \
    profiles/external-rest-api rpc-proxy/rpc-proxy >"${state}/services"
  : >"${state}/reachable"
  rm -f "${state}/fail-get-deploy" "${state}/curl-fail" "${state}/start-switches-context" \
    "${state}/pf-ignores-term" "${state}/minikube-stop-fails" "${state}/minikube-delete-fails" \
    "${state}/node-label" "${state}/minikube-profile-list-fails"
  # By default the branch profile's context is this local Minikube, minikube
  # lists the profile, and its node carries the profile label at the address
  # `minikube ip` reports.
  write_kube_contexts "${profile:-}" https://127.0.0.1:32771
  write_minikube_profiles "${profile:-}"
  printf '192.168.49.2\n' >"${state}/minikube-ip"
}

# write_minikube_profiles [<name>...]: `minikube profile list -o json` lists
# each non-empty <name> as a running, valid profile.
write_minikube_profiles() {
  local name items="" separator=""
  for name in "$@"; do
    [[ -n "${name}" ]] || continue
    items+="${separator}{\"Name\":\"${name}\",\"Status\":\"Running\"}"
    separator=,
  done
  printf '{"invalid":[],"valid":[%s]}\n' "${items}" >"${state}/minikube-profile-list"
}

# write_kube_contexts <context> <server>: the kubeconfig holds another
# session's local context and, when <context> is set, <context> -> <server>.
write_kube_contexts() {
  {
    printf 'other-session-context https://127.0.0.1:40001\n'
    [[ -z "$1" ]] || printf '%s %s\n' "$1" "$2"
  } >"${state}/kube-contexts"
}

# assert_no_calls_to <bin> <label>: the stub log has no call to <bin> at all.
assert_no_calls_to() {
  local bin="$1" label="$2"
  if grep -q "^${bin} " "${state}/calls.log"; then fail "${label}: stub log unexpectedly has a ${bin} call"; fi
  ok
}

# bp <label> <action> [NAME=value ...]
bp() {
  local label="$1" action="$2"
  shift 2
  BP_OUT="${out_dir}/${label}.log"
  BP_RC=0
  (
    cd -- "${repo}" &&
      env PATH="${stub_bin}:${PATH}" \
        BRANCH_PROFILE_STUB_STATE="${state}" \
        CACHE_ROOT="${cache_root}" \
        DOCKER_HOST="unix://${tmp}/docker.sock" \
        PF_OWNER_TERMINATE_ATTEMPTS=5 PF_OWNER_TERMINATE_DELAY=0.05 \
        "$@" bash "${BRANCH_PROFILE}" "${action}"
  ) >"${BP_OUT}" 2>&1 || BP_RC=$?
}

start_foreign_process() {
  sleep 600 &
  FOREIGN_PID=$!
  printf '%s\n' "${FOREIGN_PID}" >>"${state}/foreign-pids"
}

dead_pid() {
  local pid
  sleep 0 &
  pid=$!
  wait "${pid}" 2>/dev/null || true
  printf '%s\n' "${pid}"
}

write_control_ui_record() {
  local pid="$1" start="$2" worktree="$3"
  pf_owner_write_record_atomic "${pids_dir}/control-ui.pid" "${pid}" "${start}" \
    "${profile}" "${profile}" "${worktree}" control-plane control-ui \
    "${control_ui_port}" 3000 || fail "could not write the control-ui fixture record"
}

# === resolve / preflight ======================================================
reset_state
bp resolve resolve
assert_rc 0 'resolve'
profile="$(awk -F= '$1 == "PROFILE" { print $2; exit }' "${BP_OUT}")"
[[ "${profile}" =~ ^clerum-test-minikube-fixture-[0-9a-f]{8}$ ]] ||
  fail "resolve returned an unexpected profile name: ${profile}"
ok
profile_dir="${cache_root}/${profile}"
pids_dir="${profile_dir}/pids"

bp preflight preflight
assert_rc 0 'preflight'
assert_output_has 'preflight: OK' 'preflight'
assert_file "${profile_dir}/profile.env" 'preflight writes profile.env'
assert_file "${profile_dir}/ports.env" 'preflight writes ports.env'
assert_log_has 'docker info' 'preflight probes Docker through the bounded runner'
control_ui_port="$(awk -F= '$1 == "CONTROL_UI_PORT" { print $2; exit }' "${profile_dir}/ports.env")"
[[ "${control_ui_port}" =~ ^[0-9]+$ ]] || fail "ports.env has no CONTROL_UI_PORT"
ok

# === HOST: only 127.0.0.1 is consistent with ports.env and PF records =========
for bad_host in localhost ::1 '[::1]'; do
  reset_state
  bp "host-${bad_host//[^a-z0-9]/_}" stop "HOST=${bad_host}"
  assert_rc 1 "stop with HOST=${bad_host}"
  # Witness: the refusal names the only accepted address.
  assert_output_has 'HOST must be 127.0.0.1' "stop with HOST=${bad_host}"
  assert_log_lacks 'minikube' "stop with HOST=${bad_host} must refuse before touching minikube"
done

# === explicit profile outside the branch-scoped namespace =====================
# write_owned_profile_copy <name>: a profile directory whose metadata this
# worktree owns (same repo, branch and owner id as the branch profile), so
# profile-owner.sh accepts it and only branch-profile.sh's own name rules decide.
write_owned_profile_copy() {
  local name="$1" dir="${cache_root}/$1"
  mkdir -p "${dir}"
  cp "${profile_dir}/ports.env" "${dir}/ports.env"
  awk -v wanted="${name}" -F= '$1 == "PROFILE" { print "PROFILE=" wanted; next } { print }' \
    "${profile_dir}/profile.env" >"${dir}/profile.env"
}

reset_state
bp explicit-own resolve "MINIKUBE_PROFILE=${profile}"
assert_rc 0 'explicit selection of the branch-owned profile'
assert_output_has "PROFILE=${profile}" 'explicit selection of the branch-owned profile'
write_owned_profile_copy clerum-dev
bp explicit-shared resolve MINIKUBE_PROFILE=clerum-dev
assert_rc 1 'explicit selection of clerum-dev'
assert_output_has 'clerum-dev' 'explicit selection of clerum-dev names the refused profile'
assert_output_lacks 'PROFILE=clerum-dev' 'explicit selection of clerum-dev must not resolve'
rm -rf "${cache_root:?}/clerum-dev"

# An explicitly adopted profile that profile-owner.sh proves this worktree owns
# may predate the hashed clerum-<branch>-<owner-id> naming; it is accepted.
adopted=clerum-oauth19
write_owned_profile_copy "${adopted}"
reset_state
bp adopted-resolve resolve "MINIKUBE_PROFILE=${adopted}"
assert_rc 0 'explicit selection of an owned profile without the hashed suffix'
assert_output_has "PROFILE=${adopted}" 'explicit selection of an owned profile without the hashed suffix'
reset_state
bp adopted-status status "MINIKUBE_PROFILE=${adopted}"
assert_rc 0 'status of an owned profile without the hashed suffix'
assert_log_has "minikube -p ${adopted} status" 'status ran minikube status for the adopted profile'
reset_state
bp adopted-stop stop "MINIKUBE_PROFILE=${adopted}"
assert_rc 0 'stop of an owned profile without the hashed suffix'
assert_log_has "minikube -p ${adopted} stop" 'stop ran minikube stop for the adopted profile'

# Ownership alone is not enough on the explicit path: the name must also be in
# the local clerum-* namespace, which keeps out EKS/AKS or arbitrary contexts
# that are not on the shared-context denylist.
write_owned_profile_copy my-aks-shared
reset_state
bp explicit-outside-namespace resolve MINIKUBE_PROFILE=my-aks-shared
assert_rc 1 'explicit selection of an owned profile outside clerum-*'
# Witness: the refusal comes from the clerum-* namespace check, not the denylist.
assert_output_has 'explicit profile is outside the local clerum-* namespace: my-aks-shared' \
  'explicit selection of an owned profile outside clerum-*'
assert_output_lacks 'PROFILE=my-aks-shared' 'an owned profile outside clerum-* must not resolve'
assert_log_lacks 'minikube' 'an owned profile outside clerum-* must not reach minikube'
assert_log_lacks 'kubectl' 'an owned profile outside clerum-* must not reach kubectl'
rm -rf "${cache_root:?}/my-aks-shared"

# A profile directory without profile.env is PROFILE_METADATA_MISSING, for an
# explicitly adopted profile and for the derived branch profile alike. Nothing
# regenerates that metadata (branch-profile-start only creates it when the
# directory does not exist), so the refusal must name the code and the only
# safe next step, and must not reach minikube or kubectl.
mv "${cache_root}/${adopted}/profile.env" "${tmp}/adopted-profile.env"
reset_state
bp adopted-metadata-missing start "MINIKUBE_PROFILE=${adopted}"
assert_rc 1 'start of an adopted profile without profile.env'
assert_output_has "PROFILE_METADATA_MISSING: profile metadata for ${adopted} is missing or unreadable" \
  'the refusal of an adopted profile without profile.env names the code'
assert_output_has 'never regenerates it for an existing one' \
  'the refusal of an adopted profile without profile.env does not point at branch-profile-start'
assert_log_lacks 'minikube' 'an adopted profile without profile.env must not reach minikube'
assert_log_lacks 'kubectl' 'an adopted profile without profile.env must not reach kubectl'
mv "${tmp}/adopted-profile.env" "${cache_root}/${adopted}/profile.env"

mv "${profile_dir}/profile.env" "${tmp}/branch-profile.env"
reset_state
bp derived-metadata-missing start
assert_rc 1 'start of the branch profile without profile.env'
assert_output_has "PROFILE_METADATA_MISSING: profile metadata for this branch is missing or unreadable" \
  'the refusal of the branch profile without profile.env names the code'
assert_output_has 'never regenerates it for an existing one' \
  'the refusal of the branch profile without profile.env does not point at branch-profile-start'
assert_log_lacks 'minikube' 'a branch profile without profile.env must not reach minikube'
assert_log_lacks 'kubectl' 'a branch profile without profile.env must not reach kubectl'
mv "${tmp}/branch-profile.env" "${profile_dir}/profile.env"

# A profile the resolver derives on its own (no explicit selection) must still
# carry the hashed suffix. With the branch profile set aside, the adopted
# profile is the only persisted record for this worktree and branch.
mv "${profile_dir}" "${tmp}/branch-profile-aside"
reset_state
bp derived-unhashed resolve
assert_rc 1 'resolver-derived profile without the hashed suffix'
assert_output_has "outside the branch-scoped clerum-<branch>-<owner-id> namespace: ${adopted}" \
  'the resolver found the unhashed profile and refused it'
assert_output_has 'select an adopted profile explicitly with MINIKUBE_PROFILE=<name>' \
  'the refusal of a resolver-derived unhashed profile says how to select it'
assert_output_lacks "PROFILE=${adopted}" 'a resolver-derived unhashed profile must not resolve'
mv "${tmp}/branch-profile-aside" "${profile_dir}"
rm -rf "${cache_root:?}/${adopted}"

# Shared contexts are refused by name in every subcommand, before the resolver
# runs and before any kubectl or minikube call, even with owned metadata. The
# match is case-insensitive (CLERUM-DEV).
for shared in clerum-dev CLERUM-DEV gke_sample-project_us-central1-a_shared-cluster; do
  write_owned_profile_copy "${shared}"
  for action in resolve info preflight prepare-shims start status pf pf-health health \
    stop-pf stop setup delete e2e-plan sync-plan; do
    reset_state
    bp "shared-${shared%%_*}-${action}" "${action}" "MINIKUBE_PROFILE=${shared}" \
      "CONFIRM_DELETE=${shared}" "CONFIRM_PROFILE=${shared}"
    assert_rc 1 "${action} with MINIKUBE_PROFILE=${shared}"
    # Witness: the refusal comes from the shared-context denylist and names it.
    assert_output_has "BRANCH_PROFILE_SHARED_CONTEXT: refusing shared or protected profile: ${shared}" \
      "${action} with MINIKUBE_PROFILE=${shared}"
    assert_log_lacks 'minikube' "${action} with MINIKUBE_PROFILE=${shared} must not call minikube"
    assert_log_lacks 'kubectl' "${action} with MINIKUBE_PROFILE=${shared} must not call kubectl"
  done
  rm -rf "${cache_root:?}/${shared}"
done

# === the context named after the profile must be this local Minikube ==========
# minikube -p and kubectl --context address a cluster by context name alone,
# and `minikube -p <p> delete` for a profile minikube does not know removes the
# kubeconfig context of that name. A context with the profile's name whose API
# server is not local is refused before any minikube or kubectl --context call.
# The witness is the local kubeconfig read that decided it. The remote server
# is a public address: Python's ipaddress counts the documentation ranges
# (TEST-NET-1/2/3) as private, so the shared predicate admits them as local.
remote_server=https://8.8.8.8:6443
for action in start status pf pf-health health stop setup delete; do
  reset_state
  write_kube_contexts "${profile}" "${remote_server}"
  bp "remote-context-${action}" "${action}" "CONFIRM_DELETE=${profile}" "CONFIRM_PROFILE=${profile}"
  assert_rc 1 "${action} of a profile whose context is remote"
  assert_output_has "BRANCH_PROFILE_REMOTE_CONTEXT: kube context ${profile} points at a non-local API server (8.8.8.8)" \
    "${action} of a profile whose context is remote"
  assert_log_has "kubectl config view --raw --minify --context=${profile}" \
    "${action} read the context's server from the local kubeconfig"
  assert_no_calls_to minikube "${action} of a profile whose context is remote must not call minikube"
  assert_log_lacks 'kubectl --context=' "${action} of a profile whose context is remote must not address the cluster"
  assert_no_calls_to docker "${action} of a profile whose context is remote must not reach Docker"
done

# A DNS name other than localhost and *.minikube is the predicate's other
# remote branch. The name is reserved by RFC 2606 and never resolves.
for action in start delete; do
  reset_state
  write_kube_contexts "${profile}" https://API.Remote-Cluster.example:6443
  bp "remote-dns-context-${action}" "${action}" "CONFIRM_DELETE=${profile}"
  assert_rc 1 "${action} of a profile whose context is a remote DNS name"
  assert_output_has "BRANCH_PROFILE_REMOTE_CONTEXT: kube context ${profile} points at a non-local API server (api.remote-cluster.example)" \
    "${action} of a profile whose context is a remote DNS name"
  assert_log_has "kubectl config view --raw --minify --context=${profile}" \
    "${action} read the DNS-named context's server from the local kubeconfig"
  assert_no_calls_to minikube "${action} of a profile whose context is a remote DNS name must not call minikube"
  assert_log_lacks 'kubectl --context=' "${action} of a profile whose context is a remote DNS name must not address the cluster"
done

# The reported shape: an adopted clerum-* profile named like a remote cluster's
# context. delete must refuse without running `minikube -p clerum-prd delete`.
write_owned_profile_copy clerum-prd
reset_state
write_kube_contexts clerum-prd "${remote_server}"
bp adopted-remote-delete delete MINIKUBE_PROFILE=clerum-prd CONFIRM_DELETE=clerum-prd
assert_rc 1 'delete of an adopted profile whose context is remote'
assert_output_has 'BRANCH_PROFILE_REMOTE_CONTEXT: kube context clerum-prd points at a non-local API server' \
  'delete of an adopted profile whose context is remote'
assert_log_has 'kubectl config view --raw --minify --context=clerum-prd' \
  'delete of an adopted profile read its context from the local kubeconfig'
assert_no_calls_to minikube 'delete of an adopted profile whose context is remote must not call minikube'
rm -rf "${cache_root:?}/clerum-prd"

# A private address passes the endpoint check (Minikube's own network is
# private), so a cluster that answers must also identify itself as this
# profile: a node labelled minikube.k8s.io/name=<profile> at `minikube ip`.
for action in start status pf health; do
  reset_state
  write_kube_contexts "${profile}" https://192.168.1.50:8443
  printf 'lan-cluster\n' >"${state}/node-label"
  bp "foreign-identity-${action}" "${action}"
  assert_rc 1 "${action} of a profile whose context is another cluster"
  assert_output_has "BRANCH_PROFILE_CONTEXT_IDENTITY: kube context ${profile} does not identify Minikube profile ${profile} at 192.168.49.2" \
    "${action} of a profile whose context is another cluster"
  # Witness: the identity was read from the cluster and from minikube.
  assert_log_has "minikube -p ${profile} ip" "${action} asked minikube for the profile's IP"
  assert_log_has "kubectl --context=${profile} --request-timeout=10s get nodes -o json" \
    "${action} read the node identity"
  assert_log_lacks 'port-forward' "${action} of a profile whose context is another cluster must not forward"
  assert_log_lacks 'get deploy' "${action} of a profile whose context is another cluster must not list workloads"
  assert_no_calls_to curl "${action} of a profile whose context is another cluster must not probe services"
  if [[ "${action}" == start ]]; then
    assert_log_has "minikube start -p ${profile}" 'start started the profile before checking its identity'
    assert_log_lacks 'cluster-info' 'start of a profile whose context is another cluster stops before cluster-info'
  fi
done

# The default fixture context is local and identifies the profile: the checks
# ran and admitted it.
reset_state
bp local-identity-status status
assert_rc 0 'status of a profile whose context is this local Minikube'
assert_log_has "kubectl config view --raw --minify --context=${profile}" 'status read the context from the local kubeconfig'
assert_log_has "kubectl --context=${profile} --request-timeout=10s get nodes -o json" 'status verified the node identity'
assert_log_has "kubectl --context=${profile} --request-timeout=10s get deploy -A" 'status went on to list workloads'

# === status ===================================================================
reset_state
bp status-running status
assert_rc 0 'status of a running profile'
assert_log_has "minikube -p ${profile} status" 'status of a running profile'
assert_log_has "kubectl --context=${profile} --request-timeout=10s get deploy -A" 'status lists deployments'

reset_state
rm -f "${state}/reachable"
printf '7\n' >"${state}/minikube-status-rc"
bp status-stopped status
assert_rc 7 'status of a stopped profile returns the minikube status code'
assert_output_has "cluster not reachable for context ${profile}" 'status of a stopped profile'
assert_log_has "minikube -p ${profile} status" 'status of a stopped profile ran minikube status'
assert_log_lacks 'get deploy' 'status of a stopped profile must not list deployments'

reset_state
: >"${state}/fail-get-deploy"
bp status-kubectl-fails status
assert_rc_nonzero 'status must fail when listing deployments fails'
assert_log_has "kubectl --context=${profile} --request-timeout=10s get deploy -A" 'status reached the failing deployment listing'

# === pf / health / stop-pf ====================================================
reset_state
bp pf-all pf
assert_rc 0 'pf with every required service present'
for name in control-ui control-api external-rest-api rpc-proxy; do
  assert_file "${pids_dir}/${name}.pid" "pf records ${name}"
done
assert_no_file "${pids_dir}/profile-ui.pid" 'pf skips an absent optional service'
assert_output_has 'SKIP profile-ui' 'pf reports the skipped optional service'
assert_log_count 'port-forward --address=127.0.0.1' 4 'pf starts one forward per present service'
pf_owner_read_record "${pids_dir}/control-ui.pid" || fail 'control-ui record is unreadable'
control_ui_pid="${PF_OWNER_RECORD_PID}"
assert_alive "${control_ui_pid}" 'the recorded control-ui forward is live'

reset_state
bp health-ok health
assert_rc 0 'health with every probe answering'
assert_log_count 'curl ' 4 'health probes every present service'

reset_state
printf '%s\n' "http://127.0.0.1:$(awk -F= '$1 == "CONTROL_API_PORT" { print $2; exit }' "${profile_dir}/ports.env")/health" \
  >"${state}/curl-fail"
bp health-one-fails health
assert_rc 1 'health with one failing probe'
assert_output_has '1 health check(s) failed' 'health counts the failing probe'
assert_log_count 'curl ' 4 'health still probes every service after one failure'

reset_state
bp stop-pf-owned stop-pf
assert_rc 0 'stop-pf of verified records'
assert_output_has 'stopped or cleared verified control-ui record' 'stop-pf reports each verified record'
for name in control-ui control-api external-rest-api rpc-proxy; do
  assert_no_file "${pids_dir}/${name}.pid" "stop-pf removes ${name}"
done
assert_dead "${control_ui_pid}" 'stop-pf terminates the verified control-ui forward'

reset_state
printf '%s\n' control-plane/control-ui control-plane/control-api profiles/external-rest-api >"${state}/services"
bp pf-required-absent pf
assert_rc 1 'pf with a required service absent'
assert_output_has 'FAIL rpc-proxy' 'pf names the absent required service'
assert_output_has '1 port-forward(s) failed to start' 'pf counts the failure'
for name in control-ui control-api external-rest-api; do
  assert_file "${pids_dir}/${name}.pid" "pf still starts ${name} after another forward failed"
done
bp stop-pf-after-partial stop-pf
assert_rc 0 'stop-pf after a partial pf'

# === pf-health clears its own forwards on exit ================================
reset_state
bp pf-health pf-health
assert_rc 0 'pf-health'
assert_log_count 'port-forward --address=127.0.0.1' 4 'pf-health starts every forward'
assert_log_count 'curl ' 4 'pf-health probes every forward'
for name in control-ui control-api external-rest-api rpc-proxy; do
  assert_no_file "${pids_dir}/${name}.pid" "pf-health clears ${name} on exit"
done

# === stop / delete ============================================================
reset_state
bp stop-pf-before-stop pf
assert_rc 0 'pf before stop'
bp stop-clean stop
assert_rc 0 'stop with verified records'
assert_log_has "minikube -p ${profile} stop pidfiles=0" 'stop clears every record before minikube stop'

reset_state
printf '12345\n' >"${pids_dir}/control-ui.pid"
bp stop-unverified stop
assert_rc 1 'stop with an unverifiable record'
assert_log_has "minikube -p ${profile} stop" 'stop still stops minikube when a record cannot be verified'
assert_output_has "${pids_dir}/control-ui.pid" 'stop names the pidfile to retire by hand'
assert_file "${pids_dir}/control-ui.pid" 'stop keeps the unverifiable record'

reset_state
bp delete-unconfirmed delete
assert_rc 1 'delete without confirmation'
assert_output_has "Re-run with CONFIRM_DELETE=${profile}" 'delete without confirmation names the confirmation'
assert_log_lacks 'minikube' 'delete without confirmation must not call minikube'
assert_file "${pids_dir}/control-ui.pid" 'delete without confirmation leaves records alone'

reset_state
bp delete-unverified delete "CONFIRM_DELETE=${profile}"
assert_rc 1 'delete with an unverifiable record'
assert_log_has "minikube -p ${profile} delete" 'delete still deletes the profile when a record cannot be verified'
assert_output_has "${pids_dir}/control-ui.pid" 'delete names the pidfile to retire by hand'
assert_file "${pids_dir}/control-ui.pid" 'delete keeps the unverifiable record'
rm -f "${pids_dir}/control-ui.pid"

reset_state
bp delete-pf pf
assert_rc 0 'pf before delete'
bp delete-clean delete "CONFIRM_DELETE=${profile}"
assert_rc 0 'delete with verified records'
assert_log_has "minikube -p ${profile} delete pidfiles=0" 'delete clears every record before minikube delete'

# A failed minikube stop or delete is the command's exit code, even when every
# port-forward record was cleared.
reset_state
: >"${state}/minikube-stop-fails"
bp stop-minikube-fails stop
assert_rc 9 'stop returns the exit code of a failed minikube stop'
assert_log_has "minikube -p ${profile} stop pidfiles=0" 'stop ran the failing minikube stop with no records left'

reset_state
: >"${state}/minikube-delete-fails"
bp delete-minikube-fails delete "CONFIRM_DELETE=${profile}"
assert_rc 11 'delete returns the exit code of a failed minikube delete'
assert_log_has "minikube -p ${profile} delete pidfiles=0" 'delete ran the failing minikube delete with no records left'

# A die inside cmd_stop_pf (here: a symlinked pids directory) is contained by
# the subshell in stop_pf_before_minikube: minikube stop still runs and the
# command fails.
reset_state
mv "${pids_dir}" "${tmp}/pids-aside"
mkdir -p "${tmp}/pids-target"
ln -s "${tmp}/pids-target" "${pids_dir}"
bp stop-pf-dies stop
assert_rc_nonzero 'stop must fail when clearing the port-forward records dies'
# Witness: the die that the subshell contained.
assert_output_has "refusing symlinked port-forward PID directory: ${pids_dir}" 'stop reached the dying stop-pf'
assert_log_has "minikube -p ${profile} stop" 'a die in stop-pf must not prevent minikube stop'
rm -f "${pids_dir}"
mv "${tmp}/pids-aside" "${pids_dir}"

# === stop / delete: the context must name a profile minikube knows ============
# A local endpoint does not prove that the context named after the profile is
# this profile's: another local cluster, or one on a private address, passes
# the endpoint check, and `minikube -p <p> delete` on a profile minikube does
# not know removes the kubeconfig context of that name. A stopped profile
# cannot be asked who it is, so stop and delete ask minikube which profiles it
# has and refuse a context whose profile it does not list, before clearing any
# port-forward record. The witness is the profile list read that decided.
for action in stop delete; do
  reset_state
  bp "unknown-profile-${action}-pf" pf
  assert_rc 0 "pf before ${action} of a profile minikube does not know"
  write_minikube_profiles clerum-another-local-profile
  : >"${state}/calls.log"
  bp "unknown-profile-${action}" "${action}" "CONFIRM_DELETE=${profile}"
  assert_rc 1 "${action} of a profile minikube does not know"
  assert_output_has "BRANCH_PROFILE_UNKNOWN_MINIKUBE_PROFILE: minikube lists no profile ${profile}" \
    "${action} of a profile minikube does not know"
  assert_log_has 'minikube profile list -o json' "${action} read minikube's profiles"
  assert_log_lacks "minikube -p ${profile}" "${action} of a profile minikube does not know must not run minikube -p"
  assert_log_lacks 'kubectl --context=' "${action} of a profile minikube does not know must not address the cluster"
  assert_file "${pids_dir}/control-ui.pid" "${action} of a profile minikube does not know keeps the port-forward records"
  bp "unknown-profile-${action}-stop-pf" stop-pf
  assert_rc 0 "stop-pf after the refused ${action}"
done

# A profile list that cannot be read is a refusal, not an empty list.
for action in stop delete; do
  reset_state
  : >"${state}/minikube-profile-list-fails"
  bp "profile-list-fails-${action}" "${action}" "CONFIRM_DELETE=${profile}"
  assert_rc 1 "${action} when minikube profile list fails"
  assert_output_has 'BRANCH_PROFILE_MINIKUBE_PROFILES_UNREADABLE: minikube profile list failed' \
    "${action} when minikube profile list fails"
  assert_log_has 'minikube profile list -o json' "${action} tried to read minikube's profiles"
  assert_log_lacks "minikube -p ${profile}" "${action} when minikube profile list fails must not run minikube -p"
done

# Output that is not the {"invalid": [...], "valid": [...]} shape, with a
# string Name on every entry, is refused too, even when it mentions the
# profile: an error body, a missing list, an entry without a name.
unreadable_lists=(
  'not json'
  '{"error":{"Advice":"x"}}'
  '[]'
  "{\"valid\":[{\"Name\":\"${profile}\"}]}"
  "{\"invalid\":null,\"valid\":[{\"Name\":\"${profile}\"}]}"
  "{\"invalid\":[],\"valid\":[{\"Name\":\"${profile}\"},{\"Status\":\"Running\"}]}"
  "{\"invalid\":[],\"valid\":[{\"Name\":\"${profile}\"},\"${profile}\"]}"
)
for index in "${!unreadable_lists[@]}"; do
  reset_state
  printf '%s\n' "${unreadable_lists[${index}]}" >"${state}/minikube-profile-list"
  bp "profile-list-unreadable-${index}" delete "CONFIRM_DELETE=${profile}"
  assert_rc 1 "delete with unreadable profile list #${index}"
  assert_output_has 'BRANCH_PROFILE_MINIKUBE_PROFILES_UNREADABLE: minikube profile list printed no readable profile lists' \
    "delete with unreadable profile list #${index}"
  assert_log_has 'minikube profile list -o json' "delete with unreadable profile list #${index} read minikube's profiles"
  assert_log_lacks "minikube -p ${profile}" "delete with unreadable profile list #${index} must not run minikube -p"
done

# A known profile that is stopped (its cluster does not answer) is still
# stopped and deleted; so is one minikube lists as invalid.
for action in stop delete; do
  reset_state
  rm -f "${state}/reachable"
  printf '{"invalid":[],"valid":[{"Name":"%s","Status":"Stopped"}]}\n' "${profile}" \
    >"${state}/minikube-profile-list"
  bp "stopped-known-${action}" "${action}" "CONFIRM_DELETE=${profile}"
  assert_rc 0 "${action} of a stopped profile minikube knows"
  assert_log_has 'minikube profile list -o json' "${action} of a stopped profile read minikube's profiles"
  assert_log_has "minikube -p ${profile} ${action} pidfiles=0" "${action} of a stopped profile minikube knows ran"
done
reset_state
printf '{"invalid":[{"Name":"%s","Status":"Unknown"}],"valid":[]}\n' "${profile}" \
  >"${state}/minikube-profile-list"
bp invalid-known-delete delete "CONFIRM_DELETE=${profile}"
assert_rc 0 'delete of a profile minikube lists as invalid'
assert_log_has 'minikube profile list -o json' "delete of an invalid profile read minikube's profiles"
assert_log_has "minikube -p ${profile} delete pidfiles=0" 'delete of a profile minikube lists as invalid ran'

# Without a context named after the profile there is nothing of another
# cluster's to remove, so minikube is not asked and delete runs.
reset_state
write_kube_contexts '' ''
write_minikube_profiles
bp no-context-delete delete "CONFIRM_DELETE=${profile}"
assert_rc 0 'delete of a profile without a kube context'
# Witness: the kubeconfig read that found no context.
assert_log_has 'kubectl config get-contexts -o name' 'delete without a kube context read the kubeconfig'
assert_log_lacks 'minikube profile list' 'delete without a kube context must not need minikube profile list'
assert_log_has "minikube -p ${profile} delete pidfiles=0" 'delete of a profile without a kube context ran'

# === stop-pf attempts every record ============================================
# record_pf_pids <name...>: PF_PIDS gets the recorded PID of each named forward.
record_pf_pids() {
  local name
  PF_PIDS=()
  for name in "$@"; do
    pf_owner_read_record "${pids_dir}/${name}.pid" || fail "${name} record is unreadable"
    PF_PIDS+=("${PF_OWNER_RECORD_PID}")
  done
  ok
}

# An unknown pidfile name is kept and reported, and does not stop the verified
# records from being stopped before minikube stop runs.
reset_state
bp stop-stray-pf pf
assert_rc 0 'pf before a stop with a stray record'
record_pf_pids control-ui control-api external-rest-api rpc-proxy
printf '12345\n' >"${pids_dir}/stray.pid"
bp stop-stray stop
assert_rc_nonzero 'stop with a stray record among verified ones'
# pidfiles=1: only the stray record was left when minikube stop ran.
assert_log_has "minikube -p ${profile} stop pidfiles=1" 'stop cleared the verified records before minikube stop'
assert_output_has 'stopped or cleared verified rpc-proxy record' 'stop reached the verified records'
for name in control-ui control-api external-rest-api rpc-proxy; do
  assert_no_file "${pids_dir}/${name}.pid" "stop removes the verified ${name} record next to a stray one"
done
for pid in "${PF_PIDS[@]}"; do
  assert_dead "${pid}" 'stop terminates every verified forward next to a stray record'
done
assert_file "${pids_dir}/stray.pid" 'stop keeps the stray record'
assert_output_has "  ${pids_dir}/stray.pid" 'stop lists the kept stray record'
rm -f "${pids_dir}/stray.pid"

# The first record in glob order cannot be verified; every later verified
# record is still stopped and removed.
reset_state
bp stop-pf-first-unverified-pf pf
assert_rc 0 'pf before a stop-pf whose first record is unverifiable'
record_pf_pids control-api
orphaned_control_api_pid="${PF_PIDS[0]}"
record_pf_pids control-ui external-rest-api rpc-proxy
printf '12345\n' >"${pids_dir}/control-api.pid"
bp stop-pf-first-unverified stop-pf
assert_rc 1 'stop-pf whose first record is unverifiable'
for name in control-ui external-rest-api rpc-proxy; do
  assert_no_file "${pids_dir}/${name}.pid" "stop-pf removes ${name} after an unverifiable first record"
done
for pid in "${PF_PIDS[@]}"; do
  assert_dead "${pid}" 'stop-pf terminates the verified forwards after an unverifiable first record'
done
assert_file "${pids_dir}/control-api.pid" 'stop-pf keeps the unverifiable first record'
assert_output_has "  ${pids_dir}/control-api.pid" 'stop-pf lists the kept first record'
kill -KILL "${orphaned_control_api_pid}" 2>/dev/null || true
rm -f "${pids_dir}/control-api.pid"

# === stop-pf keeps records it cannot prove are stale ==========================
reset_state
write_control_ui_record "$(dead_pid)" 'Mon Jan  1 00:00:00 2024' "${other_worktree}"
bp stop-pf-foreign-worktree stop-pf
assert_rc 1 'stop-pf with another worktree record'
assert_output_has 'belongs to a different profile, context, worktree, service, or port binding' \
  'stop-pf ran the ownership check on the foreign record'
assert_output_lacks 'retiring' 'stop-pf must not retire another worktree record'
assert_output_lacks 'stopped or cleared verified control-ui record' 'stop-pf must not report a foreign record as cleared'
assert_file "${pids_dir}/control-ui.pid" 'stop-pf keeps another worktree record'
rm -f "${pids_dir}/control-ui.pid"

# Same PID-reuse shape as the retirement below (live PID, different start
# time), but the record is bound to another worktree: the binding check in
# stop_own_pf must keep it, because nothing proves the other worktree's
# forward is gone.
reset_state
start_foreign_process
write_control_ui_record "${FOREIGN_PID}" 'Mon Jan  1 00:00:00 2024' "${other_worktree}"
bp stop-pf-foreign-worktree-live stop-pf
assert_rc 1 'stop-pf with a live other-worktree record whose start differs'
assert_output_has 'belongs to a different profile, context, worktree, service, or port binding' \
  'stop-pf ran the ownership check on the live other-worktree record'
assert_output_has "  ${pids_dir}/control-ui.pid" 'stop-pf lists the kept other-worktree record'
assert_output_lacks 'retiring' 'stop-pf must not retire a live other-worktree record'
assert_file "${pids_dir}/control-ui.pid" 'stop-pf keeps a live other-worktree record'
assert_alive "${FOREIGN_PID}" 'stop-pf never signals the process behind another worktree record'
rm -f "${pids_dir}/control-ui.pid"

# pf must not start a forward over a record it could not stop: start_pf runs
# under `|| failed++`, where errexit is suspended, so a failed stop_own_pf has
# to return explicitly or the control-ui forward is launched anyway.
reset_state
write_control_ui_record "$(dead_pid)" 'Mon Jan  1 00:00:00 2024' "${other_worktree}"
bp pf-over-foreign-record pf
assert_rc 1 'pf with another worktree control-ui record'
assert_output_has 'belongs to a different profile, context, worktree, service, or port binding' \
  'pf ran the ownership check on the other-worktree control-ui record'
assert_output_has '1 port-forward(s) failed to start' 'pf counts the control-ui forward it refused to start'
# Witness: the other required forwards were launched in the same run.
assert_log_count 'port-forward --address=127.0.0.1' 3 'pf starts every other present service'
assert_log_count 'port-forward --address=127.0.0.1 svc/control-ui' 0 \
  'pf must not launch a control-ui forward over a record it could not stop'
pf_owner_read_record "${pids_dir}/control-ui.pid" || fail 'the other-worktree control-ui record is unreadable'
[[ "${PF_OWNER_RECORD_WORKTREE}" == "${other_worktree}" ]] ||
  fail "pf replaced the other-worktree control-ui record (worktree=${PF_OWNER_RECORD_WORKTREE})"
ok
rm -f "${pids_dir}/control-ui.pid"
bp pf-over-foreign-record-cleanup stop-pf
assert_rc 0 'stop-pf clears the forwards pf started next to the foreign record'

reset_state
start_foreign_process
write_control_ui_record "${FOREIGN_PID}" "$(pf_owner_process_start "${FOREIGN_PID}")" "${repo}"
bp stop-pf-live-foreign stop-pf
assert_rc 1 'stop-pf with a live non-kubectl process under an exact-start record'
assert_output_has 'does not have the exact recorded kubectl argv' 'stop-pf ran the argv check'
assert_output_lacks 'retiring' 'stop-pf must not retire a record whose process start still matches'
assert_file "${pids_dir}/control-ui.pid" 'stop-pf keeps the record of a live process it cannot verify'
assert_alive "${FOREIGN_PID}" 'stop-pf never signals a process it cannot verify'
rm -f "${pids_dir}/control-ui.pid"

reset_state
start_foreign_process
write_control_ui_record "${FOREIGN_PID}" 'Mon Jan  1 00:00:00 2024' "${repo}"
bp stop-pf-pid-reuse stop-pf
assert_rc 0 'stop-pf with a reused PID'
assert_output_has "retiring control-ui record: pid=${FOREIGN_PID}" 'stop-pf reports the PID-reuse retirement'
assert_output_lacks 'stopped or cleared verified control-ui record' 'a retired record is not reported as verified'
assert_no_file "${pids_dir}/control-ui.pid" 'stop-pf retires the reused-PID record'
assert_alive "${FOREIGN_PID}" 'stop-pf does not signal the process that reused the PID'

# === start restores a global context minikube switched ========================
reset_state
bp start-keeps-context start
assert_rc 0 'start that keeps the global context'
assert_log_has "minikube start -p ${profile} --keep-context" 'start runs minikube start'
assert_log_has "minikube -p ${profile} status" 'start checks status after a clean start'
[[ "$(cat "${state}/current-context")" == other-session-context ]] || fail 'start changed the global context'
ok

reset_state
: >"${state}/start-switches-context"
bp start-switches-context start
assert_rc 1 'start after minikube switched the global context'
assert_log_has "minikube start -p ${profile} --keep-context" 'start ran minikube start before detecting the switch'
assert_output_has 'switched the kubectl current-context' 'start reports the switch'
assert_log_has 'kubectl config use-context other-session-context' 'start restores the previous global context'
[[ "$(cat "${state}/current-context")" == other-session-context ]] ||
  fail "start left the global context on $(cat "${state}/current-context")"
ok
assert_log_lacks "minikube -p ${profile} status" 'start stops after detecting the switch'

# === prepare-shims: symlinks and the seed allowlist ===========================
reset_state
bp prepare-shims prepare-shims
assert_rc 0 'prepare-shims'
shims_dir="${profile_dir}/scripts/minikube"
assert_file "${shims_dir}/seed-test-data.sh" 'prepare-shims copies the seed script'
assert_file "${profile_dir}/shims.env" 'prepare-shims writes shims.env'

seed_project="${tmp}/seed-project"
mkdir -p "${seed_project}/scripts/e2e"
cat >"${seed_project}/scripts/e2e/load-dotenv.sh" <<'EOF_DOTENV'
dotenv_load_canonical_root() { return 0; }
EOF_DOTENV
cat >"${seed_project}/scripts/e2e/admin-credentials.sh" <<'EOF_ADMIN'
e2e_resolve_admin_password() { printf 'fixture-admin-password\n'; }
EOF_ADMIN
cat >"${seed_project}/scripts/e2e/seed-e2e-data.sh" <<'EOF_SEED'
printf 'CONTEXT=%s ALLOWED_CONTEXTS=%s\n' "${CONTEXT}" "${ALLOWED_CONTEXTS:-<unset>}" >>"${SEED_LOG:?}"
EOF_SEED
seed_log="${tmp}/seed.log"
run_seed_shim() {
  : >"${seed_log}"
  env CLERUM_PROJECT_DIR="${seed_project}" SEED_LOG="${seed_log}" SEED_PROFILE=minimal \
    CONTEXT="$1" bash "${shims_dir}/seed-test-data.sh" >"${out_dir}/seed-$1.log" 2>&1 ||
    fail "seed shim failed for CONTEXT=$1"
}
run_seed_shim "${profile}"
grep -Fqx "CONTEXT=${profile} ALLOWED_CONTEXTS=${profile}" "${seed_log}" ||
  fail "seed shim did not authorize the branch profile itself: $(cat "${seed_log}")"
ok
for foreign_context in clerum clerum-dev; do
  run_seed_shim "${foreign_context}"
  # Witness: the seed ran and recorded this context; the allowlist stayed empty.
  grep -Fqx "CONTEXT=${foreign_context} ALLOWED_CONTEXTS=<unset>" "${seed_log}" ||
    fail "seed shim authorized ${foreign_context}: $(cat "${seed_log}")"
  ok
done

outside="${tmp}/outside"
mkdir -p "${outside}/minikube"
printf 'keep\n' >"${outside}/minikube/keep.txt"
rm -rf "${profile_dir}/scripts"
ln -s "${outside}" "${profile_dir}/scripts"
bp prepare-shims-symlink prepare-shims
assert_rc 1 'prepare-shims with a symlinked scripts directory'
assert_output_has 'BRANCH_PROFILE_SHIM_SYMLINK' 'prepare-shims names the symlink refusal'
assert_file "${outside}/minikube/keep.txt" 'prepare-shims must not delete through a symlinked scripts directory'
rm -f "${profile_dir}/scripts"

(( ASSERTIONS >= 100 )) || fail "expected at least 100 assertions, ran ${ASSERTIONS}"
printf 'PASS: branch-profile lifecycle scenarios (%s assertions)\n' "${ASSERTIONS}"
