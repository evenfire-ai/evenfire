#!/usr/bin/env bash
# Executable negative and transition scenarios for the local T0/T1/T2 contract.
# shellcheck disable=SC2016
set -euo pipefail
set +x
set +u

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
COMMON="$ROOT/scripts/minikube/t2-common.sh"
TMP_ROOT="$TMPDIR"
if [ -z "$TMP_ROOT" ]; then TMP_ROOT=/tmp; fi
set -u

tmp="$(mktemp -d "$TMP_ROOT/evenfire-t2-scenarios.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

expect_code() {
  local expected="$1" label="$2" output="$tmp/$3"
  shift 3
  if "$@" >"$output" 2>&1; then
    fail "$label unexpectedly passed"
  fi
  grep -Fq "$expected" "$output" || {
    printf '%s\n' "$(sed -n '1,20p' "$output")" >&2
    fail "$label did not report $expected"
  }
}

repo="$tmp/evenfire"
mkdir -p "$repo"
repo="$(cd "$repo" && pwd -P)"
git init -q -b dev "$repo"
git -C "$repo" config user.email test@example.invalid
git -C "$repo" config user.name scenario-test
git -C "$repo" remote add origin https://github.com/evenfire-ai/evenfire.git
printf 'base\n' >"$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -q -m base
base_sha="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" update-ref refs/remotes/origin/dev "$base_sha"
git -C "$repo" switch -q -c feat/scenario
mkdir -p "$repo/control-api"
printf 'service\n' >"$repo/control-api/source.ts"
git -C "$repo" add control-api/source.ts
git -C "$repo" commit -q -m service
feature_sha="$(git -C "$repo" rev-parse HEAD)"
profile="clerum-feat-scenario-$(git -C "$repo" rev-parse --short=8 HEAD)"
profile_root="$tmp/profiles/$profile"
mkdir -p "$profile_root"
printf 'PROFILE=%s\nBRANCH=feat/scenario\nSHA_SHORT=%s\nDIRTY=false\nREPO_DIR=%s\n' \
  "$profile" "$(git -C "$repo" rev-parse --short=8 HEAD)" "$repo" >"$profile_root/profile.env"
printf 'PORT_BASE=23117\nCONTROL_API_URL=profile-owned-url\n' >"$profile_root/ports.env"

repo_env=(
  T2_PROJECT_DIR="$repo"
  MINIKUBE_PROFILE="$profile"
  T2_CONTEXT="$profile"
  CONTROL_API_REAL_PG_CONTEXT="$profile"
  T2_PROFILE_ROOT="$tmp/profiles"
  T2_PROFILE_ENV="$profile_root/profile.env"
  T2_PORTS_ENV="$profile_root/ports.env"
  T2_BRANCH=feat/scenario
  T2_HEAD="$feature_sha"
  T2_LOCK_ROOT="$tmp/locks"
  T2_EVIDENCE_ROOT="$tmp/evidence"
)

expect_code DEVELOPMENT_SCOPE_REQUIRED wrong-repository wrong-repository \
  env "${repo_env[@]}" bash -c 'git -C "$T2_PROJECT_DIR" remote set-url origin https://example.invalid/other-repository.git; source "$1"; t2_repo_metadata' bash "$COMMON"
git -C "$repo" remote set-url origin https://github.com/evenfire-ai/evenfire.git

git -C "$repo" branch main "$base_sha"
expect_code DEVELOPMENT_SCOPE_REQUIRED protected-branch protected-branch \
  env "${repo_env[@]}" bash -c 'git -C "$T2_PROJECT_DIR" switch -q main; source "$1"; t2_repo_metadata' bash "$COMMON"
git -C "$repo" switch -q feat/scenario

missing_profile_env=("${repo_env[@]}" T2_PROFILE_ENV="$tmp/missing-profile.env")
expect_code DEVELOPMENT_SCOPE_REQUIRED missing-profile missing-profile \
  env "${missing_profile_env[@]}" bash -c 'source "$1"; t2_profile_scope' bash "$COMMON"

expect_code DEVELOPMENT_SCOPE_REQUIRED shared-profile shared-profile \
  env "${repo_env[@]}" MINIKUBE_PROFILE=default CONTROL_API_REAL_PG_CONTEXT=default \
  bash -c 'source "$1"; t2_profile_scope' bash "$COMMON"

