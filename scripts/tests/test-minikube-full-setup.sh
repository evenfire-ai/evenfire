#!/usr/bin/env bash
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

FAIL=0
T2_TEST_RESTORE_DETACHED=false
T2_TEST_HEAD=""
T2_TEST_BRANCH=""

cleanup_test_checkout() {
  if [[ "${T2_TEST_RESTORE_DETACHED}" == true ]]; then
    git -C "${REPO_ROOT}" switch --quiet --detach "${T2_TEST_HEAD}" || true
    git -C "${REPO_ROOT}" branch -D "${T2_TEST_BRANCH}" >/dev/null 2>&1 || true
  fi
}

trap cleanup_test_checkout EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

write_test_profile_metadata() {
  local root="$1" profile="clerum-full-setup-fixture"
  local profile_dir="$root/profiles/$profile"
  local branch short_sha
  branch="$(git -C "$REPO_ROOT" branch --show-current)"
  if [[ -z "${branch}" ]]; then
    T2_TEST_HEAD="$(git -C "${REPO_ROOT}" rev-parse --verify HEAD)"
    branch="${GITHUB_HEAD_REF:-detached-ci-test}"
    git -C "${REPO_ROOT}" switch --quiet --create "${branch}" "${T2_TEST_HEAD}"
    T2_TEST_BRANCH="${branch}"
    T2_TEST_RESTORE_DETACHED=true
  fi
  short_sha="$(git -C "$REPO_ROOT" rev-parse --short=8 HEAD)"
  mkdir -p "$profile_dir"
  printf 'PROFILE=%s\nBRANCH=%s\nSHA_SHORT=%s\nDIRTY=false\nREPO_DIR=%s\n' \
    "$profile" "$branch" "$short_sha" "$REPO_ROOT" >"$profile_dir/profile.env"
  test_loopback_url() { printf 'http://%s:%s' 127.0.0.1 "$1"; }
  cat >"$profile_dir/ports.env" <<EOF_PORTS
PORT_BASE=28117
CONTROL_UI_PORT=28117
PROFILE_UI_PORT=28118
MCP_HOST_PORT=28197
REGISTRY_API_PORT=28202
CONTROL_API_PORT=28207
EXTERNAL_REST_API_PORT=28208
MEMBER_REGISTRATION_SERVICE_PORT=28209
RPC_PROXY_PORT=28211
WORKFLOW_APPROVAL_READER_PORT=28215
CONTROL_UI_URL=$(test_loopback_url 28117)
PROFILE_UI_URL=$(test_loopback_url 28118)
PROFILE_UI_BASE_URL=$(test_loopback_url 28118)
CONTROL_API_URL=$(test_loopback_url 28207)
EXTERNAL_REST_API_URL=$(test_loopback_url 28208)
MEMBER_REGISTRATION_SERVICE_URL=$(test_loopback_url 28209)
RPC_PROXY_URL=$(test_loopback_url 28211)
REGISTRY_API_URL=$(test_loopback_url 28202)
WORKFLOW_APPROVAL_READER_URL=$(test_loopback_url 28215)
MCP_HOST_URL=$(test_loopback_url 28197)
EOF_PORTS
  TEST_PROFILE="$profile"
  TEST_PROFILE_ROOT="$root/profiles"
  TEST_PROFILE_ENV="$profile_dir/profile.env"
  TEST_PORTS_ENV="$profile_dir/ports.env"
  TEST_LOCK_ROOT="$root/locks"
}

assert_broken_profile_is_recreated() {
  local tmp log_file
  tmp="$(mktemp -d)"
  log_file="$tmp/ops.log"
  write_test_profile_metadata "$tmp"

  cat > "$tmp/docker" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "context inspect")
    if [[ "$*" == *'TLSMaterial'* ]]; then
      printf 'unix:///private/tmp/evenfire-test-docker.sock\tfalse\t{}\n'
    else
      printf 'unix:///private/tmp/evenfire-test-docker.sock\n'
    fi
    ;;
  "info ") ;;
esac
exit 0
STUB

  cat > "$tmp/python3" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  cat > "$tmp/minikube" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
STATE_DIR="${TEST_STATE_DIR:?}"
printf '%s\n' "$*" >>"$LOG_FILE"

args=("$@")
if [[ "${1:-}" == "-p" ]]; then
  shift 2 || true
fi
cmd="${1:-}"
shift || true

case "$cmd" in
  status)
    if [[ -f "$STATE_DIR/started" ]]; then
      cat <<'EOF'
clerum-test
type: Control Plane
host: Running
kubelet: Running
apiserver: Running
kubeconfig: Configured
EOF
      exit 0
    fi
    cat <<'EOF'
clerum-test
type: Control Plane
host: Running
kubelet: Stopped
apiserver: Stopped
kubeconfig: Configured
EOF
    exit 2
    ;;
  delete)
    touch "$STATE_DIR/deleted"
    exit 0
    ;;
  start)
    touch "$STATE_DIR/started"
    exit 0
    ;;
esac

exit 0
STUB

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${TEST_STATE_DIR:?}"
args="$*"
if [[ "$args" == *"cluster-info"* ]]; then
  if [[ -f "$STATE_DIR/started" ]]; then
    exit 0
  fi
  exit 1
fi
exit 0
STUB

  cat > "$tmp/start.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
STATE_DIR="${TEST_STATE_DIR:?}"
printf 'start-helper %s\n' "$*" >>"$LOG_FILE"
touch "$STATE_DIR/started"
exit 0
STUB

  chmod +x "$tmp/docker" "$tmp/python3" "$tmp/minikube" "$tmp/kubectl" "$tmp/start.sh"
  mkdir -p "$tmp/state"

  if PATH="$tmp:$PATH" \
     TEST_LOG_FILE="$log_file" \
     TEST_STATE_DIR="$tmp/state" \
     MINIKUBE_PROFILE="$TEST_PROFILE" \
     T2_PROFILE_ROOT="$TEST_PROFILE_ROOT" T2_PROFILE_ENV="$TEST_PROFILE_ENV" \
     T2_PORTS_ENV="$TEST_PORTS_ENV" T2_LOCK_ROOT="$TEST_LOCK_ROOT" \
     MINIKUBE_SETUP_EXIT_AFTER_CLUSTER=true \
     MINIKUBE_RECREATE_PROFILE=true \
     CONFIRM_PROFILE="$TEST_PROFILE" \
     MINIKUBE_START_SCRIPT="$tmp/start.sh" \
     bash scripts/minikube/full-setup.sh --skip-build >/dev/null 2>&1; then
    if grep -q "delete -p $TEST_PROFILE" "$log_file" && grep -q 'start-helper' "$log_file"; then
      pass "full-setup recreates broken minikube profiles before start"
    else
      fail "full-setup did not delete and recreate broken profile"
      cat "$log_file"
    fi
  else
    fail "full-setup failed in broken-profile recovery test"
  fi

  rm -rf "$tmp"
}

assert_healthy_profile_skips_recreate() {
  local tmp log_file
  tmp="$(mktemp -d)"
  log_file="$tmp/ops.log"
  write_test_profile_metadata "$tmp"

  cat > "$tmp/docker" <<'STUB'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "context inspect")
    if [[ "$*" == *'TLSMaterial'* ]]; then
      printf 'unix:///private/tmp/evenfire-test-docker.sock\tfalse\t{}\n'
    else
      printf 'unix:///private/tmp/evenfire-test-docker.sock\n'
    fi
    ;;
  "info ") ;;
esac
exit 0
STUB

  cat > "$tmp/python3" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  cat > "$tmp/minikube" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
printf '%s\n' "$*" >>"$LOG_FILE"

if [[ "${1:-}" == "-p" ]]; then
  shift 2 || true
fi
cmd="${1:-}"
shift || true

case "$cmd" in
  status)
    cat <<'EOF'
clerum-test
type: Control Plane
host: Running
kubelet: Running
apiserver: Running
kubeconfig: Configured
EOF
    exit 0
    ;;
  delete|start)
    exit 99
    ;;
esac

exit 0
STUB

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"cluster-info"* ]]; then
  exit 0
fi
exit 0
STUB

  cat > "$tmp/start.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${TEST_LOG_FILE:?}"
printf 'start-helper %s\n' "$*" >>"$LOG_FILE"
exit 0
STUB

  chmod +x "$tmp/docker" "$tmp/python3" "$tmp/minikube" "$tmp/kubectl" "$tmp/start.sh"

  if PATH="$tmp:$PATH" \
     TEST_LOG_FILE="$log_file" \
     MINIKUBE_PROFILE="$TEST_PROFILE" \
     T2_PROFILE_ROOT="$TEST_PROFILE_ROOT" T2_PROFILE_ENV="$TEST_PROFILE_ENV" \
     T2_PORTS_ENV="$TEST_PORTS_ENV" T2_LOCK_ROOT="$TEST_LOCK_ROOT" \
     MINIKUBE_SETUP_EXIT_AFTER_CLUSTER=true \
     MINIKUBE_START_SCRIPT="$tmp/start.sh" \
     bash scripts/minikube/full-setup.sh --skip-build >/dev/null 2>&1; then
    if ! grep -q 'delete -p clerum-test' "$log_file" && grep -q 'start-helper --validate-only' "$log_file"; then
      pass "full-setup leaves healthy minikube profiles alone"
    else
      fail "full-setup unexpectedly recreated healthy profile"
      cat "$log_file"
    fi
  else
    fail "full-setup failed in healthy-profile test"
  fi

  rm -rf "$tmp"
}

