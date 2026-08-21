#!/usr/bin/env bash
# Secret-safe helpers for the local Evenfire Minikube T0/T1/T2 contract.
# shellcheck disable=SC2034,SC2269
set -eo pipefail
set +x
set +u

T2_SCRIPT_DIR="$T2_SCRIPT_DIR"
if [ -z "$T2_SCRIPT_DIR" ]; then T2_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"; fi
# shellcheck source=profile-readiness.sh
. "$T2_SCRIPT_DIR/profile-readiness.sh"
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
T2_PLAN_MODE="$T2_PLAN_MODE"
if [ -z "$T2_PLAN_MODE" ]; then T2_PLAN_MODE=false; fi
T2_BOOTSTRAP_REQUIRED=false
T2_PROFILE_HEALTHY=false
T2_PROFILE_STATUS=unknown
T2_CONTEXT_IDENTITY_VERIFIED=false
T2_UNREADY_DEPLOYMENTS=""
T2_MARKER_MATCHES_HEAD=false
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
T2_LOCK_RELEASED=false
T2_LOCK_TOKEN="$T2_LOCK_TOKEN"
T2_RUN_ID="$T2_RUN_ID"
T2_GATE_ID="$T2_GATE_ID"
if [ -z "$T2_GATE_ID" ]; then T2_GATE_ID=minikube-t2; fi
T2_CERTIFICATION_VERSION=1
T2_T0_CERTIFIED=false
T2_T1_CERTIFIED=false
T2_PRIOR_ATTESTATION=""
T2_PRIOR_T0_ATTESTATION=""
T2_PRIOR_T1_ATTESTATION=""

T2_REQUIRED_NAMESPACES="$T2_REQUIRED_NAMESPACES"
if [ -z "$T2_REQUIRED_NAMESPACES" ]; then T2_REQUIRED_NAMESPACES="control-plane gfs mcp-host mcp-server profiles rpc-proxy channels sandbox-recipes sandbox-ui webhook-ingress registry"; fi
T2_REQUIRED_SERVICES="$T2_REQUIRED_SERVICES"
if [ -z "$T2_REQUIRED_SERVICES" ]; then T2_REQUIRED_SERVICES="control-plane/control-postgres control-plane/control-api control-plane/control-ui control-plane/host-context-controller control-plane/workflow-recipes profiles/external-rest-api profiles/profile-ui rpc-proxy/rpc-proxy mcp-server/mcp-proxy"; fi
T2_REQUIRED_DEPLOYMENTS="$T2_REQUIRED_DEPLOYMENTS"
if [ -z "$T2_REQUIRED_DEPLOYMENTS" ]; then T2_REQUIRED_DEPLOYMENTS="control-plane/control-api control-plane/host-context-controller profiles/external-rest-api rpc-proxy/rpc-proxy mcp-host/chatllm"; fi
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
  local context_name
  context_name="$(kubectl config get-contexts -o name 2>/dev/null | awk -v target="$T2_CONTEXT" '$0 == target {print; exit}')"
  if [ "$context_name" != "$T2_CONTEXT" ]; then
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
  if [[ "$host" == 127.0.0.1 || "$host" == localhost || "$host" == ::1 || "$host" == *.minikube ]]; then
    return 0
  fi
  if ! python3 - "$host" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
raise SystemExit(0 if (address.is_private or address.is_loopback or address.is_link_local) else 1)
PY
  then
    T2_NEXT_COMMAND='select the generated branch-owned Minikube context, not a remote cluster context'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED "Kubernetes context endpoint is not local: $host"
    return 1
  fi
}

t2_profile_context_identity_check() {
  # A localhost API endpoint is necessary but not sufficient: kubeconfig can
  # point at another local Minikube profile, and a broad RFC1918 allowlist can
  # point at an unrelated LAN cluster. Bind the context to the exact profile
  # identity and node address reported by the selected Minikube instance.
  if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
    return 0
  fi
  local expected_ip nodes_json
  expected_ip="$(t2_mk ip 2>/dev/null || true)"
  if [ -z "$expected_ip" ]; then
    T2_NEXT_COMMAND='start the verified branch-owned Minikube profile, then retry the gate'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED "Minikube did not report an IP for profile $T2_PROFILE"
    return 1
  fi
  nodes_json="$(t2_kc get nodes -o json 2>/dev/null || true)"
  if [ -z "$nodes_json" ] || ! python3 - "$nodes_json" "$T2_PROFILE" "$expected_ip" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
profile = sys.argv[2]
expected_ip = sys.argv[3]
for node in payload.get("items", []):
    metadata = node.get("metadata") or {}
    labels = metadata.get("labels") or {}
    if labels.get("minikube.k8s.io/name") != profile:
        continue
    for address in (node.get("status") or {}).get("addresses", []):
        if address.get("type") == "InternalIP" and address.get("address") == expected_ip:
            raise SystemExit(0)
raise SystemExit(1)
PY
  then
    T2_NEXT_COMMAND='select the kube-context generated for this exact branch-owned Minikube profile'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED "Kubernetes context does not identify Minikube profile $T2_PROFILE at $expected_ip"
    return 1
  fi
  T2_CONTEXT_IDENTITY_VERIFIED=true
}