expect_code DEVELOPMENT_SCOPE_REQUIRED context-mismatch context-mismatch \
  env "${repo_env[@]}" T2_CONTEXT=another-context CONTROL_API_REAL_PG_CONTEXT=another-context \
  bash -c 'source "$1"; t2_profile_scope' bash "$COMMON"

fake_bin="$tmp/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"config get-contexts -o name"*)
    for arg in "$@"; do
      case "$arg" in
        --context=*) printf '%s' "${arg#--context=}"; exit 0 ;;
      esac
    done
    printf '%s' "${FAKE_CONTEXT:-}" ;;
  *"config view"*) printf '%s://%s:6443' https "${FAKE_ENDPOINT:-10.0.0.1}" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$fake_bin/kubectl"
context_env=("${repo_env[@]}" FAKE_CONTEXT="$profile")
expect_code DEVELOPMENT_SCOPE_REQUIRED remote-context remote-context \
  env "${repo_env[@]}" FAKE_CONTEXT=other-context PATH="$fake_bin:$PATH" \
  bash -c 'source "$1"; t2_context_check' bash "$COMMON"
env "${context_env[@]}" PATH="$fake_bin:$PATH" FAKE_ENDPOINT=127.0.0.1 \
  bash -c 'source "$1"; t2_context_check' bash "$COMMON"
env "${context_env[@]}" PATH="$fake_bin:$PATH" FAKE_ENDPOINT='[::1]' \
  bash -c 'source "$1"; t2_context_check' bash "$COMMON"
env "${context_env[@]}" PATH="$fake_bin:$PATH" FAKE_ENDPOINT=localhost \
  bash -c 'source "$1"; t2_context_check' bash "$COMMON"

missing_profile_state="$(env "${repo_env[@]}" bash -c 'source "$1"; t2_mk(){ printf "%s" "Profile not found"; }; t2_profile_status; printf "%s" "$T2_PLAN_STATE"' bash "$COMMON")"
[ "$missing_profile_state" = full-bootstrap ] || fail "missing profile selected $missing_profile_state instead of full-bootstrap"

ownership_env=("${repo_env[@]}" T2_PROFILE_ENV="$tmp/ownership.env")
printf 'PROFILE=%s\nBRANCH=feat/scenario\nSHA_SHORT=%s\nDIRTY=false\nREPO_DIR=%s\n' \
  "$profile" "$(git -C "$repo" rev-parse --short=8 HEAD)" "$tmp/other" >"$tmp/ownership.env"
expect_code PROFILE_OWNERSHIP_MISMATCH profile-ownership profile-ownership \
  env "${ownership_env[@]}" bash -c 'source "$1"; t2_profile_scope' bash "$COMMON"

stale_profile_env="$tmp/stale-profile.env"
printf 'PROFILE=%s\nBRANCH=feat/scenario\nSHA_SHORT=oldsha1\nDIRTY=false\nREPO_DIR=%s\n' \
  "$profile" "$repo" >"$stale_profile_env"
env "${repo_env[@]}" T2_PROFILE_ENV="$stale_profile_env" \
  bash -c 'source "$1"; t2_repo_metadata; t2_profile_scope' bash "$COMMON"

marker_env=("${repo_env[@]}" T2_HEAD="$feature_sha" T2_WORKTREE_ID=worktree-a)
expect_code HEAD_MARKER_MISMATCH stale-marker stale-marker \
  env "${marker_env[@]}" FAKE_MARKER='{"data":{"clusterFingerprint":"fp","gitHead":"old","worktreeId":"worktree-a","imageSource":"local","imageTag":"test"}}' \
  bash -c 'source "$1"; T2_WORKTREE_ID=worktree-a; T2_HEAD=feature; t2_kc(){ printf "%s" "$FAKE_MARKER"; }; t2_marker_check' bash "$COMMON"

expect_code PROFILE_OWNERSHIP_MISMATCH marker-ownership marker-ownership \
  env "${marker_env[@]}" FAKE_MARKER='{"data":{"clusterFingerprint":"fp","gitHead":"feature","worktreeId":"worktree-b","imageSource":"local","imageTag":"test"}}' \
  bash -c 'source "$1"; T2_WORKTREE_ID=worktree-a; T2_HEAD=feature; t2_kc(){ printf "%s" "$FAKE_MARKER"; }; t2_marker_check' bash "$COMMON"

manifest="$tmp/image-manifest.json"
printf '{"imageSource":"local","imageTag":"new"}\n' >"$manifest"
expect_code IMAGE_MANIFEST_MISMATCH stale-image stale-image \
  env "${repo_env[@]}" T2_IMAGE_MANIFEST="$manifest" T2_IMAGE_SOURCE=local T2_IMAGE_TAG=old \
  bash -c 'source "$1"; T2_IMAGE_SOURCE=local; T2_IMAGE_TAG=old; t2_image_check' bash "$COMMON"

