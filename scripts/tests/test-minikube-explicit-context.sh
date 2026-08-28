#!/usr/bin/env bash
# Public gates must receive a Kubernetes context explicitly, even when it
# happens to have the same name as the selected Minikube profile.
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
COMMON="$ROOT/scripts/minikube/t2-common.sh"
PROFILE=clerum-feature-owner

if output="$(env -u T2_CONTEXT -u CONTROL_API_REAL_PG_CONTEXT -u K8S_CONTEXT -u KUBECONTEXT \
  T2_PROJECT_DIR="$ROOT" T2_PROFILE="$PROFILE" MINIKUBE_PROFILE="$PROFILE" \
  bash -c 'source "$1"; t2_require_explicit_context' _ "$COMMON" 2>&1)"; then
  printf 'FAIL: implicit profile-to-context fallback was accepted\n' >&2
  exit 1
fi
case "$output" in
  *DEVELOPMENT_SCOPE_REQUIRED*'Kubernetes context must be supplied explicitly'*) ;;
  *) printf 'FAIL: unexpected implicit-context diagnostic: %s\n' "$output" >&2; exit 1 ;;
esac

for variable in T2_CONTEXT CONTROL_API_REAL_PG_CONTEXT K8S_CONTEXT KUBECONTEXT; do
  result="$(env -u T2_CONTEXT -u CONTROL_API_REAL_PG_CONTEXT -u K8S_CONTEXT -u KUBECONTEXT \
    "$variable=$PROFILE" T2_PROJECT_DIR="$ROOT" T2_PROFILE="$PROFILE" \
    MINIKUBE_PROFILE="$PROFILE" bash -c '
      source "$1"
      t2_require_explicit_context
      printf "%s|%s\n" "$T2_CONTEXT" "$T2_CONTEXT_SOURCE"
    ' _ "$COMMON")"
  case "$result" in
    "$PROFILE"'|explicit-'*) ;;
    *) printf 'FAIL: %s did not establish explicit context provenance: %s\n' "$variable" "$result" >&2; exit 1 ;;
  esac
done

printf 'PASS: public Minikube context provenance is explicit and fail-closed\n'
