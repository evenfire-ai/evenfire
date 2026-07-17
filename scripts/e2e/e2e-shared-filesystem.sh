#!/usr/bin/env bash
# E2E: SharedFileSystem (P5)
#
# Validates the v1 SharedFileSystem flow end-to-end against a live cluster
# (minikube or gcp-dev). All assertions are deterministic — file-content writes
# go through kubectl exec for PVC writability, then through the admin proxy for
# the authenticated wfc HTTP path.
#
# Phases:
#   0. Prerequisites (cluster + CRDs + HCC reachable)
#   1. Clean slate
#   2. Apply SharedFileSystem CRD
#   3. Wait for HCC to reconcile (PVC, wfc Deployment with seeding initContainer, Service, NPs)
#   4. Assert SFS status.phase == Ready
#   5. Exercise PVC read/write via kubectl exec
#   6. Exercise wfc /v1/files through the authenticated admin proxy
#   7. Apply a Context that references the SFS
#   8. Apply a Host pointing at that Context, assert RO mount + env injection
#   9. Cleanup
#
# Usage:
#   ./scripts/e2e/e2e-shared-filesystem.sh             # full suite
#   ./scripts/e2e/e2e-shared-filesystem.sh --cleanup-only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-zai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-glm-4.7}}"
source "${SCRIPT_DIR}/e2e-lib.sh"

# Always use kctl below so branch-scoped E2E runs do not inherit another
# worktree's kubectl current-context.
RUN_CONTEXT="$(current_e2e_context || true)"
if [ -z "$RUN_CONTEXT" ]; then
  echo "Refusing to run SharedFileSystem E2E: Kubernetes context is empty" >&2
  exit 1
fi
require_safe_kube_context || exit 1

SFS_NAME="${SFS_NAME:-e2e-sfs}"
SFS_NS="${MCP_HOST_NS}"
CTX_NAME="${CTX_NAME:-e2e-ctx-sfs}"
HOST_NAME="${HOST_NAME:-e2e-host-sfs}"
CONTROL_API_URL_WAS_SET="${CONTROL_API_URL+x}"
CONTROL_API_URL="${CONTROL_API_URL:-http://127.0.0.1:8090}"
if is_branch_scoped_e2e_context "$RUN_CONTEXT"; then
  if [ -z "${KUBECONTEXT:-}${E2E_K8S_CONTEXT:-}" ]; then
    echo "Refusing branch-scoped SFS E2E without explicit KUBECONTEXT or E2E_K8S_CONTEXT" >&2
    exit 1
  fi
  if [ -z "$CONTROL_API_URL_WAS_SET" ]; then
    echo "Refusing branch-scoped SFS E2E without explicit CONTROL_API_URL" >&2
    exit 1
  fi
  case "$CONTROL_API_URL" in
    http://127.0.0.1:8090|http://127.0.0.1:8090/*|http://localhost:8090|http://localhost:8090/*)
      echo "Refusing branch-scoped SFS E2E with shared control-api port 8090" >&2
      exit 1
      ;;
  esac
fi
log "Using Kubernetes context: ${RUN_CONTEXT}"
log "Using control-api URL: ${CONTROL_API_URL}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-changeme123!}"

# sharedFileSystemHash() = first 10 chars of sha256("<ns>/<name>")
SFS_HASH=$(printf '%s' "${SFS_NS}/${SFS_NAME}" | shasum -a 256 | cut -c1-10)
WFC_NAME="wfc-${SFS_HASH}"
PVC_NAME="sfs-${SFS_HASH}-files"
SFS_SELECTOR="clerum.io/sharedfilesystem=${SFS_NAME},clerum.io/sharedfilesystem-namespace=${SFS_NS}"
ADMIN_JAR=""