t2_profile_status() {
  local status_text status_rc=0
  status_text="$(t2_mk status 2>/dev/null)" || status_rc=$?
  if [ -z "$status_text" ]; then
    T2_PROFILE_STATUS=missing
    T2_BOOTSTRAP_REQUIRED=true
    T2_PROFILE_HEALTHY=false
    T2_PLAN_STATE=full-bootstrap
    T2_PLAN_REASON='profile is missing or uninitialized'
    return 0
  fi
  if minikube_profile_status_is_missing_or_stopped "$status_text"; then
    T2_PROFILE_STATUS=stopped
    T2_BOOTSTRAP_REQUIRED=true
    T2_PROFILE_HEALTHY=false
    T2_PLAN_STATE=full-bootstrap
    T2_PLAN_REASON='profile is missing or stopped'
    return 0
  fi
  if [ "$status_rc" -ne 0 ] || ! minikube_profile_status_is_healthy "$status_text"; then
    T2_PROFILE_STATUS=unhealthy
    T2_PROFILE_HEALTHY=false
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-start"
    t2_fail PROFILE_UNHEALTHY "Minikube profile is not healthy: $T2_PROFILE"
  fi
  T2_PROFILE_STATUS=healthy
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
      *head*)
        # Standalone preflight is fail-loud. The orchestrator planner
        # (T2_PLAN_MODE=true) must keep going so it can select targeted-sync
        # or full-reconcile and update the marker.
        if [ "$T2_PLAN_MODE" = true ]; then
          T2_MARKER_MATCHES_HEAD=false
          T2_PLAN_REASON='pre-gate marker does not match current HEAD'
          return 0
        fi
        T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-t2"
        t2_fail HEAD_MARKER_MISMATCH 'pre-gate marker does not match current HEAD'
        ;;
      *) T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-setup-local"; t2_fail BOOTSTRAP_REQUIRED 'pre-gate marker is incomplete' ;;
    esac
  fi
  T2_MARKER_MATCHES_HEAD=true
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
  local deployment_json unready
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
  if ! unready="$(python3 - "$deployment_json" "$T2_REQUIRED_DEPLOYMENTS" 2>/dev/null <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
required_refs = {}
for ref in sys.argv[2].split():
    namespace, separator, name = ref.partition("/")
    if not separator or not namespace or not name:
        raise ValueError("invalid required deployment reference")
    required_refs[(namespace, name)] = None
bad = []
for item in payload.get("items", []):
    metadata = item.get("metadata") or {}
    identity = (metadata.get("namespace"), metadata.get("name"))
    if identity in required_refs:
        required_refs[identity] = item

for (namespace, name), item in required_refs.items():
    if item is None:
        bad.append(f"{namespace}/{name} missing")
        continue
    spec = item.get("spec") or {}
    status = item.get("status") or {}
    def integer(value, field):
        if value in (None, ""):
            return 0
        if isinstance(value, bool):
            raise ValueError(field)
        return int(value)

    desired = integer(spec.get("replicas"), "spec.replicas")
    # A present deployment explicitly scaled to zero is an intentional local
    # suspension; it is not an unready pod.
    if desired == 0:
        continue
    ready = integer(status.get("readyReplicas"), "status.readyReplicas")
    available = integer(status.get("availableReplicas"), "status.availableReplicas")
    updated = integer(status.get("updatedReplicas"), "status.updatedReplicas")
    unavailable = integer(status.get("unavailableReplicas"), "status.unavailableReplicas")
    generation = integer(metadata.get("generation"), "metadata.generation")
    observed = integer(status.get("observedGeneration"), "status.observedGeneration")
    if generation <= 0 or observed != generation or updated < desired or ready < desired or available < desired or unavailable != 0:
        bad.append("%s/%s ready=%s/%s updated=%s observed=%s/%s unavailable=%s" % (
            namespace, name, ready, desired,
            updated, observed, generation, unavailable))
