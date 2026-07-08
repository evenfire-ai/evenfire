# MongoDB MCP Server

MCP server that exposes MongoDB operations as tools for LLM agents. Uses the official `mongodb/mongodb-mcp-server` image with StreamableHTTP transport on port 3000 and a separate health-check endpoint on port 3001.

## Available MCP Tools

| Tool                       | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `mongodb_find`             | Query documents with filter, projection, sort, limit |
| `mongodb_aggregate`        | Execute aggregation pipelines                        |
| `mongodb_count`            | Count documents (with optional filter)               |
| `mongodb_distinct`         | Get distinct values for a field                      |
| `mongodb_insert_one`       | Insert a single document                             |
| `mongodb_update_one`       | Update a single document                             |
| `mongodb_delete_one`       | Delete a single document                             |
| `mongodb_list_collections` | List collections in a database                       |
| `mongodb_list_databases`   | List all databases on the server                     |

Write operations (`insert_one`, `update_one`, `delete_one`) are blocked when read-only mode is enabled.

## Environment Variables

| Variable                    | Source                               | Description                             |
| --------------------------- | ------------------------------------ | --------------------------------------- |
| `MDB_MCP_CONNECTION_STRING` | K8s Secret `mcp-mongodb-credentials` | MongoDB connection URI                  |
| `MDB_MCP_TRANSPORT`         | Set by envMapping                    | Transport type (`streamableHttp`)       |
| `MDB_MCP_HTTP_HOST`         | Set by envMapping                    | HTTP bind host                          |
| `MDB_MCP_HTTP_PORT`         | Set by envMapping                    | HTTP listen port (`3000`)               |
| `MDB_MCP_HEALTH_CHECK_HOST` | Set by envMapping                    | Health-check bind host                  |
| `MDB_MCP_HEALTH_CHECK_PORT` | Set by envMapping                    | Health-check port (`3001`)              |
| `MDB_MCP_READ_ONLY`         | Set by serverConfig                  | Block write operations (`true`/`false`) |
| `MDB_MCP_LOGGERS`           | Set by serverConfig                  | Log destination (`stderr`)              |
| `MDB_MCP_TELEMETRY`         | Set by serverConfig                  | Telemetry toggle (`disabled`)           |

## Docker Image

This server uses the official Docker Hub image `mongodb/mongodb-mcp-server:latest` -- there is no local Dockerfile. The CRD sets `imagePullPolicy: Never` for local/minikube use; change to `Always` for registry-based deployments.

## Kubernetes Deployment

Deployed via the `McpServer` CRD. The Context Mapper operator creates the Deployment and Service.

```bash
# 1. Create the secret (copy example.secret.yaml and fill in your connection string)
kubectl apply -f secret.yaml

# 2. Apply the McpServer CRD instance
kubectl apply -f mcpserver.yaml
```

See `mcpserver.yaml` for the full CRD spec. Key fields:

- **Image**: `mongodb/mongodb-mcp-server:latest`
- **Namespace**: `mcp-server`
- **Transport**: StreamableHTTP at `http://mongodb-server.mcp-server.svc.cluster.local:3000/mcp`
- **Health check**: port 3001
- **Resources**: 128Mi/100m request, 256Mi/500m limit

### NetworkPolicies (3 files)

- `networkpolicy.yaml` -- DNS + outbound HTTPS/27017 for Atlas and external MongoDB; render it through `deploy/scripts/render-public-egress-exceptions.rb` before applying so it receives the canonical public-egress CIDR exclusions
- `networkpolicy-egress-mongodb.yaml` -- Egress from MCP server to MongoDB pod in `sandbox-recipes` namespace (port 27017)
- `networkpolicy-ingress-mongodb-db.yaml` -- Ingress on the MongoDB database pod allowing traffic from this MCP server

## Testing

Tests live in `mcp-servers/mongodb/__tests__/` and run from the parent `mcp-servers/` directory:

```bash
cd mcp-servers
npm install
npm run test:mongodb
```

Test suites (4 files):

- `mongodb.config.test.ts` -- CRD spec validation, env mapping, secret references, health check
- `mongodb.connection.test.ts` -- Mock MongoDB client, query operators, aggregation, write ops
- `mongodb.mcp.test.ts` -- MCP protocol operations, read-only mode enforcement
- `mongodb.statefulset.test.ts` -- Expected StatefulSet/headless Service generation, PVC config

All tests use mock clients and do not require a MongoDB instance or running cluster.