assert_branch_profile_deploy_dir_is_used() {
  if grep -Fq 'ACTIVE_MINIKUBE_DEPLOY_DIR="${BRANCH_PROFILE_DEPLOY_DIR:-${PROJECT_DIR}/deploy}"' scripts/minikube/full-setup.sh && \
     grep -Fq 'ACTIVE_MINIKUBE_KUSTOMIZE_DIR="${ACTIVE_MINIKUBE_DEPLOY_DIR}/overlays/minikube"' scripts/minikube/full-setup.sh && \
     grep -Fq 'OVERLAY_DIR="${ACTIVE_MINIKUBE_KUSTOMIZE_DIR}"' scripts/minikube/full-setup.sh; then
    pass "full-setup applies the branch-profile deploy copy when provided"
  else
    fail "full-setup does not honor BRANCH_PROFILE_DEPLOY_DIR for kustomize apply"
  fi
}

assert_member_registration_hmac_is_patched() {
  if grep -Fq 'MEMBER_REGISTRATION_HMAC="$(resolve_member_registration_hmac)"' deploy/scripts/apply-inter-service-tokens.sh && \
     grep -Fq -- '--arg memberRegistrationHmacKey "$MEMBER_REGISTRATION_HMAC_KEY"' deploy/scripts/apply-inter-service-tokens.sh && \
     grep -Fq '($memberRegistrationHmacKey): $memberRegistrationHmac' deploy/scripts/apply-inter-service-tokens.sh && \
     grep -Fq 'CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET is required when no existing control-api Secret value is present' deploy/scripts/apply-inter-service-tokens.sh; then
    pass "inter-service token patch includes fail-closed member-registration HMAC"
  else
    fail "inter-service token patch omits fail-closed member-registration HMAC"
  fi
}

assert_branch_scoped_minikube_context_is_supported() {
  if grep -Fq 'source "${SCRIPT_DIR}/lib/clerum-minikube-context.sh"' deploy/scripts/apply-inter-service-tokens.sh && \
     grep -Fq 'clerum-*|*minikube*' deploy/scripts/lib/clerum-minikube-context.sh && \
     grep -Fq 'CLERUM_PROJECT_DIR:-}/scripts/minikube/deploy-evenfire-member-registration.sh' deploy/scripts/apply-inter-service-tokens.sh; then
    pass "inter-service tokens recognize branch-scoped Clerum minikube profiles"
  else
    fail "inter-service tokens do not recognize branch-scoped Clerum minikube profiles"
  fi
}

assert_gfs_provisioning_follows_migrations_and_core_readiness() {
  local overlay_line ensure_line migration_line reconcile_after_migration control_ready_line core_block reset_block wal_block
  local reset_boundary reset_overlay reset_pg_ready reset_converge
  local wal_detect wal_error
  overlay_line="$(grep -n 'Kustomize overlay applied' scripts/minikube/full-setup.sh | head -1 | cut -d: -f1)"
  ensure_line="$(grep -n 'ensure_control_postgres_ready' scripts/minikube/full-setup.sh | tail -1 | cut -d: -f1)"
  migration_line="$(grep -n 'deploy/scripts/run-control-api-db-migration.sh' scripts/minikube/full-setup.sh | head -1 | cut -d: -f1)"
  reconcile_after_migration="$(grep -n 'reconcile-gfs-deploy-credentials.sh' scripts/minikube/full-setup.sh | tail -1 | cut -d: -f1)"
  # There are two intentional control-api readiness fences: the re-use path
  # waits before the HCC cutover, and the migration path waits afterwards.
  # Assert the post-migration fence here so adding the bounded re-use wait does
  # not make this ordering check select the earlier guard.
  control_ready_line="$(grep -n 'rollout status deployment/control-api.*timeout=180s' scripts/minikube/full-setup.sh | tail -1 | cut -d: -f1)"
  core_block="$(sed -n '/^CORE_DEPLOYS=(/,/^)/p' scripts/minikube/full-setup.sh)"
  reset_block="$(sed -n '/# 6a. Optional DB reset/,/# 6c. Re-apply generated service tokens/p' scripts/minikube/full-setup.sh)"
  wal_block="$(sed -n '/A stale or late corruption signature/,/err "${ns}\/\${name} NOT ready"/p' scripts/minikube/full-setup.sh)"

  reset_boundary="$(grep -n 'reset-control-db-storage.sh' <<<"$reset_block" | head -1 | cut -d: -f1)"
  reset_overlay="$(grep -n 'Kustomize overlay applied' <<<"$reset_block" | head -1 | cut -d: -f1)"
  reset_pg_ready="$(grep -n 'rollout status deployment/control-postgres' <<<"$reset_block" | head -1 | cut -d: -f1)"
  reset_converge="$(grep -n 'converge-control-db-after-reset.sh' <<<"$reset_block" | head -1 | cut -d: -f1)"

  wal_detect="$(grep -n 'postgres_has_invalid_checkpoint' <<<"$wal_block" | head -1 | cut -d: -f1)"
  wal_error="$(grep -n 'automatic destructive recovery is disabled' <<<"$wal_block" | head -1 | cut -d: -f1)"

  if [[ -n "$overlay_line" && -n "$ensure_line" && -n "$migration_line" && -n "$reconcile_after_migration" && -n "$control_ready_line" ]] && \
     [[ "$overlay_line" -lt "$ensure_line" && "$ensure_line" -lt "$migration_line" && "$migration_line" -lt "$control_ready_line" && "$control_ready_line" -lt "$reconcile_after_migration" ]] && \
     ! grep -q 'provision-gfs-db.sh.*\(rotate\|stage\)-' scripts/minikube/full-setup.sh && \
     grep -q 'Fresh bootstrap detected.*GFSC remains fail-closed' scripts/minikube/full-setup.sh && \
     [[ "$reset_boundary" -lt "$reset_overlay" && "$reset_overlay" -lt "$reset_pg_ready" && "$reset_pg_ready" -lt "$reset_converge" ]] && \
     [[ "$wal_detect" -lt "$wal_error" ]] && \
     ! grep -q 'reset-control-db-storage.sh' <<<"$wal_block" && \
     ! grep -q '^recover_control_postgres_wal()' scripts/minikube/full-setup.sh && \
     grep -q 'CONTROL_DB_RESET_PVC_UID is required with --reset-db' scripts/minikube/full-setup.sh && \
     grep -q 'RESET_STORAGE_ARGS.*--expected-pvc-uid' scripts/minikube/full-setup.sh && \
     grep -q 'get configmap control-db-reset-state' <<<"$reset_block" && \
     grep -q 'scale deployment/gfsc-writer --replicas="\$RESET_WRITER_REPLICAS"' <<<"$reset_block" && \
     grep -q 'scale deployment/gfsc-reader --replicas="\$RESET_READER_REPLICAS"' <<<"$reset_block" && \
     grep -q 'scale deployment/host-context-controller --replicas="\$RESET_HCC_REPLICAS"' <<<"$reset_block" && \
     ! grep -q 'delete pvc control-postgres-data' scripts/minikube/full-setup.sh && \
     [[ "$(grep -c 'GFS_RESTORE_ACTIVE_NOLOGIN=true GFS_RECOVER_ABANDONED_STATE=true' scripts/minikube/full-setup.sh)" -ge 2 ]] && \
     [[ "$(grep -c 'scripts/minikube/settle-gfs-reader-rollout.sh' scripts/minikube/full-setup.sh)" -ge 2 ]] && \
     [[ "$(grep -c 'gfs-rollout-shim' scripts/minikube/full-setup.sh)" -ge 2 ]] && \
     [[ "$core_block" != *"gfs-controller"* ]]; then
    pass "full-setup centralizes explicit UID-bound reset and never auto-deletes on WAL logs"
  else
    fail "full-setup GFS/reset ordering can leave partial roles or deadlock on GFS readiness"
  fi
}

assert_full_setup_defaults_to_db_rebuild() {
  if grep -Eq '^RESET_DB=true$' scripts/minikube/full-setup.sh && \
     grep -Fq 'case "${REUSE_DB:-false}" in' scripts/minikube/full-setup.sh && \
     grep -Eq -- '--keep-db\)[[:space:]]+RESET_DB=false' scripts/minikube/full-setup.sh && \
     grep -Fq 'reset-control-db-storage.sh' scripts/minikube/full-setup.sh; then
    pass "full-setup rebuilds the DB by default with a REUSE_DB/--keep-db opt-out"
  else
    fail "full-setup does not default to a clean DB rebuild with a REUSE_DB/--keep-db opt-out"
  fi
}

assert_reuse_db_normalizer_precedes_flag_loop() {
  local normalizer_line flag_loop_line
  normalizer_line="$(grep -Fn 'case "${REUSE_DB:-false}" in' scripts/minikube/full-setup.sh | head -1 | cut -d: -f1)"
  flag_loop_line="$(grep -Fn 'for arg in "$@"; do' scripts/minikube/full-setup.sh | head -1 | cut -d: -f1)"

  if [[ -n "$normalizer_line" && -n "$flag_loop_line" && "$normalizer_line" -lt "$flag_loop_line" ]]; then
    pass "REUSE_DB normalizer runs before the flag-parse loop (flag overrides env)"
  else
    fail "REUSE_DB normalizer does not precede the flag-parse loop — flag>env precedence not enforced"
  fi
}

assert_makefile_passes_reuse_db() {
  if grep -Fq 'REUSE_DB="$(REUSE_DB)"' Makefile; then
    pass "minikube-setup Make target forwards REUSE_DB to full-setup.sh"
  else
    fail "minikube-setup Make target does not forward REUSE_DB to full-setup.sh"
  fi
}