print("; ".join(bad))
PY
  )"; then
    if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
      T2_PLAN_STATE=full-bootstrap
      T2_PLAN_REASON='deployment readiness inventory is invalid'
      return 0
    fi
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-t2"
    t2_fail PROFILE_UNHEALTHY 'deployment readiness inventory is invalid'
  fi
  if [ -n "$unready" ]; then
    if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
      T2_PLAN_STATE=full-bootstrap
      T2_PLAN_REASON="one or more deployments are not Ready: $unready"
      return 0
    fi
    if [ "$T2_PLAN_MODE" = true ]; then
      # Orchestrator planner: a bootstrapped profile with an unready required
      # deployment is repaired by a full reconcile inside the same run.
      # Failing PROFILE_UNHEALTHY here would abort before any transition is
      # selected and force manual repair scripts. The standalone preflight and
      # the final exact-head check run with T2_PLAN_MODE=false and stay
      # fail-loud below.
      T2_UNREADY_DEPLOYMENTS="$unready"
      return 0
    fi
    T2_NEXT_COMMAND="MINIKUBE_PROFILE=$T2_PROFILE make minikube-t2"
    t2_fail PROFILE_UNHEALTHY "one or more deployments are not Ready: $unready"
  fi
}

t2_pid_file_matches_process() {
  local pid_file="$1" pid="$2" recorded_pid recorded_start actual_start
  recorded_pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
  recorded_start="$(sed -n 's/^PROCESS_START=//p' "$pid_file" 2>/dev/null | head -1 || true)"
  [ "$recorded_pid" = "$pid" ] || return 1
  [ -n "$recorded_start" ] || return 1
  [ "$recorded_start" = unavailable ] && return 0
  actual_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
  [ -n "$actual_start" ] && [ "$actual_start" = "$recorded_start" ]
}

