#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAIL=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

MANIFEST="$ROOT/deploy/base/control-plane/codex-llm-proxy.yaml"
KUSTOMIZE="$ROOT/deploy/base/control-plane/kustomization.yaml"
CONFIGMAPS="$ROOT/deploy/base/control-plane/configmaps.yaml"
RBAC="$ROOT/deploy/base/control-plane/rbac.yaml"
NETWORKPOLICIES="$ROOT/deploy/base/control-plane/networkpolicies.yaml"
TOKENS="$ROOT/deploy/scripts/apply-inter-service-tokens.sh"
IMAGES="$ROOT/deploy/images.json"
BUILD_IMAGES="$ROOT/scripts/minikube/build-images.sh"
WORKFLOW="$ROOT/.github/workflows/build-publish.yml"
GHCR="$ROOT/deploy/components/ghcr-images/kustomization.yaml"
MINIKUBE="$ROOT/deploy/overlays/minikube/kustomization.yaml"

if [[ ! -f "$MANIFEST" ]]; then
  fail "missing $MANIFEST"
  exit 1
fi

python3 - "$MANIFEST" "$KUSTOMIZE" "$CONFIGMAPS" "$RBAC" "$NETWORKPOLICIES" "$TOKENS" "$IMAGES" "$BUILD_IMAGES" "$WORKFLOW" "$GHCR" "$MINIKUBE" <<'PY'
import json, pathlib, re, sys

manifest, kustomize, configmaps, rbac, networkpolicies, tokens, images, build_images, workflow, ghcr, minikube = map(pathlib.Path, sys.argv[1:])
errors = []

text = manifest.read_text()
for needle in (
    "kind: Deployment",
    "kind: Service",
    "kind: ServiceAccount",
    "name: codex-llm-proxy",
    "automountServiceAccountToken: false",
    "type: ClusterIP",
    "name: runtime",
    "name: admin",
    "name: metrics",
    "readOnlyRootFilesystem: true",
    "runAsNonRoot: true",
    "type: RuntimeDefault",
    "drop: [ALL]",
    "CODEX_LLM_PROXY_JWT_PUBLIC_KEY",
    "CODEX_LLM_PROXY_CONTROL_API_TOKEN",
    "CODEX_LLM_PROXY_EXECUTION_ENABLED",
    "control-api-rpc-gateway.control-plane.svc",
):
    if needle not in text:
        errors.append(f"manifest missing {needle}")

if "kind: Role" in text or "kind: RoleBinding" in text:
    errors.append("proxy manifest must not declare Role/RoleBinding")
if "kind: ClusterRole" in text or "kind: ClusterRoleBinding" in text:
    errors.append("proxy manifest must not declare ClusterRole/ClusterRoleBinding")
if "kind: Namespace" in text or "kind: CustomResourceDefinition" in text:
    errors.append("proxy must not introduce a namespace or CRD")
if "kind: Ingress" in text or "kind: Gateway" in text:
    errors.append("proxy must not expose Ingress or Gateway")
if "automountServiceAccountToken: true" in text:
    errors.append("proxy must not automount a service account token")
if "type: LoadBalancer" in text or "type: NodePort" in text:
    errors.append("proxy Service must stay ClusterIP")
for forbidden in (
    "DATABASE_URL",
    "POSTGRES",
    "CONTROL_API_DATABASE",
    "control-api-internal-tokens",
    "CONTROL_API_INTERNAL_SERVICE_TOKENS",
    "CONTROL_API_INTERNAL_TOKENS",
):
    if forbidden in text:
        errors.append(f"proxy must not carry {forbidden}")
if re.search(r"capabilities:[\s\S]{0,80}\n\s+add:", text):
    errors.append("proxy must not add Linux capabilities")
container_block = re.search(r"^      containers:\n((?:        .+\n)+)", text, re.M)
named_containers = re.findall(
    r"^        - name: (\S+)", container_block.group(1) if container_block else "", re.M
)
if named_containers != ["codex-llm-proxy"]:
    errors.append(f"proxy must keep a single container, found {named_containers}")

if "codex-llm-proxy.yaml" not in kustomize.read_text():
    errors.append("kustomization does not include codex-llm-proxy.yaml")

rbac_text = rbac.read_text()
if re.search(r"name:\s*codex-llm-proxy", rbac_text):
    errors.append("rbac.yaml must not grant the proxy a Role")

