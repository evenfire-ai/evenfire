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

Available; buildable and published to the container registry. No test suite yet (unlike `airtable/` and `mongodb/`). Referenced in `docs/deploy/minikube.md` (NetworkPolicy troubleshooting for a coordinator connecting to a `web-search` MCP server) and type-checked by `scripts/build-preflight.sh`. Minikube setup does not build or pull the image; the registry installs it on demand.
