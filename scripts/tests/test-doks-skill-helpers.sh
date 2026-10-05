#!/usr/bin/env bash
# Contract test for the cloud-neutral helpers the evenfire-digitalocean-doks
# skill copies from the EKS skill: provenance header, no AWS-specific wording,
# and the fail-closed behaviour of image-gate.rb and verify-rollout.sh.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${ROOT_DIR}/.agents/skills/evenfire-digitalocean-doks/scripts"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

for f in image-gate.rb verify-rollout.sh np-deny-probe.sh; do
  [ -f "$S/$f" ] || fail "missing $f"
  grep -qE '^# (Copied|Adapted) from \.agents/skills/evenfire-aws-eks/scripts/' "$S/$f" \
    || fail "$f has no provenance header"
  if grep -vE '^# (Copied|Adapted) from ' "$S/$f" | grep -qiwE 'aws|eks|alb|vpc'; then
    fail "$f still mentions AWS-specific terms"
  fi
done
for f in verify-rollout.sh np-deny-probe.sh; do
  [ -x "$S/$f" ] || fail "$f is not executable"
done

good="$tmp/good.yaml"
cat >"$good" <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata: {name: host-context-controller, namespace: control-plane}
spec:
  template:
    spec:
      containers:
        - name: host-context-controller
          image: ghcr.io/evenfire-ai/host-context-controller:v0.10.0
          env:
            - {name: CONTEXT_MAPPER_HOST_IMAGE, value: "ghcr.io/evenfire-ai/mcp-host-slim:v0.10.0"}
            - {name: CONTEXT_MAPPER_DESKTOP_IMAGE, value: "ghcr.io/evenfire-ai/mcp-host-desktop:v0.10.0"}
            - {name: CONTEXT_MAPPER_CHANNEL_READER_IMAGE, value: "ghcr.io/evenfire-ai/channel-reader:v0.10.0"}
            - {name: CONTEXT_MAPPER_GFSC_IMAGE, value: "ghcr.io/evenfire-ai/gfs-controller:v0.10.0"}
            - {name: CONTEXT_MAPPER_EGRESS_PROXY_IMAGE, value: "ghcr.io/evenfire-ai/nginx-egress-proxy:v0.10.0"}
            - {name: CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE, value: "ghcr.io/evenfire-ai/stdio-bridge:v0.10.0"}
            - {name: CONTEXT_MAPPER_WFC_IMAGE, value: "ghcr.io/evenfire-ai/workflow-coordinator:v0.10.0"}
EOF
RELEASE_TAG=v0.10.0 ruby "$S/image-gate.rb" <"$good" | grep -q 'image gate: OK' \
  || fail "image gate rejected a valid render"

sed 's#host-context-controller:v0.10.0#host-context-controller:latest#' "$good" >"$tmp/latest.yaml"
if RELEASE_TAG=v0.10.0 ruby "$S/image-gate.rb" <"$tmp/latest.yaml" >/dev/null; then
  fail "image gate accepted a latest tag"
fi

grep -v CONTEXT_MAPPER_DESKTOP_IMAGE "$good" >"$tmp/missing.yaml"
if RELEASE_TAG=v0.10.0 ruby "$S/image-gate.rb" <"$tmp/missing.yaml" >/dev/null; then
  fail "image gate accepted a render without CONTEXT_MAPPER_DESKTOP_IMAGE"
fi

sed 's#ghcr.io/evenfire-ai/channel-reader:v0.10.0#clerum/channel-reader:0.9.5#' "$good" >"$tmp/dockerhub.yaml"
if RELEASE_TAG=v0.10.0 ruby "$S/image-gate.rb" <"$tmp/dockerhub.yaml" >/dev/null; then
  fail "image gate accepted an unqualified clerum/* image"
fi

: >"$tmp/empty.yaml"
if CONTEXT=unused RENDER="$tmp/empty.yaml" bash "$S/verify-rollout.sh" >/dev/null 2>&1; then
  fail "verify-rollout accepted an empty render"
fi

echo "test-doks-skill-helpers: OK"