cm = configmaps.read_text()
if "location = /api/v1/mcp-host/llm/provider-attempts/authorize" not in cm:
    errors.append("workflow gateway missing exact authorize location")
if "location = /api/v1/internal/llm/provider-attempts/redeem" not in cm:
    errors.append("rpc gateway missing exact redeem location")
if "location = /api/v1/internal/llm/provider-attempts/finalize" not in cm:
    errors.append("rpc gateway missing exact finalize location")
if cm.count("location / {\n          return 403;") < 2:
    errors.append("gateways must keep catch-all 403")
if "kind: Service" in cm and "codex-llm-gateway" in cm:
    errors.append("must not add a third gateway")
if re.search(r"location\s+/api/v1/mcp-host/llm", cm):
    errors.append("authorize path must stay exact-match, not a prefix wildcard")
if re.search(r"location\s+/api/v1/internal/llm", cm):
    errors.append("redeem/finalize paths must stay exact-match, not a prefix wildcard")
if "codex-llm-gateway" in text or "nginx-codex" in cm:
    errors.append("must not introduce a dedicated Codex gateway")

np = networkpolicies.read_text()
ingress = np[np.find("name: codex-llm-proxy-ingress"): np.find("name: codex-llm-proxy-egress")]
egress = np[np.find("name: codex-llm-proxy-egress"):]
if "namespaceSelector: {}" in ingress:
    errors.append("proxy ingress must not admit every namespace")
if "podSelector: {}" in ingress.split("spec:", 1)[-1][:400]:
    errors.append("proxy ingress must not select every pod")
if "cidr: 0.0.0.0/0" in ingress:
    errors.append("proxy ingress must not open the public internet")

token_src = tokens.read_text()
if "codex-llm-proxy=${TOKEN_CODEX_LLM_PROXY}" not in token_src and "codex-llm-proxy=${TOKEN_CODEX" not in token_src:
    errors.append("apply-inter-service-tokens.sh must project a dedicated codex-llm-proxy token")
if "codex-llm-proxy-secrets" not in token_src:
    errors.append("proxy must receive only its dedicated secret, not the full token map")

manifest_json = json.loads(images.read_text())
row = next((item for item in manifest_json["images"] if item["name"] == "codex-llm-proxy"), None)
if not row:
    errors.append("images.json missing codex-llm-proxy")
else:
    paths = row.get("source_paths") or []
    if "codex-llm-proxy/**" not in paths:
        errors.append("images.json must watch codex-llm-proxy/**")
    if "packages/llm-provider-attempt-contract/**" not in paths:
        errors.append("images.json must watch packages/llm-provider-attempt-contract/**")
    if row.get("published") is not True or row.get("deployed_to_minikube") is not True:
        errors.append("codex-llm-proxy must be published and deployed_to_minikube")

for consumer in ("control-api", "mcp-host", "mcp-host-slim", "mcp-host-full", "mcp-host-desktop"):
    item = next((entry for entry in manifest_json["images"] if entry["name"] == consumer), None)
    if not item:
        errors.append(f"images.json missing {consumer}")
        continue
    if "packages/llm-provider-attempt-contract/**" not in (item.get("source_paths") or []):
        errors.append(f"{consumer} source_paths must include packages/llm-provider-attempt-contract/**")

build = build_images.read_text()
if "clerum/codex-llm-proxy:test" not in build:
    errors.append("build-images.sh missing clerum/codex-llm-proxy:test")
if 'build_image "codex-llm-proxy"' not in build:
    errors.append("build-images.sh missing build_image codex-llm-proxy")

wf = workflow.read_text()
if "- image: codex-llm-proxy" not in wf:
    errors.append("build-publish.yml missing matrix image")
if "packages/llm-provider-attempt-contract/**" not in wf:
    errors.append("build-publish.yml filters must watch the attempt contract")

if "clerum/codex-llm-proxy" not in ghcr.read_text():
    errors.append("ghcr-images component missing rewrite")
if "clerum/codex-llm-proxy" not in minikube.read_text():
    errors.append("minikube overlay images: missing codex-llm-proxy")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print("ok")
PY

if [[ $? -eq 0 ]]; then
  pass "codex-llm-proxy deploy contract"
else
  fail "codex-llm-proxy deploy contract"
fi

exit "$FAIL"