t2_process_check() {
  local uid pid ppid rest command_line comm allowed pid_file recorded_pid
  local safe_profile
  safe_profile="$(printf '%s' "$T2_PROFILE" | tr -c 'A-Za-z0-9_.-' '_')"
  # Only real kubectl port-forward processes. A wrapper whose argv merely
  # mentions those words is not a port-forward (rejected by comm=kubectl).
  # Default IFS so UID/PID/PPID split. `IFS=` left pid empty and skipped every line.
  # awk is a loose pre-filter: kubectl as argv0/path token AND a later
  # standalone port-forward token. Flags may sit between those tokens.
  while read -r uid pid ppid rest; do
    [ -n "$pid" ] || continue
    command_line="$uid $pid $ppid $rest"
    comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
    case "$comm" in
      *kubectl*) ;;
      *) continue ;;
    esac
    allowed=false
    for pid_file in \
      "$T2_PROFILE_ROOT/$T2_PROFILE"/pids/*.pid \
      /tmp/pf-"$safe_profile"-*.pid; do
      [ -f "$pid_file" ] || continue
      recorded_pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
      if [ "$recorded_pid" = "$pid" ] && t2_pid_file_matches_process "$pid_file" "$pid"; then
        allowed=true
      fi
    done
    # pf-all-stack.sh is the canonical gate forwarder and records its child
    # PIDs in /tmp/pf-<profile>-*.pid. Accept those PIDs as profile-owned too;
    # otherwise T1 rejects the forwards that pre-gate-sync just started.
    for pid_file in "/tmp/pf-${safe_profile}-"*.pid; do
      [ -f "$pid_file" ] || continue
      recorded_pid="$(sed -n '1p' "$pid_file" 2>/dev/null || true)"
      if [[ -n "$recorded_pid" && "$command_line" == *" $recorded_pid "* ]] &&
         t2_pid_file_matches_process "$pid_file" "$recorded_pid"; then
        allowed=true
      fi
    done
    # Unrelated developer forwards launched without --context are not
    # attributable to this profile and must not make its gate red. A forward
    # that names this profile/context, or one recorded in this profile's PID
    # registry, is attributable and must be owned by this run.
    if [[ "$command_line" != *"$T2_PROFILE"* && "$command_line" != *"$T2_CONTEXT"* && "$allowed" != true ]]; then
      continue
    fi
    if [ "$allowed" != true ]; then
      T2_NEXT_COMMAND='stop the unrelated profile port-forward or select the owner worktree; do not share it'
      t2_fail PORT_FORWARD_CONFLICT 'a port-forward for this profile is owned by another process'
      return 1
    fi
  done < <(ps -ef 2>/dev/null | awk '/([^[:space:]]*\/)?kubectl([[:space:]]|$)/ && /[[:space:]]port-forward([[:space:]]|$)/ {print}' || true)
}

t2_classify_transition() {
  if [ "$T2_BOOTSTRAP_REQUIRED" = true ]; then
    T2_PLAN_STATE=full-bootstrap
    [ -n "$T2_PLAN_REASON" ] || T2_PLAN_REASON='profile is not bootstrapped'
    return 0
  fi
  if [ -n "$T2_UNREADY_DEPLOYMENTS" ]; then
    # Recorded by t2_deployment_check in planner mode only. Reconcile the
    # running profile in place; an unready deployment must never certify as
    # already-synced nor stop the orchestrator before a transition exists.
    T2_PLAN_STATE=full-reconcile
    T2_PLAN_REASON="deployment not Ready: $T2_UNREADY_DEPLOYMENTS"
    return 0
  fi
  if [ "$T2_MARKER_MATCHES_HEAD" = true ]; then
    T2_PLAN_STATE=already-synced
    T2_PLAN_REASON='pre-gate marker already matches HEAD'
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
      deploy/*|charts/*)
        infra=true
        break
        ;;
    esac
  done <<< "$changed"
  if [ "$infra" = true ]; then
    T2_PLAN_STATE=full-reconcile
    T2_PLAN_REASON='infrastructure, manifest, CRD, policy, storage, or overlay input changed'
  else
    T2_PLAN_STATE=targeted-sync
    T2_PLAN_REASON='changes are limited to service, package, harness, or documentation inputs'
  fi
}

t2_lock_owner_value() {
  local key="$1"
  [ -f "$T2_LOCK_DIR/owner.env" ] || return 1
  sed -n "s/^$key=//p" "$T2_LOCK_DIR/owner.env" | head -1
}

t2_lock_key() {
  printf '%s\0%s\0%s\0%s\0%s' \
    "$T2_PROJECT_DIR" "$T2_BRANCH" "$T2_HEAD" "$T2_PROFILE" "$T2_CONTEXT" |
    shasum | awk '{print $1}'
}

t2_lock_profile_id_check() {
  if [[ ! "$T2_PROFILE" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
    T2_NEXT_COMMAND='use the generated profile name without path separators or shell metacharacters'
    t2_fail DEVELOPMENT_SCOPE_REQUIRED 'profile lock identifier is not a safe local profile name'
    return 1
  fi
}

t2_lock_process_matches() {
  local pid="$1" expected_start actual_start state
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  state="$(ps -p "$pid" -o state= 2>/dev/null | tr -d '[:space:]' || true)"
  [ -z "$state" ] || [[ "$state" != Z* ]] || return 1
  expected_start="$(t2_lock_owner_value PROCESS_START || true)"
  [ -n "$expected_start" ] || return 1
  # Some macOS/sandboxed ps implementations hide lstart/state. The opaque
  # token and live PID still fence the child in that environment; use the
  # stronger start-time comparison whenever the platform exposes it.
  [ "$expected_start" = unavailable ] && return 0
  actual_start="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
  [ -z "$actual_start" ] || [ "$actual_start" = "$expected_start" ]
}

t2_lock_acquire() {
  local process_start
  t2_lock_profile_id_check || return 1
  mkdir -p "$T2_LOCK_ROOT"
  T2_LOCK_DIR="$T2_LOCK_ROOT/$T2_PROFILE.lock"
  T2_LOCK_KEY="$(t2_lock_key)"
  if [ -e "$T2_LOCK_DIR" ] || [ -L "$T2_LOCK_DIR" ]; then
    if [ -L "$T2_LOCK_DIR" ] || [ ! -d "$T2_LOCK_DIR" ]; then
      T2_NEXT_COMMAND='remove the unsafe profile-lock path manually after verifying the profile owner'
      t2_fail PROFILE_BUSY "profile lock path is not a directory: $T2_LOCK_DIR"
      return 1
    fi
    local existing_pid existing_token existing_start reclaim_dir
    existing_pid="$(t2_lock_owner_value PID || true)"
    existing_token="$(t2_lock_owner_value TOKEN || true)"
    existing_start="$(t2_lock_owner_value PROCESS_START || true)"
    if [[ ! "$existing_pid" =~ ^[0-9]+$ ]] || [ -z "$existing_token" ] || [ -z "$existing_start" ]; then
      T2_NEXT_COMMAND='verify no T2 process owns the lock, then follow the orphaned-lock recovery steps in docs/testing/minikube-t2-runbook.md'
      t2_fail PROFILE_BUSY "profile $T2_PROFILE has an orphaned lock without a valid owner identity"
      return 1
    fi
    if t2_lock_process_matches "$existing_pid"; then
      T2_NEXT_COMMAND="wait for PID $existing_pid to finish, then retry the same profile"
      t2_fail PROFILE_BUSY "profile $T2_PROFILE is locked by PID $existing_pid"
      return 1
    fi

    # Reclaim ownership is itself acquired atomically inside the stale lock.
    # With two concurrent reclaimers, exactly one can create this directory;
    # every loser fails closed before it can remove either the stale lock or a
    # replacement lock created by the winner. If a reclaimer is killed while
    # holding this claim, the marker deliberately remains and requires the
    # documented orphan-lock recovery rather than permitting an unsafe retry.
    reclaim_dir="$T2_LOCK_DIR/.reclaim"
    if ! mkdir "$reclaim_dir" 2>/dev/null; then
      T2_NEXT_COMMAND='wait for the stale-lock reclaimer to finish; if it died, follow the orphaned-lock recovery steps in docs/testing/minikube-t2-runbook.md'
      t2_fail PROFILE_BUSY "profile $T2_PROFILE stale lock is already being reclaimed"
      return 1
    fi

    # Revalidate after winning the claim. A changed or live owner means the
    # original stale observation is no longer authoritative.
    existing_pid="$(t2_lock_owner_value PID || true)"
    existing_token="$(t2_lock_owner_value TOKEN || true)"
    existing_start="$(t2_lock_owner_value PROCESS_START || true)"
    if [[ ! "$existing_pid" =~ ^[0-9]+$ ]] || [ -z "$existing_token" ] || [ -z "$existing_start" ]; then
      T2_NEXT_COMMAND='verify no T2 process owns the lock, then follow the orphaned-lock recovery steps in docs/testing/minikube-t2-runbook.md'
      t2_fail PROFILE_BUSY "profile $T2_PROFILE owner changed while its stale lock was being reclaimed"
      return 1
    fi
    if t2_lock_process_matches "$existing_pid"; then
      rmdir "$reclaim_dir" 2>/dev/null || true
      T2_NEXT_COMMAND="wait for PID $existing_pid to finish, then retry the same profile"
      t2_fail PROFILE_BUSY "profile $T2_PROFILE became live while its stale lock was being reclaimed"
      return 1
    fi
    rm -rf -- "$T2_LOCK_DIR"
  fi
  mkdir "$T2_LOCK_DIR" 2>/dev/null || {
    T2_NEXT_COMMAND='retry after the profile lock is released'
    t2_fail PROFILE_BUSY "unable to acquire the profile lock: $T2_PROFILE"
    return 1
  }
  umask 077
  T2_LOCK_TOKEN="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  process_start="$(ps -p $$ -o lstart= 2>/dev/null | sed 's/^ *//' || true)"
  [ -n "$process_start" ] || process_start=unavailable
  cat >"$T2_LOCK_DIR/owner.env" <<EOF
