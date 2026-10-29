# Playwright MCP Server

MCP server for browser automation, packaging the upstream Microsoft Playwright MCP image (`mcr.microsoft.com/playwright/mcp`, digest-pinned). Uses StreamableHTTP transport on port 8931.

This is upstream-image packaging, not first-party source: the [`Dockerfile`](./Dockerfile) extends the pinned upstream image and pre-installs the Chromium browser (`playwright install chromium`). There is no `src/` in this directory, so the tool list is defined by the upstream image — per the CRD description, it provides browser automation tools for navigation, DOM interaction, code execution, and screenshot capture. See the upstream [Playwright MCP](https://github.com/microsoft/playwright-mcp) project for the current tool set.

## Environment Variables / Secrets

None. The CRD sets `auth.type: none` and there is no secret template — the server is configured entirely through container args in `mcpserver.yaml`:

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

## Kubernetes Deployment

Deployed via the `McpServer` CRD; the operator creates the Deployment and Service.

```bash
# From mcp-servers/ — renders the NetworkPolicy template with public-egress exceptions
make deploy-playwright
```

See [`mcpserver.yaml`](./mcpserver.yaml) for the full CRD spec. Key fields:

- **Image**: `ghcr.io/evenfire-ai/playwright-server@sha256:fc603bbc05d216ca9394940463e5e216d0a48732c24555fb9b67d20775fccf73` (digest-pinned build of this Dockerfile)
- **Namespace**: `mcp-server`
- **Transport**: StreamableHTTP at `http://playwright-server.mcp-server.svc.cluster.local:8931/mcp`
- **Resources**: 512Mi/250m request, 1Gi/1000m limit

[`networkpolicy.yaml`](./networkpolicy.yaml) is a template-only policy (egress to TCP 80/443) — do not `kubectl apply` it directly; `make deploy-playwright` renders it through `deploy/scripts/render-public-egress-exceptions.rb` so it receives the canonical public-egress CIDR exclusions.

## Status

Available; deployable via the makefile. The container runtime smoke test is described below. Referenced by `docs/crds/context.md` and `charts/clerum-crds/examples/context1.yaml` (a `Context` listing `playwright-server`), and by the `deploy-playwright` target in [`../makefile`](../makefile).

## Temporary Node security patch (2026-10-22)

The pinned official image declares Node 22.22.0. The latest official release
`v0.0.83` and the previous two stable tags declare Node 24.21.0 on amd64 and
arm64, below the current security floor.

For the published image, the Dockerfile keeps the pinned official application and
browser dependencies and replaces only Node with the official digest-pinned
24.22.1 glibc binary. This is temporary until a patched official Playwright
image is available. The deployment manifest pins the published build by digest.

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