invalid_manifest="$tmp/invalid-image-manifest.json"
printf '{"imageSource":"ghcr","imageTag":""}\n' >"$invalid_manifest"
bootstrap_manifest_state="$(env "${repo_env[@]}" T2_IMAGE_MANIFEST="$invalid_manifest" T2_BOOTSTRAP_REQUIRED=true \
  bash -c 'source "$1"; T2_BOOTSTRAP_REQUIRED=true; t2_image_check; printf "%s" "$T2_PLAN_STATE"' bash "$COMMON")"
[ "$bootstrap_manifest_state" = full-bootstrap ] || fail "invalid bootstrap manifest selected $bootstrap_manifest_state instead of full-bootstrap"

local_manifest="$tmp/local-image-manifest.json"
printf '{"imageSource":"local","imageTag":"","images":{"clerum/control-api:test":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}\n' >"$local_manifest"
env "${repo_env[@]}" T2_IMAGE_MANIFEST="$local_manifest" T2_IMAGE_SOURCE=local T2_IMAGE_TAG= \
  bash -c 'source "$1"; T2_IMAGE_SOURCE=local; T2_IMAGE_TAG=""; t2_image_check' bash "$COMMON"

empty_local_manifest="$tmp/empty-local-image-manifest.json"
printf '{"imageSource":"local","imageTag":"","images":{}}\n' >"$empty_local_manifest"
expect_code IMAGE_MANIFEST_MISMATCH empty-local empty-local \
  env "${repo_env[@]}" T2_IMAGE_MANIFEST="$empty_local_manifest" T2_IMAGE_SOURCE=local T2_IMAGE_TAG= \
  bash -c 'source "$1"; T2_IMAGE_SOURCE=local; T2_IMAGE_TAG=""; t2_image_check' bash "$COMMON"

not_built_local_manifest="$tmp/not-built-local-image-manifest.json"
printf '{"imageSource":"local","imageTag":"","images":{"clerum/control-api:test":"NOT_BUILT"}}\n' >"$not_built_local_manifest"
expect_code IMAGE_MANIFEST_MISMATCH not-built-local not-built-local \
  env "${repo_env[@]}" T2_IMAGE_MANIFEST="$not_built_local_manifest" T2_IMAGE_SOURCE=local T2_IMAGE_TAG= \
  bash -c 'source "$1"; T2_IMAGE_SOURCE=local; T2_IMAGE_TAG=""; t2_image_check' bash "$COMMON"

# The multi-node writer records minikube_image_id output, which is NOT_FOUND
# when an image is absent from the node. Single-node records docker inspect's
# NOT_BUILT. Both sentinels must be rejected, so cover the multi-node one too.
not_found_local_manifest="$tmp/not-found-local-image-manifest.json"
printf '{"imageSource":"local","imageTag":"","images":{"clerum/control-api:test":"NOT_FOUND"}}
' >"$not_found_local_manifest"
expect_code IMAGE_MANIFEST_MISMATCH not-found-local not-found-local \
  env "${repo_env[@]}" T2_IMAGE_MANIFEST="$not_found_local_manifest" T2_IMAGE_SOURCE=local T2_IMAGE_TAG= \
  bash -c 'source "$1"; T2_IMAGE_SOURCE=local; T2_IMAGE_TAG=""; t2_image_check' bash "$COMMON"

short_local_manifest="$tmp/short-local-image-manifest.json"
printf '{"imageSource":"local","imageTag":"","images":{"clerum/control-api:test":"sha256:0123456789abcdef0123456789abcdef"}}\n' >"$short_local_manifest"
expect_code IMAGE_MANIFEST_MISMATCH short-local short-local \
  env "${repo_env[@]}" T2_IMAGE_MANIFEST="$short_local_manifest" T2_IMAGE_SOURCE=local T2_IMAGE_TAG= \
  bash -c 'source "$1"; T2_IMAGE_SOURCE=local; T2_IMAGE_TAG=""; t2_image_check' bash "$COMMON"

