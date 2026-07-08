# Clerum MCP Servers

MCP (Model Context Protocol) server implementations for the Clerum platform. These servers provide tool capabilities to LLM agents through the MCP protocol.

## Overview

This directory contains MCP server implementations, test suites, and Kubernetes deployment specifications. MCP servers are deployed as Kubernetes resources managed by the Context Mapper operator.

## Available Servers

| Server | Description | Transport | Port |
|--------|-------------|-----------|------|
| **Airtable** | Airtable API integration for bases, tables, and records | StreamableHTTP | 3000 |
| **MongoDB** | MongoDB integration for querying, aggregation, and schema inspection | StreamableHTTP | 3000 |

## Project Structure

```
mcp-servers/
├── airtable/                    # Airtable MCP server
│   ├── mcpserver.yaml          # CRD specification
│   ├── example.secret.yaml     # Secret template
│   └── __tests__/              # Test suite
│       ├── airtable.config.test.ts
│       ├── airtable.api.test.ts
│       ├── airtable.mcp.test.ts
│       └── airtable.k8s.test.ts
├── mongodb/                     # MongoDB MCP server
│   ├── mcpserver.yaml          # CRD specification
│   ├── example.secret.yaml     # Secret template
│   └── __tests__/              # Test suite
│       ├── mongodb.config.test.ts
│       ├── mongodb.connection.test.ts
│       ├── mongodb.mcp.test.ts
│       └── mongodb.statefulset.test.ts
├── utils/                       # Shared utilities
│   └── yaml-loader.ts          # YAML parser for tests
├── vitest.config.ts            # Test configuration
├── package.json                # Dependencies and scripts
└── README.md                   # This file
```

## Quick Start

### Prerequisites

- Node.js 20.x or higher
- Kubernetes cluster (for deployment)
- kubectl configured

### Testing