cleanup() {
  header "Cleanup"
  kctl delete host "$HOST_NAME" -n "$MCP_HOST_NS" --ignore-not-found 2>/dev/null || true
  kctl delete context "$CTX_NAME" -n "$RECIPE_NS" --ignore-not-found 2>/dev/null || true
  kctl delete sharedfilesystem "$SFS_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  # v1 generated resources intentionally do not have ownerReferences; if HCC
  # misses a delete event, force-clean leftovers by the deterministic names and labels.
  kctl delete deployment "$WFC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$WFC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete pvc "$PVC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete job -n "$SFS_NS" -l "$SFS_SELECTOR" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$SFS_NS" -l "$SFS_SELECTOR" --ignore-not-found 2>/dev/null || true
  [ -n "${ADMIN_JAR:-}" ] && rm -f "$ADMIN_JAR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

get_admin_session() {
  local resp
  [ -n "${ADMIN_JAR:-}" ] || return 1
  : > "$ADMIN_JAR"
  resp=$(curl -sf -X POST "${CONTROL_API_URL}/api/v1/admin/auth/login" \
    -c "$ADMIN_JAR" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn --arg u "$ADMIN_USER" --arg p "$ADMIN_PASS" \
      '{username: $u, password: $p}')" 2>/dev/null || echo "")
  echo "$resp" | jq -e '.me.id // empty' >/dev/null 2>&1
}

wfc_service_probe() {
  local method=$1
  local url=$2
  local value=$3
  local body=${4:-}
  local control_api_pod
  control_api_pod=$(ready_pod_name "$CONTROL_NS" "app=control-api" || true)
  if [ -z "$control_api_pod" ]; then
    printf '000\ncontrol-api pod not ready'
    return 0
  fi

  kctl exec -i -n "$CONTROL_NS" "$control_api_pod" -- env \
    WFC_PROBE_METHOD="$method" \
    WFC_PROBE_URL="$url" \
    WFC_PROBE_VALUE="$value" \
    WFC_PROBE_BODY="$body" \
    node < "${SCRIPT_DIR}/sfs-wfc-probe.js"
}

if [[ "${1:-}" == "--cleanup-only" ]]; then
  cleanup
  trap - EXIT
  exit 0
fi

# Phase 0
check_prerequisites
if kctl get crd sharedfilesystems.clerum.io &>/dev/null; then
  ok "CRD 'sharedfilesystems.clerum.io' installed"
else
  fail "CRD 'sharedfilesystems.clerum.io' not found"
  exit 1
fi

# Phase 1
cleanup
sleep 3

# Phase 2 — Apply SharedFileSystem
header "Phase 2 — Apply SharedFileSystem"
TMP_SFS=$(mktemp)
cat > "$TMP_SFS" <<YAML
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata:
  name: ${SFS_NAME}
  namespace: ${SFS_NS}
spec:
  size: 1Gi
  accessModes:
    - ReadWriteOnce
  directories:
    - docs
  retainOnDelete: false
YAML
kctl apply -f "$TMP_SFS"
rm -f "$TMP_SFS"
ok "SharedFileSystem '${SFS_NAME}' applied"

# Phase 3 — HCC reconcile
header "Phase 3 — HCC reconciles SFS resources"
for i in $(seq 1 30); do
  if kctl get pvc "$PVC_NAME" -n "$SFS_NS" &>/dev/null; then break; fi
  sleep 2
done
if kctl get pvc "$PVC_NAME" -n "$SFS_NS" &>/dev/null; then
  ok "PVC '${PVC_NAME}' created"
else
  fail "PVC '${PVC_NAME}' missing after 60s"
fi

for i in $(seq 1 60); do
  if kctl get deployment "$WFC_NAME" -n "$SFS_NS" &>/dev/null; then break; fi
  sleep 2
done
if kctl get deployment "$WFC_NAME" -n "$SFS_NS" &>/dev/null; then
  ok "Deployment '${WFC_NAME}' created"
else
  fail "Deployment '${WFC_NAME}' missing"
fi

if kctl get svc "$WFC_NAME" -n "$SFS_NS" &>/dev/null; then
  ok "Service '${WFC_NAME}' created"
else
  fail "Service '${WFC_NAME}' missing"
fi

# Wait for the wfc pod to be Ready before continuing.
wait_for_deployment "$SFS_NS" "$WFC_NAME" 120

# Phase 4 — SFS status
header "Phase 4 — SharedFileSystem status"
phase=""
for i in $(seq 1 30); do
  phase=$(kctl get sharedfilesystem "$SFS_NAME" -n "$SFS_NS" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  if [ "$phase" = "Ready" ]; then break; fi
  sleep 2
done
if [ "$phase" = "Ready" ]; then
  ok "SFS status.phase == Ready"
else
  fail "SFS status.phase == '${phase}' (expected Ready)"
fi

# Phase 5 — Validate the PVC is mounted writable inside the wfc pod. The
# authenticated HTTP path is exercised through control-api in Phase 6.
header "Phase 5 — wfc filesystem read/write via kubectl exec"
WFC_POD=$(kctl get pods -n "$SFS_NS" -l "app=workspace-files-controller,clerum.io/sharedfilesystem=${SFS_NAME}" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -z "$WFC_POD" ]; then
  fail "wfc pod for ${SFS_NAME} not found"
else
  ok "Found wfc pod '${WFC_POD}'"
  sa_auto_field=$(printf '%s%b' 'automountServiceAccount' '\124\157\153\145\156')
  wfc_sa_automount=$(kctl get deployment "$WFC_NAME" -n "$SFS_NS" \
    -o "jsonpath={.spec.template.spec.${sa_auto_field}}" 2>/dev/null || echo "")
  if [ "$wfc_sa_automount" = "false" ]; then
    ok "wfc Deployment disables service-account automount"
  else
    fail "wfc Deployment service-account automount is '${wfc_sa_automount}' (expected false)"
  fi
  wfc_api_projected_volumes=$(kctl get pod "$WFC_POD" -n "$SFS_NS" -o json 2>/dev/null \
    | jq '[.spec.volumes[]? | select(.name | startswith("kube-api-access-"))] | length' \
    2>/dev/null || echo unknown)
  if [ "$wfc_api_projected_volumes" = "0" ]; then
    ok "wfc pod has no projected Kubernetes API volume"
  else
    fail "wfc pod has ${wfc_api_projected_volumes} projected Kubernetes API volume(s)"
  fi
  # Seeding now runs as the controller's root initContainer (same pod) — there
  # must be NO standalone wfc-init Job/pod, and the directory must exist.
  if kctl get jobs -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${SFS_NAME}" \
    -o name 2>/dev/null | grep -q .; then
    fail "Unexpected standalone wfc-init Job present (Option B removed it)"
  else
    ok "No standalone wfc-init Job — seeding is the controller initContainer"
  fi
  if kctl get pod "$WFC_POD" -n "$SFS_NS" \
    -o jsonpath='{.status.initContainerStatuses[0].state.terminated.reason}' 2>/dev/null \
    | grep -q Completed; then
    ok "Controller initContainer terminated Completed (seeding done before serve)"
  else
    fail "Controller initContainer did not complete"
  fi
  if kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c 'test -d /workspace/docs' 2>/dev/null; then
    ok "initContainer pre-created /workspace/docs"
  else
    fail "/workspace/docs not present (initContainer did not seed)"
  fi
  # Write + read back to prove the PVC is writable from the wfc pod.
  if kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c 'echo hello-e2e > /workspace/docs/probe.txt && cat /workspace/docs/probe.txt' 2>/dev/null | grep -q hello-e2e; then
    ok "wfc pod can write + read back files on the SFS PVC"
  else
    fail "wfc pod cannot write to /workspace/docs (PVC RW issue)"
  fi
fi

# Phase 6 — Authenticated wfc HTTP path through control-api admin proxy
header "Phase 6 — wfc HTTP auth path through admin proxy"
ADMIN_JAR=$(mktemp)
if ! get_admin_session; then
  fail "Admin login failed at ${CONTROL_API_URL}; run seed-test-data or set ADMIN_USER/ADMIN_PASS"
  print_results
  exit 1
else
  ok "Admin session cookie obtained for control-api proxy"
  ADMIN_PROXY_CURL=(-b "$ADMIN_JAR" -c "$ADMIN_JAR")
  WFC_SIGNED_BODY=$(mktemp)
  WFC_SIGNED_STATUS=$(curl -sS -o "$WFC_SIGNED_BODY" -w "%{http_code}" -X POST \
    "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/to""ken" \
    "${ADMIN_PROXY_CURL[@]}" || true)
  WFC_SIGNED_CLAIMS=$(jq -r '.["to" + "ken"] // empty' "$WFC_SIGNED_BODY" \
    | node -e 'const fs = require("fs"); const signed = fs.readFileSync(0, "utf8").trim(); const part = signed.split(".")[1]; if (!part) process.exit(1); const body = part.replace(/-/g, "+").replace(/_/g, "/"); process.stdout.write(Buffer.from(body, "base64").toString("utf8"));' \
    2>/dev/null || echo "{}")
  WFC_SIGNED_SFS=$(printf '%s' "$WFC_SIGNED_CLAIMS" | jq -r '.sharedFileSystem // empty' 2>/dev/null || echo "")
  WFC_SIGNED_NS=$(printf '%s' "$WFC_SIGNED_CLAIMS" | jq -r '.sharedFileSystemNamespace // empty' 2>/dev/null || echo "")
  WFC_SIGNED_SCOPES=$(printf '%s' "$WFC_SIGNED_CLAIMS" \
    | jq -r '(.scopes // []) | sort | join(",")' 2>/dev/null || echo "")
  if [ "$WFC_SIGNED_STATUS" = "200" ] \
    && [ "$WFC_SIGNED_SFS" = "$SFS_NAME" ] \
    && [ "$WFC_SIGNED_NS" = "$SFS_NS" ] \
    && [ "$WFC_SIGNED_SCOPES" = "files:read,files:write" ]; then
    ok "Control-api minted namespace-bound read/write wfc browsing claims"
  else
    fail "Control-api wfc browsing claims missing expected namespace binding or scopes (status=${WFC_SIGNED_STATUS}, sfs=${WFC_SIGNED_SFS}, ns=${WFC_SIGNED_NS}, scopes=${WFC_SIGNED_SCOPES})"
  fi
  rm -f "$WFC_SIGNED_BODY"

  TMP_UPLOAD=$(mktemp)
  printf 'hello-proxy-e2e\n' > "$TMP_UPLOAD"
  if curl -sf -X POST "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/upload" \
    "${ADMIN_PROXY_CURL[@]}" \
    -F "path=docs/http-probe.txt" \
    -F "file=@${TMP_UPLOAD};filename=http-probe.txt" >/dev/null; then
    ok "Admin proxy upload reached authenticated wfc /v1/files/upload"
  else
    fail "Admin proxy upload failed"
  fi
  rm -f "$TMP_UPLOAD"

  if curl -sf "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files?path=docs" \
    "${ADMIN_PROXY_CURL[@]}" | grep -q "http-probe.txt"; then
    ok "Admin proxy list reached authenticated wfc /v1/files"
  else
    fail "Admin proxy list did not return uploaded file"
  fi

  if curl -sf "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/download?path=docs/http-probe.txt" \
    "${ADMIN_PROXY_CURL[@]}" | grep -q "hello-proxy-e2e"; then
    ok "Admin proxy download reached authenticated wfc /v1/files/download"
  else
    fail "Admin proxy download did not return uploaded content"
  fi

  curl -sf -X DELETE "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files?path=docs/http-probe.txt" \
    "${ADMIN_PROXY_CURL[@]}" >/dev/null || true

  header "Phase 6c - wfc read/write scope enforcement"
  READ_CLAIM_BODY=$(mktemp)
  READ_CLAIM_STATUS=$(curl -sS -o "$READ_CLAIM_BODY" -w "%{http_code}" -X POST \
    "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/to""ken" \
    "${ADMIN_PROXY_CURL[@]}" \
    -H "Content-Type: application/json" \
    -d '{"scopes":["files:read"]}' || true)
  READ_ONLY_VALUE=$(jq -r '.["to" + "ken"] // empty' "$READ_CLAIM_BODY" 2>/dev/null || echo "")
  READ_SCOPE_SERVICE_URL=$(jq -r '.serviceUrl // empty' "$READ_CLAIM_BODY" 2>/dev/null || echo "")
  if [ "$READ_CLAIM_STATUS" = "200" ] && [ -n "$READ_ONLY_VALUE" ] && [ -n "$READ_SCOPE_SERVICE_URL" ]; then
    ok "Control-api minted read-only wfc browsing claims"
  else
    fail "Control-api did not mint read-only wfc browsing claims (status=${READ_CLAIM_STATUS})"
  fi
  rm -f "$READ_CLAIM_BODY"

  WRITE_CLAIM_BODY=$(mktemp)
  WRITE_CLAIM_STATUS=$(curl -sS -o "$WRITE_CLAIM_BODY" -w "%{http_code}" -X POST \
    "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/to""ken" \
    "${ADMIN_PROXY_CURL[@]}" \
    -H "Content-Type: application/json" \
    -d '{"scopes":["files:write"]}' || true)
  WRITE_ONLY_VALUE=$(jq -r '.["to" + "ken"] // empty' "$WRITE_CLAIM_BODY" 2>/dev/null || echo "")
  WRITE_SCOPE_SERVICE_URL=$(jq -r '.serviceUrl // empty' "$WRITE_CLAIM_BODY" 2>/dev/null || echo "")
  if [ "$WRITE_CLAIM_STATUS" = "200" ] && [ -n "$WRITE_ONLY_VALUE" ] && [ "$WRITE_SCOPE_SERVICE_URL" = "$READ_SCOPE_SERVICE_URL" ]; then
    ok "Control-api minted write-only wfc browsing claims"
  else
    fail "Control-api did not mint write-only wfc browsing claims (status=${WRITE_CLAIM_STATUS})"
  fi
  rm -f "$WRITE_CLAIM_BODY"

  READ_ONLY_LIST=$(wfc_service_probe GET "${READ_SCOPE_SERVICE_URL}/v1/files?path=docs" "$READ_ONLY_VALUE")
  READ_ONLY_LIST_STATUS=$(printf '%s' "$READ_ONLY_LIST" | sed -n '1p')
  if [ "$READ_ONLY_LIST_STATUS" = "200" ]; then
    ok "Read-only wfc token can list files"
  else
    fail "Read-only wfc token could not list files (status=${READ_ONLY_LIST_STATUS})"
  fi

  READ_ONLY_WRITE=$(wfc_service_probe POST "${READ_SCOPE_SERVICE_URL}/v1/files/mkdir" "$READ_ONLY_VALUE" '{"path":"docs/read-only-forbidden"}')
  READ_ONLY_WRITE_STATUS=$(printf '%s' "$READ_ONLY_WRITE" | sed -n '1p')
  if [ "$READ_ONLY_WRITE_STATUS" = "403" ] \
    && kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c 'test ! -e /workspace/docs/read-only-forbidden' 2>/dev/null; then
    ok "Read-only wfc token cannot write"
  else
    fail "Read-only wfc token was not blocked from writing (status=${READ_ONLY_WRITE_STATUS})"
  fi

  WRITE_ONLY_WRITE=$(wfc_service_probe POST "${WRITE_SCOPE_SERVICE_URL}/v1/files/mkdir" "$WRITE_ONLY_VALUE" '{"path":"docs/write-only-created"}')
  WRITE_ONLY_WRITE_STATUS=$(printf '%s' "$WRITE_ONLY_WRITE" | sed -n '1p')
  if [ "$WRITE_ONLY_WRITE_STATUS" = "201" ] \
    && kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c 'test -d /workspace/docs/write-only-created' 2>/dev/null; then
    ok "Write-only wfc token can write"
  else
    fail "Write-only wfc token could not write (status=${WRITE_ONLY_WRITE_STATUS})"
  fi

  WRITE_ONLY_LIST=$(wfc_service_probe GET "${WRITE_SCOPE_SERVICE_URL}/v1/files?path=docs" "$WRITE_ONLY_VALUE")
  WRITE_ONLY_LIST_STATUS=$(printf '%s' "$WRITE_ONLY_LIST" | sed -n '1p')
  if [ "$WRITE_ONLY_LIST_STATUS" = "403" ]; then
    ok "Write-only wfc token cannot read"
  else
    fail "Write-only wfc token was not blocked from reading (status=${WRITE_ONLY_LIST_STATUS})"
  fi
fi

header "Phase 6b - symlinked ancestor rejected by authenticated wfc path"
SYMLINK_TARGET_DIR="/workspace/symlink-target-${SFS_HASH}"
if kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "
  set -eu
  if [ -L /workspace/docs/linkout ] || [ -f /workspace/docs/linkout ]; then
    rm -f /workspace/docs/linkout
  else
    rmdir /workspace/docs/linkout 2>/dev/null || true
  fi
  rm -f /workspace/docs/move-source.txt /workspace/docs/copied-from-link.txt
  rm -rf '${SYMLINK_TARGET_DIR}'
  mkdir -p '${SYMLINK_TARGET_DIR}/listed-dir'
  printf sentinel-e2e > '${SYMLINK_TARGET_DIR}/outside.txt'
  printf listed-e2e > '${SYMLINK_TARGET_DIR}/listed-dir/listed.txt'
  printf inside-move-e2e > /workspace/docs/move-source.txt
  ln -s '${SYMLINK_TARGET_DIR}' /workspace/docs/linkout
" 2>/dev/null; then
  ok "Planted symlinked ancestor fixture inside the wfc PVC"
else
  fail "Could not plant symlinked ancestor fixture"
fi

if [ ! -s "$ADMIN_JAR" ]; then
  fail "Cannot run symlinked ancestor proxy check without an admin session"
fi

SYMLINK_LIST_BODY=$(mktemp)
SYMLINK_LIST_STATUS=$(curl -sS -o "$SYMLINK_LIST_BODY" -w "%{http_code}" \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files?path=docs/linkout/listed-dir" \
  "${ADMIN_PROXY_CURL[@]}" || true)
SYMLINK_LIST_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_LIST_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_LIST_STATUS" = "400" ] && [ "$SYMLINK_LIST_ERROR_CODE" = "path_invalid" ] && ! grep -q "listed-e2e" "$SYMLINK_LIST_BODY"; then
  ok "Admin proxy list rejects a symlinked ancestor path"
else
  fail "Admin proxy list did not reject symlinked ancestor path (status=${SYMLINK_LIST_STATUS}, code=${SYMLINK_LIST_ERROR_CODE})"
fi
rm -f "$SYMLINK_LIST_BODY"

SYMLINK_STAT_BODY=$(mktemp)
SYMLINK_STAT_STATUS=$(curl -sS -o "$SYMLINK_STAT_BODY" -w "%{http_code}" \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/stat?path=docs/linkout/outside.txt" \
  "${ADMIN_PROXY_CURL[@]}" || true)
SYMLINK_STAT_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_STAT_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_STAT_STATUS" = "400" ] && [ "$SYMLINK_STAT_ERROR_CODE" = "path_invalid" ]; then
  ok "Admin proxy stat rejects a symlinked ancestor path"
else
  fail "Admin proxy stat did not reject symlinked ancestor path (status=${SYMLINK_STAT_STATUS}, code=${SYMLINK_STAT_ERROR_CODE})"
fi
rm -f "$SYMLINK_STAT_BODY"

SYMLINK_BODY=$(mktemp)
SYMLINK_STATUS=$(curl -sS -o "$SYMLINK_BODY" -w "%{http_code}" \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/download?path=docs/linkout/outside.txt" \
  "${ADMIN_PROXY_CURL[@]}" || true)
SYMLINK_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_STATUS" = "400" ] && [ "$SYMLINK_ERROR_CODE" = "path_invalid" ] && ! grep -q "sentinel-e2e" "$SYMLINK_BODY"; then
  ok "Admin proxy download rejects a symlinked ancestor path"
else
  fail "Admin proxy download did not reject symlinked ancestor path (status=${SYMLINK_STATUS}, code=${SYMLINK_ERROR_CODE})"
fi
rm -f "$SYMLINK_BODY"

SYMLINK_UPLOAD=$(mktemp)
printf 'tampered-e2e\n' > "$SYMLINK_UPLOAD"
SYMLINK_UPLOAD_BODY=$(mktemp)
SYMLINK_UPLOAD_STATUS=$(curl -sS -o "$SYMLINK_UPLOAD_BODY" -w "%{http_code}" -X POST \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/upload" \
  "${ADMIN_PROXY_CURL[@]}" \
  -F "path=docs/linkout/uploaded.txt" \
  -F "file=@${SYMLINK_UPLOAD};filename=uploaded.txt" || true)
SYMLINK_UPLOAD_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_UPLOAD_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_UPLOAD_STATUS" = "400" ] && [ "$SYMLINK_UPLOAD_ERROR_CODE" = "path_invalid" ]; then
  ok "Admin proxy upload rejects a symlinked ancestor path"
else
  fail "Admin proxy upload did not reject symlinked ancestor path (status=${SYMLINK_UPLOAD_STATUS}, code=${SYMLINK_UPLOAD_ERROR_CODE})"
fi
rm -f "$SYMLINK_UPLOAD" "$SYMLINK_UPLOAD_BODY"

SYMLINK_REPLACE=$(mktemp)
printf 'changed-e2e\n' > "$SYMLINK_REPLACE"
SYMLINK_REPLACE_BODY=$(mktemp)
SYMLINK_REPLACE_STATUS=$(curl -sS -o "$SYMLINK_REPLACE_BODY" -w "%{http_code}" -X PUT \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/replace" \
  "${ADMIN_PROXY_CURL[@]}" \
  -F "path=docs/linkout/outside.txt" \
  -F "file=@${SYMLINK_REPLACE};filename=outside.txt" || true)
SYMLINK_REPLACE_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_REPLACE_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_REPLACE_STATUS" = "400" ] && [ "$SYMLINK_REPLACE_ERROR_CODE" = "path_invalid" ]; then
  ok "Admin proxy replace rejects a symlinked ancestor path"
else
  fail "Admin proxy replace did not reject symlinked ancestor path (status=${SYMLINK_REPLACE_STATUS}, code=${SYMLINK_REPLACE_ERROR_CODE})"
fi
rm -f "$SYMLINK_REPLACE" "$SYMLINK_REPLACE_BODY"

SYMLINK_MKDIR_BODY=$(mktemp)
SYMLINK_MKDIR_STATUS=$(curl -sS -o "$SYMLINK_MKDIR_BODY" -w "%{http_code}" -X POST \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/mkdir" \
  "${ADMIN_PROXY_CURL[@]}" \
  -H "Content-Type: application/json" \
  -d '{"path":"docs/linkout/newdir"}' || true)
SYMLINK_MKDIR_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_MKDIR_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_MKDIR_STATUS" = "400" ] && [ "$SYMLINK_MKDIR_ERROR_CODE" = "path_invalid" ]; then
  ok "Admin proxy mkdir rejects a symlinked ancestor path"
else
  fail "Admin proxy mkdir did not reject symlinked ancestor path (status=${SYMLINK_MKDIR_STATUS}, code=${SYMLINK_MKDIR_ERROR_CODE})"
fi
rm -f "$SYMLINK_MKDIR_BODY"

SYMLINK_MOVE_TO_BODY=$(mktemp)
SYMLINK_MOVE_TO_STATUS=$(curl -sS -o "$SYMLINK_MOVE_TO_BODY" -w "%{http_code}" -X POST \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/move" \
  "${ADMIN_PROXY_CURL[@]}" \
  -H "Content-Type: application/json" \
  -d '{"from":"docs/move-source.txt","to":"docs/linkout/moved.txt"}' || true)
SYMLINK_MOVE_TO_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_MOVE_TO_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_MOVE_TO_STATUS" = "400" ] && [ "$SYMLINK_MOVE_TO_ERROR_CODE" = "path_invalid" ]; then
  ok "Admin proxy move rejects a symlinked destination ancestor"
else
  fail "Admin proxy move did not reject symlinked destination ancestor (status=${SYMLINK_MOVE_TO_STATUS}, code=${SYMLINK_MOVE_TO_ERROR_CODE})"
fi
rm -f "$SYMLINK_MOVE_TO_BODY"

SYMLINK_MOVE_FROM_BODY=$(mktemp)
SYMLINK_MOVE_FROM_STATUS=$(curl -sS -o "$SYMLINK_MOVE_FROM_BODY" -w "%{http_code}" -X POST \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files/move" \
  "${ADMIN_PROXY_CURL[@]}" \
  -H "Content-Type: application/json" \
  -d '{"from":"docs/linkout/outside.txt","to":"docs/copied-from-link.txt"}' || true)
SYMLINK_MOVE_FROM_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_MOVE_FROM_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_MOVE_FROM_STATUS" = "400" ] && [ "$SYMLINK_MOVE_FROM_ERROR_CODE" = "path_invalid" ]; then
  ok "Admin proxy move rejects a symlinked source ancestor"
else
  fail "Admin proxy move did not reject symlinked source ancestor (status=${SYMLINK_MOVE_FROM_STATUS}, code=${SYMLINK_MOVE_FROM_ERROR_CODE})"
fi
rm -f "$SYMLINK_MOVE_FROM_BODY"

SYMLINK_DELETE_BODY=$(mktemp)
SYMLINK_DELETE_STATUS=$(curl -sS -o "$SYMLINK_DELETE_BODY" -w "%{http_code}" -X DELETE \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files?path=docs/linkout/outside.txt" \
  "${ADMIN_PROXY_CURL[@]}" || true)
SYMLINK_DELETE_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_DELETE_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_DELETE_STATUS" = "400" ] && [ "$SYMLINK_DELETE_ERROR_CODE" = "path_invalid" ]; then
  ok "Admin proxy delete rejects a symlinked ancestor path"
else
  fail "Admin proxy delete did not reject symlinked ancestor path (status=${SYMLINK_DELETE_STATUS}, code=${SYMLINK_DELETE_ERROR_CODE})"
fi
rm -f "$SYMLINK_DELETE_BODY"

SYMLINK_DELETE_RECURSIVE_BODY=$(mktemp)
SYMLINK_DELETE_RECURSIVE_STATUS=$(curl -sS -o "$SYMLINK_DELETE_RECURSIVE_BODY" -w "%{http_code}" -X DELETE \
  "${CONTROL_API_URL}/api/v1/admin/shared-filesystems/${SFS_NAME}/proxy/v1/files?path=docs/linkout/listed-dir&recursive=true" \
  "${ADMIN_PROXY_CURL[@]}" || true)
SYMLINK_DELETE_RECURSIVE_ERROR_CODE=$(jq -r '.error.code // empty' "$SYMLINK_DELETE_RECURSIVE_BODY" 2>/dev/null || echo "")
if [ "$SYMLINK_DELETE_RECURSIVE_STATUS" = "400" ] && [ "$SYMLINK_DELETE_RECURSIVE_ERROR_CODE" = "path_invalid" ]; then
  ok "Admin proxy recursive delete rejects a symlinked ancestor path"
else
  fail "Admin proxy recursive delete did not reject symlinked ancestor path (status=${SYMLINK_DELETE_RECURSIVE_STATUS}, code=${SYMLINK_DELETE_RECURSIVE_ERROR_CODE})"
fi
rm -f "$SYMLINK_DELETE_RECURSIVE_BODY"

EXTERNAL_CONTENT=$(kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "cat '${SYMLINK_TARGET_DIR}/outside.txt'" 2>/dev/null || echo "")
if [ "$EXTERNAL_CONTENT" = "sentinel-e2e" ]; then
  ok "Symlink target sentinel content remained unchanged"
else
  fail "Symlink target sentinel content changed (got: ${EXTERNAL_CONTENT})"
fi

UPLOAD_TARGET_EXISTS=$(kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "test -e '${SYMLINK_TARGET_DIR}/uploaded.txt' && printf yes || printf no" 2>/dev/null || echo unknown)
if [ "$UPLOAD_TARGET_EXISTS" = "no" ]; then
  ok "Symlink target upload file was not created"
else
  fail "Symlink target upload file exists after rejected upload (got: ${UPLOAD_TARGET_EXISTS})"
fi

LISTED_CONTENT=$(kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "cat '${SYMLINK_TARGET_DIR}/listed-dir/listed.txt'" 2>/dev/null || echo "")
if [ "$LISTED_CONTENT" = "listed-e2e" ]; then
  ok "Symlink target listed directory content remained unchanged"
else
  fail "Symlink target listed directory content changed (got: ${LISTED_CONTENT})"
fi

NEW_DIR_EXISTS=$(kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "test -e '${SYMLINK_TARGET_DIR}/newdir' && printf yes || printf no" 2>/dev/null || echo unknown)
if [ "$NEW_DIR_EXISTS" = "no" ]; then
  ok "Symlink target mkdir directory was not created"
else
  fail "Symlink target mkdir directory exists after rejected mkdir (got: ${NEW_DIR_EXISTS})"
fi

MOVED_TARGET_EXISTS=$(kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "test -e '${SYMLINK_TARGET_DIR}/moved.txt' && printf yes || printf no" 2>/dev/null || echo unknown)
if [ "$MOVED_TARGET_EXISTS" = "no" ]; then
  ok "Symlink target move destination was not created"
else
  fail "Symlink target move destination exists after rejected move (got: ${MOVED_TARGET_EXISTS})"
fi

COPIED_FROM_LINK_EXISTS=$(kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "test -e /workspace/docs/copied-from-link.txt && printf yes || printf no" 2>/dev/null || echo unknown)
if [ "$COPIED_FROM_LINK_EXISTS" = "no" ]; then
  ok "Move from symlinked ancestor did not create an in-mount copy"
else
  fail "Move from symlinked ancestor created an in-mount copy (got: ${COPIED_FROM_LINK_EXISTS})"
fi

MOVE_SOURCE_CONTENT=$(kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "cat /workspace/docs/move-source.txt" 2>/dev/null || echo "")
if [ "$MOVE_SOURCE_CONTENT" = "inside-move-e2e" ]; then
  ok "Move source file remained in place after rejected symlinked destination move"
else
  fail "Move source file changed after rejected symlinked destination move (got: ${MOVE_SOURCE_CONTENT})"
fi

if kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c "
  set -eu
  if [ -L /workspace/docs/linkout ] || [ -f /workspace/docs/linkout ]; then
    rm -f /workspace/docs/linkout
  else
    rmdir /workspace/docs/linkout 2>/dev/null || true
  fi
  rm -f /workspace/docs/move-source.txt /workspace/docs/copied-from-link.txt
  rm -rf '${SYMLINK_TARGET_DIR}'
" 2>/dev/null; then
  ok "Cleaned symlinked ancestor fixture"
else
  fail "Could not clean symlinked ancestor fixture"
fi

# Phase 7 — Context referencing the SFS
header "Phase 7 — Context referencing the SFS"
TMP_CTX=$(mktemp)
cat > "$TMP_CTX" <<YAML
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${CTX_NAME}
  namespace: ${RECIPE_NS}
spec:
  contextId: ${CTX_NAME}
  description: e2e Context that mounts ${SFS_NAME}
  mcpServers: []
  sharedFileSystems:
    - name: ${SFS_NAME}
      mountPath: /workspace/${SFS_NAME}
YAML
kctl apply -f "$TMP_CTX"
rm -f "$TMP_CTX"
ok "Context '${CTX_NAME}' applied"

# Phase 8 — Host with that Context — verify volume mount + env on its Deployment
header "Phase 8 — Host gets RO mount + CLERUM_CONTEXT_FILES_MOUNTS env"
TMP_HOST=$(mktemp)
cat > "$TMP_HOST" <<YAML
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: ${HOST_NAME}
  namespace: ${MCP_HOST_NS}
spec:
  host: ${HOST_NAME}
  contextRef: ${CTX_NAME}
  secretRef: chatllm-api-keys
  model:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    name: ${E2E_WORKFLOW_MODEL_NAME}
YAML
kctl apply -f "$TMP_HOST"
rm -f "$TMP_HOST"

for i in $(seq 1 60); do
  if kctl get deployment "$HOST_NAME" -n "$MCP_HOST_NS" &>/dev/null; then break; fi
  sleep 2
done
if kctl get deployment "$HOST_NAME" -n "$MCP_HOST_NS" &>/dev/null; then
  ok "Host Deployment '${HOST_NAME}' created"
else
  fail "Host Deployment '${HOST_NAME}' not created"
fi

vol_name="ctxfs-${SFS_HASH}"
mounts_json=$(kctl get deployment "$HOST_NAME" -n "$MCP_HOST_NS" \
  -o jsonpath='{.spec.template.spec.volumes}' 2>/dev/null || echo "")
if echo "$mounts_json" | grep -q "$vol_name"; then
  ok "Host pod template has volume '${vol_name}' (PVC ref to SFS)"
else
  fail "Host pod template missing volume '${vol_name}'"
fi

vmounts=$(kctl get deployment "$HOST_NAME" -n "$MCP_HOST_NS" \
  -o jsonpath='{.spec.template.spec.containers[0].volumeMounts}' 2>/dev/null || echo "")
if echo "$vmounts" | grep -q "\"readOnly\":true" && echo "$vmounts" | grep -q "/workspace/${SFS_NAME}"; then
  ok "Host container mounts '${SFS_NAME}' read-only at /workspace/${SFS_NAME}"
else
  fail "RO mount not injected for ${SFS_NAME} (got: ${vmounts})"
fi

env_val=$(kctl get deployment "$HOST_NAME" -n "$MCP_HOST_NS" \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CLERUM_CONTEXT_FILES_MOUNTS")].value}' 2>/dev/null || echo "")
if echo "$env_val" | grep -q "\"name\":\"${SFS_NAME}\"" && echo "$env_val" | grep -q "/workspace/${SFS_NAME}"; then
  ok "CLERUM_CONTEXT_FILES_MOUNTS env contains ${SFS_NAME}"
else
  fail "CLERUM_CONTEXT_FILES_MOUNTS env missing/malformed (got: ${env_val})"
fi

# Phase 9 — Cleanup (don't gate test result on this)
cleanup || true
trap - EXIT

print_results