ghcr_manifest="$tmp/ghcr-image-manifest.json"
printf '{"imageSource":"ghcr","imageTag":""}\n' >"$ghcr_manifest"
expect_code IMAGE_MANIFEST_MISMATCH tagless-ghcr tagless-ghcr \
  env "${repo_env[@]}" T2_IMAGE_MANIFEST="$ghcr_manifest" T2_IMAGE_SOURCE=ghcr T2_IMAGE_TAG= \
  bash -c 'source "$1"; T2_IMAGE_SOURCE=ghcr; T2_IMAGE_TAG=""; t2_image_check' bash "$COMMON"

expect_code SECRET_MISSING missing-secret missing-secret \
  env "${repo_env[@]}" T2_BOOTSTRAP_REQUIRED=false T2_REQUIRED_NAMESPACES=control-plane \
  T2_REQUIRED_SERVICES=control-plane/control-api T2_REQUIRED_SECRETS=control-plane/absent \
  T2_REQUIRED_CONFIGMAPS=control-plane/control-api-config \
  bash -c 'source "$1"; t2_kc(){ case "$*" in *"get secret"*) return 1;; *) return 0;; esac; }; t2_resource_checks' bash "$COMMON"

expect_code CONFIGMAP_MISSING missing-configmap missing-configmap \
  env "${repo_env[@]}" T2_BOOTSTRAP_REQUIRED=false T2_REQUIRED_NAMESPACES=control-plane \
  T2_REQUIRED_SERVICES=control-plane/control-api T2_REQUIRED_SECRETS=control-plane/present \
  T2_REQUIRED_CONFIGMAPS=control-plane/absent \
  bash -c 'source "$1"; t2_kc(){ case "$*" in *"get configmap"*) return 1;; *) return 0;; esac; }; t2_resource_checks' bash "$COMMON"

expect_code POSTGRES_NOT_READY postgres-not-ready postgres-not-ready \
  env "${repo_env[@]}" T2_BOOTSTRAP_REQUIRED=false T2_REQUIRED_PVC=control-plane/data \
  bash -c 'source "$1"; t2_kc(){ case "$*" in *"get pvc"*) printf %s "{\"status\":{\"phase\":\"Pending\"}}";; *) return 0;; esac; }; t2_postgres_check' bash "$COMMON"

targeted_state="$(env "${repo_env[@]}" T2_PROJECT_DIR="$repo" T2_BOOTSTRAP_REQUIRED=false \
  T2_ORIGIN_DEV="$base_sha" T2_HEAD="$feature_sha" \
  bash -c 'source "$1"; T2_ORIGIN_DEV="$2"; T2_HEAD="$3"; T2_BOOTSTRAP_REQUIRED=false; t2_classify_transition; printf "%s" "$T2_PLAN_STATE"' bash "$COMMON" "$base_sha" "$feature_sha")"
[ "$targeted_state" = targeted-sync ] || fail "service change selected $targeted_state instead of targeted-sync"

printf 'agents\n' >"$repo/AGENTS.md"
mkdir -p "$repo/scripts/e2e"
printf 'harness\n' >"$repo/scripts/e2e/gate.sh"
git -C "$repo" add AGENTS.md scripts/e2e/gate.sh
git -C "$repo" commit -q -m harness-docs
docs_sha="$(git -C "$repo" rev-parse HEAD)"
docs_state="$(env "${repo_env[@]}" T2_PROJECT_DIR="$repo" T2_BOOTSTRAP_REQUIRED=false \
  T2_ORIGIN_DEV="$base_sha" T2_HEAD="$docs_sha" \
  bash -c 'source "$1"; T2_ORIGIN_DEV="$2"; T2_HEAD="$3"; T2_BOOTSTRAP_REQUIRED=false; t2_classify_transition; printf "%s" "$T2_PLAN_STATE"' bash "$COMMON" "$base_sha" "$docs_sha")"
[ "$docs_state" = targeted-sync ] || fail "harness/docs change selected $docs_state instead of targeted-sync"

mkdir -p "$repo/deploy"
printf 'infrastructure\n' >"$repo/deploy/change.txt"
git -C "$repo" add deploy/change.txt
git -C "$repo" commit -q -m infrastructure
infra_sha="$(git -C "$repo" rev-parse HEAD)"
full_state="$(env "${repo_env[@]}" T2_PROJECT_DIR="$repo" T2_BOOTSTRAP_REQUIRED=false \
  T2_ORIGIN_DEV="$base_sha" T2_HEAD="$infra_sha" \
  bash -c 'source "$1"; T2_ORIGIN_DEV="$2"; T2_HEAD="$3"; T2_BOOTSTRAP_REQUIRED=false; t2_classify_transition; printf "%s" "$T2_PLAN_STATE"' bash "$COMMON" "$base_sha" "$infra_sha")"