assert_reset_db_flag_backcompat() {
  if grep -Eq -- '--reset-db\)[[:space:]]+RESET_DB=true' scripts/minikube/full-setup.sh; then
    pass "--reset-db flag still forces a DB rebuild (back-compat)"
  else
    fail "--reset-db flag no longer sets RESET_DB=true (back-compat broken)"
  fi
}

assert_skip_build_staleness_find_is_sigpipe_guarded() {
  # full-setup.sh runs `set -euo pipefail`. The --skip-build staleness check
  # pipes `find <source dirs> -newer "$LAST_BUILD_MARKER" | head -1`; when find
  # has matches, head closes the pipe after line 1 and find dies with SIGPIPE
  # (141), which pipefail turns into a fatal `make Error 141`. The pipeline must
  # tolerate that exit status.
  if grep -Fq 'newer "$LAST_BUILD_MARKER" 2>/dev/null | head -1 || true' scripts/minikube/full-setup.sh; then
    pass "skip-build staleness find|head pipeline is SIGPIPE-guarded"
  else
    fail "skip-build staleness find|head is unguarded — SIGPIPE (141) aborts --skip-build"
  fi
}

assert_pipefail_head_guard_prevents_abort() {
  # Deterministic proof the guard is not vacuous: `yes | head -1` always leaves
  # the producer writing when head exits, so under `set -euo pipefail` the bare
  # form aborts (SIGPIPE 141) while the `|| true` form (as applied above) exits 0.
  local bare_rc=0 guarded_rc=0
  bash -c 'set -euo pipefail; v=$(yes | head -1); : "$v"' >/dev/null 2>&1 || bare_rc=$?
  bash -c 'set -euo pipefail; v=$(yes | head -1 || true); : "$v"' >/dev/null 2>&1 || guarded_rc=$?
  if [ "$bare_rc" -ne 0 ] && [ "$guarded_rc" -eq 0 ]; then
    pass "pipefail SIGPIPE guard (|| true) prevents the abort the bare pipeline hits"
  else
    fail "SIGPIPE guard behaved unexpectedly (bare_rc=$bare_rc guarded_rc=$guarded_rc)"
  fi
}

assert_setup_runtime_operations_are_bounded() {
  local setup="scripts/minikube/full-setup.sh"
  if grep -Fq 'run_setup_with_deadline minikube-setup-status' "$setup" && \
     grep -Fq 'run_setup_with_deadline minikube-setup-delete' "$setup" && \
     grep -Fq 'run_setup_with_deadline minikube-setup-start' "$setup" && \
     grep -Fq 'run_setup_with_deadline minikube-setup-validate' "$setup" && \
     grep -Fq 'bash "${SCRIPT_DIR}/docker-cli-env.sh" --check-info' "$setup" && \
     grep -Fq 'if (( status >= 124 )); then' "$setup" && \
     ! grep -Fq 'minikube -p "$PROFILE" status 2>/dev/null || true' "$setup" && \
     ! grep -Eq '(^|[[:space:]])docker info([[:space:]]|$)' "$setup"; then
    pass "full-setup bounds profile lifecycle and isolates its Docker probe"
  else
    fail "full-setup contains an unbounded profile lifecycle or ambient Docker probe"
  fi
}

# full-setup.sh is a 1284-line orchestrator that needs a real cluster to run,
# so these cases read its resolved configuration rather than executing it: they
# source the top of the script with a guard variable set, which stops it before
# the first cluster call. That is the same seam the existing profile cases use,
# applied to variables instead of to minikube invocations.
#
# The stub dir is a safety net, not decoration. Config resolution calls none of
# docker/minikube/kubectl, so if the config-only seam is ever deleted or moved,
# `source full-setup.sh` would otherwise drive a REAL cluster from a unit test.
# The stubs fail loudly instead, which aborts the sourced script at Step 1 and
# leaves the assertion reading an empty value -- a red test, never a green one.
FULL_SETUP_STUB_DIR="$(mktemp -d)"
for _stub in docker minikube kubectl; do
  cat > "$FULL_SETUP_STUB_DIR/$_stub" <<STUB
#!/usr/bin/env bash
echo "STUB: '$_stub' must not be called while resolving full-setup.sh config" >&2
exit 1
STUB
  chmod +x "$FULL_SETUP_STUB_DIR/$_stub"
done
unset _stub
trap 'rm -rf "$FULL_SETUP_STUB_DIR"' EXIT

full_setup_resolves() {
  # full_setup_resolves <var> [env assignments...]
  local var="$1"; shift
  env "$@" PATH="$FULL_SETUP_STUB_DIR:$PATH" MINIKUBE_FULL_SETUP_CONFIG_ONLY=true \
    bash -c 'source "$0" >/dev/null 2>&1; printf "%s" "${'"$var"'}"' \
    "$REPO_ROOT/scripts/minikube/full-setup.sh"
}

# ---------------------------------------------------------------------------
# A PROJECT_DIR whose recorded image manifest the test controls
# ---------------------------------------------------------------------------
#
# full-setup.sh now resolves both the image MODE (on --skip-build) and the ghcr
# TAG from deploy/minikube/.image-manifest.json, and it derives PROJECT_DIR from
# its own location -- so the only way to hand it a chosen manifest is to run a
# COPY of the script from a copied tree.
#
# That copy is not optional even for the cases that want no manifest at all:
# the file is gitignored, so CI never has one and any machine that has run a
# real `make minikube-setup` always does. Running against $REPO_ROOT would make
# "does the banner print the committed pin?" answer differently on a laptop
# than in CI. Every manifest-sensitive case below runs from a copy with the
# manifest either removed or written explicitly.
make_full_setup_copy() {
  # make_full_setup_copy <dir> [manifest-json]
  local d=$1 manifest=${2:-}
  mkdir -p "$d/repo"
  cp -R "$REPO_ROOT/deploy" "$d/repo/deploy"
  cp -R "$REPO_ROOT/scripts" "$d/repo/scripts"
  # `git init`, not decoration. full-setup.sh calls dotenv_canonical_root under
  # `set -e`, and its last statement is `[[ -f .env ]] && printf` -- which
  # returns 1, aborting the caller, when the tree is neither a git repo nor
  # carries a .env. A plain copy is exactly that; a git checkout without a .env
  # (which is what CI runs) takes the branch above it and returns 0. Initialising
  # one here matches CI AND keeps the copy independent of whatever .env the
  # developer's primary checkout happens to hold.
  git init -q "$d/repo"
  rm -f "$d/repo/deploy/minikube/.image-manifest.json"
  if [ -n "$manifest" ]; then
    mkdir -p "$d/repo/deploy/minikube"
    printf '%s' "$manifest" > "$d/repo/deploy/minikube/.image-manifest.json"
  fi
}

# The two fields image-mode.sh reads, in the shape both writers emit.
recorded_manifest() {
  # recorded_manifest <imageSource> <imageTag>
  printf '{\n  "generated": "2026-08-06T00:00:00Z",\n  "profile": "clerum-test",\n  "imageSource": "%s",\n  "imageTag": "%s",\n  "images": {}\n}\n' \
    "$1" "$2"
}

# full_setup_copy_resolves <dir> <var> <flags> [env assignments...]
# <flags> is the (unquoted, test-controlled) flag string handed to the sourced
# script, e.g. --skip-build; pass '' for none.
full_setup_copy_resolves() {
  local d="$1" var="$2" flags="$3"; shift 3
  env "$@" PATH="$FULL_SETUP_STUB_DIR:$PATH" MINIKUBE_FULL_SETUP_CONFIG_ONLY=true \
    bash -c 'source "$0" '"$flags"' >/dev/null 2>&1; printf "%s" "${'"$var"'}"' \
    "$d/repo/scripts/minikube/full-setup.sh"
}

# full_setup_copy_output <dir> <flags> [env assignments...] -- the banner and
# warnings the run prints, which is what an operator actually sees.
full_setup_copy_output() {
  local d="$1" flags="$2"; shift 2
  # $flags is a test-controlled literal, deliberately word-split.
  # shellcheck disable=SC2086
  env "$@" PATH="$FULL_SETUP_STUB_DIR:$PATH" MINIKUBE_FULL_SETUP_CONFIG_ONLY=true \
    bash "$d/repo/scripts/minikube/full-setup.sh" $flags 2>&1
}

assert_ghcr_is_the_default_image_source() {
  local got
  got="$(full_setup_resolves IMAGE_SOURCE)"
  if [ "$got" = "ghcr" ]; then
    pass "IMAGE_SOURCE defaults to ghcr"
  else
    fail "IMAGE_SOURCE defaulted to '${got}', expected 'ghcr'"
  fi
}

assert_image_source_local_is_honoured() {
  local got
  got="$(full_setup_resolves IMAGE_SOURCE IMAGE_SOURCE=local)"
  if [ "$got" = "local" ]; then
    pass "IMAGE_SOURCE=local is honoured"
  else
    fail "IMAGE_SOURCE=local resolved to '${got}'"
  fi
}

assert_bootstrap_seed_deferral_is_opt_in() {
  local got
  got="$(full_setup_resolves DEFER_BOOTSTRAP_SEED)"
  if [ "$got" = "false" ]; then
    pass "bootstrap seed deferral defaults to false"
  else
    fail "bootstrap seed deferral defaulted to '${got}', expected 'false'"
  fi
}

