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

"$ROOT/scripts/tests/test-minikube-profile-owner.sh"

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
local_loopback_url() { printf 'http://%s:%s' 127.0.0.1 "$1"; }
cat >"$profile_root/ports.env" <<EOF_PORTS
PORT_BASE=23117
CONTROL_UI_PORT=23117
PROFILE_UI_PORT=23118
MCP_HOST_PORT=23197
REGISTRY_API_PORT=23202
CONTROL_API_PORT=23207
EXTERNAL_REST_API_PORT=23208
MEMBER_REGISTRATION_SERVICE_PORT=23209
RPC_PROXY_PORT=23211
WORKFLOW_APPROVAL_READER_PORT=23215
CONTROL_UI_URL=$(local_loopback_url 23117)
PROFILE_UI_URL=$(local_loopback_url 23118)
PROFILE_UI_BASE_URL=$(local_loopback_url 23118)
CONTROL_API_URL=$(local_loopback_url 23207)
EXTERNAL_REST_API_URL=$(local_loopback_url 23208)
MEMBER_REGISTRATION_SERVICE_URL=$(local_loopback_url 23209)
RPC_PROXY_URL=$(local_loopback_url 23211)
REGISTRY_API_URL=$(local_loopback_url 23202)
WORKFLOW_APPROVAL_READER_URL=$(local_loopback_url 23215)
MCP_HOST_URL=$(local_loopback_url 23197)
EOF_PORTS

