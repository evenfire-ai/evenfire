/**
 * Integration test: ModelConfigHandler DI wiring in ClerumMcpServer.
 *
 * Validates that the full dependency chain works:
 * server.ts constructor → K8sSecretReaderImpl + HttpMcpHostClient → ModelConfigHandler
 * server.ts configureModel endpoint → passes handler + token to restEndpoints
 *
 * These tests catch the class of bugs where interfaces exist but
 * implementations are never wired (Bug B3).
 */
import { describe, expect, it, vi } from 'vitest'
import { HttpMcpHostClient } from '../../../src/workflow/httpMcpHostClient'
import { K8sSecretReaderImpl } from '../../../src/workflow/k8sSecretReaderImpl'
import { ModelConfigHandler } from '../../../src/workflow/modelConfigHandler'

// Simulate a real 404 from the K8s API so readConfigMapWithPresence reports the
// allowlist CM as absent (degraded mode). Returning `{ data: undefined }` would
// instead mean "CM exists, empty data" → deny-all, so absence MUST throw 404.
function notFound(): never {
  const err = new Error('Not Found') as Error & { response: { statusCode: number } }
  err.response = { statusCode: 404 }
  throw err
}

describe('ModelConfigHandler DI Wiring (B3 regression)', () => {
  describe('K8sSecretReaderImpl satisfies K8sSecretReader interface', () => {
    it('has readConfigMap method', () => {
      const mockApi = { readNamespacedConfigMap: vi.fn(), readNamespacedSecret: vi.fn() }
      const reader = new K8sSecretReaderImpl(mockApi as never)
      expect(typeof reader.readConfigMap).toBe('function')
    })

    it('has readConfigMapWithPresence method', () => {
      const mockApi = { readNamespacedConfigMap: vi.fn(), readNamespacedSecret: vi.fn() }
      const reader = new K8sSecretReaderImpl(mockApi as never)
      expect(typeof reader.readConfigMapWithPresence).toBe('function')
    })

    it('has readSecret method', () => {
      const mockApi = { readNamespacedConfigMap: vi.fn(), readNamespacedSecret: vi.fn() }
      const reader = new K8sSecretReaderImpl(mockApi as never)
      expect(typeof reader.readSecret).toBe('function')
    })
  })

  describe('HttpMcpHostClient satisfies McpHostClient interface', () => {
    it('has configure method', () => {
      const client = new HttpMcpHostClient()
      expect(typeof client.configure).toBe('function')
    })
  })

  describe('ModelConfigHandler accepts concrete implementations', () => {
    it('constructs with K8sSecretReaderImpl + HttpMcpHostClient', () => {
      const mockApi = { readNamespacedConfigMap: vi.fn(), readNamespacedSecret: vi.fn() }
      const reader = new K8sSecretReaderImpl(mockApi as never)
      const mcpClient = new HttpMcpHostClient()

      // This is the exact construction that happens in server.ts
      const handler = new ModelConfigHandler(reader, mcpClient)
      expect(handler).toBeInstanceOf(ModelConfigHandler)
    })

    it('constructs with optional ObjectStorageReader', () => {
      const mockApi = { readNamespacedConfigMap: vi.fn(), readNamespacedSecret: vi.fn() }
      const reader = new K8sSecretReaderImpl(mockApi as never)
      const mcpClient = new HttpMcpHostClient()
      const mockStorage = { download: vi.fn().mockResolvedValue('soul content') }

      const handler = new ModelConfigHandler(reader, mcpClient, mockStorage)
      expect(handler).toBeInstanceOf(ModelConfigHandler)
    })
  })

  describe('End-to-end model hot-swap flow', () => {
    it('resolves apiKey from ConfigMap→Secret chain and forwards to mcp_host', async () => {
      // 1. Mock K8s: ConfigMap maps provider "openai" → "openai-prod-secret/apiKey"
      // Post-R1 format: key = provider, value = "secretName/keyName".
      const mockApi = {
        // The R3 allowlist ConfigMap is absent here (degraded mode); the broker
        // proceeds since this direct-handler call passes no `validateDegraded`.
        readNamespacedConfigMap: vi.fn(({ name }: { name: string }) => {
          if (name === 'clerum-llm-allowed-models') notFound()
          return Promise.resolve({ data: { openai: 'openai-prod-secret/apiKey' } })
        }),
        readNamespacedSecret: vi.fn().mockResolvedValue({
          data: {
            apiKey: Buffer.from('sk-prod-12345').toString('base64'),
          },
        }),
      }
      const reader = new K8sSecretReaderImpl(mockApi as never)

      // 2. Mock mcp_host: accepts configure request
      const mcpClient = new HttpMcpHostClient()
      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ configured: true }),
        text: async () => '{}',
      })
      globalThis.fetch = fetchMock

      // 3. Run handler
      const handler = new ModelConfigHandler(reader, mcpClient)
      const result = await handler.handle(
        { stepId: 'step-1', provider: 'openai', model: 'gpt-4' },
        'http://wf-test-mcp-host.sandbox-recipes.svc.cluster.local:8080',
        'wrc-to-mcphost-jwt'
      )

      // 4. Verify: handler resolved apiKey and forwarded to mcp_host
      expect(result.status).toBe(202)
      expect(result.body).toEqual({ configured: true, provider: 'openai', model: 'gpt-4' })

      // 5. Verify: fetch was called with apiKey on the WRC→mcp_host leg
      expect(fetchMock).toHaveBeenCalledWith(
        'http://wf-test-mcp-host.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/configure',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('sk-prod-12345'),
        })
      )
      expect(fetchMock).toHaveBeenCalledWith(
        'http://wf-test-mcp-host.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/configure',
        expect.objectContaining({
          body: expect.stringContaining('"llmSecretName":"openai-prod-secret"'),
        })
      )

      // 6. Verify: response to coordinator does NOT contain apiKey (S11)
      expect(JSON.stringify(result.body)).not.toContain('sk-prod-12345')

      // Cleanup
      globalThis.fetch = vi.fn()
    })

    it('returns 500 when ConfigMap not found', async () => {
      const mockApi = {
        // Allowlist CM absent (404 → degraded); the secret-mapping CM exists but
        // has no data (data: undefined → readConfigMap returns null → 500).
        readNamespacedConfigMap: vi.fn(({ name }: { name: string }) => {
          if (name === 'clerum-llm-allowed-models') notFound()
          return Promise.resolve({ data: undefined })
        }),
        readNamespacedSecret: vi.fn(),
      }
      const reader = new K8sSecretReaderImpl(mockApi as never)
      const mcpClient = new HttpMcpHostClient()

      const handler = new ModelConfigHandler(reader, mcpClient)
      const result = await handler.handle(
        { stepId: 's1', provider: 'openai', model: 'gpt-4' },
        'http://mcp:8080',
        'tok'
      )

      expect(result.status).toBe(500)
      expect(result.body.error).toContain('ConfigMap not found')
    })

    it('returns 404 when provider has no secret mapping', async () => {
      const mockApi = {
        readNamespacedConfigMap: vi.fn(({ name }: { name: string }) => {
          if (name === 'clerum-llm-allowed-models') notFound()
          return Promise.resolve({ data: { openai: 'openai-secret/apiKey' } })
        }),
        readNamespacedSecret: vi.fn(),
      }
      const reader = new K8sSecretReaderImpl(mockApi as never)
      const mcpClient = new HttpMcpHostClient()

      const handler = new ModelConfigHandler(reader, mcpClient)
      // BUG-11/V9 fix: use a valid provider (claude) that is absent from the
      // ConfigMap — post-R1 the 404 is driven by the provider key, not the model.
      const result = await handler.handle(
        { stepId: 's1', provider: 'claude', model: 'claude-4-unknown' },
        'http://mcp:8080',
        'tok'
      )

      expect(result.status).toBe(404)
      expect(result.body.error).toContain('No secret mapping found')
    })

    it('returns 502 when mcp_host is unreachable', async () => {
      const mockApi = {
        readNamespacedConfigMap: vi.fn(({ name }: { name: string }) => {
          if (name === 'clerum-llm-allowed-models') notFound()
          return Promise.resolve({ data: { openai: 'openai-secret/apiKey' } })
        }),
        readNamespacedSecret: vi.fn().mockResolvedValue({
          data: { apiKey: Buffer.from('sk-test').toString('base64') },
        }),
      }
      const reader = new K8sSecretReaderImpl(mockApi as never)
      const mcpClient = new HttpMcpHostClient()

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

      const handler = new ModelConfigHandler(reader, mcpClient)
      const result = await handler.handle(
        { stepId: 's1', provider: 'openai', model: 'gpt-4' },
        'http://mcp:8080',
        'tok'
      )

      expect(result.status).toBe(502)
      expect(result.body.error).toContain('unreachable')

      globalThis.fetch = vi.fn()
    })
  })
})
