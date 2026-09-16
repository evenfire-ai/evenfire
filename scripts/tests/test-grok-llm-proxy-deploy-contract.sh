#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

MANIFEST="$ROOT/deploy/base/control-plane/grok-llm-proxy.yaml"
KUSTOMIZE="$ROOT/deploy/base/control-plane/kustomization.yaml"
BASE_KUSTOMIZE="$ROOT/deploy/base/kustomization.yaml"
CONFIGMAPS="$ROOT/deploy/base/control-plane/configmaps.yaml"
RBAC="$ROOT/deploy/base/control-plane/rbac.yaml"
NETWORKPOLICIES="$ROOT/deploy/base/control-plane/networkpolicies.yaml"
TOKENS="$ROOT/deploy/scripts/apply-inter-service-tokens.sh"
IMAGES="$ROOT/deploy/images.json"
BUILD_IMAGES="$ROOT/scripts/minikube/build-images.sh"
WORKFLOW="$ROOT/.github/workflows/build-publish.yml"
CI_PUBLIC="$ROOT/.github/workflows/ci-public.yml"
GHCR="$ROOT/deploy/components/ghcr-images/kustomization.yaml"
MINIKUBE="$ROOT/deploy/overlays/minikube/kustomization.yaml"
SECRETS="$ROOT/deploy/base/control-plane/secrets-canary.yaml"
PREFLIGHT="$ROOT/scripts/build-preflight.sh"
INCREMENTAL="$ROOT/scripts/minikube/pre-gate-incremental.sh"

if [[ ! -f "$MANIFEST" ]]; then
  fail "missing $MANIFEST"
  exit 1
fi

python3 - "$MANIFEST" "$KUSTOMIZE" "$BASE_KUSTOMIZE" "$CONFIGMAPS" "$RBAC" "$NETWORKPOLICIES" "$TOKENS" "$IMAGES" "$BUILD_IMAGES" "$WORKFLOW" "$CI_PUBLIC" "$GHCR" "$MINIKUBE" "$SECRETS" "$PREFLIGHT" "$INCREMENTAL" <<'PY'
import json, pathlib, re, sys

(
    manifest, kustomize, base_kustomize, configmaps, rbac, networkpolicies, tokens, images,
    build_images, workflow, ci_public, ghcr, minikube, secrets, preflight, incremental,
) = map(pathlib.Path, sys.argv[1:])
errors = []

text = manifest.read_text()
for needle in (
    "kind: Deployment",
    "kind: Service",
    "kind: ServiceAccount",
    "name: grok-llm-proxy",
    "automountServiceAccountToken: false",
    "type: ClusterIP",
    "name: runtime",
    "name: admin",
    "name: metrics",
    "readOnlyRootFilesystem: true",
    "runAsNonRoot: true",
    "type: RuntimeDefault",
    "drop: [ALL]",
    "GROK_LLM_PROXY_JWT_PUBLIC_KEY",
    "GROK_LLM_PROXY_CONTROL_API_TOKEN",
    "GROK_LLM_PROXY_EXECUTION_ENABLED",
    "control-api-rpc-gateway.control-plane.svc",
):
    if needle not in text:
        errors.append(f"manifest missing {needle}")

if "kind: Role" in text or "kind: RoleBinding" in text:
    errors.append("proxy manifest must not declare Role/RoleBinding")
if "automountServiceAccountToken: true" in text:
    errors.append("proxy must not automount a service account token")
if "type: LoadBalancer" in text or "type: NodePort" in text:
    errors.append("proxy Service must stay ClusterIP")
if "DATABASE_URL" in text or "POSTGRES" in text:
    errors.append("proxy must not carry database credentials")
if "CONTROL_API_INTERNAL_SERVICE_TOKENS" in text:
    errors.append("proxy must not receive the full token map")

if "grok-llm-proxy.yaml" not in kustomize.read_text():
    errors.append("kustomization does not include grok-llm-proxy.yaml")

cm = configmaps.read_text()
if "location = /api/v1/internal/llm/grok/provider-attempts/redeem" not in cm:
    errors.append("rpc gateway missing exact Grok redeem location")
if "location = /api/v1/internal/llm/grok/provider-attempts/finalize" not in cm:
    errors.append("rpc gateway missing exact Grok finalize location")
if re.search(r"location\s+/api/v1/internal/llm/grok", cm):
    errors.append("Grok redeem/finalize paths must stay exact-match, not a prefix wildcard")
