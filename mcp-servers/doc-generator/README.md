# Doc Generator MCP Server

First-party MCP server (source in [`src/index.ts`](./src/index.ts)) that generates print-ready HTML documents and Excel spreadsheets into an output directory. Uses StreamableHTTP transport on port 3000 (`POST /mcp`), with a health check at `GET /health` on the same port.

## Available MCP Tools

| Tool             | Description                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `generate_pdf`   | Converts markdown to a styled, print-ready HTML document (A4/letter `@page` CSS) plus a plain-text fallback |
| `generate_excel` | Creates a real `.xlsx` workbook (via ExcelJS) with styled headers, auto-width columns, alternating rows     |
| `list_artifacts` | Lists generated files in the output directory with name, path, size, and creation date                      |

Honest caveat: despite the name, `generate_pdf` writes **HTML** (print-ready, for downstream PDF rendering) and a `.txt` fallback — it does not produce PDF binaries itself. The tool response reports `format: "html"`.

## Environment Variables

| Variable     | Source                         | Description                                    |
| ------------ | ------------------------------ | ---------------------------------------------- |
| `PORT`       | Dockerfile default (3000)      | HTTP listen port for both `/mcp` and `/health` |
| `OUTPUT_DIR` | Dockerfile default (`/output`) | Directory where generated files are written    |

No API keys or secrets are required.

## Docker Build

```bash
docker build -t doc-generator-mcp:latest .
```

Multi-stage `node:24-alpine` build; runs as a non-root `mcp` user (uid 1001) that owns `/output`. `scripts/minikube/build-images.sh` builds it into minikube as `clerum/doc-generator-mcp:v1`. It is not currently in the `.github/workflows/build-publish.yml` publish matrix.

## Deployment

This directory has no `mcpserver.yaml` or NetworkPolicy — there is no ready-made `McpServer` CRD instance in-tree. To deploy it, write your own `McpServer` resource pointing at the image (see [`../README.md`](../README.md) for the CRD shape) or reference the image as an MCP workload in a workflow recipe. Generated files land in `OUTPUT_DIR` inside the container; mount a volume there if you need to keep or share them.

## Status

Available; built for local minikube use by `scripts/minikube/build-images.sh` and type-checked by `scripts/build-preflight.sh`. No test suite yet (unlike `airtable/` and `mongodb/`) and not yet referenced by user-facing docs.
