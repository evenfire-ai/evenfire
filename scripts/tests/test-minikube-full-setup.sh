#!/usr/bin/env bash
set -u

FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

assert_broken_profile_is_recreated() {
  local tmp log_file
  tmp="$(mktemp -d)"
  log_file="$tmp/ops.log"

  cat > "$tmp/docker" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "info" ]]; then
  exit 0
fi
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
     MINIKUBE_SETUP_EXIT_AFTER_CLUSTER=true \
     MINIKUBE_RECREATE_PROFILE=true \
     CONFIRM_PROFILE=clerum-test \
     MINIKUBE_START_SCRIPT="$tmp/start.sh" \
     bash scripts/minikube/full-setup.sh --skip-build >/dev/null 2>&1; then
    if grep -q 'delete -p clerum-test' "$log_file" && grep -q 'start-helper' "$log_file"; then
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

  cat > "$tmp/docker" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "info" ]]; then
  exit 0
fi
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
  control_ready_line="$(grep -n 'rollout status deployment/control-api.*timeout=180s' scripts/minikube/full-setup.sh | head -1 | cut -d: -f1)"
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
     ! grep -q 'GFS_RESTORE_ACTIVE_NOLOGIN=true' scripts/minikube/full-setup.sh && \
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

exit $FAIL
