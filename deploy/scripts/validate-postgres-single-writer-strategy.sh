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
command -v yq >/dev/null 2>&1 || fail "yq is required"

# Zero overlays means the loop below runs zero iterations and the script exits 0
# having validated nothing — a fail-open. An empty or whitespace-only
# SINGLE_WRITER_OVERLAYS must fail loudly, not pass vacuously.
[ "${#OVERLAYS[@]}" -gt 0 ] ||
  fail "SINGLE_WRITER_OVERLAYS resolved to zero overlays — refusing to pass vacuously"

for overlay in "${OVERLAYS[@]}"; do
  # Render OFFLINE: `kubectl kustomize` builds the overlay client-side, and yq
  # converts the multi-document YAML into a single JSON array for jq. The
  # previous `kubectl create --dry-run=client` performed API discovery
  # (kind -> resource), which needs a live API server and fails in CI with
  # "unable to recognize STDIN: connection refused". This validation is a pure
  # rendered-manifest lint and must never touch a cluster.
  rendered_json="$(
    cd "${ROOT_DIR}" &&
      kubectl kustomize "${overlay}" |
        yq ea -o=json '[.]'
  )"

  for id in "${DATABASE_DEPLOYS[@]}"; do
    namespace="${id%%/*}"
    name="${id#*/}"
    if ! deployment="$(
      jq -e --arg namespace "${namespace}" --arg name "${name}" \
        'first(.[] | select(.kind == "Deployment" and .metadata.namespace == $namespace and .metadata.name == $name))' \
        <<<"${rendered_json}"
    )"; then
      # This overlay does not render ${id}. The script runs on partial overlay
      # sets on purpose (gcp-* and the registry Deployment live in the sibling
      # evenfire-infra repo; this repo ships only the minikube overlay), so an
      # absent deploy is validated in whatever overlay/repo DEFINES it, not here.
      # A real Recreate->RollingUpdate regression on a deploy that IS rendered
      # still fails loudly below; a silent disappearance is surfaced by this
      # NOTICE rather than a hard fail against an overlay that never had it.
      echo "NOTICE: ${overlay} does not render Deployment ${id}; skipping (validated where it is defined)" >&2
      continue
    fi

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
    if ! deployment="$(
      jq -e --arg namespace "${namespace}" --arg name "${name}" \
        'first(.[] | select(.kind == "Deployment" and .metadata.namespace == $namespace and .metadata.name == $name))' \
        <<<"${rendered_json}"
    )"; then
      # This overlay does not render ${id}. The script runs on partial overlay
      # sets on purpose (gcp-* and the registry Deployment live in the sibling
      # evenfire-infra repo; this repo ships only the minikube overlay), so an
      # absent deploy is validated in whatever overlay/repo DEFINES it, not here.
      # A real Recreate->RollingUpdate regression on a deploy that IS rendered
      # still fails loudly below; a silent disappearance is surfaced by this
      # NOTICE rather than a hard fail against an overlay that never had it.
      echo "NOTICE: ${overlay} does not render Deployment ${id}; skipping (validated where it is defined)" >&2
      continue
    fi

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
