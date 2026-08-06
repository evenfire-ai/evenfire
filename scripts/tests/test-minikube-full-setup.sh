#!/usr/bin/env bash
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

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
# The block is extracted with awk, not `sed -n '/start/,/^else$/p'`: the sed
# range would run past the SKIP_BUILD branch and swallow the
# `elif [ "$IMAGE_SOURCE" = ghcr ]` acquisition arm below it, so a staleness
# warning with no mode-awareness left in it would still match on the elif and
# report PASS. awk stops BEFORE the terminating elif/else.
assert_the_skip_build_staleness_advice_is_mode_aware() {
  local sh block
  sh="$REPO_ROOT/scripts/minikube/full-setup.sh"
  block="$(awk '/Even with --skip-build, warn if local code is newer/{f=1}
                f && /^(elif|else)/{exit}
                f' "$sh")"
  if [ -z "$block" ]; then
    fail "could not locate the --skip-build staleness block in $sh"
    return
  fi
  if grep -q 'IMAGE_SOURCE' <<< "$block" \
     && grep -q 'minikube-pull-images\|IMAGE_SOURCE=local' <<< "$block"; then
    pass "the --skip-build staleness warning branches on IMAGE_SOURCE"
  else
    fail "the --skip-build staleness block still gives build-only advice: $block"
  fi
}

# A contributor must be able to tell from the transcript which images the
# cluster is about to run and where the tag came from.
assert_the_banner_names_the_source_the_tag_and_its_origin() {
  local sh
  sh="$REPO_ROOT/scripts/minikube/full-setup.sh"
  local missing=""
  grep -q 'print_image_source_banner' "$sh" || missing+="no print_image_source_banner function; "
  grep -q 'TAG_ORIGIN' "$sh" || missing+="no TAG_ORIGIN variable; "
  if [ -z "$missing" ]; then
    pass "the setup prints an image-source banner naming source, tag and origin"
  else
    fail "$missing"
  fi
}

assert_the_tag_origin_distinguishes_pin_from_override() {
  local pinned overridden
  pinned="$(full_setup_resolves TAG_ORIGIN)"
  overridden="$(full_setup_resolves TAG_ORIGIN MINIKUBE_IMAGE_TAG=latest)"
  if grep -qi "pin" <<< "$pinned" && grep -q "MINIKUBE_IMAGE_TAG" <<< "$overridden"; then
    pass "TAG_ORIGIN distinguishes the committed pin from the override"
  else
    fail "TAG_ORIGIN was '${pinned}' (pinned) and '${overridden}' (overridden)"
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
assert_ghcr_is_the_default_image_source
assert_image_source_local_is_honoured
assert_an_unknown_image_source_is_a_hard_error
assert_ghcr_mode_moves_only_the_render_dir
assert_ghcr_mode_with_skip_uis_renders_the_no_uis_ghcr_overlay
assert_local_mode_renders_the_unchanged_overlays
assert_the_tag_override_copies_the_tree_and_leaves_the_commit_alone
assert_the_tag_override_copy_is_a_whole_deploy_tree_with_the_new_tag
assert_the_skip_build_staleness_advice_is_mode_aware
assert_the_banner_names_the_source_the_tag_and_its_origin
assert_the_tag_origin_distinguishes_pin_from_override
assert_every_defined_case_is_invoked

exit $FAIL
