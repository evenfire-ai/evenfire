# Playwright MCP Server

MCP server for browser automation, packaging the upstream Microsoft Playwright MCP image (`mcr.microsoft.com/playwright/mcp`, digest-pinned). Uses StreamableHTTP transport on port 8931.

The [`Dockerfile`](./Dockerfile) extends the pinned upstream image and installs Chrome Headless Shell from Chrome for Testing. The upstream [Playwright MCP](https://github.com/microsoft/playwright-mcp) image supplies the tools for navigation, DOM interaction, code execution, and screenshots.

## Environment Variables / Secrets

The image sets `PLAYWRIGHT_MCP_EXECUTABLE_PATH` to select the pinned browser.
The CRD uses `auth.type: none` and reads its container arguments from `mcpserver.yaml`.

- `--headless --browser chromium --no-sandbox`
- `--host 0.0.0.0 --port 8931`
- `--allowed-hosts "*"`

## Docker Build

```bash
docker build -t playwright-mcp-server:latest .
```

- `scripts/minikube/build-images.sh` optionally builds/reuses it as `clerum/playwright-mcp-server:test` (gated by `MINIKUBE_BUILD_PLAYWRIGHT_MCP_IMAGE`; the default minikube overlay does not deploy it).
- `.github/workflows/build-publish.yml` publishes it to `ghcr.io/evenfire-ai/playwright-server` on changes under `mcp-servers/playwright/`.

The in-tree `mcpserver.yaml` pins the multi-architecture image published from this Dockerfile by digest.
Later builds can publish a new digest and update `latest`; they do not change the
manifest's pin. Validate a new image before updating that pin.

## Kubernetes Deployment

Deployed via the `McpServer` CRD; the operator creates the Deployment and Service.

```bash
# From mcp-servers/ — renders the NetworkPolicy template with public-egress exceptions
make deploy-playwright
```

See [`mcpserver.yaml`](./mcpserver.yaml) for the full CRD spec. Key fields:

- **Image**: `ghcr.io/evenfire-ai/playwright-server@sha256:2e5ef0183d6dda21e0797ef32f1cbba2e07e38ec93b67bd3675079c5729ffa74` (verified Node and Chromium image)
- **Namespace**: `mcp-server`
- **Transport**: StreamableHTTP at `http://playwright-server.mcp-server.svc.cluster.local:8931/mcp`
- **Resources**: 512Mi/250m request, 1Gi/1000m limit

Before deploying, verify that the effective HCC image policy permits
`ghcr.io/evenfire-ai/` or that an approved mirror is used. The base deployment
allows this prefix; other environments can use different policies.

[`networkpolicy.yaml`](./networkpolicy.yaml) is a template-only policy (egress to TCP 80/443) — do not `kubectl apply` it directly; `make deploy-playwright` renders it through `deploy/scripts/render-public-egress-exceptions.rb` so it receives the canonical public-egress CIDR exclusions.

## Status

Available; deployable via the makefile. The container runtime smoke test is described below. Referenced by `docs/crds/context.md` and `charts/clerum-crds/examples/context1.yaml` (a `Context` listing `playwright-server`), and by the `deploy-playwright` target in [`../makefile`](../makefile).

## Temporary Node security patch (2026-10-22)

The pinned official image declares Node 22.22.0. The latest official release
`v0.0.83` and the previous two stable tags declare Node 24.21.0 on amd64 and
arm64, below the current security floor.

The Dockerfile keeps the pinned upstream application and system dependencies
and replaces Node with the official digest-pinned 24.22.3 glibc binary.
This is temporary until a patched official Playwright image is available.

## Chromium in new builds

New builds select Chrome Headless Shell `157.0.8103.78` through the MCP executable
setting. The Dockerfile verifies the official archive's SHA-256 for amd64 and
arm64. The smoke test verifies the selected executable and starts a real session.
[Chrome for Testing downloads](https://googlechromelabs.github.io/chrome-for-testing/157.0.8103.78.json) ·
[CVE-2026-125350 fix](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop_018223192.html?hl=fr)

The deployment manifest and cluster probe pin the verified multi-architecture
image from the [combined security candidate](https://github.com/evenfire-ai/evenfire/commit/9a461918d4ac0538a9891d872d6f27630c0e25e3).
The probe checks the image identity, Node version, and Chromium major version.

`test/runtime-smoke.cjs` runs inside the isolated Linux container. It starts the
real MCP HTTP server and Chromium, navigates to a loopback fixture, clicks the
button through MCP, checks the updated page and verifies an actual PNG capture.
CI runs the image and this browser check on amd64 and arm64. CLI loading alone
is not a successful browser validation.

## Cluster probe (Minikube)

From a clean development worktree descended from `origin/dev`, resolve the
branch-owned profile with `make -f scripts/minikube-profiles/branch.mk branch-profile-resolve`.
Export `MINIKUBE_PROFILE` and `CONTROL_API_REAL_PG_CONTEXT` with that profile,
use Node 24, and install the `host-context-controller` dependencies before running
this command from the repository root:

```bash
bash scripts/minikube/with-t2-mutation-lock.sh -- node scripts/e2e/playwright-mcp-cluster-probe.mjs
```

The probe creates a temporary McpServer and checks the image, Node, MCP and
Chromium through loopback inside its pod. It does not exercise the Kubernetes
Service, DNS, NetworkPolicy, mcp-host or Desktop. The policy cleanup check looks
for residue; this fixture does not create a Context or egress bindings.

If the probe reports `RESOURCE_CREATION_AMBIGUOUS` or `CLEANUP_FAILED`, inspect
the journal in the printed evidence directory and verify the profile, context,
run labels and resource identity before recovery. If the journal could not be
written after creation, it can show `creation-pending` without a UID even though
the server exists. An unknown UID is not proof that a resource belongs to the
run. Do not delete all resources with the suite
label; any authorized deletion must preserve UID and resourceVersion
preconditions under the profile's mutation lease.