assert_bootstrap_seed_deferral_flag_resolves_for_local_minimal() {
  local d got
  d="$(mktemp -d)"
  make_full_setup_copy "$d"
  got="$(full_setup_copy_resolves "$d" DEFER_BOOTSTRAP_SEED --defer-bootstrap-seed IMAGE_SOURCE=local)"
  if [ "$got" = "true" ]; then
    pass "--defer-bootstrap-seed resolves true for the local minimal browser flow"
  else
    fail "--defer-bootstrap-seed resolved to '${got}', expected 'true'"
  fi
  rm -rf "$d"
}

assert_bootstrap_seed_deferral_rejects_non_local_or_e2e_modes() {
  local d out rc problems=""
  d="$(mktemp -d)"
  make_full_setup_copy "$d"

  out="$(full_setup_copy_output "$d" --defer-bootstrap-seed IMAGE_SOURCE=ghcr 2>&1)" || rc=$?
  rc="${rc:-0}"
  if [ "$rc" -eq 0 ] || ! grep -q "IMAGE_SOURCE=local" <<< "$out"; then
    problems+="ghcr mode was not rejected; "
  fi

  rc=0
  out="$(full_setup_copy_output "$d" "--defer-bootstrap-seed --seed-profile=e2e" IMAGE_SOURCE=local 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ] || ! grep -q "requires --seed-profile=minimal" <<< "$out"; then
    problems+="e2e seed profile was not rejected; "
  fi

  if [ -z "$problems" ]; then
    pass "bootstrap seed deferral rejects GHCR and e2e fixture modes"
  else
    fail "$problems"
  fi
  rm -rf "$d"
}

assert_minimal_seed_is_setup_first_and_link_fail_closed() {
  local seed="$REPO_ROOT/scripts/e2e/seed-e2e-data.sh"
  local dispatch verify_body setup_line login_line verify_line

  # Bound the dispatch and the verifier exactly. A range that ends at the first
  # bare `else` runs past every nested block and swallows most of the file, so
  # presence greps alone still pass when the ordering is reversed or the
  # fail-closed abort is downgraded to a warning.
  dispatch="$(awk '/^# ─── Step 1: Bootstrap before login/,/^fi$/' "$seed")"
  verify_body="$(awk '/^verify_minimal_operator_bootstrap\(\) \{$/,/^\}$/' "$seed")"

  setup_line="$(printf '%s\n' "$dispatch" | grep -n '^  perform_initial_setup$' | head -1 | cut -d: -f1)"
  login_line="$(printf '%s\n' "$dispatch" | grep -n 'login_admin_only' | head -1 | cut -d: -f1)"
  verify_line="$(printf '%s\n' "$dispatch" | grep -n '^  verify_minimal_operator_bootstrap$' | head -1 | cut -d: -f1)"

  if [ -z "$setup_line" ] || [ -z "$login_line" ] || [ -z "$verify_line" ]; then
    fail "minimal seed dispatch must call setup, the login fallback and link verification"
    return
  fi
  # control-api marks last_login_at on every successful admin login, and
  # setupInitialAdminCredentials only matches a bootstrap row whose
  # last_login_at is still NULL. Logging in first destroys setup eligibility
  # permanently, so this ordering is the whole point of the minimal path.
  if [ "$setup_line" -ge "$login_line" ]; then
    fail "minimal seed logs in at line $login_line before consuming setup at line $setup_line; login sets last_login_at and permanently disqualifies /admin/auth/setup"
    return
  fi
  if [ "$verify_line" -le "$login_line" ]; then
    fail "minimal seed must verify the initial_setup link after the login fallback, not before it"
    return
  fi
  if ! printf '%s\n' "$verify_body" | grep -Fq 'if ! clerum_initial_setup_link_matches '; then
    fail "minimal link verification does not gate on the shared initial_setup link contract"
    return
  fi
  # The missing-link branch must abort. Downgrading it to a log leaves the
  # install running as an ordinary unlinked member, which is the exact
  # regression this assertion exists to catch.
  if ! printf '%s\n' "$verify_body" | grep -Eq '^ *die "Minimal bootstrap is incomplete'; then
    fail "minimal link verification does not abort when the initial_setup link is absent"
    return
  fi
  pass "minimal seed consumes setup before login and aborts without an active initial_setup link"
}

assert_minimal_bootstrap_contract_runs_on_system_bash() {
  local contract="$REPO_ROOT/scripts/e2e/minimal-bootstrap-contract.sh"
  local output
  if ! /bin/bash -n "$contract" "$REPO_ROOT/scripts/e2e/seed-e2e-data.sh" "$REPO_ROOT/scripts/minikube/full-setup.sh"; then
    fail "minimal bootstrap scripts are not parseable by the system Bash"
    return
  fi
  # `! cmd` is explicitly exempt from set -e, so a bare `! predicate` line can
  # never fail this suite. refute() runs the predicate inside an `if` and exits
  # non-zero on unexpected success, which set -e does propagate.
  output="$(/bin/bash -c '
    set -e
    source "$1"
    refute() { if "$@"; then printf "unexpected success: %s\n" "$*" >&2; exit 1; fi; }
    [ "$(clerum_canonical_email "Admin@EvenFire.Local")" = "admin@evenfire.local" ]
    [ "$(clerum_minimal_desktop_email "Admin@EvenFire.Local" "" false)" = "admin@evenfire.local" ]
    [ "$(clerum_minimal_desktop_email "Admin@EvenFire.Local" "Desktop@Example.Local" true)" = "desktop@example.local" ]
    clerum_initial_setup_link_matches active initial_setup desktop-id admin-id admin-id
    refute clerum_initial_setup_link_matches revoked initial_setup desktop-id admin-id admin-id
    refute clerum_initial_setup_link_matches active revoked desktop-id admin-id admin-id
    refute clerum_initial_setup_link_matches active initial_setup desktop-id "" admin-id
    refute clerum_initial_setup_link_matches active initial_setup "" admin-id admin-id
    refute clerum_initial_setup_link_matches active initial_setup desktop-id other-admin admin-id
    [ "$(clerum_minimal_setup_outcome 201)" = setup_succeeded ]
    [ "$(clerum_minimal_setup_outcome 409)" = setup_already_consumed ]
    [ "$(clerum_minimal_setup_outcome 401)" = setup_failed ]
    printf ok
  ' bash "$contract")"
  if [ "$output" = "ok" ] && \
     ! grep -Eq '\$\{[A-Za-z_][A-Za-z0-9_]*,,\}' "$REPO_ROOT/scripts/e2e/seed-e2e-data.sh" "$REPO_ROOT/scripts/minikube/full-setup.sh"; then
    pass "minimal bootstrap canonicalization and link contract run on system Bash 3.2"
  else
    fail "minimal bootstrap still contains a Bash-4 lowercase expansion or contract failure"
  fi
}

assert_minimal_seed_rejects_a_divergent_identity() {
  local seed="$REPO_ROOT/scripts/e2e/seed-e2e-data.sh"
  local output rc=0
  output="$(CONTEXT=clerum-test SEED_PROFILE=minimal \
    ADMIN_EMAIL='Admin@EvenFire.Local' E2E_DEV_LOGIN_EMAIL='other@example.invalid' \
    ADMIN_PASSWORD='test-password-only' /bin/bash "$seed" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] && grep -Fq 'requires the Desktop identity email' <<<"$output"; then
    pass "minimal seeder rejects a Desktop identity that differs from the bootstrap admin"
  else
    fail "minimal seeder accepted a divergent Desktop identity (rc=$rc output=$output)"
  fi
}

assert_minimal_setup_requires_admin_identity_email() {
  local contract="$REPO_ROOT/scripts/e2e/minimal-bootstrap-contract.sh"
  local output

  # Exercise the decision both call sites now share, rather than grepping for
  # the source line that expresses it. A grep passes on any refactor that keeps
  # the text and changes the meaning.
  if ! output="$(/bin/bash -c '
    set -e
    source "$1"
    refute() { if "$@"; then printf "unexpected success: %s\n" "$*" >&2; exit 1; fi; }
    clerum_minimal_identity_matches admin@evenfire.local admin@evenfire.local
    refute clerum_minimal_identity_matches admin@evenfire.local other@example.invalid
    refute clerum_minimal_identity_matches admin@evenfire.local ""
    refute clerum_minimal_identity_matches "" admin@evenfire.local
    refute clerum_minimal_identity_matches "" ""
    case "$(clerum_minimal_identity_error other@example.invalid admin@evenfire.local)" in
      *"Desktop identity email (other@example.invalid)"*"bootstrap admin email (admin@evenfire.local)"*) ;;
      *) exit 1 ;;
    esac
    printf ok
  ' bash "$contract")"; then
    fail "minimal identity guard does not accept the admin identity and reject every divergence"
    return
  fi
  if [ "$output" != "ok" ]; then
    fail "minimal identity guard contract did not complete (output=$output)"
    return
  fi
  # Both enforcement points must route through the shared guard, so a fix in
  # one cannot silently leave the other permissive.
  if ! grep -Fq 'clerum_minimal_identity_matches "$ADMIN_EMAIL" "$SEED_USER_EMAIL"' \
      "$REPO_ROOT/scripts/minikube/full-setup.sh" ||
    ! grep -Fq 'clerum_minimal_identity_matches "$ADMIN_EMAIL" "$DEV_EMAIL"' \
      "$REPO_ROOT/scripts/e2e/seed-e2e-data.sh"; then
    fail "a minimal enforcement point does not use the shared identity guard"
    return
  fi
  pass "minimal setup refuses a second unlinked Desktop identity"
}