repo_env=(
  T2_PROJECT_DIR="$repo"
  MINIKUBE_PROFILE="$profile"
  T2_CONTEXT="$profile"
  CONTROL_API_REAL_PG_CONTEXT="$profile"
  T2_PROFILE_ROOT="$tmp/profiles"
  T2_PROFILE_ENV="$profile_root/profile.env"
  T2_PORTS_ENV="$profile_root/ports.env"
  T2_REQUIRED_DEPLOYMENTS=gfs/gfsc-reader
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
expect_code PROFILE_OWNERSHIP_MISMATCH missing-profile missing-profile \
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
    if [ -n "${FAKE_CONTEXT:-}" ]; then
      printf '%s' "${FAKE_CONTEXT}"
      exit 0
    fi
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
expect_code DEVELOPMENT_SCOPE_REQUIRED public-endpoint public-endpoint \
  env "${context_env[@]}" PATH="$fake_bin:$PATH" FAKE_ENDPOINT=8.8.8.8 \
  bash -c 'source "$1"; t2_context_check' bash "$COMMON"
env "${context_env[@]}" PATH="$fake_bin:$PATH" FAKE_ENDPOINT=192.168.1.99 \
  bash -c 'source "$1"; t2_context_check' bash "$COMMON"

identity_json='{"items":[{"metadata":{"labels":{"minikube.k8s.io/name":"PROFILE"}},"status":{"addresses":[{"type":"InternalIP","address":"172.17.0.3"}]}}]}'
identity_ok="$(env "${repo_env[@]}" IDENTITY_JSON="$identity_json" \
  bash -c 'source "$1"; T2_BOOTSTRAP_REQUIRED=false; t2_mk(){ printf 172.17.0.3; }; t2_kc(){ printf "%s" "$IDENTITY_JSON" | sed "s/PROFILE/$T2_PROFILE/g"; }; t2_profile_context_identity_check; printf "%s" "$T2_CONTEXT_IDENTITY_VERIFIED"' bash "$COMMON")"
[ "$identity_ok" = true ] || fail "exact Minikube profile/node identity did not verify"
identity_wrong='{"items":[{"metadata":{"labels":{"minikube.k8s.io/name":"other-profile"}},"status":{"addresses":[{"type":"InternalIP","address":"172.17.0.3"}]}}]}'
expect_code DEVELOPMENT_SCOPE_REQUIRED wrong-profile-identity wrong-profile-identity \
  env "${repo_env[@]}" IDENTITY_JSON="$identity_wrong" \
  bash -c 'source "$1"; T2_BOOTSTRAP_REQUIRED=false; t2_mk(){ printf 172.17.0.3; }; t2_kc(){ printf "%s" "$IDENTITY_JSON"; }; t2_profile_context_identity_check' bash "$COMMON"

missing_profile_state="$(env "${repo_env[@]}" bash -c 'source "$1"; t2_mk(){ printf "%s" "Profile not found"; }; t2_profile_status; printf "%s" "$T2_PLAN_STATE"' bash "$COMMON")"
[ "$missing_profile_state" = full-bootstrap ] || fail "missing profile selected $missing_profile_state instead of full-bootstrap"

expect_code PROFILE_UNHEALTHY status-probe-timeout status-probe-timeout \
  env "${repo_env[@]}" bash -c 'source "$1"; t2_mk(){ return 124; }; t2_profile_status' bash "$COMMON"

healthy_profile_state="$(env T2_PROJECT_DIR="$repo" MINIKUBE_PROFILE="$profile" T2_CONTEXT="$profile" CONTROL_API_REAL_PG_CONTEXT="$profile" T2_PROFILE_ROOT="$tmp/profiles" T2_PROFILE_ENV="$profile_root/profile.env" T2_PORTS_ENV="$profile_root/ports.env" T2_REQUIRED_DEPLOYMENTS=gfs/gfsc-reader T2_BRANCH=feat/scenario T2_HEAD="$feature_sha" T2_LOCK_ROOT="$tmp/locks" T2_EVIDENCE_ROOT="$tmp/evidence" bash -c 'source "$1"; t2_mk(){ printf "%s" "host: Running\nkubelet: Running\napiserver: Running"; }; t2_profile_status; printf "%s:%s" "$T2_PROFILE_STATUS" "$T2_PROFILE_HEALTHY"' bash "$COMMON")"
[ "$healthy_profile_state" = healthy:true ] || fail "healthy profile selected $healthy_profile_state instead of healthy:true"

partial_profile_state="$(env T2_PROJECT_DIR="$repo" MINIKUBE_PROFILE="$profile" T2_CONTEXT="$profile" CONTROL_API_REAL_PG_CONTEXT="$profile" T2_PROFILE_ROOT="$tmp/profiles" T2_PROFILE_ENV="$profile_root/profile.env" T2_PORTS_ENV="$profile_root/ports.env" T2_REQUIRED_DEPLOYMENTS=gfs/gfsc-reader T2_BRANCH=feat/scenario T2_HEAD="$feature_sha" T2_LOCK_ROOT="$tmp/locks" T2_EVIDENCE_ROOT="$tmp/evidence" bash -c 'source "$1"; t2_mk(){ printf "%s" "host: Running\nkubelet: Stopped\napiserver: Running"; return 1; }; t2_profile_status; printf "%s:%s:%s" "$T2_PLAN_STATE" "$T2_PROFILE_STATUS" "$T2_PROFILE_HEALTHY"' bash "$COMMON")"
[ "$partial_profile_state" = full-bootstrap:stopped:false ] || fail "partial stopped profile selected $partial_profile_state instead of full-bootstrap:stopped:false"

expect_code PROFILE_UNHEALTHY incomplete-profile-status incomplete-profile-status \
  env T2_PROJECT_DIR="$repo" MINIKUBE_PROFILE="$profile" T2_CONTEXT="$profile" CONTROL_API_REAL_PG_CONTEXT="$profile" T2_PROFILE_ROOT="$tmp/profiles" T2_PROFILE_ENV="$profile_root/profile.env" T2_PORTS_ENV="$profile_root/ports.env" T2_REQUIRED_DEPLOYMENTS=gfs/gfsc-reader T2_BRANCH=feat/scenario T2_HEAD="$feature_sha" T2_LOCK_ROOT="$tmp/locks" T2_EVIDENCE_ROOT="$tmp/evidence" bash -c 'source "$1"; t2_mk(){ printf "%s" "host: Running\nkubelet: Unknown\napiserver: Running"; return 1; }; t2_profile_status' bash "$COMMON"

ownership_env=("${repo_env[@]}" T2_PROFILE_ENV="$tmp/ownership.env")
printf 'PROFILE=%s\nBRANCH=feat/scenario\nSHA_SHORT=%s\nDIRTY=false\nREPO_DIR=%s\n' \
  "$profile" "$(git -C "$repo" rev-parse --short=8 HEAD)" "$tmp/other" >"$tmp/ownership.env"
expect_code PROFILE_OWNERSHIP_MISMATCH profile-ownership profile-ownership \
  env "${ownership_env[@]}" bash -c 'source "$1"; t2_profile_scope' bash "$COMMON"

stale_profile_env="$tmp/stale-profile.env"
printf 'PROFILE=%s\nBRANCH=feat/scenario\nSHA_SHORT=deadbeef\nDIRTY=false\nREPO_DIR=%s\n' \
  "$profile" "$repo" >"$stale_profile_env"
env "${repo_env[@]}" T2_PROFILE_ENV="$stale_profile_env" \
  bash -c 'source "$1"; t2_repo_metadata; t2_profile_scope' bash "$COMMON"

worktree_id="$(bash -c 'source "$1"; t2_worktree_id "$2"' bash "$ROOT/scripts/minikube/t2-worktree-id.sh" "$repo")"
owner_id="$(bash -c 'source "$1"; t2_profile_owner_id "$2" "$3"' bash "$ROOT/scripts/minikube/t2-worktree-id.sh" "$repo" feat/scenario)"
v2_profile_env="$tmp/v2-profile.env"
cat >"$v2_profile_env" <<EOF
PROFILE_SCHEMA_VERSION=2
WORKTREE_ID=$worktree_id
OWNER_ID=$owner_id
CREATED_HEAD=$feature_sha
PROFILE=$profile
REPO_DIR=$repo
BRANCH=feat/scenario
EOF
env "${repo_env[@]}" T2_PROFILE_ENV="$v2_profile_env" \
  bash -c 'source "$1"; t2_repo_metadata; t2_profile_scope' bash "$COMMON"

bad_v2_owner_env="$tmp/bad-v2-owner.env"
sed 's/^OWNER_ID=.*/OWNER_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
  "$v2_profile_env" >"$bad_v2_owner_env"
expect_code PROFILE_OWNERSHIP_MISMATCH v2-owner-mismatch v2-owner-mismatch \
  env "${repo_env[@]}" T2_PROFILE_ENV="$bad_v2_owner_env" \
  bash -c 'source "$1"; t2_repo_metadata; t2_profile_scope' bash "$COMMON"

bad_ports_env="$tmp/bad-ports.env"
printf 'PORT_BASE=not-a-port\n' >"$bad_ports_env"
expect_code PROFILE_OWNERSHIP_MISMATCH corrupt-profile-ports corrupt-profile-ports \
  env "${repo_env[@]}" T2_PROFILE_ENV="$v2_profile_env" T2_PORTS_ENV="$bad_ports_env" \
  bash -c 'source "$1"; t2_repo_metadata; t2_profile_scope' bash "$COMMON"

marker_env=("${repo_env[@]}" T2_HEAD="$feature_sha" T2_WORKTREE_ID=worktree-a)
expect_code HEAD_MARKER_MISMATCH stale-marker stale-marker \
  env "${marker_env[@]}" FAKE_MARKER='{"data":{"clusterFingerprint":"fp","gitHead":"old","worktreeId":"worktree-a","imageSource":"local","imageTag":"test"}}' \
  bash -c 'source "$1"; T2_WORKTREE_ID=worktree-a; T2_HEAD=feature; t2_kc(){ printf "%s" "$FAKE_MARKER"; }; t2_marker_check' bash "$COMMON"

expect_code PROFILE_OWNERSHIP_MISMATCH marker-ownership marker-ownership \
  env "${marker_env[@]}" FAKE_MARKER='{"data":{"clusterFingerprint":"fp","gitHead":"feature","worktreeId":"worktree-b","imageSource":"local","imageTag":"test"}}' \
  bash -c 'source "$1"; T2_WORKTREE_ID=worktree-a; T2_HEAD=feature; t2_kc(){ printf "%s" "$FAKE_MARKER"; }; t2_marker_check' bash "$COMMON"

missing_marker_state="$(env "${marker_env[@]}" bash -c 'source "$1"; T2_WORKTREE_ID=worktree-a; T2_HEAD=feature; t2_kc(){ printf "%s" "{}"; }; t2_marker_check; printf "%s" "$T2_PLAN_STATE"' bash "$COMMON")"
[ "$missing_marker_state" = full-bootstrap ] || fail "empty marker selected $missing_marker_state instead of full-bootstrap"

expect_code PROFILE_UNHEALTHY marker-read-timeout marker-read-timeout \
  env "${marker_env[@]}" bash -c 'source "$1"; T2_WORKTREE_ID=worktree-a; T2_HEAD=feature; t2_kc(){ return 124; }; t2_marker_check' bash "$COMMON"

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
printf '{"generated":"manifest-generated","imageSource":"local","imageTag":"","images":{"clerum/control-api:test":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}\n' >"$local_manifest"
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

# A new image acquisition can replace the digest while Git HEAD stays the
# same. The marker must carry the manifest's generated stamp; otherwise the
# planner would incorrectly choose already-synced/T2-runtime against the new
# image set.
stamp_manifest="$tmp/stamp-image-manifest.json"
printf '{"generated":"new-generated","imageSource":"local","imageTag":"test","images":{"clerum/control-api:test":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}\n' >"$stamp_manifest"
stamp_state="$(env T2_PROJECT_DIR="$repo" MINIKUBE_PROFILE="$profile" \
  T2_CONTEXT="$profile" CONTROL_API_REAL_PG_CONTEXT="$profile" \
  T2_PROFILE_ROOT="$tmp/profiles" T2_PROFILE_ENV="$profile_root/profile.env" \
  T2_PORTS_ENV="$profile_root/ports.env" T2_REQUIRED_DEPLOYMENTS=gfs/gfsc-reader \
  T2_BRANCH=feat/scenario T2_HEAD="$feature_sha" T2_ORIGIN_DEV="$base_sha" \
  T2_LOCK_ROOT="$tmp/locks" T2_EVIDENCE_ROOT="$tmp/evidence" \
  T2_IMAGE_MANIFEST="$stamp_manifest" \
  FAKE_MARKER='{"data":{"clusterFingerprint":"fp","gitHead":"'"$feature_sha"'","worktreeId":"worktree-a","imageSource":"local","imageTag":"test","imagesGeneratedAt":"old-generated"}}' \
  bash -c 'source "$1"; T2_WORKTREE_ID=worktree-a; T2_HEAD="$3"; T2_ORIGIN_DEV="$2"; T2_PLAN_MODE=true; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$FAKE_MARKER"; }; t2_marker_check; t2_image_check; t2_classify_transition; printf "%s|%s" "$T2_PLAN_STATE" "$T2_PLAN_REASON"' bash "$COMMON" "$base_sha" "$feature_sha")"
