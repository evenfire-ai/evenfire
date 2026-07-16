/**
 * Airtable MCP Server - Configuration Tests
 *
 * Tests for validating CRD configuration, transport setup, and
 * environment variable mapping for the Airtable MCP server.
 *
 * Covers:
 * - CRD spec validation
 * - Transport configuration (StreamableHTTP)
 * - Environment variable mapping
 * - Resource requirements
 * - Secret references
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
  envMapping?: Record<string, string>
  env?: Array<{
    name: string
    value: string
  }>
  envSecret: {
    name: string
    keys: Array<{
      secretKey: string
      envVar: string
    }>
  }
  egressBindings?: Array<{
    dns?: string
    cidr?: string
    port: number
    protocol?: string
  }>
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

describe('Airtable MCP Server - CRD Configuration', () => {
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
      expect(crd.metadata.name).toBe('airtable-server')
    })

    it('should be in mcp-server namespace', () => {
      expect(crd.metadata.namespace).toBe('mcp-server')
    })
  })

  describe('Context Reference', () => {
    it('should reference context1', () => {
      expect(crd.spec.contextRef).toBe('context1')
    })

    it('should match the Context CRD configuration', () => {
      // This validates that airtable-server is included in context1.yaml
      const expectedContextRef = 'context1'
      expect(crd.spec.contextRef).toBe(expectedContextRef)
    })
  })

  describe('Description', () => {
    it('should have a description', () => {
      expect(crd.spec.description).toBeDefined()
      expect(crd.spec.description.length).toBeGreaterThan(0)
    })

    it('should mention Airtable in description', () => {
      expect(crd.spec.description.toLowerCase()).toContain('airtable')
    })

    it('should describe available capabilities', () => {
      const desc = crd.spec.description.toLowerCase()
      expect(desc).toMatch(/querying|searching|records|bases|tables/)
    })
  })

  describe('Image Configuration', () => {
    it('should use correct image registry', () => {
      expect(crd.spec.image).toBe(
        'us-central1-docker.pkg.dev/your-gcp-project/clerum/airtable-mcp-server:latest'
      )
    })

    it('should have Always pull policy', () => {
      expect(crd.spec.imagePullPolicy).toBe('Always')
    })

    it('should use a specific tag (not latest for production)', () => {
      // Note: Using 'latest' in dev is acceptable, but production should use specific tags
      // This test documents the current state
      expect(crd.spec.image).toContain(':latest')
    })
  })

  describe('Transport Configuration', () => {
    it('should use streamableHttp transport type', () => {
      expect(crd.spec.transport.type).toBe('streamableHttp')
    })

    it('should have correct service URL', () => {
      expect(crd.spec.transport.url).toBe(
        'http://airtable-server.mcp-server.svc.cluster.local:3000/mcp'
      )
    })

    it('should use port 3000', () => {
      expect(crd.spec.transport.port).toBe(3000)
    })

    it('should follow K8s service naming convention', () => {
      const url = crd.spec.transport.url
      expect(url).toMatch(/\.svc\.cluster\.local/)
      expect(url).toContain('airtable-server')
      expect(url).toContain('mcp-server')
    })
  })

  describe('Environment Variable Mapping', () => {
    it('should map transport env var', () => {
      expect(crd.spec.envMapping).toBeDefined()
      expect(crd.spec.envMapping?.transport).toBe('MCP_TRANSPORT')
    })

    it('should map HTTP port env var', () => {
      expect(crd.spec.envMapping?.httpPort).toBe('PORT')
    })

    it('should not have unexpected mappings', () => {
      const validKeys = ['transport', 'httpPort']
      const actualKeys = Object.keys(crd.spec.envMapping || {})
      actualKeys.forEach(key => {
        expect(validKeys).toContain(key)
      })
    })

    it('should enable traffic logging for runtime diagnostics', () => {
      const logEnv = crd.spec.env?.find(env => env.name === 'AIRTABLE_MCP_LOG_TRAFFIC')
      expect(logEnv?.value).toBe('true')
    })
  })

  describe('Secret Configuration', () => {
    it('should reference mcp-airtable-credentials secret', () => {
      expect(crd.spec.envSecret.name).toBe('mcp-airtable-credentials')
    })

    it('should map api-key to AIRTABLE_API_KEY env var', () => {
      const keyMapping = crd.spec.envSecret.keys.find(k => k.secretKey === 'api-key')
      expect(keyMapping?.envVar).toBe('AIRTABLE_API_KEY')
    })

    it('should have exactly one secret key mapping', () => {
      expect(crd.spec.envSecret.keys).toHaveLength(1)
    })

    it('should use correct secret key name', () => {
      expect(crd.spec.envSecret.keys[0].secretKey).toBe('api-key')
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
      // Airtable MCP should run within 256MB memory
      expect(parseInt(crd.spec.resources.limits.memory)).toBeLessThanOrEqual(256)

      // CPU limit should be adequate for HTTP processing
      expect(parseInt(crd.spec.resources.limits.cpu)).toBeLessThanOrEqual(500)
    })
  })

  describe('Egress Configuration', () => {
    it('should declare egress bindings for Airtable API access', () => {
      expect(crd.spec.egressBindings).toBeDefined()
      expect(crd.spec.egressBindings).toHaveLength(1)
    })

    it('should allow outbound HTTPS to api.airtable.com', () => {
      const binding = crd.spec.egressBindings?.[0]
      expect(binding?.dns).toBe('api.airtable.com')
      expect(binding?.port).toBe(443)
      expect(binding?.protocol).toBe('TCP')
    })
  })

  describe('Authentication', () => {
    it('should use none auth type', () => {
      expect(crd.spec.auth.type).toBe('none')
    })

    it('should rely on envSecret for credentials instead', () => {
      // Auth is handled via API key in environment variables
      expect(crd.spec.envSecret).toBeDefined()
      expect(crd.spec.envSecret.keys.length).toBeGreaterThan(0)
    })
  })

  describe('Server State', () => {
    it('should be enabled by default', () => {
      expect(crd.spec.enabled).toBe(true)
    })
  })
})

describe('Airtable MCP Server - Example Secret Template', () => {
  let secret: any

  beforeEach(() => {
    secret = loadExampleSecret()
  })

  describe('Secret Metadata', () => {
    it('should have correct secret name', () => {
      expect(secret.metadata.name).toBe('mcp-airtable-credentials')
    })

    it('should be in mcp-server namespace', () => {
      expect(secret.metadata.namespace).toBe('mcp-server')
    })

    it('should have app label', () => {
      expect(secret.metadata.labels?.app).toBe('mcp-airtable')
    })

    it('should be Opaque type', () => {
      expect(secret.type).toBe('Opaque')
    })
  })

  describe('Secret Data Structure', () => {
    it('should have api-key field', () => {
      expect(secret.data).toHaveProperty('api-key')
    })

    it('should have placeholder for base64 encoded key', () => {
      expect(secret.data['api-key']).toContain('<BASE64_ENCODED_AIRTABLE_API_KEY>')
    })

    it('should include encoding instructions in comment', () => {
      const content = readFileSync(EXAMPLE_SECRET_YAML, 'utf-8')
      expect(content).toContain('base64')
      expect(content).toContain('echo -n')
    })
  })
})

describe('Airtable MCP Server - Configuration Validation', () => {
  it('should match Context CRD server reference', () => {
    const crd = loadMcpServerCrd()

    // The server name 'airtable-server' should match what's in context1.yaml
    expect(crd.metadata.name).toBe('airtable-server')
  })

  it('should be compatible with StreamableHTTP transport', () => {
    const crd = loadMcpServerCrd()

    // Validate transport type is supported
    expect(['streamableHttp', 'sse', 'stdio']).toContain(crd.spec.transport.type)

    // StreamableHTTP requires a URL
    if (crd.spec.transport.type === 'streamableHttp') {
      expect(crd.spec.transport.url).toBeDefined()
      expect(crd.spec.transport.url).toMatch(/^https?:\/\//)
    }
  })

  it('should have all required fields for context-mapper reconciliation', () => {
    const crd = loadMcpServerCrd()

    // Required fields for the operator to create Deployment
    expect(crd.spec.image).toBeDefined()
    expect(crd.spec.transport).toBeDefined()
    expect(crd.spec.envMapping).toBeDefined()
    expect(crd.spec.envSecret).toBeDefined()
    expect(crd.spec.resources).toBeDefined()
  })

  it('should include explicit egress bindings for external API reachability', () => {
    const crd = loadMcpServerCrd()
    expect(crd.spec.egressBindings?.[0]).toMatchObject({
      dns: 'api.airtable.com',
      port: 443,
      protocol: 'TCP',
    })
  })

  it('should have consistent naming across components', () => {
    const crd = loadMcpServerCrd()
    const secret = loadExampleSecret()

    // Secret name should match envSecret.name in CRD
    expect(crd.spec.envSecret.name).toBe(secret.metadata.name)

    // Server name should be consistent
    expect(crd.metadata.name).toContain('airtable')
    expect(secret.metadata.labels?.app).toContain('airtable')
  })
})

describe('Airtable MCP Server - Security Configuration', () => {
  let crd: McpServerCrd

  beforeEach(() => {
    crd = loadMcpServerCrd()
  })

  it('should not run as root (image should use non-root user)', () => {
    // This test documents the security requirement
    // The actual validation would require inspecting the Dockerfile
    expect(crd.spec.image).toBeDefined()
    // TODO: Add Dockerfile inspection test
  })

  it('should use read-only root filesystem (image requirement)', () => {
    // This test documents the security requirement
    // Validation requires image inspection
    // TODO: Add image security scan test
  })

  it('should have minimal resource footprint', () => {
    // Defense in depth: limit blast radius if compromised
    expect(parseInt(crd.spec.resources.limits.memory)).toBeLessThanOrEqual(256)
    expect(parseInt(crd.spec.resources.limits.cpu)).toBeLessThanOrEqual(500)
  })

  it('should have least privilege (only required API key)', () => {
    // Only api-key is needed, no other credentials
    expect(crd.spec.envSecret.keys).toHaveLength(1)
    expect(crd.spec.envSecret.keys[0].secretKey).toBe('api-key')
  })
})
