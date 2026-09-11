# Web Search MCP Server

First-party MCP server (source in [`src/index.ts`](./src/index.ts)) that wraps the Brave Search API for real web search. Uses StreamableHTTP transport on port 3000 (`POST /mcp`), with a health check at `GET /health` on the same port.

## Available MCP Tools

| Tool          | Description                                                                              |
| ------------- | ---------------------------------------------------------------------------------------- |
| `web_search`  | Search the web via the Brave Search API; returns titles, URLs, snippets (max 20 results) |
| `fetch_page`  | Fetch a URL and return its text content with HTML tags stripped (15s timeout)            |
| `search_news` | Search recent news via the Brave Search API with `day`/`week`/`month` freshness          |

If `SEARCH_API_KEY` is unset, the search tools do not fail — they return a placeholder result explaining how to configure the key.

## Environment Variables

| Variable         | Source                    | Description                                    |
| ---------------- | ------------------------- | ---------------------------------------------- |
| `SEARCH_API_KEY` | Deployment config/secret  | Brave Search API subscription token            |
| `PORT`           | Dockerfile default (3000) | HTTP listen port for both `/mcp` and `/health` |

There is no `example.secret.yaml` in this directory yet; supply `SEARCH_API_KEY` through whatever secret mechanism your deployment uses.

## Docker Build

```bash
docker build -t web-search-mcp:latest .
```

Multi-stage `node:24-alpine` build: compiles TypeScript, then runs `node dist/index.js`.

- Minikube setup neither builds nor pulls it. The evenfire registry distributes this connector and installs it on demand, writing the catalog entry's image reference straight into the `McpServer` resource, so no locally loaded `clerum/*` alias is involved. It is `deployed_to_minikube: false` in `deploy/images.json`.
- `.github/workflows/build-publish.yml` publishes it to `ghcr.io/evenfire-ai/web-search-mcp` on changes under `mcp-servers/web-search/`.

## Deployment

This directory has no `mcpserver.yaml` or NetworkPolicy — unlike `airtable/` and `mongodb/`, there is no ready-made `McpServer` CRD instance in-tree. To deploy it, write your own `McpServer` resource pointing at the image (see [`../README.md`](../README.md) for the CRD shape) or reference the image as an MCP workload in a workflow recipe.

> Note: several workflow-recipe docs and e2e specs use a workload id `web-search` backed by the upstream `ghcr.io/aas-ee/open-web-search` image — that is a different server from this one.

## Status

Available; buildable and published to the container registry. Unit and isolated HTTP/MCP suites are available; see Regression tests below. Referenced in `docs/deploy/minikube.md` (NetworkPolicy troubleshooting for a coordinator connecting to a `web-search` MCP server) and type-checked by `scripts/build-preflight.sh`. Minikube setup does not build or pull the image; the registry installs it on demand.

## fetch_page security contract

`fetch_page` accepts HTTP(S) URLs without userinfo. It rejects non-public and
special-purpose IPv4/IPv6 destinations, validates both DNS record families, pins
the connection to the validated address, and validates every redirect. HTTPS
redirects to HTTP are rejected. No ambient proxy is used. NetworkPolicy remains
a complementary deployment control.

The operation has a 15-second absolute deadline, five redirects maximum, a 1 MiB
body limit before and after decompression, and four active calls per process.
Additional calls fail immediately. `maxChars` remains the output display limit;
it is not the download limit. Redirect and error bodies are destroyed without
reading them. Encodings supported: identity, gzip, deflate and br.

Errors expose a stable code without upstream details. Private destinations and
oversized documents previously accepted are intentionally rejected.

### Regression tests

Use Node 24. `npm test` builds and executes the unit suite. `npm run test:network`
uses the real MCP server and an isolated HTTP fixture inside Docker, with no
external network or published ports. It requires a locally available
`node:24-alpine` image and never pulls implicitly. Run Docker tests on the host,
outside the native Codex sandbox. Only compiled code, dependencies and test files
are mounted read-only. These protocol tests do not replace the Desktop journey.
