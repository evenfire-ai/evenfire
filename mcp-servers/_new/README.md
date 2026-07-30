# Batch 1 — Official remote MCP wrappers

Category A connectors: no image build. Each YAML points `spec.remote.baseUrl` at a
vendor-hosted MCP endpoint; the platform runs an `nginx-egress-proxy` pod per
connector and injects auth headers from the referenced Secret.

| Connector   | Remote endpoint                          | Auth header                                  | Secret                 |
| ----------- | ---------------------------------------- | -------------------------------------------- | ---------------------- |
| `atlassian` | `https://mcp.atlassian.com/v1/mcp/authv2`| `Authorization: Bearer ${ATLASSIAN_API_KEY}` | `atlassian-credentials`|
| `linear`    | `https://mcp.linear.app/mcp`             | `Authorization: Bearer ${LINEAR_API_KEY}`    | `linear-credentials`   |
| `asana`     | `https://mcp.asana.com/v2/mcp`           | `Authorization: Bearer ${ASANA_ACCESS_TOKEN}`| `asana-credentials`    |
| `sentry`    | `https://mcp.sentry.dev/mcp`             | `Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}` | `sentry-credentials` |

Status: all 4 deployed to the `dev` profile, `Ready=True`, pods Running, proxy
wiring verified (`/health` 200; `initialize` reaches the vendor and is rejected
only because the placeholder tokens are fake).

## To activate a connector

Replace the placeholder secret with a real credential (example for Linear):

```bash
kubectl --context=dev delete secret linear-credentials -n mcp-server
kubectl --context=dev create secret generic linear-credentials \
  -n mcp-server --from-literal=LINEAR_API_KEY=<real-key>
```

Where to get each credential:

- **atlassian** — Atlassian service-account API key (or personal API token as
  `Basic base64(email:token)`; swap `valueTemplate` accordingly). Note: some tools
  unavailable with token auth; `cloudId` must be passed explicitly to tools.
- **linear** — Linear Settings → Account → Security & Access → API key.
- **asana** — Asana token. V2 server documents OAuth; verify PAT passthrough
  during smoke test (see note in `asana.yaml`).
- **sentry** — Sentry user auth token with scopes: `org:read project:read
  project:write team:read team:write event:write`.

## Smoke test (per connector)

```bash
kubectl --context=dev port-forward -n mcp-server svc/<name> 3100:3000 &
curl -s -X POST http://localhost:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.1"}}}'
# then tools/list — if tools come back, flip Tested to ✅ in the tracker
```