REPOSITORY=$T2_PROJECT_DIR
BRANCH=$T2_BRANCH
HEAD=$T2_HEAD
PROFILE=$T2_PROFILE
CONTEXT=$T2_CONTEXT
WORKTREE_ID=$T2_WORKTREE_ID
LOCK_KEY=$T2_LOCK_KEY
TOKEN=$T2_LOCK_TOKEN
PID=$$
PROCESS_START=$process_start
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  T2_LOCK_HELD=true
  T2_LOCK_RELEASED=false
}

t2_lock_validate_inherited() {
  local expected_pid expected_token owner_key owner_value
  t2_lock_profile_id_check || return 1
  T2_LOCK_DIR="$T2_LOCK_ROOT/$T2_PROFILE.lock"
  T2_LOCK_KEY="$(t2_lock_key)"
  if [ -L "$T2_LOCK_DIR" ] || [ ! -d "$T2_LOCK_DIR" ] || [ -L "$T2_LOCK_DIR/owner.env" ]; then
    T2_NEXT_COMMAND='run the parent T2 command with its profile lock token, then retry this child operation'
    t2_fail PROFILE_LOCK_REQUIRED "inherited profile lock is missing for $T2_PROFILE"
    return 1
  fi
  expected_token="$T2_LOCK_TOKEN"
  owner_value="$(t2_lock_owner_value TOKEN || true)"
  if [ -z "$expected_token" ] || [ "$owner_value" != "$expected_token" ]; then
    T2_NEXT_COMMAND='pass the opaque T2_LOCK_TOKEN from the owning T2 process; do not bypass the profile lock'
    t2_fail PROFILE_LOCK_REQUIRED 'inherited profile lock token is missing or does not match'
    return 1
  fi
  for owner_key in REPOSITORY BRANCH HEAD PROFILE CONTEXT WORKTREE_ID LOCK_KEY; do
    case "$owner_key" in
      REPOSITORY) expected_pid="$T2_PROJECT_DIR" ;;
      BRANCH) expected_pid="$T2_BRANCH" ;;
      HEAD) expected_pid="$T2_HEAD" ;;
      PROFILE) expected_pid="$T2_PROFILE" ;;
      CONTEXT) expected_pid="$T2_CONTEXT" ;;
      WORKTREE_ID) expected_pid="$T2_WORKTREE_ID" ;;
      LOCK_KEY) expected_pid="$T2_LOCK_KEY" ;;
    esac
    if [ "$(t2_lock_owner_value "$owner_key" || true)" != "$expected_pid" ]; then
      T2_NEXT_COMMAND='re-run the operation from the worktree/profile that owns the T2 lock'
      t2_fail PROFILE_OWNERSHIP_MISMATCH "profile lock owner does not match $owner_key"
      return 1
    fi
  done
  expected_pid="$(t2_lock_owner_value PID || true)"
  if ! t2_lock_process_matches "$expected_pid"; then
    T2_NEXT_COMMAND='restart the parent T2 operation so it can acquire a live profile lock'
    t2_fail PROFILE_LOCK_REQUIRED 'inherited profile lock owner is not a live process'
    return 1
  fi
  T2_LOCK_HELD=false
  T2_LOCK_RELEASED=false
}

