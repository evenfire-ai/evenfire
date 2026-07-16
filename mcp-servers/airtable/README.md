# Airtable MCP Server

MCP server that exposes Airtable operations as tools for LLM agents. Uses StreamableHTTP transport on port 3000.

Source: [domdomegg/airtable-mcp-server](https://github.com/domdomegg/airtable-mcp-server) (cloned at build time).

## Available MCP Tools

| Tool                     | Description                                   |
| ------------------------ | --------------------------------------------- |
| `airtable_list_bases`    | List all accessible Airtable bases            |
| `airtable_list_tables`   | List tables in a base                         |
| `airtable_list_records`  | List records in a table (with optional limit) |
| `airtable_get_record`    | Get a single record by ID                     |
| `airtable_create_record` | Create a new record                           |
| `airtable_update_record` | Update an existing record                     |
| `airtable_delete_record` | Delete a record                               |
| `airtable_query_records` | Query records with filterByFormula            |

## Environment Variables

| Variable                   | Source                                | Description                                                       |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `AIRTABLE_API_KEY`         | K8s Secret `mcp-airtable-credentials` | Airtable personal access token                                    |
| `MCP_TRANSPORT`            | Set by envMapping                     | Transport type (`streamableHttp`)                                 |
| `PORT`                     | Set by envMapping                     | HTTP listen port (`3000`)                                         |
| `AIRTABLE_MCP_LOG_TRAFFIC` | `spec.env` in `mcpserver.yaml`        | Enables inbound HTTP + outbound Airtable fetch logging in the pod |

## Docker Build

```bash
docker build -t airtable-mcp-server:latest .
```

The Dockerfile clones the upstream repo, builds it, and runs as a non-root `mcp` user.

## Kubernetes Deployment

Deployed via the `McpServer` CRD. The Context Mapper operator watches the CRD and creates the Deployment and Service automatically.

```bash
# 1. Create the secret (copy example.secret.yaml and fill in your API key)
kubectl apply -f secret.yaml

# 2. Apply the McpServer CRD instance
kubectl apply -f mcpserver.yaml
```

See `mcpserver.yaml` for the full CRD spec. Key fields:

- **Image**: `us-central1-docker.pkg.dev/your-gcp-project/clerum/airtable-mcp-server:latest`
- **Namespace**: `mcp-server`
- **Transport**: StreamableHTTP at `http://airtable-server.mcp-server.svc.cluster.local:3000/mcp`
- **EgressBindings**: `api.airtable.com:443/TCP` so HCC can generate the required outbound NetworkPolicy
- **Resources**: 128Mi/100m request, 256Mi/500m limit

Preferred network model: declare `spec.egressBindings` on the `McpServer` and let HCC generate the L3-egress NetworkPolicy. The local [`networkpolicy.yaml`](./networkpolicy.yaml) remains as a manual fallback template for non-HCC flows; render it through `deploy/scripts/render-public-egress-exceptions.rb` before applying so it receives the canonical public-egress CIDR exclusions.

When `AIRTABLE_MCP_LOG_TRAFFIC=true`, the image boots through a small local runtime shim that logs:

- inbound HTTP requests handled by the pod
- outbound `fetch()` calls to `api.airtable.com`
- status/error timing without printing the Airtable token

## Testing

Tests live in `mcp-servers/airtable/__tests__/` and run from the parent `mcp-servers/` directory:

```bash
cd mcp-servers
npm install
npm run test:airtable
```

Test suites (4 files):

- `airtable.config.test.ts` -- CRD spec validation, secret references, transport config
- `airtable.api.test.ts` -- Mock Airtable client, CRUD operations, rate limiting
- `airtable.mcp.test.ts` -- MCP protocol operations (tools/list, tools/call)
- `airtable.k8s.test.ts` -- Expected Deployment/Service generation, resource mapping

All tests use mock clients and do not require Airtable credentials or a running cluster.
