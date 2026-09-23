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


def active(path):
    """The file without its comment lines, so a commented-out value never
    satisfies an assertion."""
    lines = path.read_text().splitlines()
    return "\n".join(line for line in lines if not line.lstrip().startswith("#")) + "\n"


text = active(manifest)
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

# The per-attempt cap is the minimum of every source, so a stale value here
# silently holds it below the 30 min contract ceiling.
for var in ("GROK_LLM_PROXY_MAX_STREAM_DURATION_MS", "GROK_LLM_PROXY_MAX_DEADLINE_MS"):
    if f'  {var}: "1800000"\n' not in text:
        errors.append(f"manifest must set {var} to 1800000")

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

# Eight 8 MiB streams and three queued 8 MiB bodies (#739 D5) peaked at 510 MiB
# of RSS with a 384 MiB old space and at 480-511 MiB with an uncapped heap. That
# is past the former 256Mi limit and under 768Mi, so the pod gets a 768Mi limit
# and the same heap cap as codex-llm-proxy (whose visual slots need 1Gi).
memory_limit = re.search(r"limits:\n\s+cpu: \S+\n\s+memory: (\S+)", text)
memory_request = re.search(r"requests:\n\s+cpu: \S+\n\s+memory: (\S+)", text)
heap_cap = re.search(
    r"- name: NODE_OPTIONS\n\s+value: \"--max-old-space-size=(\d+)\"", text
)
if not memory_limit or memory_limit.group(1) != "768Mi":
    errors.append("proxy memory limit must be 768Mi")
if not memory_request or memory_request.group(1) != "256Mi":
    errors.append("proxy memory request must be 256Mi")
if not heap_cap or heap_cap.group(1) != "384":
    errors.append("proxy must cap the V8 old space at 384 MiB through NODE_OPTIONS")

# #739 D6: on SIGTERM the proxy stops accepting and waits for its open streams
# (main.ts awaits servers.close()), so the grace period must outlast the
# longest stream plus 60 s for redeem and finalize. Derived from the same
# manifest, so the two values cannot drift apart.
stream_ms = re.findall(r'^  GROK_LLM_PROXY_MAX_STREAM_DURATION_MS: "(\d+)"$', text, re.M)
grace = re.findall(r"^\s+terminationGracePeriodSeconds: (\d+)$", text, re.M)
print(
    f"parsed GROK_LLM_PROXY_MAX_STREAM_DURATION_MS={stream_ms} "
    f"terminationGracePeriodSeconds={grace}"
)
if len(stream_ms) != 1 or len(grace) != 1:
    errors.append(
        "manifest must set GROK_LLM_PROXY_MAX_STREAM_DURATION_MS and "
        "terminationGracePeriodSeconds exactly once"
    )