[ "$full_state" = full-reconcile ] || fail "infrastructure change selected $full_state instead of full-reconcile"

already_state="$(env "${repo_env[@]}" T2_PROJECT_DIR="$repo" T2_BOOTSTRAP_REQUIRED=false \
  T2_ORIGIN_DEV="$base_sha" T2_HEAD="$infra_sha" \
  bash -c 'source "$1"; T2_ORIGIN_DEV="$2"; T2_HEAD="$3"; T2_BOOTSTRAP_REQUIRED=false; T2_MARKER_MATCHES_HEAD=true; t2_classify_transition; printf "%s" "$T2_PLAN_STATE"' bash "$COMMON" "$base_sha" "$infra_sha")"
[ "$already_state" = already-synced ] || fail "matching marker selected $already_state instead of already-synced"

# A bootstrapped profile with an unready required deployment must not stop
# the orchestrator planner before a transition exists (PROFILE_UNHEALTHY was
# the multi-script loop): planner mode selects full-reconcile and names the
# deployment, even when the marker already matches HEAD.
unready_json='{"items":[{"metadata":{"namespace":"gfs","name":"gfsc-reader"},"spec":{"replicas":1},"status":{"readyReplicas":0,"availableReplicas":0}}]}'
planner_unready="$(env "${repo_env[@]}" UNREADY_JSON="$unready_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=true; T2_BOOTSTRAP_REQUIRED=false; T2_MARKER_MATCHES_HEAD=true; t2_kc(){ printf "%s" "$UNREADY_JSON"; }; t2_deployment_check; t2_classify_transition; printf "%s|%s" "$T2_PLAN_STATE" "$T2_PLAN_REASON"' bash "$COMMON")"
[ "${planner_unready%%|*}" = full-reconcile ] || fail "planner mode selected ${planner_unready%%|*} instead of full-reconcile for an unready deployment"
case "$planner_unready" in
  *gfs/gfsc-reader*) ;;
  *) fail 'planner full-reconcile reason does not name the unready deployment' ;;
esac

# Negative pin: the standalone preflight and the final exact-head check
# (T2_PLAN_MODE=false) stay fail-loud on an unready deployment.
expect_code PROFILE_UNHEALTHY unready-final-preflight unready-final-preflight \
  env "${repo_env[@]}" UNREADY_JSON="$unready_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$UNREADY_JSON"; }; t2_deployment_check' bash "$COMMON"

# A kubectl command can return a non-JSON diagnostic (for example during a
# transient API/proxy failure) or JSON with an invalid replica field. The
# parser failure must be adjudicated as the stable profile failure, not leak a
# Python traceback and exit before t2_fail can emit next:.
expect_code PROFILE_UNHEALTHY invalid-deployment-inventory invalid-deployment-inventory \
  env "${repo_env[@]}" INVALID_INVENTORY='{not-json' \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$INVALID_INVENTORY"; }; t2_deployment_check' bash "$COMMON"
expect_code PROFILE_UNHEALTHY malformed-deployment-inventory malformed-deployment-inventory \
  env "${repo_env[@]}" INVALID_INVENTORY='{"items":[{"spec":{"replicas":"not-an-integer"}}]}' \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$INVALID_INVENTORY"; }; t2_deployment_check' bash "$COMMON"

plan_mode_head="$(env "${marker_env[@]}" T2_PLAN_MODE=true FAKE_MARKER='{"data":{"clusterFingerprint":"fp","gitHead":"old","worktreeId":"worktree-a","imageSource":"local","imageTag":"test"}}' \
  bash -c 'source "$1"; T2_WORKTREE_ID=worktree-a; T2_HEAD=feature; T2_PLAN_MODE=true; t2_kc(){ printf "%s" "$FAKE_MARKER"; }; t2_marker_check; printf "%s" "$T2_MARKER_MATCHES_HEAD"' bash "$COMMON")"
[ "$plan_mode_head" = false ] || fail "planner mode still treated a stale marker as matching HEAD"