t2_mutation_lock() {
  if [ "$T2_SKIP_LOCK" = true ]; then
    t2_lock_validate_inherited
  else
    t2_lock_acquire
  fi
}

t2_lock_release() {
  local incoming_status=$? status owner_pid owner_token cleanup_status=0
  if [ "$#" -gt 0 ]; then status="$1"; else status="$incoming_status"; fi
  if [ "$T2_LOCK_RELEASED" = true ]; then
    return "$status"
  fi
  T2_LOCK_RELEASED=true
  if [ "$T2_LOCK_HELD" = true ] && [ -n "$T2_LOCK_DIR" ]; then
    owner_pid="$(t2_lock_owner_value PID || true)"
    owner_token="$(t2_lock_owner_value TOKEN || true)"
    if [ "$owner_pid" = "$$" ] && [ -n "$T2_LOCK_TOKEN" ] && [ "$owner_token" = "$T2_LOCK_TOKEN" ]; then
      rm -rf -- "$T2_LOCK_DIR" || cleanup_status=1
    fi
  fi
  T2_LOCK_HELD=false
  if [ -n "$T2_EVIDENCE_FILE" ] && [ -f "$T2_EVIDENCE_FILE" ] && [ -n "$T2_ERROR_CODE" ]; then
    t2_evidence_write failure FAIL "$T2_ERROR_CODE"
  fi
  if [ "$cleanup_status" -ne 0 ] && [ -n "$T2_EVIDENCE_FILE" ] && [ -f "$T2_EVIDENCE_FILE" ]; then
    # A PASS written before EXIT is not a valid attestation if the profile lock
    # could not be released. Invalidate it explicitly and keep the detail
    # secret-free so a later runtime-only lane cannot reuse unsafe evidence.
    t2_evidence_write lock-cleanup INVALIDATED 'profile lock cleanup failed; prior attestation is invalid' || true
  fi
  if [ "$status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then
    status="$cleanup_status"
  fi
  return "$status"
}

t2_evidence_init() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  T2_RUN_ID="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  T2_EVIDENCE_DIR="$T2_EVIDENCE_ROOT/$stamp-$(printf '%s' "$T2_HEAD" | cut -c1-12)-$T2_RUN_ID"
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
  T2_WORKTREE_ID="$T2_WORKTREE_ID" T2_RUN_ID="$T2_RUN_ID" T2_GATE_ID="$T2_GATE_ID" \
  T2_PROFILE="$T2_PROFILE" T2_CONTEXT="$T2_CONTEXT" T2_CLUSTER_FINGERPRINT="$T2_CLUSTER_FINGERPRINT" \
  T2_PROFILE_STATUS="$T2_PROFILE_STATUS" T2_PROFILE_HEALTHY="$T2_PROFILE_HEALTHY" \
  T2_EVIDENCE_DIR="$T2_EVIDENCE_DIR" \
  T2_IMAGE_MANIFEST="$T2_IMAGE_MANIFEST" T2_IMAGE_SOURCE="$T2_IMAGE_SOURCE" T2_IMAGE_TAG="$T2_IMAGE_TAG" \
  python3 - "$file" "$T2_EVIDENCE_FILE" <<'PY'
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
path = Path(os.sys.argv[1])
prior_path = Path(os.sys.argv[2])
prior = {}
if prior_path.exists():
    try: prior = json.loads(prior_path.read_text())
    except ValueError: prior = {}
prior.setdefault("evidenceVersion", 1)
prior["certificationVersion"] = 1
prior.setdefault("runId", os.environ.get("T2_RUN_ID", ""))
now = datetime.now(timezone.utc)
prior.setdefault("attestationStartedAt", now.isoformat().replace("+00:00", "Z"))
prior.setdefault(
    "attestationExpiresAt",
    (now + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
)
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
    "worktreeId": os.environ.get("T2_WORKTREE_ID", ""),
    "runId": os.environ.get("T2_RUN_ID", ""),
    "gateId": os.environ.get("T2_GATE_ID", ""),
    "worktree": os.environ.get("T2_PROJECT_DIR", ""),
    "profile": os.environ.get("T2_PROFILE", ""),
    "context": os.environ.get("T2_CONTEXT", ""),
    "profileStatus": os.environ.get("T2_PROFILE_STATUS", ""),
    "profileHealthy": os.environ.get("T2_PROFILE_HEALTHY", "false"),
    "clusterFingerprintRef": os.environ.get("T2_CLUSTER_FINGERPRINT", ""),
    "imageManifestRef": os.environ.get("T2_IMAGE_MANIFEST", ""),
    "localLogDirectory": os.path.join(os.environ.get("T2_EVIDENCE_DIR", ""), "logs"),
    "imageSource": os.environ.get("T2_IMAGE_SOURCE", ""),
    "imageTag": os.environ.get("T2_IMAGE_TAG", ""),
    "phase": os.environ.get("PHASE", ""),
    "status": os.environ.get("STATUS", ""),
    "detail": redact(os.environ.get("DETAIL", "")),
})
phase = os.environ.get("PHASE", "")
status = os.environ.get("STATUS", "")
attestation = prior.get("attestationStatus", "IN_PROGRESS")
if status in {"FAIL", "INVALIDATED"}:
    attestation = "INVALIDATED"