assert_an_unknown_image_source_is_a_hard_error() {
  local out rc
  out="$(env PATH="$FULL_SETUP_STUB_DIR:$PATH" IMAGE_SOURCE=gchr \
    MINIKUBE_FULL_SETUP_CONFIG_ONLY=true \
    bash "$REPO_ROOT/scripts/minikube/full-setup.sh" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] && grep -qi "IMAGE_SOURCE" <<< "$out"; then
    pass "an unknown IMAGE_SOURCE fails loudly instead of falling back"
  else
    fail "expected a hard error naming IMAGE_SOURCE; got rc=$rc out='$out'"
  fi
}

# Only the RENDER dir moves. The kustomize dir is where the generated
# k8s-api-ip.yaml lands and where the template lives; moving it would break
# minikube-detect-k8s-api-ip.sh and the patchesStrategicMerge reference.
assert_ghcr_mode_moves_only_the_render_dir() {
  local render kustomize
  render="$(full_setup_resolves ACTIVE_MINIKUBE_RENDER_DIR)"
  kustomize="$(full_setup_resolves ACTIVE_MINIKUBE_KUSTOMIZE_DIR)"
  if [[ "$render" == */overlays/minikube-ghcr ]] && [[ "$kustomize" == */overlays/minikube ]]; then
    pass "ghcr mode renders minikube-ghcr while the kustomize dir stays overlays/minikube"
  else
    fail "render='${render}' kustomize='${kustomize}'"
  fi
}

assert_ghcr_mode_with_skip_uis_renders_the_no_uis_ghcr_overlay() {
  local render
  render="$(full_setup_resolves ACTIVE_MINIKUBE_RENDER_DIR MINIKUBE_SKIP_UIS=true)"
  if [[ "$render" == */overlays/minikube-no-uis-ghcr ]]; then
    pass "ghcr + --skip-uis renders minikube-no-uis-ghcr"
  else
    fail "render dir was '${render}'"
  fi
}

assert_local_mode_renders_the_unchanged_overlays() {
  local a b
  a="$(full_setup_resolves ACTIVE_MINIKUBE_RENDER_DIR IMAGE_SOURCE=local)"
  b="$(full_setup_resolves ACTIVE_MINIKUBE_RENDER_DIR IMAGE_SOURCE=local MINIKUBE_SKIP_UIS=true)"
  if [[ "$a" == */overlays/minikube ]] && [[ "$b" == */overlays/minikube-no-uis ]]; then
    pass "local mode renders today's overlays unchanged"
  else
    fail "local render dirs were '${a}' and '${b}'"
  fi
}

# Never `rm -rf "$(dirname "$1")"` unguarded: `dirname ""` is `.`, so an
# assertion that failed to resolve a deploy dir would delete the caller's
# working directory. Only remove a path that is an absolute */deploy outside
# the repo.
remove_override_copy() {
  local deploy_dir="${1:-}"
  case "$deploy_dir" in
    /*/deploy) ;;
    *) return 0 ;;
  esac
  [ "$deploy_dir" = "$REPO_ROOT/deploy" ] && return 0
  rm -rf "$(dirname "$deploy_dir")"
}

# The override must never touch the committed tree. A single in-place `sed` on
# deploy/components/ghcr-images/kustomization.yaml would make the operator lever
# a second writer of the release coordinate.
assert_the_tag_override_copies_the_tree_and_leaves_the_commit_alone() {
  local before after deploy_dir
  before="$(git -C "$REPO_ROOT" status --porcelain deploy/components/ghcr-images | wc -l | tr -d ' ')"
  deploy_dir="$(full_setup_resolves ACTIVE_MINIKUBE_DEPLOY_DIR MINIKUBE_IMAGE_TAG=latest)"
  after="$(git -C "$REPO_ROOT" status --porcelain deploy/components/ghcr-images | wc -l | tr -d ' ')"
  if [ "$before" = "$after" ] && [ -n "$deploy_dir" ] && [[ "$deploy_dir" != "$REPO_ROOT/deploy" ]]; then
    pass "MINIKUBE_IMAGE_TAG renders from a temp copy and leaves the committed component untouched"
  else
    fail "deploy dir was '${deploy_dir}' (repo deploy is $REPO_ROOT/deploy); git status lines before=$before after=$after"
  fi
  remove_override_copy "$deploy_dir"
}

# The whole tree must move: resources: ../minikube and
# deploy/scripts/minikube-detect-k8s-api-ip.sh both resolve relative to the
# deploy root, so copying only the component would break both.
assert_the_tag_override_copy_is_a_whole_deploy_tree_with_the_new_tag() {
  local deploy_dir tag problems=""
  deploy_dir="$(full_setup_resolves ACTIVE_MINIKUBE_DEPLOY_DIR MINIKUBE_IMAGE_TAG=v9.9.9)"
  [ -d "$deploy_dir/overlays/minikube" ] || problems+="no overlays/minikube in the copy; "
  [ -d "$deploy_dir/overlays/minikube-ghcr" ] || problems+="no overlays/minikube-ghcr in the copy; "
  [ -f "$deploy_dir/scripts/minikube-detect-k8s-api-ip.sh" ] || problems+="no deploy/scripts in the copy; "
  # No 2>/dev/null here: if the component is missing from the copy, sed's error
  # belongs in the transcript, not swallowed into an empty-string "mismatch".
  tag="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\).*$/\1/p' \
    "$deploy_dir/components/ghcr-images/kustomization.yaml" | sort -u | tr '\n' ' ')"
  [ "$tag" = "v9.9.9 " ] || problems+="copy's newTag is '${tag}', expected 'v9.9.9 '; "
  if [ -z "$problems" ]; then
    pass "the override copy is a whole deploy tree with every newTag rewritten"
  else
    fail "$problems"
  fi
  remove_override_copy "$deploy_dir"
}

# "Run without --skip-build to rebuild" is wrong advice in ghcr mode: nothing
# was built, and rebuilding is exactly what the default path exists to avoid.
#
# A grep-only check over the OLD wide awk range (from the "Even with
# --skip-build" comment down to the terminating elif/else) is satisfied by
# text that lives entirely in the manifest-ABSENT sibling sub-block
# ("Run without --skip-build, or 'make minikube-pull-images'..."), so it stays
# green even if the manifest-PRESENT ghcr/local arms below are swapped or
# deleted outright (both verified live). The range is narrowed here to just
# the manifest-PRESENT "NEWEST_SRC found" if/else/fi -- anchored on the
# mode-independent `-n "$NEWEST_SRC"` text, with the closing `fi` found by
# depth-counting `; then`/`fi` pairs rather than by line number or
# indentation -- and then the extracted REAL source is `eval`'d with stub
# warn()/log() functions and IMAGE_SOURCE set to each mode in turn. That is
# genuine evaluated behaviour: a swap of the `= ghcr` operand (or a deletion
# of the arms) changes what gets printed for a given mode, not just what text
# is reachable somewhere in the block.
extract_full_setup_staleness_arms_block() {
  local sh="$1"
  awk '
    $0 ~ /-n "\$NEWEST_SRC"/ && !cap { cap = 1; depth = 0 }
    cap {
      print
      line = $0
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line ~ /; *then$/) depth++
      if (line == "fi") { depth--; if (depth == 0) exit }
    }
  ' "$sh"
}

run_full_setup_staleness_block() {
  local mode="$1" block="$2" tmpfile out
  tmpfile="$(mktemp)"
  {
    printf 'warn() { printf "WARN:%%s\\n" "$*"; }\n'
    printf 'log() { printf "LOG:%%s\\n" "$*"; }\n'
    printf '%s\n' "$block"
  } > "$tmpfile"
  out="$(IMAGE_SOURCE="$mode" NEWEST_SRC=fake/newer/file EFFECTIVE_IMAGE_TAG=v1.2.3 bash "$tmpfile" 2>&1)"
  rm -f "$tmpfile"
  printf '%s' "$out"
}

assert_the_skip_build_staleness_advice_is_mode_aware() {
  local sh block ghcr_out local_out problem=""
  sh="$REPO_ROOT/scripts/minikube/full-setup.sh"
  block="$(extract_full_setup_staleness_arms_block "$sh")"
  if [ -z "$block" ]; then
    fail "could not locate the --skip-build staleness NEWEST_SRC arms in $sh"
    return
  fi

  ghcr_out="$(run_full_setup_staleness_block ghcr "$block")"
  local_out="$(run_full_setup_staleness_block local "$block")"

  grep -q 'pre-gate-sync' <<< "$ghcr_out" || problem+="ghcr advice (evaluated) is missing the pre-gate-sync mention; "
  grep -q 'minikube-setup-local' <<< "$ghcr_out" || problem+="ghcr advice (evaluated) is missing the minikube-setup-local mention; "
  grep -qi 'rebuild' <<< "$ghcr_out" && problem+="ghcr advice (evaluated) wrongly says rebuild: $ghcr_out; "

  grep -qi 'rebuild' <<< "$local_out" || problem+="local advice (evaluated) is missing rebuild guidance: $local_out; "
  grep -q 'pre-gate-sync' <<< "$local_out" && problem+="local advice (evaluated) wrongly mentions pre-gate-sync: $local_out; "

  if [ -z "$problem" ]; then
    pass "the --skip-build staleness warning branches on IMAGE_SOURCE (evaluated per mode, not just mentioned)"
  else
    fail "$problem"
  fi
}

# A contributor must be able to tell from the transcript which images the
# cluster is about to run and where the tag came from.
#
# Grepping the source for `print_image_source_banner` and `TAG_ORIGIN` only
# proves those names exist SOMEWHERE in the file -- the function definition
# and the TAG_ORIGIN= assignments satisfy both greps even if the call site
# that actually invokes the banner is deleted (verified live: removing the
# bare `print_image_source_banner` call still leaves both greps green). This
# instead runs the real script through the existing config-only seam (see
# `full_setup_resolves` above) and asserts on the CAPTURED STDOUT the banner
# writes -- observed output, not source text -- so a deleted call site prints
# nothing and the assertion fails.
#
# Runs from a copy with NO recorded manifest (see make_full_setup_copy): the
# tag now falls back to the committed pin only when nothing is recorded, and
# the manifest is gitignored, so against $REPO_ROOT this case would assert the
# pin in CI and the last-pulled tag on a developer machine.
assert_the_banner_prints_the_image_source_tag_and_origin() {
  local d out committed_tag problem=""
  d="$(mktemp -d)"
  make_full_setup_copy "$d"
  out="$(full_setup_copy_output "$d" '')"
  committed_tag="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\).*$/\1/p' \
    "$REPO_ROOT/deploy/components/ghcr-images/kustomization.yaml" | sort -u | head -1)"
  grep -q 'Images: PULLED from ghcr.io/evenfire-ai' <<< "$out" || problem+="banner did not name the image source; "
  [ -n "$committed_tag" ] && grep -q "tag: *${committed_tag}" <<< "$out" || problem+="banner did not print the committed tag '${committed_tag}'; "
  grep -q 'origin: *committed pin in deploy/components/ghcr-images/kustomization.yaml' <<< "$out" || problem+="banner did not name the tag's origin; "
  if [ -z "$problem" ]; then
    pass "the setup prints an image-source banner naming source, tag and origin (observed stdout)"
  else
    fail "$problem got: $out"
  fi
  rm -rf "$d"
}

assert_the_tag_origin_distinguishes_pin_from_override() {
  local d pinned overridden
  d="$(mktemp -d)"
  make_full_setup_copy "$d"
  pinned="$(full_setup_copy_resolves "$d" TAG_ORIGIN '')"
  overridden="$(full_setup_copy_resolves "$d" TAG_ORIGIN '' MINIKUBE_IMAGE_TAG=latest)"
  if grep -qi "pin" <<< "$pinned" && grep -q "MINIKUBE_IMAGE_TAG" <<< "$overridden"; then
    pass "TAG_ORIGIN distinguishes the committed pin from the override"
  else
    fail "TAG_ORIGIN was '${pinned}' (pinned) and '${overridden}' (overridden)"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# THE MODE AND THE TAG FOLLOW THE CLUSTER
# ---------------------------------------------------------------------------

# FIX: --skip-build acquires nothing, so the overlay must follow the images
# already on the node. Taking IMAGE_SOURCE instead rendered the -ghcr overlays
# over a locally built cluster, pointing every Deployment at a ghcr ref nothing
# had pulled. It is not a rare path: `make minikube-setup` ALWAYS passes
# IMAGE_SOURCE=ghcr (the Makefile defaults it), which is exactly the value used
# here.
#
# Semantic mutation coverage: `if false && [ "$SKIP_BUILD" = true ]`, or
# swapping `!=` for `=` in the recorded-vs-requested comparison, or inverting
# image_mode_source's `[ -n "$recorded" ]` -- each one puts the ghcr overlay
# back and this fails.
assert_skip_build_follows_the_recorded_image_source() {
  local d render problems=""
  d="$(mktemp -d)"
  make_full_setup_copy "$d" "$(recorded_manifest local "")"
  render="$(full_setup_copy_resolves "$d" ACTIVE_MINIKUBE_RENDER_DIR --skip-build IMAGE_SOURCE=ghcr)"
  [[ "$render" == */overlays/minikube ]] || problems+="a local-recorded cluster rendered '${render}'; "

  # And the mirror image, so the fix cannot be "always render the local
  # overlay": a ghcr-recorded cluster redeployed from an IMAGE_SOURCE=local
  # shell must render the ghcr overlay.
  rm -rf "$d"; d="$(mktemp -d)"
  make_full_setup_copy "$d" "$(recorded_manifest ghcr latest)"
  render="$(full_setup_copy_resolves "$d" ACTIVE_MINIKUBE_RENDER_DIR --skip-build IMAGE_SOURCE=local)"
  [[ "$render" == */overlays/minikube-ghcr ]] || problems+="a ghcr-recorded cluster rendered '${render}'; "

  if [ -z "$problems" ]; then
    pass "--skip-build renders the overlay the cluster's recorded images need, in both directions"
  else
    fail "$problems"
  fi
  rm -rf "$d"
}