evidence="$tmp/evidence.json"
detail_value="$(printf '%s://%s:%s@%s' postgresql user marker local-db)"
env "${repo_env[@]}" T2_EVIDENCE_FILE="$evidence" T2_EVIDENCE_DIR="$tmp/evidence-dir" \
  T2_BRANCH=feat/scenario T2_HEAD="$infra_sha" T2_ORIGIN_DEV="$base_sha" T2_MERGE_BASE="$base_sha" \
  T2_CLUSTER_FINGERPRINT=fp T2_IMAGE_MANIFEST=manifest T2_IMAGE_SOURCE=local T2_IMAGE_TAG=test \
  DETAIL_VALUE="$detail_value" bash -c 'source "$1"; T2_EVIDENCE_FILE="$2"; T2_EVIDENCE_DIR="$3"; T2_BRANCH=feat/scenario; T2_HEAD="$4"; T2_ORIGIN_DEV="$5"; T2_MERGE_BASE="$5"; T2_CLUSTER_FINGERPRINT=fp; T2_IMAGE_MANIFEST=manifest; T2_IMAGE_SOURCE=local; T2_IMAGE_TAG=test; t2_evidence_write T1 PASS "$6"' bash "$COMMON" "$evidence" "$tmp/evidence-dir" "$infra_sha" "$base_sha" "$detail_value"
grep -Fq '<postgres-dsn-redacted>' "$evidence" || fail 'evidence did not redact a DSN-shaped detail'
grep -Fq 'marker@local-db' "$evidence" && fail 'evidence retained the DSN payload'

grep -Fq 'CONTROL_API_REAL_PG_REQUIRED=1' "$ROOT/scripts/e2e/minikube-real-postgres.sh"
grep -Fq 'ZERO_TESTS_EXECUTED' "$ROOT/scripts/e2e/minikube-real-postgres.sh"
grep -Fq 'start_isolated_postgres' "$ROOT/scripts/e2e/minikube-real-postgres.sh"
grep -Fq 'ISOLATED_DSN' "$ROOT/scripts/e2e/minikube-real-postgres.sh"
grep -Fq '|| suite_status=$?' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 must capture vitest exit before adjudicating the reporter'
grep -Fq 'complete green JSON reporter' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 must require a complete green reporter'
grep -Fq 'Vitest process exited $suite_status' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 must fail on a non-zero Vitest exit'
grep -Fq 'restore_gfs_runtime_credentials' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 must restore branch-profile GFS credentials on exit'
grep -Fq 'GFS_RESTORE_ACTIVE_NOLOGIN=true' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 GFS restore must opt into the NOLOGIN recovery contract'
grep -Fq 'GFS_RECOVER_ABANDONED_STATE=true' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 GFS restore must resume an interrupted gfsc-reader rollout claim'
grep -Fq 'settle-gfs-reader-rollout.sh' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 GFS restore must settle a Ready gfsc-reader leftover rollout claim first'
grep -Fq 'gfs-rollout-shim' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 GFS restore must use the HCC-safe reader rollout wait'
grep -Eq 't2_kc[^|]*port-forward' "$ROOT/scripts/e2e/minikube-real-postgres.sh" && fail 'T1 must background the port-forward as a direct kubectl child, not through the t2_kc function'
grep -Fq 'kubectl --context="$T2_CONTEXT" -n "$PG_NAMESPACE" port-forward' "$ROOT/scripts/e2e/minikube-real-postgres.sh" || fail 'T1 must launch the control-postgres port-forward with an explicit kubectl context'
grep -Fq 'GFS_RESTORE_ACTIVE_NOLOGIN=true' "$ROOT/scripts/minikube/pre-gate-sync.sh" || fail 'pre-gate-sync must restore a NOLOGIN GFS role from the committed Secret DSN'
grep -Fq 'GFS_RECOVER_ABANDONED_STATE=true' "$ROOT/scripts/minikube/pre-gate-sync.sh" || fail 'pre-gate-sync must resume an interrupted gfsc-reader rollout claim'
grep -Fq 'settle-gfs-reader-rollout.sh' "$ROOT/scripts/minikube/pre-gate-sync.sh" || fail 'pre-gate-sync must settle a Ready gfsc-reader leftover rollout claim before reconcile'
grep -Fq 'gfs-rollout-shim' "$ROOT/scripts/minikube/pre-gate-sync.sh" || fail 'pre-gate-sync reconcile must use the HCC-safe reader rollout wait'
grep -Fq 'wait-gfs-reader-ready.sh' "$ROOT/scripts/minikube/pre-gate-sync.sh" || fail 'pre-gate-sync reader convergence must judge readiness, not the template generation HCC rewrites'
[[ "$(grep -c 'GFS_RESTORE_ACTIVE_NOLOGIN=true GFS_RECOVER_ABANDONED_STATE=true' "$ROOT/scripts/minikube/full-setup.sh")" -ge 2 ]] || fail 'full-setup REUSE_DB must restore a NOLOGIN GFS role and resume an abandoned reader rollout on both reconcile calls'
[[ "$(grep -c 'scripts/minikube/settle-gfs-reader-rollout.sh' "$ROOT/scripts/minikube/full-setup.sh")" -ge 2 ]] || fail 'full-setup REUSE_DB must settle a Ready gfsc-reader leftover rollout claim before both reconciles'
[[ "$(grep -c 'gfs-rollout-shim' "$ROOT/scripts/minikube/full-setup.sh")" -ge 2 ]] || fail 'full-setup REUSE_DB reconciles must use the HCC-safe reader rollout wait on both calls'
[[ "$(grep -c 'sync-auth-key.sh' "$ROOT/scripts/minikube/full-setup.sh")" -ge 3 ]] || fail 'full-setup must re-sync gfs-config.jwt-public-key before both GFS reconciles'
grep -Fq 'T2_LOCK_ROOT' "$COMMON"
grep -Fq 't2_mutation_lock' "$COMMON"
grep -Fq 't2_lock_validate_inherited' "$COMMON"
grep -Fq 'PORT_FORWARD_CONFLICT' "$COMMON"
grep -Fq 'while read -r uid pid ppid rest' "$COMMON" || fail 't2_process_check must split ps -ef fields'
grep -Fq 'IFS= read -r uid pid ppid rest' "$COMMON" && fail 'IFS= read disables PID split and silences PORT_FORWARD_CONFLICT'
grep -Fq '([^[:space:]]*\/)?kubectl([[:space:]]|$)' "$COMMON" || fail 't2_process_check awk must match a kubectl argv0/path token'
grep -Fq '[[:space:]]port-forward([[:space:]]|$)' "$COMMON" || fail 't2_process_check awk must match a standalone port-forward token'
grep -Fq 'kubectl[[:space:]]+port-forward' "$COMMON" && fail 't2_process_check awk still requires kubectl/port-forward adjacency'
grep -Fq '[0-9]+:[0-9]+(:[0-9]+)?(\.[0-9]+)?' "$COMMON" && fail 't2_process_check awk still anchors on a TIME-column regex'

