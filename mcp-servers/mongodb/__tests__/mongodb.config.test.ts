/**
 * MongoDB MCP Server - Configuration Tests
 *
 * Tests for validating CRD configuration, transport setup, and
 * environment variable mapping for the MongoDB MCP server.
 *
 * Covers:
 * - CRD spec validation
 * - Transport configuration (SSE)
 * - Environment variable mapping
 * - Resource requirements
 * - Secret references
 * - Health check configuration
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loadYaml } from '../../utils/yaml-loader'

// =============================================================================
// Test Data
// =============================================================================

const MCP_SERVER_YAML = join(__dirname, '../mcpserver.yaml')
const EXAMPLE_SECRET_YAML = join(__dirname, '../example.secret.yaml')

// =============================================================================
// Types
// =============================================================================

interface McpServerSpec {
  contextRef: string
  description: string
  image: string
  imagePullPolicy: string
  transport: {
    type: string
    url: string
    port: number
  }
  healthCheck?: {
    port: number
  }
  serverConfig: {
    readOnly: boolean
    loggers: string
    telemetry: string
  }
  envMapping: {
    transport: string
    httpHost: string
    httpPort: string
    healthCheckHost: string
    healthCheckPort: string
    readOnly: string
    loggers: string
    telemetry: string
  }
  envSecret: {
    name: string
    keys: Array<{
      secretKey: string
      envVar: string
    }>
  }
  resources: {
    requests: { memory: string; cpu: string }
    limits: { memory: string; cpu: string }
  }
  auth: {
    type: string
  }
  enabled: boolean
}

interface McpServerCrd {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace: string
  }
  spec: McpServerSpec
}

// =============================================================================
// Fixtures
// =============================================================================

function loadMcpServerCrd(): McpServerCrd {
  const content = readFileSync(MCP_SERVER_YAML, 'utf-8')
  return loadYaml(content) as McpServerCrd
}

function loadExampleSecret(): any {
  const content = readFileSync(EXAMPLE_SECRET_YAML, 'utf-8')
  return loadYaml(content)
}

// =============================================================================
// Test Suite
// =============================================================================

describe('MongoDB MCP Server - CRD Configuration', () => {
  let crd: McpServerCrd

  beforeEach(() => {
    crd = loadMcpServerCrd()
  })

  describe('Metadata', () => {
    it('should have correct API version', () => {
      expect(crd.apiVersion).toBe('clerum.io/v1alpha1')
    })

    it('should be McpServer kind', () => {
      expect(crd.kind).toBe('McpServer')
    })

    it('should have correct server name', () => {
      expect(crd.metadata.name).toBe('mongodb-server')
    })

    it('should be in mcp-server namespace', () => {
      expect(crd.metadata.namespace).toBe('mcp-server')
    })
  })

  describe('Context Reference', () => {
    it('should reference context1', () => {
      expect(crd.spec.contextRef).toBe('context1')
    })
  })

  describe('Description', () => {
    it('should have a description', () => {
      expect(crd.spec.description).toBeDefined()
      expect(crd.spec.description.length).toBeGreaterThan(0)
    })

    it('should mention MongoDB in description', () => {
      expect(crd.spec.description.toLowerCase()).toContain('mongodb')
    })

    it('should describe available capabilities', () => {
      const desc = crd.spec.description.toLowerCase()
      expect(desc).toMatch(/querying|aggregation|schema|indexes|atlas/)
    })
  })

  describe('Image Configuration', () => {
    it('should use official MongoDB image', () => {
      expect(crd.spec.image).toBe('mongodb/mongodb-mcp-server:latest')
    })

    it('should have Never pull policy for local images', () => {
      // Local image build for minikube/E2E — no registry pull needed
      expect(crd.spec.imagePullPolicy).toBe('Never')
    })

    it('should use Docker Hub official image', () => {
      expect(crd.spec.image).toMatch(/^mongodb\//)
    })
  })

  describe('Transport Configuration', () => {
    it('should use streamableHttp transport type', () => {
      expect(crd.spec.transport.type).toBe('streamableHttp')
    })

    it('should have correct service URL', () => {
      expect(crd.spec.transport.url).toBe(
        'http://mongodb-server.mcp-server.svc.cluster.local:3000/mcp'
      )
    })

    it('should use port 3000', () => {
      expect(crd.spec.transport.port).toBe(3000)
    })

    it('should follow K8s service naming convention', () => {
      const url = crd.spec.transport.url
      expect(url).toMatch(/\.svc\.cluster\.local/)
      expect(url).toContain('mongodb-server')
    })
  })

  describe('Health Check Configuration', () => {
    it('should have health check port configured', () => {
      expect(crd.spec.healthCheck).toBeDefined()
      expect(crd.spec.healthCheck?.port).toBe(3001)
    })

    it('should use different port from MCP transport', () => {
      expect(crd.spec.healthCheck?.port).not.toBe(crd.spec.transport.port)
    })

    it('should use port 3001 for health checks', () => {
      expect(crd.spec.healthCheck?.port).toBe(3001)
    })
  })

  describe('Server Configuration', () => {
    it('should have readOnly mode disabled for development', () => {
      // readOnly is false to allow E2E write operations during testing
      expect(crd.spec.serverConfig.readOnly).toBe(false)
    })

    it('should configure stderr logging', () => {
      expect(crd.spec.serverConfig.loggers).toBe('stderr')
    })

    it('should have telemetry disabled', () => {
      expect(crd.spec.serverConfig.telemetry).toBe('disabled')
    })

    it('should have configurable read-only mode', () => {
      // readOnly is configurable — false for dev/E2E, true for production
      expect(typeof crd.spec.serverConfig.readOnly).toBe('boolean')
    })
  })

  describe('Environment Variable Mapping', () => {
    it('should map transport env var', () => {
      expect(crd.spec.envMapping.transport).toBe('MDB_MCP_TRANSPORT')
    })

    it('should map HTTP host env var', () => {
      expect(crd.spec.envMapping.httpHost).toBe('MDB_MCP_HTTP_HOST')
    })

    it('should map HTTP port env var', () => {
      expect(crd.spec.envMapping.httpPort).toBe('MDB_MCP_HTTP_PORT')
    })

    it('should map health check host env var', () => {
      expect(crd.spec.envMapping.healthCheckHost).toBe('MDB_MCP_HEALTH_CHECK_HOST')
    })

    it('should map health check port env var', () => {
      expect(crd.spec.envMapping.healthCheckPort).toBe('MDB_MCP_HEALTH_CHECK_PORT')
    })

    it('should map readOnly env var', () => {
      expect(crd.spec.envMapping.readOnly).toBe('MDB_MCP_READ_ONLY')
    })

    it('should map loggers env var', () => {
      expect(crd.spec.envMapping.loggers).toBe('MDB_MCP_LOGGERS')
    })

    it('should map telemetry env var', () => {
      expect(crd.spec.envMapping.telemetry).toBe('MDB_MCP_TELEMETRY')
    })

    it('should use MDB_MCP_ prefix for all env vars', () => {
      const allKeys = Object.values(crd.spec.envMapping)
      allKeys.forEach(key => {
        expect(key).toMatch(/^MDB_MCP_/)
      })
    })
  })

  describe('Secret Configuration', () => {
    it('should reference mcp-mongodb-credentials secret', () => {
      expect(crd.spec.envSecret.name).toBe('mcp-mongodb-credentials')
    })

    it('should map connection-string to MDB_MCP_CONNECTION_STRING env var', () => {
      const keyMapping = crd.spec.envSecret.keys.find(k => k.secretKey === 'connection-string')
      expect(keyMapping?.envVar).toBe('MDB_MCP_CONNECTION_STRING')
    })

    it('should have exactly one secret key mapping', () => {
      expect(crd.spec.envSecret.keys).toHaveLength(1)
    })

    it('should use correct secret key name', () => {
      expect(crd.spec.envSecret.keys[0].secretKey).toBe('connection-string')
    })
  })

  describe('Resource Requirements', () => {
    it('should have memory request', () => {
      expect(crd.spec.resources.requests.memory).toBeDefined()
      expect(crd.spec.resources.requests.memory).toMatch(/\d+Mi/)
    })

    it('should have CPU request', () => {
      expect(crd.spec.resources.requests.cpu).toBeDefined()
      expect(crd.spec.resources.requests.cpu).toMatch(/\d+m/)
    })

    it('should have memory limit', () => {
      expect(crd.spec.resources.limits.memory).toBeDefined()
      expect(crd.spec.resources.limits.memory).toMatch(/\d+Mi/)
    })

    it('should have CPU limit', () => {
      expect(crd.spec.resources.limits.cpu).toBeDefined()
      expect(crd.spec.resources.limits.cpu).toMatch(/\d+m/)
    })

    it('should have higher limits than requests', () => {
      const reqMem = parseInt(crd.spec.resources.requests.memory)
      const limMem = parseInt(crd.spec.resources.limits.memory)
      expect(limMem).toBeGreaterThan(reqMem)

      const reqCpu = parseInt(crd.spec.resources.requests.cpu)
      const limCpu = parseInt(crd.spec.resources.limits.cpu)
      expect(limCpu).toBeGreaterThan(reqCpu)
    })

    it('should use reasonable resource limits for MCP server', () => {
      expect(parseInt(crd.spec.resources.limits.memory)).toBeLessThanOrEqual(256)
      expect(parseInt(crd.spec.resources.limits.cpu)).toBeLessThanOrEqual(500)
    })
  })

  describe('Authentication', () => {
    it('should use none auth type', () => {
      expect(crd.spec.auth.type).toBe('none')
    })

    it('should rely on connection string for auth', () => {
      // MongoDB authentication is via connection string
      expect(crd.spec.envSecret).toBeDefined()
      expect(crd.spec.envSecret.keys[0].secretKey).toBe('connection-string')
    })
  })

  describe('Server State', () => {
    it('should be enabled by default', () => {
      expect(crd.spec.enabled).toBe(true)
    })
  })
})

describe('MongoDB MCP Server - Example Secret Template', () => {
  let secret: any

  beforeEach(() => {
    secret = loadExampleSecret()
  })

  describe('Secret Metadata', () => {
    it('should have correct secret name', () => {
      expect(secret.metadata.name).toBe('mcp-mongodb-credentials')
    })

    it('should be in mcp-server namespace', () => {
      expect(secret.metadata.namespace).toBe('mcp-server')
    })

    it('should have app label', () => {
      expect(secret.metadata.labels?.app).toBe('mcp-mongodb')
    })

    it('should be Opaque type', () => {
      expect(secret.type).toBe('Opaque')
    })
  })

  describe('Secret Data Structure', () => {
    it('should have connection-string field', () => {
      expect(secret.data).toHaveProperty('connection-string')
    })

    it('should have placeholder for base64 encoded string', () => {
      expect(secret.data['connection-string']).toContain('<BASE64_ENCODED_CONNECTION_STRING>')
    })

    it('should include encoding instructions in comment', () => {
      const content = readFileSync(EXAMPLE_SECRET_YAML, 'utf-8')
      expect(content).toContain('base64')
      expect(content).toContain('echo -n')
      expect(content).toContain('mongodb')
    })

    it('should show mongodb+srv:// example format', () => {
      const content = readFileSync(EXAMPLE_SECRET_YAML, 'utf-8')
      expect(content).toContain('mongodb+srv://')
    })
  })
})

describe('MongoDB MCP Server - Configuration Validation', () => {
  let crd: McpServerCrd

  beforeEach(() => {
    crd = loadMcpServerCrd()
  })

  it('should match Context CRD server reference', () => {
    expect(crd.metadata.name).toBe('mongodb-server')
  })

  it('should be compatible with StreamableHTTP transport', () => {
    expect(['streamableHttp', 'sse', 'stdio']).toContain(crd.spec.transport.type)

    if (crd.spec.transport.type === 'streamableHttp') {
      expect(crd.spec.transport.url).toBeDefined()
      expect(crd.spec.transport.url).toMatch(/^https?:\/\//)
    }
  })

  it('should have separate health check endpoint', () => {
    // MongoDB MCP has separate health check port
    expect(crd.spec.healthCheck).toBeDefined()
    expect(crd.spec.healthCheck?.port).not.toBe(crd.spec.transport.port)
  })

  it('should have readOnly mode configurable via env mapping', () => {
    // readOnly is false for dev/E2E; env mapping allows runtime override
    expect(typeof crd.spec.serverConfig.readOnly).toBe('boolean')
    expect(crd.spec.envMapping.readOnly).toBe('MDB_MCP_READ_ONLY')
  })

  it('should have all required fields for context-mapper reconciliation', () => {
    expect(crd.spec.image).toBeDefined()
    expect(crd.spec.transport).toBeDefined()
    expect(crd.spec.envMapping).toBeDefined()
    expect(crd.spec.envSecret).toBeDefined()
    expect(crd.spec.resources).toBeDefined()
  })

  it('should use MongoDB-specific env var prefix', () => {
    const allValues = Object.values(crd.spec.envMapping)
    allValues.forEach(value => {
      expect(value).toMatch(/^MDB_MCP_/)
    })
  })

  it('should support connection string authentication', () => {
    // MongoDB uses connection string for auth (username/password)
    expect(crd.spec.envSecret.keys[0].secretKey).toBe('connection-string')
    expect(crd.spec.envSecret.keys[0].envVar).toBe('MDB_MCP_CONNECTION_STRING')
  })
})

describe('MongoDB MCP Server - Security Configuration', () => {
  let crd: McpServerCrd

  beforeEach(() => {
    crd = loadMcpServerCrd()
  })

  it('should have readOnly mode mapped for runtime control', () => {
    // readOnly is configurable via MDB_MCP_READ_ONLY env var
    // Default is false for dev/E2E; set to true in production deployments
    expect(crd.spec.envMapping.readOnly).toBe('MDB_MCP_READ_ONLY')
  })

  it('should have telemetry disabled', () => {
    // Reduces attack surface, no data exfiltration via telemetry
    expect(crd.spec.serverConfig.telemetry).toBe('disabled')
  })

  it('should have minimal resource footprint', () => {
    // Limit blast radius if compromised
    expect(parseInt(crd.spec.resources.limits.memory)).toBeLessThanOrEqual(256)
    expect(parseInt(crd.spec.resources.limits.cpu)).toBeLessThanOrEqual(500)
  })

  it('should use connection string for auth (least privilege)', () => {
    // Connection string should have minimal required permissions
    expect(crd.spec.envSecret.keys).toHaveLength(1)
    expect(crd.spec.envSecret.keys[0].secretKey).toBe('connection-string')
  })

  it('should not have additional credentials', () => {
    // Only connection string needed (no separate username/password)
    expect(crd.spec.envSecret.keys).toHaveLength(1)
  })
})

describe('MongoDB vs Airtable - Configuration Comparison', () => {
  let mongoCrd: McpServerCrd
  let airtableCrd: McpServerCrd

  beforeEach(() => {
    mongoCrd = loadMcpServerCrd()

    // Load Airtable CRD for comparison
    const airtablePath = join(__dirname, '../../airtable/mcpserver.yaml')
    const airtableContent = readFileSync(airtablePath, 'utf-8')
    airtableCrd = loadYaml(airtableContent) as McpServerCrd
  })

  it('should use different env var prefixes', () => {
    // MongoDB: MDB_MCP_*
    const mongoEnvVars = Object.values(mongoCrd.spec.envMapping)
    mongoEnvVars.forEach(v => {
      expect(v).toMatch(/^MDB_MCP_/)
    })

    // Airtable: MCP_TRANSPORT, PORT (no prefix for these)
    const airtableTransport = airtableCrd.spec.envMapping.transport
    expect(airtableTransport).not.toMatch(/^MDB_MCP_/)
  })

  it('should have health check (Airtable does not)', () => {
    expect(mongoCrd.spec.healthCheck).toBeDefined()
    // Airtable CRD doesn't have healthCheck field
  })

  it('should have serverConfig (Airtable does not)', () => {
    expect(mongoCrd.spec.serverConfig).toBeDefined()
    expect(mongoCrd.spec.serverConfig).toHaveProperty('readOnly')
    expect(mongoCrd.spec.serverConfig).toHaveProperty('loggers')
    expect(mongoCrd.spec.serverConfig).toHaveProperty('telemetry')
  })

  it('both should use same transport type', () => {
    expect(mongoCrd.spec.transport.type).toBe(airtableCrd.spec.transport.type)
  })

  it('both should have similar resource requirements', () => {
    const mongoMem = parseInt(mongoCrd.spec.resources.limits.memory)
    const airtableMem = parseInt(airtableCrd.spec.resources.limits.memory)

    // Both should be within similar range
    expect(Math.abs(mongoMem - airtableMem)).toBeLessThanOrEqual(128)
  })
})
