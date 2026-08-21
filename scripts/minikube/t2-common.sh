#!/usr/bin/env bash
# Secret-safe helpers for the local Evenfire Minikube T0/T1/T2 contract.
# shellcheck disable=SC2034,SC2269
set -eo pipefail
set +x
set +u

T2_SCRIPT_DIR="$T2_SCRIPT_DIR"
if [ -z "$T2_SCRIPT_DIR" ]; then T2_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"; fi
T2_PROJECT_DIR="$T2_PROJECT_DIR"
if [ -z "$T2_PROJECT_DIR" ]; then T2_PROJECT_DIR="$(cd -- "$T2_SCRIPT_DIR/../.." && pwd -P)"; fi
T2_PROFILE="$T2_PROFILE"
if [ -z "$T2_PROFILE" ]; then T2_PROFILE="$MINIKUBE_PROFILE"; fi
T2_CONTEXT="$T2_CONTEXT"
if [ -z "$T2_CONTEXT" ]; then T2_CONTEXT="$CONTROL_API_REAL_PG_CONTEXT"; fi
if [ -z "$T2_CONTEXT" ]; then T2_CONTEXT="$K8S_CONTEXT"; fi
if [ -z "$T2_CONTEXT" ]; then T2_CONTEXT="$KUBECONTEXT"; fi
if [ -z "$T2_CONTEXT" ]; then T2_CONTEXT="$T2_PROFILE"; fi
T2_TIMEOUT_SECONDS="$T2_TIMEOUT_SECONDS"
if [ -z "$T2_TIMEOUT_SECONDS" ]; then T2_TIMEOUT_SECONDS="$T2_TIMEOUT"; fi
if [ -z "$T2_TIMEOUT_SECONDS" ]; then T2_TIMEOUT_SECONDS=180; fi
T2_PROFILE_ROOT="$T2_PROFILE_ROOT"
if [ -z "$T2_PROFILE_ROOT" ]; then T2_PROFILE_ROOT="$CLERUM_PROFILE_CACHE_ROOT"; fi
if [ -z "$T2_PROFILE_ROOT" ]; then T2_PROFILE_ROOT="$HOME/.cache/clerum/minikube-profiles"; fi
T2_PROFILE_ENV="$T2_PROFILE_ENV"
if [ -z "$T2_PROFILE_ENV" ]; then T2_PROFILE_ENV="$T2_PROFILE_ROOT/$T2_PROFILE/profile.env"; fi
T2_PORTS_ENV="$T2_PORTS_ENV"
if [ -z "$T2_PORTS_ENV" ]; then T2_PORTS_ENV="$CLERUM_PROFILE_PORTS_ENV"; fi
if [ -z "$T2_PORTS_ENV" ]; then T2_PORTS_ENV="$T2_PROFILE_ROOT/$T2_PROFILE/ports.env"; fi
T2_LOCK_ROOT="$T2_LOCK_ROOT"
if [ -z "$T2_LOCK_ROOT" ]; then T2_LOCK_ROOT="$HOME/.cache/evenfire/minikube-t2-locks"; fi
T2_EVIDENCE_ROOT="$T2_EVIDENCE_ROOT"
if [ -z "$T2_EVIDENCE_ROOT" ]; then T2_EVIDENCE_ROOT="$T2_PROJECT_DIR/.local-notes/infra/runs"; fi
T2_MARKER_NAME="$T2_MARKER_NAME"
if [ -z "$T2_MARKER_NAME" ]; then T2_MARKER_NAME="$CLERUM_PRE_GATE_SYNC_CONFIGMAP"; fi
if [ -z "$T2_MARKER_NAME" ]; then T2_MARKER_NAME=clerum-pre-gate-sync-state; fi
T2_CONTROL_NAMESPACE="$T2_CONTROL_NAMESPACE"
if [ -z "$T2_CONTROL_NAMESPACE" ]; then T2_CONTROL_NAMESPACE=control-plane; fi
T2_IMAGE_MANIFEST="$T2_IMAGE_MANIFEST"
if [ -z "$T2_IMAGE_MANIFEST" ]; then T2_IMAGE_MANIFEST="$T2_PROJECT_DIR/deploy/minikube/.image-manifest.json"; fi

T2_ERROR_CODE=""
T2_NEXT_COMMAND='re-run the canonical command with the verified profile'
T2_PLAN_STATE=""
T2_PLAN_REASON=""
T2_BOOTSTRAP_REQUIRED=false
T2_PROFILE_HEALTHY=false
T2_MARKER_JSON=""
T2_IMAGE_SOURCE=""
T2_IMAGE_TAG=""
T2_CLUSTER_FINGERPRINT=""
T2_WORKTREE_ID=""
T2_HEAD=""
T2_BRANCH=""
T2_ORIGIN_DEV=""
T2_MERGE_BASE=""
T2_LOCK_DIR=""
T2_LOCK_KEY=""
T2_EVIDENCE_DIR=""
T2_EVIDENCE_FILE=""
T2_LOCK_HELD=false