# The operator has to be told, or a redeploy that quietly ignores IMAGE_SOURCE
# is indistinguishable from one that honoured it.
assert_skip_build_says_it_is_following_the_cluster() {
  local d out problems=""
  d="$(mktemp -d)"
  make_full_setup_copy "$d" "$(recorded_manifest local "")"
  out="$(full_setup_copy_output "$d" --skip-build IMAGE_SOURCE=ghcr)"
  grep -q 'acquired as IMAGE_SOURCE=local' <<< "$out" || problems+="no warning naming the recorded mode; "
  grep -q 'BUILT LOCALLY from source' <<< "$out" || problems+="the banner did not follow the recorded mode; "

  # Silence when there is nothing to say: a matching mode must not warn, or the
  # warning becomes noise everyone learns to ignore.
  rm -rf "$d"; d="$(mktemp -d)"
  make_full_setup_copy "$d" "$(recorded_manifest ghcr latest)"
  out="$(full_setup_copy_output "$d" --skip-build IMAGE_SOURCE=ghcr)"
  grep -q 'acquired as IMAGE_SOURCE=' <<< "$out" && problems+="warned even though the modes agree; "

  if [ -z "$problems" ]; then
    pass "--skip-build warns when it overrides IMAGE_SOURCE, and stays quiet when it does not"
  else
    fail "$problems"
  fi
  rm -rf "$d"
}

# The anti-regression for `make minikube-setup-local` over a pulled cluster: a
# run that ACQUIRES images is about to rewrite the record, so the environment
# still decides. Mutation: drop the `[ "$SKIP_BUILD" = true ]` guard and this
# resolves ghcr from the record, making a mode switch impossible.
assert_an_acquiring_run_still_honours_image_source() {
  local d render problems=""
  d="$(mktemp -d)"
  make_full_setup_copy "$d" "$(recorded_manifest ghcr latest)"
  render="$(full_setup_copy_resolves "$d" ACTIVE_MINIKUBE_RENDER_DIR '' IMAGE_SOURCE=local)"
  [[ "$render" == */overlays/minikube ]] || problems+="IMAGE_SOURCE=local over a ghcr record rendered '${render}'; "

  rm -rf "$d"; d="$(mktemp -d)"
  make_full_setup_copy "$d" "$(recorded_manifest local "")"
  render="$(full_setup_copy_resolves "$d" ACTIVE_MINIKUBE_RENDER_DIR '' IMAGE_SOURCE=ghcr)"
  [[ "$render" == */overlays/minikube-ghcr ]] || problems+="IMAGE_SOURCE=ghcr over a local record rendered '${render}'; "

  if [ -z "$problems" ]; then
    pass "a run that acquires images still honours IMAGE_SOURCE, so a cluster can change modes"
  else
    fail "$problems"
  fi
  rm -rf "$d"
}

# The fresh-cluster path: on a FIRST run there is no manifest at all, so the
# env default must still apply -- including under --skip-build. Mutation: make
# image_mode_source ignore its env fallback and both halves break.
assert_a_cluster_with_no_record_keeps_the_env_default() {
  local d ghcr_render local_render problems=""
  d="$(mktemp -d)"
  make_full_setup_copy "$d"
  ghcr_render="$(full_setup_copy_resolves "$d" ACTIVE_MINIKUBE_RENDER_DIR --skip-build)"
  local_render="$(full_setup_copy_resolves "$d" ACTIVE_MINIKUBE_RENDER_DIR --skip-build IMAGE_SOURCE=local)"
  [[ "$ghcr_render" == */overlays/minikube-ghcr ]] || problems+="default rendered '${ghcr_render}'; "
  [[ "$local_render" == */overlays/minikube ]] || problems+="IMAGE_SOURCE=local rendered '${local_render}'; "
  if [ -z "$problems" ]; then
    pass "with nothing recorded, --skip-build still follows the IMAGE_SOURCE default and override"
  else
    fail "$problems"
  fi
  rm -rf "$d"
}

# FIX: EFFECTIVE_IMAGE_TAG came from the committed pin and ignored the tag the
# cluster recorded, so after the documented `MINIKUBE_IMAGE_TAG=latest make
# minikube-setup` bootstrap every LATER run reported and acted on v0.6.0
# against a cluster running :latest.
#
# Mutation coverage: swap the precedence in image_mode_ghcr_tag (pin before
# record), or invert its `[ -n "$recorded" ]`, and this reads the pin.
assert_the_effective_tag_comes_from_the_record_not_the_pin() {
  local d tag origin pin problems=""
  d="$(mktemp -d)"
  make_full_setup_copy "$d" "$(recorded_manifest ghcr recorded-test-tag)"
  tag="$(full_setup_copy_resolves "$d" EFFECTIVE_IMAGE_TAG '')"
  origin="$(full_setup_copy_resolves "$d" TAG_ORIGIN '')"
  pin="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\).*$/\1/p' \
    "$REPO_ROOT/deploy/components/ghcr-images/kustomization.yaml" | sort -u | head -1)"
  [ "$tag" = "recorded-test-tag" ] || problems+="EFFECTIVE_IMAGE_TAG was '${tag}', expected the recorded tag (pin is '${pin}'); "
  grep -q 'deploy/minikube/.image-manifest.json' <<< "$origin" || problems+="TAG_ORIGIN was '${origin}', which does not name the manifest; "
  if [ -z "$problems" ]; then
    pass "EFFECTIVE_IMAGE_TAG is the tag the cluster recorded, and TAG_ORIGIN names the manifest"
  else
    fail "$problems"
  fi
  rm -rf "$d"
}