elif phase == "complete" and status == "PASS":
    attestation = "PASS"
prior["attestationStatus"] = attestation
lane_attestation = prior.get("laneAttestationStatus", "IN_PROGRESS")
if phase == "lanes" and status == "PASS":
    lane_attestation = "PASS"
elif phase == "lock-cleanup" and status == "INVALIDATED":
    lane_attestation = "INVALIDATED"
prior["laneAttestationStatus"] = lane_attestation
prior.setdefault("phases", []).append({
    "name": os.environ.get("PHASE", ""),
    "status": os.environ.get("STATUS", ""),
    "timestamp": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
})
path.write_text(json.dumps(prior, indent=2, sort_keys=True) + "\n")
PY
  mv -- "$file" "$T2_EVIDENCE_FILE"
}

t2_certification_validate_prior_lanes() {
  local result
  if [ -z "$T2_CLUSTER_FINGERPRINT" ]; then
    T2_NEXT_COMMAND='run the exact-head preflight and regenerate a profile marker with a cluster fingerprint'
    t2_fail CERTIFICATION_REQUIRED 'current exact-head marker has no cluster fingerprint'
  fi
  if ! result="$(
    CERTIFICATION_ROOT="$T2_EVIDENCE_ROOT" \
    EXPECTED_REPOSITORY="$T2_PROJECT_DIR" EXPECTED_BRANCH="$T2_BRANCH" \
    EXPECTED_HEAD="$T2_HEAD" EXPECTED_ORIGIN_DEV="$T2_ORIGIN_DEV" \
    EXPECTED_WORKTREE_ID="$T2_WORKTREE_ID" EXPECTED_PROFILE="$T2_PROFILE" \
    EXPECTED_CONTEXT="$T2_CONTEXT" EXPECTED_FINGERPRINT="$T2_CLUSTER_FINGERPRINT" \
    EXPECTED_GATE_ID="$T2_GATE_ID" python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["CERTIFICATION_ROOT"])