T2_REQUIRED_NAMESPACES="$T2_REQUIRED_NAMESPACES"
if [ -z "$T2_REQUIRED_NAMESPACES" ]; then T2_REQUIRED_NAMESPACES="control-plane gfs mcp-host mcp-server profiles rpc-proxy channels sandbox-recipes sandbox-ui webhook-ingress registry"; fi
T2_REQUIRED_SERVICES="$T2_REQUIRED_SERVICES"
if [ -z "$T2_REQUIRED_SERVICES" ]; then T2_REQUIRED_SERVICES="control-plane/control-postgres control-plane/control-api control-plane/control-ui control-plane/host-context-controller control-plane/workflow-recipes profiles/external-rest-api profiles/profile-ui rpc-proxy/rpc-proxy mcp-server/mcp-proxy"; fi
T2_REQUIRED_SECRETS="$T2_REQUIRED_SECRETS"
if [ -z "$T2_REQUIRED_SECRETS" ]; then T2_REQUIRED_SECRETS="control-plane/control-postgres control-plane/control-api-secrets control-plane/control-ui-secrets control-plane/inter-service-tokens profiles/external-rest-api-secrets rpc-proxy/rpc-proxy-secrets mcp-host/chatllm-api-keys gfs/gfs-controller-db gfs/gfs-controller-reader-db"; fi
T2_REQUIRED_CONFIGMAPS="$T2_REQUIRED_CONFIGMAPS"
if [ -z "$T2_REQUIRED_CONFIGMAPS" ]; then T2_REQUIRED_CONFIGMAPS="control-plane/$T2_MARKER_NAME control-plane/control-api-config control-plane/control-api-public-key mcp-host/mcp-host-config mcp-host/clerum-model-secret-mapping profiles/external-rest-api-config rpc-proxy/rpc-proxy-config gfs/gfs-config"; fi
T2_REQUIRED_PVC="$T2_REQUIRED_PVC"
if [ -z "$T2_REQUIRED_PVC" ]; then T2_REQUIRED_PVC="control-plane/control-postgres-data"; fi
T2_PLAN_MODE="$T2_PLAN_MODE"
T2_SKIP_LOCK="$T2_SKIP_LOCK"
T2_PLAN_FILE="$T2_PLAN_FILE"
T2_RUN_T0="$T2_RUN_T0"
T2_RUN_T1="$T2_RUN_T1"
T2_REQUIRE_PLAYWRIGHT="$T2_REQUIRE_PLAYWRIGHT"
T2_T0_COMMAND="$T2_T0_COMMAND"
T2_PLAYWRIGHT_COMMAND="$T2_PLAYWRIGHT_COMMAND"
T2_HEALTHCHECK_COMMAND="$T2_HEALTHCHECK_COMMAND"
T2_RESET_PVC="$T2_RESET_PVC"
T2_EXPECTED_PVC_UID="$T2_EXPECTED_PVC_UID"
T2_TMP_ROOT="$TMPDIR"
CONTROL_API_REAL_PG_CONTEXT="$CONTROL_API_REAL_PG_CONTEXT"
MINIKUBE_PROFILE="$MINIKUBE_PROFILE"
set -u

t2_fail() {
  T2_ERROR_CODE="$1"
  shift
  printf '%s: %s\n' "$T2_ERROR_CODE" "$*" >&2
  printf 'next: %s\n' "$T2_NEXT_COMMAND" >&2
  return 1
}

t2_require_commands() {
  local command_name
  for command_name in git kubectl minikube python3 shasum awk sed find ps; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      T2_NEXT_COMMAND="install or enable $command_name, then re-run make minikube-t2-preflight"
      t2_fail LOCAL_DEPENDENCY_MISSING "required local dependency is unavailable: $command_name"
    fi
  done
}

t2_kc() {
  kubectl --context="$T2_CONTEXT" "$@"
}

t2_mk() {
  minikube -p "$T2_PROFILE" "$@"
}

t2_canonical_path() {
  (cd -- "$1" 2>/dev/null && pwd -P)
}