# The floor and the override, so the precedence is pinned from both ends.
assert_the_effective_tag_precedence_is_override_then_record_then_pin() {
  local d pin from_pin from_override problems=""
  pin="$(sed -n 's/^[[:space:]]*newTag:[[:space:]]*\([^[:space:]]*\).*$/\1/p' \
    "$REPO_ROOT/deploy/components/ghcr-images/kustomization.yaml" | sort -u | head -1)"
  d="$(mktemp -d)"
  make_full_setup_copy "$d"
  from_pin="$(full_setup_copy_resolves "$d" EFFECTIVE_IMAGE_TAG '')"
  [ -n "$pin" ] && [ "$from_pin" = "$pin" ] || problems+="with nothing recorded the tag was '${from_pin}', expected the pin '${pin}'; "

  rm -rf "$d"; d="$(mktemp -d)"
  make_full_setup_copy "$d" "$(recorded_manifest ghcr recorded-test-tag)"
  from_override="$(full_setup_copy_resolves "$d" EFFECTIVE_IMAGE_TAG '' MINIKUBE_IMAGE_TAG=v9.9.9)"
  [ "$from_override" = "v9.9.9" ] || problems+="MINIKUBE_IMAGE_TAG did not beat the record; got '${from_override}'; "

  if [ -z "$problems" ]; then
    pass "the effective tag is MINIKUBE_IMAGE_TAG, else the recorded tag, else the committed pin"
  else
    fail "$problems"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# --skip-uis reaches the PULL path
# ---------------------------------------------------------------------------
#
# The -no-uis-ghcr overlay deletes both UI Deployments, so pulling control-ui
# and profile-ui costs ~470 MiB for images nothing references. The local build
# path has always passed --skip-uis through; the pull path did not.
#
# Step 5's ghcr arm needs a cluster to run, so the REAL arm is extracted and
# eval'd with a stub pull-images.sh that records its argv. That is evaluated
# behaviour, not a grep for the flag's name somewhere in the file: deleting the
# `if [ "$SKIP_UIS" = true ]` guard, or inverting it, changes what the stub is
# called with.
extract_full_setup_pull_invocation() {
  awk '
    /log "Pulling published images/ { cap = 1 }
    cap { print }
    cap && /ok "All published images pulled"/ { exit }
  ' "$1"
}

run_full_setup_pull_invocation() {
  local d=$1 skip_uis=$2 script
  mkdir -p "$d/bin"
  cat > "$d/bin/pull-images.sh" <<'STUB'
#!/usr/bin/env bash
printf 'pull-images.sh %s\n' "$*" >>"${TEST_LOG_FILE:?}"
exit 0
STUB
  chmod +x "$d/bin/pull-images.sh"
  script="$d/pull-arm.sh"
  {
    printf 'set -euo pipefail\n'
    printf 'log() { printf "LOG:%%s\\n" "$*"; }\n'
    printf 'ok() { printf "OK:%%s\\n" "$*"; }\n'
    printf 'SCRIPT_DIR=%q\n' "$d/bin"
    printf 'PROFILE="clerum-test"\n'
    printf 'EFFECTIVE_IMAGE_TAG="v0.0.0-test"\n'
    printf 'SKIP_UIS=%q\n' "$skip_uis"
    extract_full_setup_pull_invocation "$REPO_ROOT/scripts/minikube/full-setup.sh"
  } > "$script"
  TEST_LOG_FILE="$d/ops.log" bash "$script" 2>&1
}

assert_the_pull_path_forwards_skip_uis() {
  local d out rc problems=""
  d="$(mktemp -d)"
  if [ -z "$(extract_full_setup_pull_invocation "$REPO_ROOT/scripts/minikube/full-setup.sh")" ]; then
    fail "could not locate the ghcr pull invocation in full-setup.sh"
    rm -rf "$d"
    return
  fi

  out="$(run_full_setup_pull_invocation "$d" true)"; rc=$?
  [ "$rc" -eq 0 ] || problems+="the extracted pull arm exited ${rc} with SKIP_UIS=true: ${out}; "
  grep -q '^pull-images.sh --skip-uis$' "$d/ops.log" \
    || problems+="SKIP_UIS=true did not forward --skip-uis (log: $(cat "$d/ops.log")); "

  # The complement, so the fix cannot be "always pass --skip-uis". Also proves
  # the empty-array expansion does not abort under `set -u`.
  rm -rf "$d"; d="$(mktemp -d)"
  out="$(run_full_setup_pull_invocation "$d" false)"; rc=$?
  [ "$rc" -eq 0 ] || problems+="the extracted pull arm exited ${rc} with SKIP_UIS=false: ${out}; "
  grep -q '^pull-images.sh $' "$d/ops.log" \
    || problems+="SKIP_UIS=false did not call the puller with no flags (log: $(cat "$d/ops.log")); "

  if [ -z "$problems" ]; then
    pass "the ghcr pull path forwards --skip-uis only when SKIP_UIS is set (evaluated argv)"
  else
    fail "$problems"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# The GENERATED k8s-api-ip.yaml under a tag override
# ---------------------------------------------------------------------------
#
# patches/k8s-api-ip.yaml is generated and gitignored; overlays/minikube commits
# only the .template, and overlays/minikube-ghcr renders `../minikube`, which
# patches with it. With MINIKUBE_IMAGE_TAG set, ACTIVE_MINIKUBE_KUSTOMIZE_DIR is
# the mktemp copy, so Step 6b used to write the patch ONLY there and the working
# tree never got one. The next `make minikube-pre-gate-sync` renders a FRESH
# copy of ${PROJECT_DIR}/deploy (image-mode.sh) for the control-api migration,
# BEFORE `make minikube-deploy-all` regenerates the patch, and kustomize dies on
# `evalsymlink failure on .../patches/k8s-api-ip.yaml`.
#
# These cases run the REAL Step 6b block and the REAL
# deploy/scripts/minikube-detect-k8s-api-ip.sh against a stubbed kubectl, then
# assert on the FILES that appear on disk and on how many times the detector
# ran. Inverting the condition (or wrapping it in `if false && ...`) changes
# both, so neither assertion survives a semantic mutation.
extract_full_setup_k8s_api_ip_block() {
  awk '
    /Refreshing minikube K8s API endpoint CIDRs/ { cap = 1 }
    cap { print }
    cap && /Minikube K8s API CIDRs refreshed/ { exit }
  ' "$1"
}

# A throwaway PROJECT_DIR carrying the real detector and the real patch
# template, plus a kubectl stub that answers the one endpoint read the detector
# makes and logs every call so invocations can be counted.
prepare_k8s_api_ip_repo() {
  local d=$1
  mkdir -p "$d/bin" "$d/project/deploy/scripts" "$d/project/deploy/overlays/minikube/patches"
  cp "$REPO_ROOT/deploy/scripts/minikube-detect-k8s-api-ip.sh" "$d/project/deploy/scripts/"
  cp "$REPO_ROOT/deploy/overlays/minikube/patches/k8s-api-ip.yaml.template" \
    "$d/project/deploy/overlays/minikube/patches/"
  cat > "$d/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"${TEST_LOG_FILE:?}"
case "$*" in
  *"get endpoints kubernetes"*) echo "10.11.12.13"; exit 0 ;;
esac
exit 0
STUB
  chmod +x "$d/bin/kubectl"
}

# The mktemp copy apply_image_tag_override would have produced.
prepare_k8s_api_ip_override_copy() {
  local d=$1
  mkdir -p "$d/override/deploy/overlays/minikube/patches"
  cp "$REPO_ROOT/deploy/overlays/minikube/patches/k8s-api-ip.yaml.template" \
    "$d/override/deploy/overlays/minikube/patches/"
}

run_k8s_api_ip_block() {
  local d=$1 active=$2 script
  script="$d/step6b.sh"
  {
    printf 'set -euo pipefail\n'
    printf 'log() { printf "LOG:%%s\\n" "$*"; }\n'
    printf 'ok() { printf "OK:%%s\\n" "$*"; }\n'
    printf 'PROFILE="clerum-test"\n'
    printf 'PROJECT_DIR=%q\n' "$d/project"
    printf 'ACTIVE_MINIKUBE_KUSTOMIZE_DIR=%q\n' "$active"
    extract_full_setup_k8s_api_ip_block "$REPO_ROOT/scripts/minikube/full-setup.sh"
  } > "$script"
  PATH="$d/bin:$PATH" TEST_LOG_FILE="$d/ops.log" bash "$script" 2>&1
}

assert_the_tag_override_also_generates_the_api_ip_patch_in_the_working_tree() {
  local d out rc calls problems=""
  d="$(mktemp -d)"
  prepare_k8s_api_ip_repo "$d"
  prepare_k8s_api_ip_override_copy "$d"
  out="$(run_k8s_api_ip_block "$d" "$d/override/deploy/overlays/minikube")"
  rc=$?
  calls="$(grep -c 'get endpoints kubernetes' "$d/ops.log")"
  [ "$rc" -eq 0 ] || problems+="step 6b block exited $rc; "
  grep -q '10.11.12.13/32' "$d/override/deploy/overlays/minikube/patches/k8s-api-ip.yaml" \
    || problems+="the render copy did not get the generated patch; "
  # The whole point: the working tree gets one too, so image-mode.sh's copy and
  # the pre-gate migration render both find it.
  grep -q '10.11.12.13/32' "$d/project/deploy/overlays/minikube/patches/k8s-api-ip.yaml" \
    || problems+="the working tree did not get the generated patch; "
  [ "$calls" = "2" ] || problems+="detector ran ${calls} time(s), expected 2; "
  if [ -z "$problems" ]; then
    pass "a tag override generates k8s-api-ip.yaml in the render copy AND in the working tree"
  else
    fail "$problems out=$out"
  fi
  rm -rf "$d"
}

# The complement, so the fix cannot be "always run it twice": with no override
# the active kustomize dir IS the working tree, and one generation is enough.
assert_the_unoverridden_path_generates_the_api_ip_patch_once() {
  local d out rc calls problems=""
  d="$(mktemp -d)"
  prepare_k8s_api_ip_repo "$d"
  out="$(run_k8s_api_ip_block "$d" "$d/project/deploy/overlays/minikube")"
  rc=$?
  calls="$(grep -c 'get endpoints kubernetes' "$d/ops.log")"
  [ "$rc" -eq 0 ] || problems+="step 6b block exited $rc; "
  grep -q '10.11.12.13/32' "$d/project/deploy/overlays/minikube/patches/k8s-api-ip.yaml" \
    || problems+="the working tree did not get the generated patch; "
  [ "$calls" = "1" ] || problems+="detector ran ${calls} time(s), expected 1; "
  if [ -z "$problems" ]; then
    pass "the unoverridden path generates k8s-api-ip.yaml exactly once, in the working tree"
  else
    fail "$problems out=$out"
  fi
  rm -rf "$d"
}

assert_trace_writer_fence_closes_and_proves_zero_replicas() {
  local fence_block
  fence_block="$(sed -n '/^fence_partial_trace_worker()/,/^}/p' scripts/minikube/full-setup.sh)"
  if grep -Fq -- '--replicas=0' <<<"$fence_block" && \
     grep -Fq "jsonpath={.spec.replicas}" <<<"$fence_block" && \
     grep -Fq 'trace-maintenance-worker did not converge to zero desired replicas' <<<"$fence_block" && \
     grep -Fq 'trace-maintenance-worker pods remain after the zero-replica fence' <<<"$fence_block"; then
    pass "trace-maintenance-worker recovery fence scales to zero and proves no writer pod remains"
  else
    fail "trace-maintenance-worker recovery can be marked fenced without proving a zero-replica state"
  fi
}

assert_trace_writer_fence_is_behaviorally_fail_closed() {
  local d fence_block run_script out rc problems=""
  d="$(mktemp -d)"
  fence_block="$(sed -n '/^fence_partial_trace_worker()/,/^}/p' scripts/minikube/full-setup.sh)"

  mkdir -p "$d/bin"
  cat > "$d/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -u
state_dir="${TEST_TRACE_STATE_DIR:?}"
case "$*" in
  *"scale deployment/trace-maintenance-worker --replicas=0"*)
    : >"$state_dir/scaled"
    exit 0
    ;;
  *"get deployment/trace-maintenance-worker"*)
    printf '%s' "${TEST_TRACE_DESIRED:-0}"
    exit 0
    ;;
  *"get pods -l app=trace-maintenance-worker"*)
    if [ -f "$state_dir/waited" ]; then
      exit 0
    fi
    printf '%s' "${TEST_TRACE_PODS:-}"
    exit 0
    ;;
  *"wait --for=delete pod"*)
    : >"$state_dir/waited"
    exit 0
    ;;