if "CONTROL_API_GROK_SUBSCRIPTION_ENABLED: 'false'" not in cm:
    errors.append("base control-api config must keep Grok subscription disabled")
if cm.count("location / {\n          return 403;") < 2:
    errors.append("gateways must keep catch-all 403")

np = networkpolicies.read_text()
if "name: grok-llm-proxy-ingress" not in np or "name: grok-llm-proxy-egress" not in np:
    errors.append("networkpolicies missing grok-llm-proxy ingress/egress")
if "app: grok-llm-proxy" not in np[np.find("name: control-api-rpc-gateway"): np.find("name: grok-llm-proxy-ingress") if "name: grok-llm-proxy-ingress" in np else len(np)]:
    gateway = np[np.find("name: control-api-rpc-gateway"):]
    if "app: grok-llm-proxy" not in gateway.split("egress:", 1)[0]:
        errors.append("rpc gateway ingress must admit app: grok-llm-proxy")
if "name: grok-llm-proxy-egress" not in base_kustomize.read_text():
    errors.append("base kustomization must fill grok-llm-proxy-egress except")

token_src = tokens.read_text()
if "grok-llm-proxy=${TOKEN_GROK_LLM_PROXY}" not in token_src:
    errors.append("apply-inter-service-tokens.sh must project a dedicated grok-llm-proxy token")
if "grok-llm-proxy-secrets" not in token_src:
    errors.append("proxy must receive only its dedicated secret, not the full token map")
if "codex-llm-proxy and grok-llm-proxy tokens must be distinct" not in token_src:
    errors.append("token script must refuse equal Codex and Grok tokens")

if "name: grok-llm-proxy-secrets" not in secrets.read_text():
    errors.append("secrets-canary.yaml missing grok-llm-proxy-secrets")

manifest_json = json.loads(images.read_text())
row = next((item for item in manifest_json["images"] if item["name"] == "grok-llm-proxy"), None)
if not row:
    errors.append("images.json missing grok-llm-proxy")
else:
    paths = row.get("source_paths") or []
    if "grok-llm-proxy/**" not in paths:
        errors.append("images.json must watch grok-llm-proxy/**")
    if "packages/grok-provider-attempt-contract/**" not in paths:
        errors.append("images.json must watch packages/grok-provider-attempt-contract/**")

for consumer in ("control-api", "mcp-host", "mcp-host-slim", "mcp-host-full", "mcp-host-desktop"):
    item = next((entry for entry in manifest_json["images"] if entry["name"] == consumer), None)
    if not item:
        errors.append(f"images.json missing {consumer}")
        continue
    if "packages/grok-provider-attempt-contract/**" not in (item.get("source_paths") or []):
        errors.append(f"{consumer} source_paths must include packages/grok-provider-attempt-contract/**")

build = build_images.read_text()
if "clerum/grok-llm-proxy:test" not in build:
    errors.append("build-images.sh missing clerum/grok-llm-proxy:test")
if 'build_image "grok-llm-proxy"' not in build:
    errors.append("build-images.sh missing build_image grok-llm-proxy")

wf = workflow.read_text()
if "- image: grok-llm-proxy" not in wf:
    errors.append("build-publish.yml missing matrix image")
if "packages/grok-provider-attempt-contract/**" not in wf:
    errors.append("build-publish.yml filters must watch the Grok attempt contract")
if "- grok-llm-proxy" not in ci_public.read_text():
    errors.append("ci-public.yml missing grok-llm-proxy")
if "clerum/grok-llm-proxy" not in ghcr.read_text():
    errors.append("ghcr-images component missing rewrite")
if "clerum/grok-llm-proxy" not in minikube.read_text():
    errors.append("minikube overlay images: missing grok-llm-proxy")
if "configmaps/grok-llm-proxy-config.yaml" not in minikube.read_text():
    errors.append("minikube overlay missing grok-llm-proxy config sibling")
if '"grok-llm-proxy"' not in preflight.read_text():
    errors.append("build-preflight.sh missing grok-llm-proxy")
if "grok-llm-proxy/*" not in incremental.read_text():
    errors.append("pre-gate-incremental.sh missing grok-llm-proxy")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print("ok")
PY

if [[ $? -eq 0 ]]; then
  pass "grok-llm-proxy deploy contract"
else
  fail "grok-llm-proxy deploy contract"
fi

exit "$FAIL"