See the [Testing](#testing) section below for the full test suite guide. Quick start:

```bash
npm install
npm test
```

### Deployment

Deploy MCP servers to Kubernetes:

```bash
# Apply CRD specifications
kubectl apply -f airtable/mcpserver.yaml
kubectl apply -f mongodb/mcpserver.yaml

# Create secrets (use example.secret.yaml as templates)
kubectl apply -f airtable/secret.yaml
kubectl apply -f mongodb/secret.yaml
```

## Configuration

### MCP Server CRD

Each server is defined by a `McpServer` CRD:

```yaml
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: airtable-server
  namespace: mcp-server
spec:
  contextRef: context1
  description: "Airtable MCP server for data operations"
  image: your-registry.example.com/evenfire/airtable-mcp-server:latest
  imagePullPolicy: Always
  transport:
    type: streamableHttp
    url: http://airtable-server.mcp-server.svc.cluster.local:3000/mcp
    port: 3000
  envMapping:
    transport: MCP_TRANSPORT
    httpPort: PORT
  envSecret:
    name: mcp-airtable-credentials
    keys:
      - secretKey: api-key
        envVar: AIRTABLE_API_KEY
  resources:
    requests:
      memory: "128Mi"
      cpu: "100m"
    limits:
      memory: "256Mi"
      cpu: "500m"
  auth:
    type: none
  enabled: true
```

### Secrets

API keys and connection strings are stored as Kubernetes secrets:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-airtable-credentials
  namespace: mcp-server
type: Opaque
data:
  # Base64 encoded values
  api-key: <BASE64_ENCODED_API_KEY>
```

Encode secrets:

```bash
echo -n "your-api-key" | base64
```

## MCP Tools

### Airtable Server

- `airtable_list_bases` - List accessible Airtable bases
- `airtable_list_tables` - List tables in a base
- `airtable_list_records` - List records in a table
- `airtable_get_record` - Get a single record
- `airtable_create_record` - Create a new record
- `airtable_update_record` - Update an existing record
- `airtable_delete_record` - Delete a record

### MongoDB Server

- `mongodb_find` - Query documents
- `mongodb_aggregate` - Aggregation pipeline
- `mongodb_count_documents` - Count matching documents
- `mongodb_distinct` - Get distinct values
- `mongodb_list_collections` - List collections

## Transport Protocol

All servers use **StreamableHTTP** transport:

- **Protocol**: HTTP/1.1
- **Path**: `/mcp`
- **Methods**: POST for MCP operations
- **Content-Type**: `application/json`

### MCP Endpoints

- **tools/list** - List available tools
- **tools/call** - Execute a tool

## Resource Requirements

| Server | Memory Request | Memory Limit | CPU Request | CPU Limit |
|--------|----------------|--------------|-------------|-----------|
| Airtable | 128Mi | 256Mi | 100m | 500m |
| MongoDB | 128Mi | 256Mi | 100m | 500m |

## Architecture

MCP servers are deployed as Kubernetes Deployments (or StatefulSets for stateful services like MongoDB) by the Context Mapper operator. The operator:

1. Watches `McpServer` CRDs
2. Creates Deployments/Services
3. Generates NetworkPolicies for access control
4. Manages secret references

## Development

### Adding a New MCP Server

1. Create server directory: `your-server/`
2. Create CRD specification: `your-server/mcpserver.yaml`
3. Create secret template: `your-server/example.secret.yaml`
4. Create test suite: `your-server/__tests__/*.test.ts`
5. Add test script to `package.json`

### Test Structure

Follow the established test pattern:
- `*.config.test.ts` - CRD configuration validation
- `*.api.test.ts` - API interaction mocks
- `*.mcp.test.ts` - MCP protocol operations
- `*.k8s.test.ts` - Kubernetes resource generation

## Security

- Secrets are never stored in CRDs
- NetworkPolicies enforce deny-by-default
- Resource limits prevent resource exhaustion
- Read-only mode enforced where applicable (e.g., MongoDB)

## Monitoring

Each server exposes a health check endpoint:

```
http://server-name.mcp-server.svc.cluster.local:3001/health
```

## Troubleshooting

### Server Not Starting

Check pod logs:

```bash
kubectl logs -n mcp-server -l app=airtable-server
```

### Connection Failures

Verify:
1. Secret exists and has correct keys
2. Service is reachable: `kubectl get svc -n mcp-server`
3. NetworkPolicies allow traffic

### Test Failures

See the [Testing — Troubleshooting](#troubleshooting-1) section below.

## Testing

Complete guide for testing the MCP servers (Airtable, MongoDB) in the Clerum project. The test suite validates CRD configuration, Kubernetes resource generation, MCP protocol operations, and API interactions. Tests are organized by server type and cover both unit and integration scenarios.

### Test Statistics

| Metric | Value |
|--------|-------|
| **Total Test Cases** | 343 unit tests |
| **Test Framework** | Vitest 4.0.18 |
| **Test Environment** | Node.js |
| **Coverage** | Configuration, API, MCP, K8s resources |

### Test Files by Server

**Airtable**
- `airtable.config.test.ts` — CRD and configuration validation
- `airtable.api.test.ts` — Airtable API mocking and interactions
- `airtable.mcp.test.ts` — MCP protocol operations
- `airtable.k8s.test.ts` — Kubernetes resource generation

**MongoDB**
- `mongodb.config.test.ts` — CRD and configuration validation
- `mongodb.connection.test.ts` — MongoDB connection handling
- `mongodb.mcp.test.ts` — MCP protocol operations
- `mongodb.statefulset.test.ts` — StatefulSet resource generation

### Prerequisites

- **Node.js**: Version 20.x or higher (tests use `@types/node@^20.10.0`)
- **npm**: For dependency management
- **TypeScript**: Version 5.3.0 or higher

```bash
cd mcp-servers
npm install
```

### Running Tests

```bash
cd mcp-servers

# All tests
npm test

# Per-server
npm run test:airtable
npm run test:mongodb

# Watch mode (development)
npm run test:watch

# Single file
npx vitest run airtable/__tests__/airtable.config.test.ts

# With coverage (reports under coverage/)
npx vitest run --coverage
```

### Test Categories

Tests are organized into four categories. A given server may have several or all of these files depending on what it exercises.

#### 1. Configuration Tests (`*.config.test.ts`)

Validate CRD specifications, environment variable mappings, resource requirements, and secret configurations.

**What they test:**
- CRD metadata (API version, kind, names)
- Context references
- Transport configuration (StreamableHTTP)
- Environment variable mappings
- Secret references and key mappings
- Resource requirements (CPU, memory)
- Authentication configuration

```typescript
expect(crd.apiVersion).toBe('clerum.io/v1alpha1');
expect(crd.kind).toBe('McpServer');
expect(crd.spec.transport.type).toBe('streamableHttp');
```

#### 2. API Tests (`*.api.test.ts`)

Test external API interactions using mocks. Validate API client behavior, error handling, and rate limiting.

**What they test:**
- API mock setup
- Response parsing
- Error handling (rate limits, auth failures)
- Data transformation
- Retry logic

**Key fixtures:**
- `MockAirtableClient` — Simulates Airtable API
- `MockMongoClient` — Simulates MongoDB connections

#### 3. MCP Protocol Tests (`*.mcp.test.ts`)

Validate MCP protocol operations including `tools/list`, `tools/call`, and session management.

**What they test:**
- MCP `tools/list` endpoint
- Tool parameter validation
- Tool execution (`tools/call`)
- Response formatting
- Error responses

**Example MCP tools validated:**
- `airtable_list_bases`, `airtable_list_tables`, `airtable_list_records`
- `mongodb_find`, `mongodb_aggregate`, `mongodb_count_documents`

#### 4. Kubernetes Tests (`*.k8s.test.ts`, `*.statefulset.test.ts`)

Validate Kubernetes resource generation (Deployments, Services, StatefulSets).

**What they test:**
- Deployment resource generation
- Service resource generation
- StatefulSet generation (MongoDB)
- Container configuration
- Volume mounts and claims
- Resource limits and requests

### Test Utilities

#### YAML Loader (`utils/yaml-loader.ts`)

Simple YAML parser for loading test fixtures from CRD files.

```typescript
import { loadYaml } from '../../utils/yaml-loader';

const crd = loadYaml(yamlContent);
expect(crd.kind).toBe('McpServer');
```

#### Mock Clients

Test files include mock implementations for:
- `MockAirtableClient` — Airtable API mock
- `MockMongoClient` — MongoDB connection mock
- `MockAirtableMcpServer` — MCP server mock

### Test Fixtures

Test fixtures are located alongside test files:
- `mcpserver.yaml` — CRD specification
- `example.secret.yaml` — Secret template

### Vitest Configuration (`vitest.config.ts`)

```typescript
{
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html']
    }
  }
}
```

### Writing New Tests

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { loadYaml } from '../../utils/yaml-loader';

describe('Feature Name', () => {
  let fixture: any;

  beforeEach(() => {
    fixture = loadFixture();
  });

  it('should validate behavior', () => {
    expect(fixture.property).toBe('expected');
  });
});
```

**Best practices:**

1. Use descriptive test names that explain what is being tested
2. Group related tests using `describe` blocks
3. Use `beforeEach` for fixture setup
4. Mock external dependencies (API calls, K8s API)
5. Test error cases as well as success paths
6. Keep tests focused — one assertion per test is ideal

### Troubleshooting

**Tests fail to load** — Ensure test files are in `__tests__` directories and end with `.test.ts`.

**Import errors** — Run `npm install` to ensure dependencies are installed.

**YAML parsing issues** — Validate YAML syntax and ensure the `yaml-loader` utility can handle the structure.

**Timeout errors** — Increase timeout in vitest config if needed:

```typescript
export default defineConfig({
  test: {
    testTimeout: 10000, // 10 seconds
    hookTimeout: 10000
  }
});
```

### CI/CD Integration

Tests run automatically in CI pipelines:

```bash
npm run lint      # Lint TypeScript code
npm run typecheck # Type checking
npm test          # Run all tests
```

### Test Maintenance

#### Adding Tests for a New MCP Server

1. Create `__tests__` directory: `mcp-servers/your-server/__tests__/`
2. Create test files following the pattern:
   - `your-server.config.test.ts`
   - `your-server.api.test.ts` (if applicable)
   - `your-server.mcp.test.ts`
   - `your-server.k8s.test.ts` (or `.statefulset.test.ts`)
3. Add npm script: `"test:your-server": "vitest run your-server/__tests__"`

#### Updating Tests After CRD Changes

When CRD specifications change, update corresponding `*.config.test.ts` files to validate new fields and structure.

## Documentation

- [Architecture](../docs/architecture/overview.md) — System architecture
- [CRD Specifications](../charts/clerum-crds/crds/) — CRD definitions

## License

Part of the Clerum project.
