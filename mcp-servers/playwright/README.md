# Playwright MCP Server

MCP server for browser automation, packaging the upstream Microsoft Playwright MCP image (`mcr.microsoft.com/playwright/mcp`, digest-pinned). Uses StreamableHTTP transport on port 8931.

The [`Dockerfile`](./Dockerfile) keeps the pinned upstream application and browser dependencies, replaces its Node 22.22.0 binary with the official digest-pinned Node 24.22.1 glibc binary, and pre-installs Chromium (`playwright install chromium`). CI verifies the effective Node version and CLI loading on amd64 and arm64. There is no `src/` in this directory, so the tool list remains defined by the upstream [Playwright MCP](https://github.com/microsoft/playwright-mcp) application.

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

The in-tree `mcpserver.yaml` still pins the upstream image with Node 22.22.0. A security rollout must publish the validated repository image and replace that reference with its multiarch digest. Changing the Dockerfile alone does not update that manifest, and a mutable `latest` reference does not bind it to the validated artifact.

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