# Real launcher argv (flags between kubectl and port-forward). TIME prefixes
# are only ps -ef wrappers. The dead adjacency regex must miss these lines.
pf_profile="clerum-t2-pf-fixture"
pf_all='user 4242 1 0 10:00 ttys000 0:00 kubectl --context='"${pf_profile}"' -n control-plane port-forward --address=127.0.0.1 svc/control-ui 3000:3000'
pf_ctl='user 4243 1 0 10:00 ttys000 0:00.03 kubectl -n control-plane port-forward svc/control-api 8090:8090'
pf_e2e='user 4244 1 0 10:00 pts/0 00:00:00 kubectl --context '"${pf_profile}"' port-forward svc/control-ui -n control-plane 3000:3000'
bare_pf='user 4245 1 0 10:00 ttys000 0:00 kubectl port-forward --context='"${pf_profile}"' svc/x 8080:80'
path_pf='user 4246 1 0 10:00 pts/0 00:00:00 /usr/local/bin/kubectl --context='"${pf_profile}"' -n control-plane port-forward --address=127.0.0.1 svc/control-api 8090:8090'
wrapper_pf='user 4247 1 0 10:00 ttys000 0:00 bash -c echo kubectl port-forward --context='"${pf_profile}"
awk_pf="$(sed -n '/^t2_process_check()/,/^}/p' "$COMMON" | sed -n "s/.*awk '\\(.*\\)' .*/\\1/p")"
[ -n "$awk_pf" ] || fail 'could not extract t2_process_check awk program'
printf '%s\n' "$awk_pf" | grep -Fq 'kubectl[[:space:]]+port-forward' && fail 'extracted awk still requires kubectl/port-forward adjacency'
dead_awk='/[[:space:]][0-9]+:[0-9]+(:[0-9]+)?(\.[0-9]+)?[[:space:]]+([^[:space:]]*\/)?kubectl[[:space:]]+port-forward([[:space:]]|$)/ {print}'
printf '%s\n' "$pf_all" "$pf_ctl" "$pf_e2e" | awk "$dead_awk" >"$tmp/pf-dead-awk.out"
[ ! -s "$tmp/pf-dead-awk.out" ] || fail 'real-launcher fixtures still match the dead adjacency regex — fixtures are wrong'
printf '%s\n' "$pf_all" "$pf_ctl" "$pf_e2e" "$bare_pf" "$path_pf" "$wrapper_pf" | awk "$awk_pf" >"$tmp/pf-awk.out"
grep -Fq -- "--context=${pf_profile} -n control-plane port-forward --address=127.0.0.1" "$tmp/pf-awk.out" || fail 'awk missed pf-all-stack real launcher'
grep -Fq 'kubectl -n control-plane port-forward svc/control-api' "$tmp/pf-awk.out" || fail 'awk missed pf-control-stack real launcher'
grep -Fq -- "--context ${pf_profile} port-forward svc/control-ui" "$tmp/pf-awk.out" || fail 'awk missed run-e2e real launcher'
grep -Fq 'kubectl port-forward --context=' "$tmp/pf-awk.out" || fail 'awk missed a bare kubectl port-forward'
grep -Fq '/usr/local/bin/kubectl --context=' "$tmp/pf-awk.out" || fail 'awk missed a path kubectl with flags before port-forward'
read -r _ pid _ _ <<<"$pf_all"
[ "$pid" = 4242 ] || fail "ps field split left pid='$pid' instead of 4242"