esac
exit 0
STUB
  chmod +x "$d/bin/kubectl"

  run_script="$d/run.sh"
  {
    printf 'set -u\n'
    printf 'KC=%q\n' 'kubectl --context=test'
    printf 'PARTIAL_TRACE_REPLICAS=2\n'
    printf 'PARTIAL_TRACE_FENCED=false\n'
    printf 'STATE_DIR=%q\n' "$d"
    printf 'log() { :; }\n'
    printf 'err() { printf "ERR:%%s\\n" "$*" >&2; }\n'
    printf 'writer_recovery_state_phase() { printf "%%s\\n" "$1" >>"$STATE_DIR/phases"; }\n'
    printf '%s\n' "$fence_block"
    printf 'fence_partial_trace_worker\n'
  } >"$run_script"

  out="$(TEST_TRACE_STATE_DIR="$d" TEST_TRACE_DESIRED=0 TEST_TRACE_PODS='pod/trace-0' \
    PATH="$d/bin:$PATH" bash "$run_script" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || problems+="zero-replica convergence exited $rc; "
  [ -f "$d/scaled" ] || problems+="zero-replica convergence never scaled; "
  grep -Fxq 'trace-fenced' "$d/phases" || problems+="successful fence never persisted trace-fenced; "

  rm -f "$d/scaled" "$d/waited" "$d/phases"
  out="$(TEST_TRACE_STATE_DIR="$d" TEST_TRACE_DESIRED=1 TEST_TRACE_PODS= \
    PATH="$d/bin:$PATH" bash "$run_script" 2>&1)"
  rc=$?
  [ "$rc" -ne 0 ] || problems+="nonzero desired replicas were accepted; "
  if [ -f "$d/phases" ] && grep -Fxq 'trace-fenced' "$d/phases"; then
    problems+="trace-fenced was persisted after nonzero convergence; "
  fi
  grep -Fq 'did not converge to zero desired replicas' <<<"$out" \
    || problems+="nonzero convergence did not report the stable failure; "

  if [ -z "$problems" ]; then
    pass "trace-maintenance-worker fence proves convergence and rejects nonzero desired replicas"
  else
    fail "$problems out=$out"
  fi
  rm -rf "$d"
}

assert_recovery_migrations_are_head_bound() {
  local current_head_checks
  current_head_checks="$(grep -Fc '[ "$WRITER_RECOVERY_STATE_HEAD" = "$T2_HEAD" ]' scripts/minikube/full-setup.sh)"
  if grep -Fq 'writer_recovery_state_cli read --include-head' scripts/minikube/full-setup.sh && \
     grep -Fq 'PARTIAL_CONTROL_API_REPLICAS WRITER_RECOVERY_STATE_HEAD' scripts/minikube/full-setup.sh && \
     [ "$current_head_checks" -ge 2 ]; then
    pass "recovery resumes with writers fenced and reruns migrations after a HEAD change"
  else
    fail "recovery can reuse a historical migration boundary after HEAD changes"
  fi
}

# The guard that keeps this file honest: a case defined but never added to the
# call block below reports nothing at all, which reads as a green run.
assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$REPO_ROOT/scripts/tests/test-minikube-full-setup.sh"
  defined="$(grep -oE '^assert_[a-z_0-9]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_0-9]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_broken_profile_is_recreated
assert_healthy_profile_skips_recreate
assert_branch_profile_deploy_dir_is_used
assert_member_registration_hmac_is_patched
assert_branch_scoped_minikube_context_is_supported
assert_gfs_provisioning_follows_migrations_and_core_readiness
assert_full_setup_defaults_to_db_rebuild
assert_makefile_passes_reuse_db
assert_reuse_db_normalizer_precedes_flag_loop
assert_reset_db_flag_backcompat
assert_skip_build_staleness_find_is_sigpipe_guarded
assert_pipefail_head_guard_prevents_abort
assert_setup_runtime_operations_are_bounded
assert_ghcr_is_the_default_image_source
assert_image_source_local_is_honoured
assert_bootstrap_seed_deferral_is_opt_in
assert_bootstrap_seed_deferral_flag_resolves_for_local_minimal
assert_bootstrap_seed_deferral_rejects_non_local_or_e2e_modes
assert_minimal_seed_is_setup_first_and_link_fail_closed
assert_minimal_setup_requires_admin_identity_email
assert_minimal_bootstrap_contract_runs_on_system_bash
assert_minimal_seed_rejects_a_divergent_identity
assert_an_unknown_image_source_is_a_hard_error
assert_ghcr_mode_moves_only_the_render_dir
assert_ghcr_mode_with_skip_uis_renders_the_no_uis_ghcr_overlay
assert_local_mode_renders_the_unchanged_overlays
assert_the_tag_override_copies_the_tree_and_leaves_the_commit_alone
assert_the_tag_override_copy_is_a_whole_deploy_tree_with_the_new_tag
assert_the_skip_build_staleness_advice_is_mode_aware
assert_the_banner_prints_the_image_source_tag_and_origin
assert_the_tag_origin_distinguishes_pin_from_override
assert_the_tag_override_also_generates_the_api_ip_patch_in_the_working_tree
assert_the_unoverridden_path_generates_the_api_ip_patch_once
assert_trace_writer_fence_closes_and_proves_zero_replicas
assert_trace_writer_fence_is_behaviorally_fail_closed
assert_recovery_migrations_are_head_bound
assert_skip_build_follows_the_recorded_image_source
assert_skip_build_says_it_is_following_the_cluster
assert_an_acquiring_run_still_honours_image_source
assert_a_cluster_with_no_record_keeps_the_env_default
assert_the_effective_tag_comes_from_the_record_not_the_pin
assert_the_effective_tag_precedence_is_override_then_record_then_pin
assert_the_pull_path_forwards_skip_uis
assert_every_defined_case_is_invoked

exit $FAIL