case "$stamp_state" in
  already-synced*) fail "a changed image acquisition was treated as already-synced: $stamp_state" ;;
  targeted-sync*|full-reconcile*) ;;
  *) fail "changed image acquisition selected an unexpected plan: $stamp_state" ;;
esac

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

ready_json='{"items":[{"metadata":{"namespace":"gfs","name":"gfsc-reader","generation":7},"spec":{"replicas":1},"status":{"observedGeneration":7,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}]}'
env "${repo_env[@]}" READY_JSON="$ready_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$READY_JSON"; }; t2_deployment_check' bash "$COMMON"
# Each required deployment must use its own metadata generation. Keep an
# unrelated item last so a stale loop variable cannot make healthy resources
# appear unready.
multi_ready_json='{"items":[{"metadata":{"namespace":"gfs","name":"gfsc-reader","generation":7},"spec":{"replicas":1},"status":{"observedGeneration":7,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"gfs","name":"gfsc-writer","generation":11},"spec":{"replicas":1},"status":{"observedGeneration":11,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"control-plane","name":"unrelated","generation":3},"spec":{"replicas":1},"status":{"observedGeneration":3,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}]}'
env "${repo_env[@]}" T2_REQUIRED_DEPLOYMENTS='gfs/gfsc-reader gfs/gfsc-writer' MULTI_READY_JSON="$multi_ready_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$MULTI_READY_JSON"; }; t2_deployment_check' bash "$COMMON"

