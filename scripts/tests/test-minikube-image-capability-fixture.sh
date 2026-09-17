#!/usr/bin/env bash
# Hermetic residue checks: no cluster calls and no checkout mutations.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BEFORE="$(git -C "$ROOT" status --porcelain; git -C "$ROOT" rev-parse HEAD; git -C "$ROOT" branch --show-current)"
FIXTURE="$(mktemp -d)"
cleanup() {
  local result=$?
  rm -rf -- "$FIXTURE"
  if [[ "$BEFORE" != "$(git -C "$ROOT" status --porcelain; git -C "$ROOT" rev-parse HEAD; git -C "$ROOT" branch --show-current)" ]]; then
    printf 'FAIL: Host checkout changed\n' >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
source "$ROOT/scripts/minikube/t2-common.sh"
T2_PROJECT_DIR="$FIXTURE"
mkdir -p "$FIXTURE/deploy/minikube"
MANIFEST="$FIXTURE/deploy/minikube/.image-manifest.json"
printf '%s' '{"images":{"clerum/image-capabilities-mcp-host:test":"sha256:fixture"}}' > "$MANIFEST"
CONFIG='{"data":{},"metadata":{}}'
DEPLOYMENTS='{"items":[{"metadata":{},"spec":{"template":{"spec":{"containers":[{"image":"clerum/mcp-host:test"}]}}}}]}'
RUNTIME=true
t2_kc() {
  case "$*" in
    *'get configmap'*) printf '%s' "$CONFIG" ;;
    *'exec deployment/chatllm'*) printf '%s' "$RUNTIME" ;;
    *) return 99 ;;
  esac
}
t2_fail() { printf '%s\n' "$1" >&2; return 1; }
t2_image_capability_fixture_check "$DEPLOYMENTS"
CONFIG='{"data":{"IMAGE_CAPABILITIES_RUN_ID":"image-capabilities-123456abcdef"},"metadata":{}}'
if t2_image_capability_fixture_check "$DEPLOYMENTS" 2>/dev/null; then exit 1; fi
CONFIG='{"data":{"NODE_ENV":"test"},"metadata":{}}'
if t2_image_capability_fixture_check "$DEPLOYMENTS" 2>/dev/null; then exit 1; fi
CONFIG='{"data":{},"metadata":{}}'
BAD_DEPLOYMENTS="${DEPLOYMENTS/clerum\/mcp-host:test/clerum\/image-capabilities-mcp-host:test}"
if t2_image_capability_fixture_check "$BAD_DEPLOYMENTS" 2>/dev/null; then exit 1; fi
RUNTIME=false
if t2_image_capability_fixture_check "$DEPLOYMENTS" 2>/dev/null; then exit 1; fi
printf '%s' '{"images":{}}' > "$MANIFEST"
t2_image_capability_fixture_check "$DEPLOYMENTS"
printf 'PASS: optional image fixture cannot survive a T2 runtime verdict\n'
