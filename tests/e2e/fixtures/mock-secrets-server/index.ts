/**
 * Mock Secrets Server
 *
 * HTTP server that provides test secrets for E2E testing.
 * This simulates a secrets management service without requiring
 * real credentials or external services.
 *
 * Usage:
 * ```bash
 * npm start              # Start server on port 18090
 * PORT=19090 npm start   # Start on custom port
 * ```
 *
 * Endpoints:
 * - GET /secrets - List all available secrets
 * - GET /secrets/{name} - Get a specific secret
 * - POST /secrets/{name} - Create/update a secret
 * - DELETE /secrets/{name} - Delete a secret
 * - GET /health - Health check
 */
import express, { Request, Response } from 'express'
import cors from 'cors'

// =============================================================================
// Configuration
// =============================================================================

const PORT = process.env.PORT || '18090'
const BASE_URL = `http://localhost:${PORT}`

// =============================================================================
// Types
// =============================================================================

interface SecretData {
  [key: string]: string
}

interface Secret {
  name: string
  namespace: string
  data: SecretData
  createdAt: Date
  labels?: Record<string, string>
}

// =============================================================================
// In-Memory Secret Store
// =============================================================================

const secretsStore: Map<string, Secret> = new Map()

// Initialize with default test secrets
function initializeDefaultSecrets() {
  // MongoDB test secret
  secretsStore.set('mcp-mongodb-credentials', {
    name: 'mcp-mongodb-credentials',
    namespace: 'mcp-server',
    createdAt: new Date(),
    labels: {
      app: 'mcp-mongodb',
      'clerum.io/test': 'true',
    },
    data: {
      'connection-string':
        process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/test',
    },
  })

  // Airtable test secret
  secretsStore.set('mcp-airtable-credentials', {
    name: 'mcp-airtable-credentials',
    namespace: 'mcp-server',
    createdAt: new Date(),
    labels: {
      app: 'mcp-airtable',
      'clerum.io/test': 'true',
    },
    data: {
      'api-key':
        process.env.AIRTABLE_API_KEY ||
        'patDummyDummyDummyDummyDummyDummyDummyDummyDummyDummyDummy',
    },
  })

  // LLM provider keys (for mcp-host tests)
  secretsStore.set('mcp-host-keys', {
    name: 'mcp-host-keys',
    namespace: 'mcp-host',
    createdAt: new Date(),
    labels: {
      'clerum.io/test': 'true',
    },
    data: {
      'openai-api-key': process.env.OPENAI_API_KEY || 'sk-dummy-openai-key',
      'claude-api-key': process.env.CLAUDE_API_KEY || 'sk-dummy-claude-key',
      'zai-api-key': process.env.ZAI_API_KEY || 'zai-dummy-key',
      'bailian-api-key': process.env.BAILIAN_API_KEY || 'bailian-dummy-key',
    },
  })

  // (#273) The legacy `clerum-channel-reader-credentials` fixture used to
  // be seeded here for the static channel-reader Deployment. With the
  // static retired, channel credentials are per-Host
  // (`channel-reader-<host>-credentials`) and are written by control-api's
  // `/admin/channel-secrets` endpoint during the test, not pre-seeded.

  console.log(`[MockSecrets] Initialized with ${secretsStore.size} default secrets`)
}

// =============================================================================
// Express App Setup
// =============================================================================

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Request logging middleware
app.use((req: Request, res: Response, next) => {
  console.log(`[MockSecrets] ${req.method} ${req.path}`)
  next()
})

// =============================================================================
// Health Check
// =============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'mock-secrets-server',
    timestamp: new Date().toISOString(),
    secrets: secretsStore.size,
  })
})

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Mock Secrets Server for Clerum E2E Testing',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      listSecrets: 'GET /secrets',
      getSecret: 'GET /secrets/:name',
      createSecret: 'POST /secrets/:name',
      updateSecret: 'PUT /secrets/:name',
      deleteSecret: 'DELETE /secrets/:name',
    },
    baseUrl: BASE_URL,
  })
})

// =============================================================================
// Secret Endpoints
// =============================================================================

/**
 * GET /secrets
 * Lists all available secrets (metadata only, no data values)
 */
app.get('/secrets', (_req: Request, res: Response) => {
  const secrets = Array.from(secretsStore.values()).map(secret => ({
    name: secret.name,
    namespace: secret.namespace,
    keys: Object.keys(secret.data),
    labels: secret.labels,
    createdAt: secret.createdAt,
  }))

  res.json({
    secrets,
    count: secrets.length,
  })
})

/**
 * GET /secrets/:name
 * Gets a specific secret with its data values
 */
app.get('/secrets/:name', (req: Request, res: Response) => {
  const { name } = req.params
  const secret = secretsStore.get(name)

  if (!secret) {
    res.status(404).json({
      error: 'SecretNotFound',
      message: `Secret '${name}' not found`,
    })
    return
  }

  res.json({
    name: secret.name,
    namespace: secret.namespace,
    data: secret.data,
    labels: secret.labels,
    createdAt: secret.createdAt,
  })
})

/**
 * POST /secrets/:name
 * Creates a new secret
 */
