#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERLAY="$ROOT/deploy/overlays/minikube"
PATCH="$OVERLAY/patches/gfs-upload-v2.yaml"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail 'kubectl is required to validate the committed minikube render'
[[ -f "$PATCH" ]] || fail 'minikube has no versioned GFS Upload v2 profile patch'
grep -Eq '^[[:space:]]*-[[:space:]]+patches/gfs-upload-v2\.yaml$' "$OVERLAY/kustomization.yaml" \
  || fail 'minikube kustomization does not include its GFS Upload v2 profile patch'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$ROOT/deploy" "$TMP/deploy"
sed 's#__K8S_API_IP__#10.96.0.1#g' \
  "$TMP/deploy/overlays/minikube/patches/k8s-api-ip.yaml.template" \
  >"$TMP/deploy/overlays/minikube/patches/k8s-api-ip.yaml"

if ! kubectl kustomize "$TMP/deploy/overlays/minikube" \
  >"$TMP/render.yaml" 2>"$TMP/render.err"; then
  cat "$TMP/render.err" >&2
  fail 'committed minikube overlay does not render'
fi
awk '
  BEGIN { RS="---\n" }
  /kind: Deployment/ && /name: host-context-controller/ { print; found=1; exit }
  END { if (!found) exit 1 }
' "$TMP/render.yaml" >"$TMP/hcc.yaml" \
  || fail 'rendered minikube overlay has no host-context-controller Deployment'

env_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*-[[:space:]]+name:[[:space:]]+" key "$" {
      if (getline <= 0 || $0 !~ "^[[:space:]]+value:[[:space:]]+") exit 2
      sub("^[[:space:]]+value:[[:space:]]+", "")
      gsub(/^\"|\"$/, "")
      print
      found=1
      exit
    }
    END { if (!found) exit 1 }
  ' "$TMP/hcc.yaml"
}

expected=(
  'CONTEXT_MAPPER_GFSC_UPLOAD_V2_ENABLED=true'
  'CONTEXT_MAPPER_GFSC_UPLOAD_PROTOCOL_MAX_FILE_BYTES=1073741824'
  'CONTEXT_MAPPER_GFSC_UPLOAD_PRODUCT_MAX_FILE_BYTES=209715200'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_FILE_BYTES=209715200'
  'CONTEXT_MAPPER_GFSC_UPLOAD_PREFERRED_CHUNK_BYTES=8388608'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_CHUNK_BYTES=16777216'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MIN_PART_BYTES=1048576'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_PART_COUNT=1024'
  'CONTEXT_MAPPER_GFSC_UPLOAD_SESSION_TTL_MS=86400000'
  'CONTEXT_MAPPER_GFSC_UPLOAD_COMPLETED_RECEIPT_TTL_MS=86400000'
  'CONTEXT_MAPPER_GFSC_UPLOAD_STALE_PART_LEASE_MS=600000'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_ACTIVE_PER_SUBJECT=2'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_ACTIVE_GLOBAL=8'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_CONCURRENT_PARTS_PER_SESSION=4'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_CONCURRENT_PART_STREAMS_GLOBAL=16'
  'CONTEXT_MAPPER_GFSC_UPLOAD_INSTABILITY_FAILURE_THRESHOLD=3'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_CONCURRENT_FINALIZATIONS=1'
  'CONTEXT_MAPPER_GFSC_UPLOAD_MIN_FREE_BYTES=10737418240'
  'CONTEXT_MAPPER_GFSC_UPLOAD_PART_TIMEOUT_MS=300000'
  'CONTEXT_MAPPER_GFSC_UPLOAD_FINALIZE_TIMEOUT_MS=600000'
)

for contract in "${expected[@]}"; do
  key="${contract%%=*}"
  want="${contract#*=}"
  got="$(env_value "$key")" \
    || fail "rendered HCC omits $key"
  [[ "$got" == "$want" ]] \
    || fail "rendered HCC sets $key=$got, expected $want"
done

# Enabling a local T2 profile must not enable the production-safe public base.
if grep -A2 -F 'name: CONTEXT_MAPPER_GFSC_UPLOAD_V2_ENABLED' \
  "$ROOT/deploy/base/control-plane/host-context-controller.yaml" | grep -Eq "value:[[:space:]]*['\"]?true['\"]?[[:space:]]*$"; then
  fail 'public base enables GFS Upload v2 instead of leaving activation to an environment overlay'
fi

printf 'PASS: minikube renders the exact enabled GFS Upload v2 200 MiB profile while public base stays disabled\n'
