#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Overlays to render. Defaults to the full production set; the gcp-* overlays
# live in keyper-labs/evenfire-infra, so this script's full coverage runs there.
# Override (space-separated) to validate only the overlays present in a given
# checkout — e.g. SINGLE_WRITER_OVERLAYS="deploy/overlays/minikube" in this repo.
read -r -a OVERLAYS <<<"${SINGLE_WRITER_OVERLAYS:-deploy/overlays/minikube deploy/overlays/gcp-dev deploy/overlays/gcp-prod}"
DATABASE_DEPLOYS=(
  "control-plane/control-postgres"
  "registry/registry-postgres"
)
# Deployments whose safety model assumes a single writer with NO leader election
# (see host-context-controller/src/statelessLifecycleExecutor.ts). For these the
# RENDERED manifest — not just deploy/base — must keep replicas<=1 and
# strategy=Recreate with no rollingUpdate residue, or a rollout reopens the
# two-writer NetworkPolicy overlap closed in PR #205. Unlike DATABASE_DEPLOYS
# these mount no PVC, so they need their own list rather than the PVC heuristic.
SINGLE_WRITER_DEPLOYS=(
  "control-plane/host-context-controller"
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

  for id in "${SINGLE_WRITER_DEPLOYS[@]}"; do
    namespace="${id%%/*}"
    name="${id#*/}"
    deployment="$(
      jq -e --arg namespace "${namespace}" --arg name "${name}" \
        'first(.[] | select(.kind == "Deployment" and .metadata.namespace == $namespace and .metadata.name == $name))' \
        <<<"${rendered_json}"
    )" || fail "${overlay}: missing Deployment ${id}"

    replicas="$(jq -r '.spec.replicas // 1' <<<"${deployment}")"
    if [ "${replicas}" -gt 1 ]; then
      fail "${overlay}: single-writer Deployment ${id} must keep replicas<=1 (no leader election), got ${replicas}"
    fi

    strategy="$(jq -r '.spec.strategy.type // "RollingUpdate"' <<<"${deployment}")"
    if [ "${strategy}" != "Recreate" ]; then
      fail "${overlay}: single-writer Deployment ${id} must use strategy.type=Recreate, got ${strategy}"
    fi

    if jq -e '.spec.strategy.rollingUpdate != null' >/dev/null <<<"${deployment}"; then
      fail "${overlay}: single-writer Deployment ${id} uses Recreate and must not render spec.strategy.rollingUpdate"
    fi
  done
done

echo "Single-writer rollout strategy validation passed"
