# E2E Test Fixtures - Secret Management System

## Overview

This directory contains utilities for managing Kubernetes secrets during E2E testing, resolving the gap where `secret.yaml` files don't exist and manual `.env` configuration is required.

## Components

### 1. Secret Manager (`secret-manager.ts`)

TypeScript utilities for creating, managing, and cleaning up Kubernetes secrets programmatically.

#### Installation

```bash
# From project root
npm install --save-dev @kubernetes/client-node @types/node
```

#### Usage

```typescript
import {
  cleanupAllTestSecrets,
  cleanupMcpTestSecretsAfterEach,
  cleanupTestSecret,
  createAllMcpTestSecrets,
  createMcpTestSecretsBeforeEach,
  createTestSecret,
  verifySecretMounted,
} from './tests/e2e/fixtures/secret-manager'

// Create a single secret
await createTestSecret('mongodb-server', {
  'connection-string': 'mongodb://localhost:27017/test',
})

// Create all MCP server secrets
await createAllMcpTestSecrets()

// Verify secret is mounted in pod
const mountInfo = await verifySecretMounted('mongodb-server-pod', 'mcp-mongodb-credentials')

// Cleanup after tests
await cleanupAllTestSecrets()
```

#### Vitest Integration

```typescript
import { afterEach, beforeEach } from 'vitest'
import {
  cleanupMcpTestSecretsAfterEach,
  createMcpTestSecretsBeforeEach,
} from './tests/e2e/fixtures/secret-manager'

beforeEach(createMcpTestSecretsBeforeEach(['mongodb-server', 'airtable-server']))
afterEach(cleanupMcpTestSecretsAfterEach(['mongodb-server', 'airtable-server']))
```

### 2. Mock Secrets Server (`mock-secrets-server/`)

HTTP server that provides test secrets via REST API, simulating a secrets management service.

#### Installation

```bash
cd tests/e2e/fixtures/mock-secrets-server
npm install
```

#### Starting the Server

```bash
# Start on default port 18090
npm start

# Start on custom port
PORT=19090 npm start

# Development mode with auto-reload
npm run dev
```

#### API Endpoints

| Method | Endpoint                   | Description                   |
| ------ | -------------------------- | ----------------------------- |
| GET    | `/`                        | API documentation             |
| GET    | `/health`                  | Health check                  |
| GET    | `/secrets`                 | List all secrets (metadata)   |
| GET    | `/secrets/:name`           | Get specific secret with data |
| POST   | `/secrets/:name`           | Create new secret             |
| PUT    | `/secrets/:name`           | Update or create secret       |
| DELETE | `/secrets/:name`           | Delete secret                 |
| DELETE | `/secrets`                 | Clear all secrets             |
| GET    | `/mcp/:server/credentials` | Get MCP server credentials    |
| POST   | `/mcp/:server/credentials` | Set MCP server credentials    |

#### Example Usage

```bash
# Get all secrets
curl http://localhost:18090/secrets

# Get MongoDB credentials
curl http://localhost:18090/secrets/mcp-mongodb-credentials

# Get MongoDB credentials via MCP endpoint
curl http://localhost:18090/mcp/mongodb/credentials

# Set custom credentials
curl -X POST http://localhost:18090/mcp/airtable/credentials \
  -H "Content-Type: application/json" \
  -d '{"credentials": {"api-key": "patXXX..."}}'
```

## Default Test Secrets

The mock secrets server is pre-initialized with these test secrets:

| Secret Name                | Namespace    | Keys                                                                 |
| -------------------------- | ------------ | -------------------------------------------------------------------- |
| `mcp-mongodb-credentials`  | `mcp-server` | `connection-string`                                                  |
| `mcp-airtable-credentials` | `mcp-server` | `api-key`                                                            |
| `mcp-host-keys`            | `mcp-host`   | `openai-api-key`, `claude-api-key`, `zai-api-key`, `bailian-api-key` |

> (#273) The legacy `clerum-channel-reader-credentials` fixture is no longer seeded. Per-Host credentials (`channel-reader-<host>-credentials`) are written by control-api's `/admin/channel-secrets` during the test rather than pre-seeded.

## Environment Variables

The mock secrets server respects these environment variables:

| Variable                    | Description               | Default                          |
| --------------------------- | ------------------------- | -------------------------------- |
| `PORT`                      | Server port               | `18090`                          |
| `MONGODB_CONNECTION_STRING` | MongoDB connection string | `mongodb://localhost:27017/test` |
| `AIRTABLE_API_KEY`          | Airtable API key          | `patDummy...`                    |
| `OPENAI_API_KEY`            | OpenAI API key            | `sk-dummy-openai-key`            |
| `CLAUDE_API_KEY`            | Claude API key            | `sk-dummy-claude-key`            |
| `ZAI_API_KEY`               | ZAI API key               | `zai-dummy-key`                  |
| `BAILIAN_API_KEY`           | Bailian API key           | `bailian-dummy-key`              |
| `TELEGRAM_BOT_TOKEN`        | Telegram bot token        | `dummy-telegram-token`           |
| `SLACK_BOT_TOKEN`           | Slack bot token           | `dummy-slack-token`              |
| `EMAIL_USERNAME`            | Email username            | `test@example.com`               |
| `EMAIL_PASSWORD`            | Email password            | `dummy-password`                 |

## Integration with E2E Tests

### Example Test File

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupTestSecret,
  createTestSecret,
  verifySecretMounted,
} from '../fixtures/secret-manager'

describe('MongoDB MCP Server E2E', () => {
  beforeAll(async () => {
    // Create test secret before running tests
    await createTestSecret('mongodb-server', {
      'connection-string':
        process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/test',
    })

    // Deploy McpServer CRD
    await kubectlApply('mcp-servers/mongodb/mcpserver.yaml')
  })

  afterAll(async () => {
    // Cleanup
    await cleanupTestSecret('mcp-mongodb-credentials', 'mcp-server')
    await kubectlDelete('mcp-servers/mongodb/mcpserver.yaml')
  })

  it('should mount secret in pod', async () => {
    const podName = await getPodName('mongodb-server')
    const mountInfo = await verifySecretMounted(podName, 'mcp-mongodb-credentials')

    expect(mountInfo.envVars.length).toBeGreaterThan(0)
  })

  it('should have MCP server ready', async () => {
    const podName = await getPodName('mongodb-server')
    const pod = await getPod(podName)

    expect(pod.status.phase).toBe('Running')
  })
})
```

## Troubleshooting

### "Cannot find module '@kubernetes/client-node'"

```bash
npm install --save-dev @kubernetes/client-node @types/node
```

### "Cannot connect to Kubernetes cluster"

Ensure minikube is running:

```bash
minikube start
kubectl cluster-info
```

### Mock secrets server not responding

```bash
# Check if server is running
curl http://localhost:18090/health

# Restart server
cd tests/e2e/fixtures/mock-secrets-server
npm start
```

## Related Documentation

- `docs/archive/mcp-servers/DIAGNOSTICO-ARQUITECTURA.md` - Architecture diagnosis (archived snapshot)
- `docs/archive/testing/E2E-REAL-SYSTEMS-TESTING.md` - E2E testing guide (historical)
- `scripts/create-k8s-secrets.sh` - Production secrets script