# The default scope is fail-closed even when the API returns an empty inventory.
empty_inventory_json='{"items":[]}'
expect_code PROFILE_UNHEALTHY default-empty-inventory default-empty-inventory \
  env "${repo_env[@]}" T2_REQUIRED_DEPLOYMENTS= EMPTY_INVENTORY_JSON="$empty_inventory_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$EMPTY_INVENTORY_JSON"; }; t2_deployment_check' bash "$COMMON"

# A missing core Deployment is reported even when the other core Deployments
# are healthy; the inventory cannot silently shrink the required contract.
missing_core_json='{"items":[{"metadata":{"namespace":"control-plane","name":"control-api","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"control-plane","name":"host-context-controller","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"profiles","name":"external-rest-api","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"rpc-proxy","name":"rpc-proxy","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}]}'
expect_code PROFILE_UNHEALTHY missing-core-deployment missing-core-deployment \
  env "${repo_env[@]}" T2_REQUIRED_DEPLOYMENTS= MISSING_CORE_JSON="$missing_core_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$MISSING_CORE_JSON"; }; t2_deployment_check' bash "$COMMON"

# All five core Deployments ready is a valid default-scope pass.
default_core_ready_json='{"items":[{"metadata":{"namespace":"control-plane","name":"control-api","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"control-plane","name":"host-context-controller","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"profiles","name":"external-rest-api","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"rpc-proxy","name":"rpc-proxy","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"mcp-host","name":"chatllm","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}]}'
env "${repo_env[@]}" T2_REQUIRED_DEPLOYMENTS= DEFAULT_CORE_READY_JSON="$default_core_ready_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$DEFAULT_CORE_READY_JSON"; }; t2_deployment_check' bash "$COMMON"