app.post('/secrets/:name', (req: Request, res: Response) => {
  const { name } = req.params
  const { namespace = 'default', data, labels } = req.body

  if (!data || typeof data !== 'object') {
    res.status(400).json({
      error: 'InvalidData',
      message: 'Request body must contain a "data" object',
    })
    return
  }

  if (secretsStore.has(name)) {
    res.status(409).json({
      error: 'SecretAlreadyExists',
      message: `Secret '${name}' already exists. Use PUT to update.`,
    })
    return
  }

  const secret: Secret = {
    name,
    namespace,
    data,
    labels,
    createdAt: new Date(),
  }

  secretsStore.set(name, secret)

  console.log(`[MockSecrets] Created secret: ${name} in namespace ${namespace}`)

  res.status(201).json({
    name: secret.name,
    namespace: secret.namespace,
    keys: Object.keys(secret.data),
    labels: secret.labels,
    createdAt: secret.createdAt,
  })
})

/**
 * PUT /secrets/:name
 * Updates an existing secret or creates if it doesn't exist
 */
app.put('/secrets/:name', (req: Request, res: Response) => {
  const { name } = req.params
  const { namespace = 'default', data, labels } = req.body

  if (!data || typeof data !== 'object') {
    res.status(400).json({
      error: 'InvalidData',
      message: 'Request body must contain a "data" object',
    })
    return
  }

  const existing = secretsStore.get(name)

  const secret: Secret = {
    name,
    namespace,
    data: { ...existing?.data, ...data },
    labels: { ...existing?.labels, ...labels },
    createdAt: existing?.createdAt || new Date(),
  }

  secretsStore.set(name, secret)

  console.log(`[MockSecrets] ${existing ? 'Updated' : 'Created'} secret: ${name}`)

  res.json({
    name: secret.name,
    namespace: secret.namespace,
    keys: Object.keys(secret.data),
    labels: secret.labels,
    createdAt: secret.createdAt,
    updatedAt: new Date(),
  })
})

/**
 * DELETE /secrets/:name
 * Deletes a secret
 */
app.delete('/secrets/:name', (req: Request, res: Response) => {
  const { name } = req.params
  const deleted = secretsStore.delete(name)

  if (!deleted) {
    res.status(404).json({
      error: 'SecretNotFound',
      message: `Secret '${name}' not found`,
    })
    return
  }

  console.log(`[MockSecrets] Deleted secret: ${name}`)

  res.json({
    name,
    deleted: true,
  })
})

/**
 * DELETE /secrets
 * Clears all secrets (for test cleanup)
 */
app.delete('/secrets', (_req: Request, res: Response) => {
  const count = secretsStore.size
  secretsStore.clear()

  console.log(`[MockSecrets] Cleared all ${count} secrets`)

  // Re-initialize defaults
  initializeDefaultSecrets()

  res.json({
    deleted: count,
    message: `Cleared ${count} secrets and re-initialized defaults`,
  })
})

// =============================================================================
// MCP Server Specific Endpoints
// =============================================================================

/**
 * GET /mcp/:server/credentials
 * Gets credentials for a specific MCP server
 */
app.get('/mcp/:server/credentials', (req: Request, res: Response) => {
  const { server } = req.params

  // Map server name to secret name
  const secretMap: Record<string, string> = {
    mongodb: 'mcp-mongodb-credentials',
    airtable: 'mcp-airtable-credentials',
    'mongodb-server': 'mcp-mongodb-credentials',
    'airtable-server': 'mcp-airtable-credentials',
  }

  const secretName = secretMap[server] || `mcp-${server}-credentials`
  const secret = secretsStore.get(secretName)

  if (!secret) {
    res.status(404).json({
      error: 'McpServerCredentialsNotFound',
      message: `No credentials found for MCP server '${server}'`,
    })
    return
  }

  res.json({
    server,
    credentials: secret.data,
  })
})

/**
 * POST /mcp/:server/credentials
 * Sets credentials for a specific MCP server
 */
app.post('/mcp/:server/credentials', (req: Request, res: Response) => {
  const { server } = req.params
  const { credentials } = req.body

  if (!credentials || typeof credentials !== 'object') {
    res.status(400).json({
      error: 'InvalidCredentials',
      message: 'Request body must contain a "credentials" object',
    })
    return
  }

  const secretName = `mcp-${server}-credentials`
  const existing = secretsStore.get(secretName)

  const secret: Secret = {
    name: secretName,
    namespace: 'mcp-server',
    data: { ...existing?.data, ...credentials },
    labels: {
      app: `mcp-${server}`,
      'clerum.io/test': 'true',
    },
    createdAt: existing?.createdAt || new Date(),
  }

  secretsStore.set(secretName, secret)

  console.log(`[MockSecrets] Set credentials for MCP server: ${server}`)

  res.status(201).json({
    server,
    secretName,
    keys: Object.keys(secret.data),
  })
})

// =============================================================================
// Server Startup
// =============================================================================

initializeDefaultSecrets()

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Mock Secrets Server for Clerum E2E Testing        ║
╠══════════════════════════════════════════════════════════════╣
║  Base URL:     ${BASE_URL.padEnd(50)}║
║  Health Check: ${`${BASE_URL}/health`.padEnd(50)}║
║  API Docs:     ${`${BASE_URL}/`.padEnd(50)}║
╠══════════════════════════════════════════════════════════════╣
║  Available Secrets:                                           ║
${Array.from(secretsStore.keys())
  .map(s => `║    - ${s.padEnd(52)}║`)
  .join('')}
╚══════════════════════════════════════════════════════════════╝
  `)
})

// =============================================================================
// Graceful Shutdown
// =============================================================================

process.on('SIGTERM', () => {
  console.log('[MockSecrets] SIGTERM received, shutting down gracefully...')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[MockSecrets] SIGINT received, shutting down gracefully...')
  process.exit(0)
})
