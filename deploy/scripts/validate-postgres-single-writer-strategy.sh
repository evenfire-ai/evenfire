#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERLAYS=(
  "deploy/overlays/minikube"
  "deploy/overlays/gcp-dev"
  "deploy/overlays/gcp-prod"
)
DATABASE_DEPLOYS=(
  "control-plane/control-postgres"
  "registry/registry-postgres"
)

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

for overlay in "${OVERLAYS[@]}"; do
  rendered_json="$(
    cd "${ROOT_DIR}" &&
      kubectl kustomize "${overlay}" |
        kubectl create --dry-run=client --validate=false -f - -o json |
        jq -s '.'
  )"

  for id in "${DATABASE_DEPLOYS[@]}"; do
    namespace="${id%%/*}"
    name="${id#*/}"
    deployment="$(
      jq -e --arg namespace "${namespace}" --arg name "${name}" \
        'first(.[] | select(.kind == "Deployment" and .metadata.namespace == $namespace and .metadata.name == $name))' \
        <<<"${rendered_json}"
    )" || fail "${overlay}: missing Deployment ${id}"

    pvc_count="$(
      jq '[.spec.template.spec.volumes[]? | select(.persistentVolumeClaim.claimName != null)] | length' \
        <<<"${deployment}"
    )"
    if [ "${pvc_count}" -eq 0 ]; then
      fail "${overlay}: Deployment ${id} does not mount a PVC; update DATABASE_DEPLOYS if it is no longer stateful"
    fi

    strategy="$(jq -r '.spec.strategy.type // "RollingUpdate"' <<<"${deployment}")"
    if [ "${strategy}" != "Recreate" ]; then
      fail "${overlay}: Deployment ${id} mounts a PVC and must use strategy.type=Recreate, got ${strategy}"
    fi

    if jq -e '.spec.strategy.rollingUpdate != null' >/dev/null <<<"${deployment}"; then
      fail "${overlay}: Deployment ${id} uses Recreate and must not render spec.strategy.rollingUpdate"
    fi
  done
done

echo "Postgres single-writer rollout strategy validation passed"