t2_repo_metadata() {
  local actual_root remote_url
  actual_root="$(git -C "$T2_PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$actual_root" ]; then
    T2_NEXT_COMMAND='run from the canonical Evenfire checkout'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'the working directory is not a Git repository'
  fi
  actual_root="$(t2_canonical_path "$actual_root")"
  if [ "$actual_root" != "$T2_PROJECT_DIR" ]; then
    T2_NEXT_COMMAND='run from the Git worktree that owns the branch profile'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED "repository root does not match the active worktree"
  fi
  remote_url="$(git -C "$T2_PROJECT_DIR" remote get-url origin 2>/dev/null || true)"
  if [[ "$remote_url" != *evenfire* ]]; then
    T2_NEXT_COMMAND='select a checkout whose origin remote is the Evenfire repository'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'origin is not the Evenfire repository'
  fi
  T2_BRANCH="$(git -C "$T2_PROJECT_DIR" branch --show-current 2>/dev/null || true)"
  T2_HEAD="$(git -C "$T2_PROJECT_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  T2_ORIGIN_DEV="$(git -C "$T2_PROJECT_DIR" rev-parse --verify origin/dev 2>/dev/null || true)"
  if [ -z "$T2_BRANCH" ] || [ -z "$T2_HEAD" ] || [ -z "$T2_ORIGIN_DEV" ]; then
    T2_NEXT_COMMAND='fetch origin/dev and run from a named development branch'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'branch, HEAD, or origin/dev could not be resolved'
  fi
  case "$T2_BRANCH" in
    main|master|dev|origin/dev|production|staging|release/*)
      T2_NEXT_COMMAND='create a new development branch from the current origin/dev'
      t2_fail DEVELOPMENT_SCOPE_REQUIRED "protected branch is not allowed: $T2_BRANCH" ;;
  esac
  if [[ "$T2_BRANCH" == detached/* ]]; then
    T2_NEXT_COMMAND='create a named development branch from origin/dev'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'detached HEADs are not allowed'
  fi
  if ! git -C "$T2_PROJECT_DIR" merge-base --is-ancestor "$T2_ORIGIN_DEV" "$T2_HEAD"; then
    T2_NEXT_COMMAND='rebase or merge the current origin/dev, then re-run the preflight'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'origin/dev is not an ancestor of HEAD'
  fi
  T2_MERGE_BASE="$(git -C "$T2_PROJECT_DIR" merge-base "$T2_ORIGIN_DEV" "$T2_HEAD" 2>/dev/null || true)"
  if [ "$T2_MERGE_BASE" != "$T2_ORIGIN_DEV" ]; then
    T2_NEXT_COMMAND='rebase or merge the current origin/dev, then re-run the preflight'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'merge-base is not the current origin/dev'
  fi
  if [ -n "$(git -C "$T2_PROJECT_DIR" status --porcelain=v1)" ]; then
    T2_NEXT_COMMAND='commit or restore the worktree before invoking Minikube validation'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'worktree is dirty'
  fi
  T2_WORKTREE_ID="$(printf '%s' "$T2_PROJECT_DIR" | shasum | awk '{print $1}')"
}

t2_profile_scope() {
  if [ -z "$T2_PROFILE" ] || [ -z "$T2_CONTEXT" ] || [ "$T2_PROFILE" != "$T2_CONTEXT" ]; then
    T2_NEXT_COMMAND='set MINIKUBE_PROFILE and CONTROL_API_REAL_PG_CONTEXT to the same generated profile'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'an explicit branch-owned profile and matching Kubernetes context are required'
  fi
  case "$T2_PROFILE" in
    *gke*|*prod*|*staging*|clerum-test|default|minikube)
      T2_NEXT_COMMAND='select the generated branch-owned Minikube profile for this worktree'
      t2_fail DEVELOPMENT_SCOPE_REQUIRED "profile is shared, non-local, or protected: $T2_PROFILE" ;;
  esac
  if [[ ! "$T2_PROFILE" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
    T2_NEXT_COMMAND='use the generated profile name without shell metacharacters'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'profile name is not a valid local Minikube identifier'
  fi
  if [ ! -f "$T2_PROFILE_ENV" ]; then
    T2_NEXT_COMMAND='generate profile.env and ports.env with the branch profile helper, then retry'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED "generated profile metadata is missing: $T2_PROFILE_ENV"
  fi
  local profile_name profile_repo profile_branch profile_sha profile_dirty
  profile_name="$(awk -F= '$1 == "PROFILE" {print substr($0, index($0,"=")+1); exit}' "$T2_PROFILE_ENV" 2>/dev/null || true)"
  profile_repo="$(awk -F= '$1 == "REPO_DIR" {print substr($0, index($0,"=")+1); exit}' "$T2_PROFILE_ENV" 2>/dev/null || true)"
  profile_branch="$(awk -F= '$1 == "BRANCH" {print substr($0, index($0,"=")+1); exit}' "$T2_PROFILE_ENV" 2>/dev/null || true)"
  profile_sha="$(awk -F= '$1 == "SHA_SHORT" {print substr($0, index($0,"=")+1); exit}' "$T2_PROFILE_ENV" 2>/dev/null || true)"
  profile_dirty="$(awk -F= '$1 == "DIRTY" {print substr($0, index($0,"=")+1); exit}' "$T2_PROFILE_ENV" 2>/dev/null || true)"
  if [ "$profile_name" != "$T2_PROFILE" ] || [ -z "$profile_repo" ] || [ -z "$profile_branch" ] || [ -z "$profile_sha" ]; then
    T2_NEXT_COMMAND='regenerate the profile metadata from the current worktree, then retry'
    t2_fail PROFILE_OWNERSHIP_MISMATCH 'profile metadata is incomplete or names a different profile'
  fi
  if [ "$profile_dirty" = true ]; then
    T2_NEXT_COMMAND='commit or restore the worktree, then regenerate the profile metadata'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'profile metadata was generated from a dirty worktree'
  fi
  if [ "$(t2_canonical_path "$profile_repo")" != "$T2_PROJECT_DIR" ]; then
    T2_NEXT_COMMAND='use the profile generated by this Evenfire worktree, not another worktree'
    t2_fail PROFILE_OWNERSHIP_MISMATCH 'profile metadata belongs to another worktree'
  fi
  if [ "$profile_branch" != "$T2_BRANCH" ]; then
    T2_NEXT_COMMAND='regenerate the profile for the current branch'
    t2_fail PROFILE_OWNERSHIP_MISMATCH 'profile branch does not match current branch'
  fi
  # A healthy branch-owned profile is reusable across commits. The cache SHA
  # is historical naming metadata; exact runtime identity is enforced below
  # by the pre-gate marker's gitHead/worktreeId pair, not by recreating a
  # Minikube cluster for every commit.
  if [ ! -f "$T2_PORTS_ENV" ]; then
    T2_NEXT_COMMAND='generate the profile-owned random ports before starting a gate'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED "profile-owned ports.env is missing: $T2_PORTS_ENV"
  fi
}

t2_context_check() {
  if ! kubectl --context="$T2_CONTEXT" config current-context >/dev/null 2>&1; then
    T2_NEXT_COMMAND='select the explicit Kubernetes context generated with the profile'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED "Kubernetes context is unavailable: $T2_CONTEXT"
  fi
  local endpoint host
  endpoint="$(t2_kc config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)"
  if [ -z "$endpoint" ]; then
    T2_NEXT_COMMAND='select a Kubernetes context with a resolvable local cluster endpoint'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED "Kubernetes context endpoint is unavailable: $T2_CONTEXT"
  fi
  host="${endpoint#*://}"
  host="${host%%/*}"
  if [[ "$host" == \[*\]* ]]; then
    host="${host#\[}"
    host="${host%%\]*}"
  else
    host="${host%%:*}"
  fi
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  case "$host" in
    127.0.0.1|localhost|::1|192.168.*|*.minikube) ;;
    *)
      T2_NEXT_COMMAND='select the generated branch-owned Minikube context, not a remote cluster context'
      t2_fail DEVELOPMENT_SCOPE_REQUIRED "Kubernetes context endpoint is not local: $host"
      ;;
  esac
}

t2_profile_status() {
  local status_json status_text
  status_json="$(t2_mk status --output=json 2>/dev/null || true)"
  status_text="$(t2_mk status 2>/dev/null || true)"
  if [ -z "$status_json" ] && [ -z "$status_text" ]; then
    T2_BOOTSTRAP_REQUIRED=true
    T2_PROFILE_HEALTHY=false
    T2_PLAN_STATE=full-bootstrap
    T2_PLAN_REASON='profile is missing or uninitialized'
    return 0
  fi
  if [[ "$status_text" == *Stopped* || "$status_text" == *Nonexistent* || "$status_text" == *'does not exist'* || "$status_text" == *'not found'* || "$status_json" == *'does not exist'* || "$status_json" == *'not found'* ]]; then
    T2_BOOTSTRAP_REQUIRED=true
    T2_PROFILE_HEALTHY=false
    T2_PLAN_STATE=full-bootstrap
    T2_PLAN_REASON='profile is missing or stopped'
    return 0
  fi
  if [[ "$status_text" != *Running* && "$status_json" != *Running* ]]; then
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-start"
    t2_fail PROFILE_UNHEALTHY "Minikube profile is not healthy: $T2_PROFILE"
  fi
  T2_PROFILE_HEALTHY=true
}

t2_marker_check() {
  T2_MARKER_JSON="$(t2_kc -n "$T2_CONTROL_NAMESPACE" get configmap "$T2_MARKER_NAME" -o json 2>/dev/null || true)"
  if [ -z "$T2_MARKER_JSON" ]; then
    T2_BOOTSTRAP_REQUIRED=true
    [ -n "$T2_PLAN_STATE" ] || T2_PLAN_STATE=full-bootstrap
    [ -n "$T2_PLAN_REASON" ] || T2_PLAN_REASON='pre-gate marker is missing'
    return 0
  fi
  local marker_values
  if ! marker_values="$(python3 - "$T2_MARKER_JSON" "$T2_WORKTREE_ID" "$T2_HEAD" 2>&1 <<'PY'
import json
import sys
data = (json.loads(sys.argv[1]).get("data") or {})
for key in ("clusterFingerprint", "gitHead", "worktreeId"):
    if not data.get(key):
        raise SystemExit("missing:" + key)
if data.get("worktreeId") != sys.argv[2]:
    raise SystemExit("ownership")
if data.get("gitHead") != sys.argv[3]:
    raise SystemExit("head")
print("\t".join([data.get("clusterFingerprint", ""), data.get("imageSource", ""), data.get("imageTag", "")]))
PY
  )"; then
    case "$marker_values" in
      *ownership*) T2_NEXT_COMMAND='run pre-gate-sync for this worktree/profile, then retry'; t2_fail PROFILE_OWNERSHIP_MISMATCH 'pre-gate marker belongs to another worktree' ;;
      *head*) T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-pre-gate-sync GATE=minikube-t2"; t2_fail HEAD_MARKER_MISMATCH 'pre-gate marker does not match current HEAD' ;;
      *) T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"; t2_fail BOOTSTRAP_REQUIRED 'pre-gate marker is incomplete' ;;
    esac
  fi
  IFS=$'\t' read -r T2_CLUSTER_FINGERPRINT T2_IMAGE_SOURCE T2_IMAGE_TAG <<< "$marker_values"
}

t2_image_check() {
  if [ ! -f "$T2_IMAGE_MANIFEST" ]; then
    if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
      T2_PLAN_STATE=full-bootstrap
      T2_PLAN_REASON='image manifest is absent'
      return 0
    fi
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    t2_fail IMAGE_MANIFEST_MISMATCH "image manifest is missing: $T2_IMAGE_MANIFEST"
  fi
  local manifest_values
  if ! manifest_values="$(python3 - "$T2_IMAGE_MANIFEST" <<'PY'
import json
import sys
from pathlib import Path
try:
    payload = json.loads(Path(sys.argv[1]).read_text())
except (OSError, ValueError):
    raise SystemExit("invalid")
source = payload.get("imageSource") or payload.get("source") or payload.get("mode") or ""
tag = payload.get("imageTag") or payload.get("tag") or ""
# Local builds are identified by the per-image digests in the manifest and
# intentionally have no registry tag. GHCR manifests still require a tag.
images = payload.get("images")
if source not in {"local", "ghcr"} or (source == "ghcr" and not tag):
    raise SystemExit("missing")
if source == "local":
    import re
    if not isinstance(images, dict) or not images:
        raise SystemExit("local-images")
    digest = re.compile(r"^sha256:[0-9a-fA-F]{64}$")
    if any(not isinstance(name, str) or not name or not isinstance(value, str) or not digest.fullmatch(value) for name, value in images.items()):
        raise SystemExit("local-digests")
print(source + "\t" + tag)
PY
  )"; then
    if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
      T2_PLAN_STATE=full-bootstrap
      T2_PLAN_REASON='image manifest is invalid or has no source/tag; bootstrap will replace it'
      return 0
    fi
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    t2_fail IMAGE_MANIFEST_MISMATCH 'image manifest is invalid or incomplete for its image source'
  fi
  local manifest_source manifest_tag
  IFS=$'\t' read -r manifest_source manifest_tag <<< "$manifest_values"
  if { [ -n "$T2_IMAGE_SOURCE" ] && [ "$manifest_source" != "$T2_IMAGE_SOURCE" ]; } ||
     { [ -n "$T2_IMAGE_TAG" ] && [ "$manifest_tag" != "$T2_IMAGE_TAG" ]; }; then
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    t2_fail IMAGE_MANIFEST_MISMATCH 'image manifest does not match the deployed marker'
  fi
  T2_IMAGE_SOURCE="$manifest_source"
  T2_IMAGE_TAG="$manifest_tag"
}

t2_get_name() {
  printf '%s\t%s\n' "$(printf '%s' "$1" | cut -d/ -f1)" "$(printf '%s' "$1" | cut -d/ -f2-)"
}

t2_resource_checks() {
  local item namespace name
  for namespace in $T2_REQUIRED_NAMESPACES; do
    if ! t2_kc get namespace "$namespace" >/dev/null 2>&1; then
      if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
        T2_PLAN_STATE=full-bootstrap
        T2_PLAN_REASON="namespace $namespace is not present"
        continue
      fi
      T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
      t2_fail PROFILE_UNHEALTHY "required namespace is missing: $namespace"
    fi
  done
  for item in $T2_REQUIRED_SERVICES; do
    IFS=$'\t' read -r namespace name <<< "$(t2_get_name "$item")"
    if ! t2_kc -n "$namespace" get service "$name" >/dev/null 2>&1; then
      if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
        T2_PLAN_STATE=full-bootstrap
        T2_PLAN_REASON="service $item is not present"
        continue
      fi
      T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
      t2_fail PROFILE_UNHEALTHY "required Service is missing: $item"
    fi
  done
  for item in $T2_REQUIRED_SECRETS; do
    IFS=$'\t' read -r namespace name <<< "$(t2_get_name "$item")"
    if ! t2_kc -n "$namespace" get secret "$name" >/dev/null 2>&1; then
      if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
        T2_PLAN_STATE=full-bootstrap
        T2_PLAN_REASON="Secret $item is not present"
        continue
      fi
      T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
      t2_fail SECRET_MISSING "required Secret is missing: $namespace/$name"
    fi
  done
  for item in $T2_REQUIRED_CONFIGMAPS; do
    IFS=$'\t' read -r namespace name <<< "$(t2_get_name "$item")"
    if ! t2_kc -n "$namespace" get configmap "$name" >/dev/null 2>&1; then
      if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
        T2_PLAN_STATE=full-bootstrap
        T2_PLAN_REASON="ConfigMap $item is not present"
        continue
      fi
      T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
      t2_fail CONFIGMAP_MISSING "required ConfigMap is missing: $namespace/$name"
    fi
  done
}

t2_postgres_check() {
  local namespace name pvc_json phase
  IFS=$'\t' read -r namespace name <<< "$(t2_get_name "$T2_REQUIRED_PVC")"
  pvc_json="$(t2_kc -n "$namespace" get pvc "$name" -o json 2>/dev/null || true)"
  if [ -z "$pvc_json" ]; then
    if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
      T2_PLAN_STATE=full-bootstrap
      T2_PLAN_REASON="PVC $T2_REQUIRED_PVC is not present"
      return 0
    fi
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    t2_fail POSTGRES_NOT_READY "required PVC is missing: $T2_REQUIRED_PVC"
  fi
  phase="$(python3 - "$pvc_json" <<'PY'
import json
import sys
print((json.loads(sys.argv[1]).get("status") or {}).get("phase", ""))
PY
  )"
  if [ "$phase" != Bound ]; then
    if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
      T2_PLAN_STATE=full-bootstrap
      T2_PLAN_REASON="PVC $T2_REQUIRED_PVC is not Bound"
      return 0
    fi
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    t2_fail POSTGRES_NOT_READY "PostgreSQL PVC is not Bound: $T2_REQUIRED_PVC ($phase)"
  fi
  if ! t2_kc -n "$namespace" get service control-postgres >/dev/null 2>&1; then
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    t2_fail POSTGRES_NOT_READY 'control-postgres Service is missing'
  fi
  if ! t2_kc -n "$namespace" rollout status deployment/control-postgres --timeout="${T2_TIMEOUT_SECONDS}s" >/dev/null 2>&1; then
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    t2_fail POSTGRES_NOT_READY "control-postgres did not become Ready within $T2_TIMEOUT_SECONDS seconds"
  fi
}

t2_deployment_check() {
  local deployment_json
  deployment_json="$(t2_kc get deployments -A -o json 2>/dev/null || true)"
  if [ -z "$deployment_json" ]; then
    if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
      T2_PLAN_STATE=full-bootstrap
      T2_PLAN_REASON='deployment readiness inventory is unavailable'
      return 0
    fi
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"
    t2_fail PROFILE_UNHEALTHY 'deployment readiness inventory is unavailable'
  fi
  if ! python3 - "$deployment_json" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
bad = []
for item in payload.get("items", []):
    metadata = item.get("metadata") or {}
    spec = item.get("spec") or {}
    status = item.get("status") or {}
    desired = int(spec.get("replicas") or 0)
    if desired == 0:
        continue
    ready = int(status.get("readyReplicas") or 0)
    available = int(status.get("availableReplicas") or 0)
    if ready < desired or available < desired:
        bad.append("%s/%s %s/%s" % (metadata.get("namespace", "?"), metadata.get("name", "?"), ready, desired))
if bad:
    print("; ".join(bad), file=sys.stderr)
    raise SystemExit(1)
PY
  then
    if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
      T2_PLAN_STATE=full-bootstrap
      T2_PLAN_REASON='one or more deployments are not Ready'
      return 0
    fi
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-t2"
    t2_fail PROFILE_UNHEALTHY 'one or more deployments are not Ready'
  fi
}

t2_process_check() {
  local process_lines allowed pid command_line pid_file profile_safe
  process_lines="$(ps -ef 2>/dev/null | awk '/[p]ort-forward/ && /kubectl/ {print}' || true)"
  [ -z "$process_lines" ] && return 0
  profile_safe="${T2_PROFILE//[^A-Za-z0-9_.-]/_}"
  while IFS= read -r command_line; do
    [ -z "$command_line" ] && continue
    [[ "$command_line" == *"$T2_PROFILE"* || "$command_line" == *"$T2_CONTEXT"* ]] || continue
    allowed=false
    for pid_file in "$T2_PROFILE_ROOT/$T2_PROFILE"/pids/*.pid; do
      [ -f "$pid_file" ] || continue
      pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
      [[ -n "$pid" && "$command_line" == *" $pid "* ]] && allowed=true
    done
    # pf-all-stack.sh is the canonical gate forwarder and records its child
    # PIDs in /tmp/pf-<profile>-*.pid. Accept those PIDs as profile-owned too;
    # otherwise T1 rejects the forwards that pre-gate-sync just started.
    for pid_file in "/tmp/pf-${profile_safe}-"*.pid; do
      [ -f "$pid_file" ] || continue
      pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
      [[ -n "$pid" && "$command_line" == *" $pid "* ]] && allowed=true
    done
    if [ "$allowed" != true ]; then
      T2_NEXT_COMMAND='stop the unrelated profile port-forward or select the owner worktree; do not share it'
      t2_fail PORT_FORWARD_CONFLICT 'a port-forward for this profile is owned by another process'
    fi
  done <<< "$process_lines"
}

t2_classify_transition() {
  if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
    T2_PLAN_STATE=full-bootstrap
    [ -n "$T2_PLAN_REASON" ] || T2_PLAN_REASON='profile is not bootstrapped'
    return 0
  fi
  local changed infra=false path
  changed="$(git -C "$T2_PROJECT_DIR" diff --name-only "$T2_ORIGIN_DEV...$T2_HEAD")"
  if [ -z "$changed" ]; then
    T2_PLAN_STATE=targeted-sync
    T2_PLAN_REASON='no source changes after exact marker'
    return 0
  fi
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      deploy/*|charts/*|scripts/minikube/*|scripts/e2e/*|Makefile|AGENTS.md|.github/workflows/*)
        infra=true
        break
        ;;
    esac
  done <<< "$changed"
  if [ "$infra" = true ]; then
    T2_PLAN_STATE=full-reconcile
    T2_PLAN_REASON='infrastructure, manifest, CRD, policy, storage, or orchestration input changed'
  else
    T2_PLAN_STATE=targeted-sync
    T2_PLAN_REASON='changes are limited to service/package source inputs'
  fi
}

t2_lock_acquire() {
  mkdir -p "$T2_LOCK_ROOT"
  T2_LOCK_DIR="$T2_LOCK_ROOT/$T2_PROFILE.lock"
  T2_LOCK_KEY="$(printf '%s\0%s\0%s\0%s' "$T2_PROJECT_DIR" "$T2_BRANCH" "$T2_HEAD" "$T2_PROFILE" | shasum | awk '{print $1}')"
  if ! mkdir "$T2_LOCK_DIR" 2>/dev/null; then
    local existing_pid
    existing_pid="$(sed -n 's/^PID=//p' "$T2_LOCK_DIR/owner.env" 2>/dev/null | head -1 || true)"
    if [[ ! "$existing_pid" =~ ^[0-9]+$ ]]; then
      T2_NEXT_COMMAND='verify no T2 process owns the lock, then follow the orphaned-lock recovery steps in docs/testing/minikube-t2-runbook.md'
      t2_fail PROFILE_BUSY "profile $T2_PROFILE has a lock without a valid owner PID"
    fi
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      T2_NEXT_COMMAND="wait for PID $existing_pid to finish, then retry the same profile"
      t2_fail PROFILE_BUSY "profile $T2_PROFILE is locked by PID $existing_pid"
    fi
    rm -rf "$T2_LOCK_DIR"
    mkdir "$T2_LOCK_DIR" 2>/dev/null || {
      T2_NEXT_COMMAND='retry after the profile lock is released'
      t2_fail PROFILE_BUSY "unable to reclaim the profile lock: $T2_PROFILE"
    }
  fi
  umask 077
  cat >"$T2_LOCK_DIR/owner.env" <<EOF
REPOSITORY=$T2_PROJECT_DIR
BRANCH=$T2_BRANCH
HEAD=$T2_HEAD
PROFILE=$T2_PROFILE
CONTEXT=$T2_CONTEXT
LOCK_KEY=$T2_LOCK_KEY
PID=$$
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  T2_LOCK_HELD=true
  trap t2_lock_release EXIT INT TERM
}

t2_lock_release() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$T2_LOCK_HELD" = true ] && [ -n "$T2_LOCK_DIR" ]; then
    local owner_pid
    owner_pid="$(sed -n 's/^PID=//p' "$T2_LOCK_DIR/owner.env" 2>/dev/null | head -1 || true)"
    if [ "$owner_pid" = "$$" ]; then rm -rf "$T2_LOCK_DIR"; fi
  fi
  if [ -n "$T2_EVIDENCE_FILE" ] && [ -f "$T2_EVIDENCE_FILE" ] && [ -n "$T2_ERROR_CODE" ]; then
    t2_evidence_write failure FAIL "$T2_ERROR_CODE"
  fi
  exit "$status"
}

t2_evidence_init() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  T2_EVIDENCE_DIR="$T2_EVIDENCE_ROOT/$stamp-$(printf '%s' "$T2_HEAD" | cut -c1-12)"
  T2_EVIDENCE_FILE="$T2_EVIDENCE_DIR/evidence.json"
  umask 077
  mkdir -p "$T2_EVIDENCE_DIR/logs"
  t2_evidence_write preflight RUNNING ''
}

t2_evidence_write() {
  local phase="$1" status="$2" detail="$3" file
  [ -n "$T2_EVIDENCE_FILE" ] || return 0
  file="$T2_EVIDENCE_FILE.tmp"
  PHASE="$phase" STATUS="$status" DETAIL="$detail" \
  T2_PROJECT_DIR="$T2_PROJECT_DIR" T2_BRANCH="$T2_BRANCH" T2_HEAD="$T2_HEAD" \
  T2_ORIGIN_DEV="$T2_ORIGIN_DEV" T2_MERGE_BASE="$T2_MERGE_BASE" \
  T2_PROFILE="$T2_PROFILE" T2_CONTEXT="$T2_CONTEXT" T2_CLUSTER_FINGERPRINT="$T2_CLUSTER_FINGERPRINT" \
  T2_EVIDENCE_DIR="$T2_EVIDENCE_DIR" \
  T2_IMAGE_MANIFEST="$T2_IMAGE_MANIFEST" T2_IMAGE_SOURCE="$T2_IMAGE_SOURCE" T2_IMAGE_TAG="$T2_IMAGE_TAG" \
  python3 - "$file" "$T2_EVIDENCE_FILE" <<'PY'
import json
import os
from pathlib import Path
path = Path(os.sys.argv[1])
prior_path = Path(os.sys.argv[2])
prior = {}
if prior_path.exists():
    try: prior = json.loads(prior_path.read_text())
    except ValueError: prior = {}
prior.setdefault("evidenceVersion", 1)
def redact(value):
    import re
    value = str(value or "")
    value = re.sub(r"postgres(?:ql)?://[^\s\"'<>]+", "<postgres-dsn-redacted>", value)
    value = re.sub(r"(?i)(bearer\s+)[^\s]+", r"\1<token-redacted>", value)
    value = re.sub(r"-----BEGIN [^-]+-----.*?-----END [^-]+-----", "<private-key-redacted>", value, flags=re.S)
    value = re.sub(r"(?i)(?:password|token|secret|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,;]+", "<secret-assignment-redacted>", value)
    return value

prior.update({
    "repository": os.environ.get("T2_PROJECT_DIR", ""),
    "branch": os.environ.get("T2_BRANCH", ""),
    "head": os.environ.get("T2_HEAD", ""),
    "originDev": os.environ.get("T2_ORIGIN_DEV", ""),
    "mergeBase": os.environ.get("T2_MERGE_BASE", ""),
    "worktree": os.environ.get("T2_PROJECT_DIR", ""),
    "profile": os.environ.get("T2_PROFILE", ""),
    "context": os.environ.get("T2_CONTEXT", ""),
    "clusterFingerprintRef": os.environ.get("T2_CLUSTER_FINGERPRINT", ""),
    "imageManifestRef": os.environ.get("T2_IMAGE_MANIFEST", ""),
    "localLogDirectory": os.path.join(os.environ.get("T2_EVIDENCE_DIR", ""), "logs"),
    "imageSource": os.environ.get("T2_IMAGE_SOURCE", ""),
    "imageTag": os.environ.get("T2_IMAGE_TAG", ""),
    "phase": os.environ.get("PHASE", ""),
    "status": os.environ.get("STATUS", ""),
    "detail": redact(os.environ.get("DETAIL", "")),
})
prior.setdefault("phases", []).append({
    "name": os.environ.get("PHASE", ""),
    "status": os.environ.get("STATUS", ""),
    "timestamp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
})
path.write_text(json.dumps(prior, indent=2, sort_keys=True) + "\n")
PY
  mv -- "$file" "$T2_EVIDENCE_FILE"
}

t2_write_plan() {
  local plan_file="$1"
  [ -n "$plan_file" ] || return 0
  PLAN_STATE="$T2_PLAN_STATE" PLAN_REASON="$T2_PLAN_REASON" python3 - "$plan_file" <<'PY'
import json
import os
from pathlib import Path
Path(os.sys.argv[1]).write_text(json.dumps({
    "state": os.environ.get("PLAN_STATE", ""),
    "reason": os.environ.get("PLAN_REASON", ""),
}, sort_keys=True) + "\n")
PY
}