pf_root="$tmp/pf-check-profiles"
mkdir -p "$pf_root/$pf_profile/pids"
pf_bin="$tmp/pf-ps-bin"
mkdir -p "$pf_bin"
cat >"$pf_bin/ps" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-ef" ]; then
  cat "${T2_PS_EF_FILE:?}"
  exit 0
fi
pid=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p)
      pid="$2"
      shift 2
      ;;
    -p*)
      pid="${1#-p}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
case "$pid" in
  4242|4243|4244|4245|4246) printf '%s\n' kubectl ;;
  4247) printf '%s\n' bash ;;
  *) printf '\n' ;;
esac
EOF
chmod +x "$pf_bin/ps"

run_process_check() {
  local ef_file="$1" out="$2"
  T2_PS_EF_FILE="$ef_file" PATH="$pf_bin:$PATH" \
    T2_PROFILE="$pf_profile" T2_CONTEXT="$pf_profile" \
    MINIKUBE_PROFILE="$pf_profile" \
    T2_PROFILE_ROOT="$pf_root" \
    T2_PROJECT_DIR="$ROOT" \
    T2_LOCK_ROOT="$tmp/locks" \
    bash -c 'source "$1"; t2_process_check' bash "$COMMON" >"$out" 2>&1
}

printf '%s\n' "$pf_all" >"$tmp/ps-ef-real.out"
if run_process_check "$tmp/ps-ef-real.out" "$tmp/pf-real.err"; then
  fail 't2_process_check did not fail a foreign real launcher (PORT_FORWARD_CONFLICT)'
fi
grep -Fq 'PORT_FORWARD_CONFLICT' "$tmp/pf-real.err" || fail 'foreign real launcher did not report PORT_FORWARD_CONFLICT'

printf '%s\n' "$wrapper_pf" >"$tmp/ps-ef-wrap.out"
if ! run_process_check "$tmp/ps-ef-wrap.out" "$tmp/pf-wrap.err"; then
  fail 't2_process_check failed on a wrapper that only mentions kubectl (comm=bash)'
fi

grep -Fq 'REUSE_DB=true' "$ROOT/scripts/minikube/t2.sh"
grep -Fq 'CONTROL_DB_RESET_PVC_UID' "$ROOT/scripts/minikube/t2.sh"

forward_tmp="$tmp/port-forward-check"
mkdir -p "$forward_tmp/bin" "$forward_tmp/profile-cache/profile-a/pids"
cat >"$forward_tmp/bin/ps" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'root 4242 1 0 00:00 ? 00:00:00 kubectl --context=profile-a -n control-plane port-forward svc/control-api 30100:8090'
EOF
chmod +x "$forward_tmp/bin/ps"
printf '4242\n' >"/tmp/pf-profile-a-control-api.pid"
forward_check="$(env PATH="$forward_tmp/bin:$PATH" T2_PROFILE=profile-a T2_CONTEXT=profile-a \
  T2_PROFILE_ROOT="$forward_tmp/profile-cache" bash -c 'source "$1"; t2_process_check; printf PASS' bash "$COMMON")"
rm -f "/tmp/pf-profile-a-control-api.pid"
[ "$forward_check" = PASS ] || fail "canonical /tmp port-forward ownership was rejected: $forward_check"

printf 'PASS: local Minikube T0/T1/T2 scenario checks\n'
