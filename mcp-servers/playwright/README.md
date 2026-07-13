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

Note: the in-tree `mcpserver.yaml` currently points directly at the upstream digest-pinned image rather than the locally built one.

## Kubernetes Deployment

Deployed via the `McpServer` CRD; the operator creates the Deployment and Service.

```bash
# From mcp-servers/ — renders the NetworkPolicy template with public-egress exceptions
make deploy-playwright
```

See [`mcpserver.yaml`](./mcpserver.yaml) for the full CRD spec. Key fields:

- **Image**: `mcr.microsoft.com/playwright/mcp@sha256:a9d607e5…` (digest-pinned upstream)
- **Namespace**: `mcp-server`
- **Transport**: StreamableHTTP at `http://playwright-server.mcp-server.svc.cluster.local:8931/mcp`
- **Resources**: 512Mi/250m request, 1Gi/1000m limit

[`networkpolicy.yaml`](./networkpolicy.yaml) is a template-only policy (egress to TCP 80/443) — do not `kubectl apply` it directly; `make deploy-playwright` renders it through `deploy/scripts/render-public-egress-exceptions.rb` so it receives the canonical public-egress CIDR exclusions.

## Status

Available; deployable via the makefile. No test suite in this directory (unlike `airtable/` and `mongodb/`). Referenced by `docs/crds/context.md` and `charts/clerum-crds/examples/context1.yaml` (a `Context` listing `playwright-server`), and by the `deploy-playwright` target in [`../makefile`](../makefile).
