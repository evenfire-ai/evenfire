import { describe, expect, it, vi } from 'vitest'
import { K8sSecretReaderImpl } from '../../../src/workflow/k8sSecretReaderImpl'

// Mock CoreV1Api
function mockCoreApi(
  overrides: {
    readNamespacedConfigMap?: (params: { name: string; namespace: string }) => Promise<unknown>
    readNamespacedSecret?: (params: { name: string; namespace: string }) => Promise<unknown>
  } = {}
) {
  return {
    readNamespacedConfigMap: overrides.readNamespacedConfigMap ?? vi.fn(),
    readNamespacedSecret: overrides.readNamespacedSecret ?? vi.fn(),
  } as unknown as import('@kubernetes/client-node').CoreV1Api
}

describe('K8sSecretReaderImpl', () => {
  describe('readConfigMap', () => {
    it('returns data from ConfigMap', async () => {
      const api = mockCoreApi({
        readNamespacedConfigMap: async () => ({
          data: { 'openai/gpt-4': 'openai-secret', 'claude/sonnet': 'claude-secret' },
        }),
      })
      const reader = new K8sSecretReaderImpl(api)
      const result = await reader.readConfigMap('mcp-host', 'clerum-model-secret-mapping')
      expect(result).toEqual({
        'openai/gpt-4': 'openai-secret',
        'claude/sonnet': 'claude-secret',
      })
    })

    it('returns null when ConfigMap has no data', async () => {
      const api = mockCoreApi({
        readNamespacedConfigMap: async () => ({ data: undefined }),
      })
      const reader = new K8sSecretReaderImpl(api)
      const result = await reader.readConfigMap('control-plane', 'missing-data')
      expect(result).toBeNull()
    })

    it('returns null on 404', async () => {
      const api = mockCoreApi({
        readNamespacedConfigMap: async () => {
          const err = new Error('Not Found') as Error & { response: { statusCode: number } }
          err.response = { statusCode: 404 }
          throw err
        },
      })
      const reader = new K8sSecretReaderImpl(api)
      const result = await reader.readConfigMap('control-plane', 'nonexistent')
      expect(result).toBeNull()
    })

    it('propagates non-404 errors', async () => {
      const api = mockCoreApi({
        readNamespacedConfigMap: async () => {
          const err = new Error('Forbidden') as Error & { response: { statusCode: number } }
          err.response = { statusCode: 403 }
          throw err
        },
      })
      const reader = new K8sSecretReaderImpl(api)
      await expect(reader.readConfigMap('control-plane', 'forbidden')).rejects.toThrow('Forbidden')
    })
  })

  describe('readSecret', () => {
    it('decodes base64 Secret data', async () => {
      const api = mockCoreApi({
        readNamespacedSecret: async () => ({
          data: {
            apiKey: Buffer.from('sk-test-12345').toString('base64'),
            'api-key': Buffer.from('sk-alt-67890').toString('base64'),
          },
        }),
      })
      const reader = new K8sSecretReaderImpl(api)
      const result = await reader.readSecret('control-plane', 'openai-secret')
      expect(result).toEqual({
        apiKey: 'sk-test-12345',
        'api-key': 'sk-alt-67890',
      })
    })

    it('returns null when Secret has no data', async () => {
      const api = mockCoreApi({
        readNamespacedSecret: async () => ({ data: undefined }),
      })
      const reader = new K8sSecretReaderImpl(api)
      const result = await reader.readSecret('control-plane', 'empty-secret')
      expect(result).toBeNull()
    })

    it('returns null on 404', async () => {
      const api = mockCoreApi({
        readNamespacedSecret: async () => {
          const err = new Error('Not Found') as Error & { response: { statusCode: number } }
          err.response = { statusCode: 404 }
          throw err
        },
      })
      const reader = new K8sSecretReaderImpl(api)
      const result = await reader.readSecret('control-plane', 'nonexistent')
      expect(result).toBeNull()
    })

    it('propagates non-404 errors', async () => {
      const api = mockCoreApi({
        readNamespacedSecret: async () => {
          const err = new Error('Forbidden') as Error & { response: { statusCode: number } }
          err.response = { statusCode: 403 }
          throw err
        },
      })
      const reader = new K8sSecretReaderImpl(api)
      await expect(reader.readSecret('control-plane', 'forbidden')).rejects.toThrow('Forbidden')
    })

    it('handles multi-line base64 values (PEM keys)', async () => {
      const pemKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----'
      const api = mockCoreApi({
        readNamespacedSecret: async () => ({
          data: { 'private.pem': Buffer.from(pemKey).toString('base64') },
        }),
      })
      const reader = new K8sSecretReaderImpl(api)
      const result = await reader.readSecret('control-plane', 'signing-key')
      expect(result?.['private.pem']).toBe(pemKey)
    })
  })
})