else:
    # Queue wait 60 + body read 10 + redeem 15 + finalize 15 + margin 20.
    # The proxy's test/deployManifest.test.ts derives the same sum from code.
    required_grace = -(-int(stream_ms[0]) // 1000) + 120
    if int(grace[0]) != required_grace:
        errors.append(
            f"terminationGracePeriodSeconds must be {required_grace} "
            f"(MAX_STREAM_DURATION_MS / 1000 + 120), found {grace[0]}"
        )

if "grok-llm-proxy.yaml" not in active(kustomize):
    errors.append("kustomization does not include grok-llm-proxy.yaml")

cm = active(configmaps)
if "location = /api/v1/internal/llm/grok/provider-attempts/redeem" not in cm:
    errors.append("rpc gateway missing exact Grok redeem location")
if "location = /api/v1/internal/llm/grok/provider-attempts/finalize" not in cm:
    errors.append("rpc gateway missing exact Grok finalize location")
if re.search(r"location\s+/api/v1/internal/llm/grok", cm):
    errors.append("Grok redeem/finalize paths must stay exact-match, not a prefix wildcard")
# The public base ships every Grok switch off and each environment's overlay
# turns it on; keyper-labs/evenfire-infra CI asserts the base half on every
# dev commit. The minikube overlay turns them on (#739). The Host switch
# (MCP_HOST_GROK_SUBSCRIPTION_ENABLED) is not here: HCC injects it per Host.
if "CONTROL_API_GROK_SUBSCRIPTION_ENABLED: 'false'" not in cm:
    errors.append("base control-api config must keep Grok subscription disabled")
if 'GROK_LLM_PROXY_EXECUTION_ENABLED: "false"' not in text:
    errors.append("base grok-llm-proxy config must keep execution disabled")
# The proxy derives its body limit from the contract plus the envelope
# allowance; a literal in base would freeze it at a stale value.
if "GROK_LLM_PROXY_MAX_BODY_BYTES" in text:
    errors.append("base grok-llm-proxy config must not set GROK_LLM_PROXY_MAX_BODY_BYTES")
wrc_disabled = re.compile(r'- name: WRC_GROK_SUBSCRIPTION_ENABLED\n\s+value: "false"\n')
if not wrc_disabled.search(active(manifest.parent / "workflow-recipes.yaml")):
    errors.append("base workflow-recipes must keep Grok subscriptions disabled")
wrc_enabled = re.compile(r'- name: WRC_GROK_SUBSCRIPTION_ENABLED\n\s+value: "true"\n')
overlay = minikube.parent
if "CONTROL_API_GROK_SUBSCRIPTION_ENABLED: 'true'" not in active(
    overlay / "configmaps/control-api-config.yaml"
):
    errors.append("minikube control-api-config must enable Grok subscriptions")
if "GROK_LLM_PROXY_EXECUTION_ENABLED: 'true'" not in active(
    overlay / "configmaps/grok-llm-proxy-config.yaml"
):
    errors.append("minikube grok-llm-proxy-config must enable execution")
wrc_patch = overlay / "patches/workflow-recipes-grok.yaml"
if "patches/workflow-recipes-grok.yaml" not in active(minikube):
    errors.append("minikube overlay must apply patches/workflow-recipes-grok.yaml")
if not wrc_patch.is_file() or not wrc_enabled.search(active(wrc_patch)):
    errors.append("minikube workflow-recipes patch must enable Grok subscriptions")
if cm.count("location / {\n          return 403;") < 2:
    errors.append("gateways must keep catch-all 403")

np = active(networkpolicies)
if "name: grok-llm-proxy-ingress" not in np or "name: grok-llm-proxy-egress" not in np:
    errors.append("networkpolicies missing grok-llm-proxy ingress/egress")
docs = [chunk for chunk in np.split("\n---\n") if chunk.strip()]
gateway = next(
    (
        chunk
        for chunk in docs
        if re.search(r"(?m)^  name: control-api-rpc-gateway\s*$", chunk)
    ),
    "",
)
ingress = ""
if "\n  ingress:\n" in gateway:
    ingress = gateway.split("\n  ingress:\n", 1)[1].split("\n  egress:\n", 1)[0]
if "app: grok-llm-proxy" not in ingress:
    errors.append("rpc gateway ingress must admit app: grok-llm-proxy")
if "name: grok-llm-proxy-egress" not in active(base_kustomize):
    errors.append("base kustomization must fill grok-llm-proxy-egress except")

token_src = active(tokens)
if "grok-llm-proxy=${TOKEN_GROK_LLM_PROXY}" not in token_src:
    errors.append("apply-inter-service-tokens.sh must project a dedicated grok-llm-proxy token")
if "grok-llm-proxy-secrets" not in token_src:
    errors.append("proxy must receive only its dedicated secret, not the full token map")
if "codex-llm-proxy and grok-llm-proxy tokens must be distinct" not in token_src:
    errors.append("token script must refuse equal Codex and Grok tokens")

if "name: grok-llm-proxy-secrets" not in active(secrets):
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

build = active(build_images)
if "clerum/grok-llm-proxy:test" not in build:
    errors.append("build-images.sh missing clerum/grok-llm-proxy:test")
if 'build_image "grok-llm-proxy"' not in build:
    errors.append("build-images.sh missing build_image grok-llm-proxy")

wf = active(workflow)
if "- image: grok-llm-proxy" not in wf:
    errors.append("build-publish.yml missing matrix image")
if "packages/grok-provider-attempt-contract/**" not in wf:
    errors.append("build-publish.yml filters must watch the Grok attempt contract")
if "- grok-llm-proxy" not in active(ci_public):
    errors.append("ci-public.yml missing grok-llm-proxy")
if "clerum/grok-llm-proxy" not in active(ghcr):
    errors.append("ghcr-images component missing rewrite")
if "clerum/grok-llm-proxy" not in active(minikube):
    errors.append("minikube overlay images: missing grok-llm-proxy")
if "configmaps/grok-llm-proxy-config.yaml" not in active(minikube):
    errors.append("minikube overlay missing grok-llm-proxy config sibling")
if '"grok-llm-proxy"' not in active(preflight):
    errors.append("build-preflight.sh missing grok-llm-proxy")
if "grok-llm-proxy/*" not in active(incremental):
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