expected = {
    "repository": os.environ["EXPECTED_REPOSITORY"],
    "branch": os.environ["EXPECTED_BRANCH"],
    "head": os.environ["EXPECTED_HEAD"],
    "originDev": os.environ["EXPECTED_ORIGIN_DEV"],
    "worktreeId": os.environ["EXPECTED_WORKTREE_ID"],
    "profile": os.environ["EXPECTED_PROFILE"],
    "context": os.environ["EXPECTED_CONTEXT"],
    "clusterFingerprintRef": os.environ["EXPECTED_FINGERPRINT"],
    "gateId": os.environ["EXPECTED_GATE_ID"],
}
for candidate in sorted(root.glob("*/evidence.json"), reverse=True):
    try:
        data = json.loads(candidate.read_text())
    except (OSError, ValueError):
        continue
    if data.get("certificationVersion") != 1:
        continue
    if data.get("attestationStatus") != "PASS" and data.get("laneAttestationStatus") != "PASS":
        continue
    if not data.get("runId"):
        continue
    try:
        expiry = datetime.fromisoformat(str(data.get("attestationExpiresAt", "")).replace("Z", "+00:00"))
        if expiry <= datetime.now(timezone.utc):
            continue
    except (TypeError, ValueError):
        continue
    if any(data.get(key, "") != value for key, value in expected.items()):
        continue
    latest = {}
    for phase in data.get("phases", []):
        name = phase.get("name")
        if name in {"T0", "T0_ATTESTED"}:
            latest["T0"] = phase.get("status")
        if name in {"T1", "T1_ATTESTED"}:
            latest["T1"] = phase.get("status")
    if latest.get("T0") == "PASS" and latest.get("T1") == "PASS":
        print("\t".join([str(candidate), "PASS", "PASS"]))
        raise SystemExit(0)
raise SystemExit("no valid exact-head T0/T1 attestation was found")
PY
  )"; then
    T2_NEXT_COMMAND='run make minikube-t2 with T0=true and T1=true to create exact-head lane attestations'
    t2_fail CERTIFICATION_REQUIRED "$result"
  fi
  IFS=$'\t' read -r T2_PRIOR_ATTESTATION T2_PRIOR_T0_ATTESTATION T2_PRIOR_T1_ATTESTATION <<< "$result"
  T2_T0_CERTIFIED=true
  T2_T1_CERTIFIED=true
  t2_evidence_write T0_ATTESTED PASS "reused exact-head attestation from $T2_PRIOR_ATTESTATION"
  t2_evidence_write T1_ATTESTED PASS "reused exact-head attestation from $T2_PRIOR_ATTESTATION"
}

t2_write_plan() {
  local plan_file="$1"
  [ -n "$plan_file" ] || return 0
  local tmp_file="$plan_file.tmp.$$"
  PLAN_STATE="$T2_PLAN_STATE" PLAN_REASON="$T2_PLAN_REASON" \
  PLAN_PROFILE_STATUS="$T2_PROFILE_STATUS" PLAN_PROFILE_HEALTHY="$T2_PROFILE_HEALTHY" \
  python3 - "$tmp_file" <<'PY'
import json
import os
from pathlib import Path
Path(os.sys.argv[1]).write_text(json.dumps({
    "state": os.environ.get("PLAN_STATE", ""),
    "reason": os.environ.get("PLAN_REASON", ""),
    "profileStatus": os.environ.get("PLAN_PROFILE_STATUS", ""),
    "profileHealthy": os.environ.get("PLAN_PROFILE_HEALTHY", "false"),
}, sort_keys=True) + "\n")
PY
  mv -- "$tmp_file" "$plan_file"
}