# A required core Deployment scaled to zero is not a valid certification
# result, even though additional non-core Deployments may remain suspended.
zero_core_json='{"items":[{"metadata":{"namespace":"control-plane","name":"control-api","generation":1},"spec":{"replicas":0},"status":{"observedGeneration":1,"updatedReplicas":0,"readyReplicas":0,"availableReplicas":0,"unavailableReplicas":0}},{"metadata":{"namespace":"control-plane","name":"host-context-controller","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"profiles","name":"external-rest-api","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"rpc-proxy","name":"rpc-proxy","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"mcp-host","name":"chatllm","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}]}'
expect_code PROFILE_UNHEALTHY required-core-scaled-zero required-core-scaled-zero \
  env "${repo_env[@]}" T2_REQUIRED_DEPLOYMENTS= ZERO_CORE_JSON="$zero_core_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$ZERO_CORE_JSON"; }; t2_deployment_check' bash "$COMMON"

# Production scope also evaluates every additional Deployment. Keep the five
# core Deployments healthy while an otherwise out-of-scope UI is unready; the
# old allowlist passed this fixture and certified a broken profile.
out_of_scope_unready_json='{"items":[{"metadata":{"namespace":"control-plane","name":"control-api","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"control-plane","name":"host-context-controller","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"profiles","name":"external-rest-api","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"rpc-proxy","name":"rpc-proxy","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"mcp-host","name":"chatllm","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}},{"metadata":{"namespace":"control-plane","name":"control-ui","generation":1},"spec":{"replicas":1},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":0,"availableReplicas":0,"unavailableReplicas":1}}]}'
expect_code PROFILE_UNHEALTHY out-of-scope-unready out-of-scope-unready \
  env "${repo_env[@]}" T2_REQUIRED_DEPLOYMENTS= OUT_OF_SCOPE_JSON="$out_of_scope_unready_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$OUT_OF_SCOPE_JSON"; }; t2_deployment_check' bash "$COMMON"

stale_generation_json='{"items":[{"metadata":{"namespace":"gfs","name":"gfsc-reader","generation":8},"spec":{"replicas":1},"status":{"observedGeneration":7,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1,"unavailableReplicas":0}}]}'
expect_code PROFILE_UNHEALTHY stale-generation stale-generation \
  env "${repo_env[@]}" INVALID_INVENTORY="$stale_generation_json" \
  bash -c 'source "$1"; T2_PLAN_MODE=false; T2_BOOTSTRAP_REQUIRED=false; t2_kc(){ printf "%s" "$INVALID_INVENTORY"; }; t2_deployment_check' bash "$COMMON"

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
if grep -Fq 'Traceback' "$tmp/invalid-deployment-inventory"; then
  fail 'invalid deployment inventory leaked a Python traceback instead of the stable failure contract'
fi
grep -Fq 'next:' "$tmp/invalid-deployment-inventory" ||
  fail 'invalid deployment inventory omitted the stable next-step guidance'
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
[[ "$(grep -c 'T2_SKIP_LOCK=true' "$ROOT/scripts/minikube/full-setup.sh")" -ge 4 ]] || fail 'full-setup GFS child mutators must validate the parent lease instead of acquiring a second lock'
grep -Fq 'T2_LOCK_ROOT' "$COMMON"
grep -Fq 't2_mutation_lock' "$COMMON"
grep -Fq 't2_lock_validate_inherited' "$COMMON"
grep -Fq 'PORT_FORWARD_CONFLICT' "$COMMON"
grep -Fq 'port-forward-owner.sh' "$COMMON" || fail 'T2 must load the shared exact port-forward owner'
grep -Fq 'matching_records' "$COMMON" || fail 'T2 must require exactly one structured ownership record'
bash "$ROOT/scripts/tests/test-minikube-t2-process-owner.sh"

grep -Fq 'REUSE_DB=true' "$ROOT/scripts/minikube/t2.sh"
grep -Fq 'CONTROL_DB_RESET_PVC_UID' "$ROOT/scripts/minikube/t2.sh"

printf 'PASS: local Minikube T0/T1/T2 scenario checks\n'
