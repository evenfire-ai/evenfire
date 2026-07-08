import { describe, expect, it, vi } from 'vitest'
import {
  type K8sSecretReader,
  type McpHostClient,
  ModelConfigHandler,
  type ObjectStorageReader,
} from '../../../src/workflow/modelConfigHandler'

// ─── Mock Factories ─────────────────────────────────────────────────────

function mockK8s(
  configMap: Record<string, string> | null = null,
  secret: Record<string, string> | null = null
): K8sSecretReader {
  return {
    readConfigMap: vi.fn().mockResolvedValue(configMap),
    readSecret: vi.fn().mockResolvedValue(secret),
  }
}

function mockMcpHost(
  status = 200,
  body: Record<string, unknown> = { configured: true }
): McpHostClient {
  return {
    configure: vi.fn().mockResolvedValue({ status, body }),
  }
}

const DEFAULT_CONFIGMAP = { 'openai__gpt-4': 'openai-secret/apiKey' }
const DEFAULT_SECRET = { apiKey: 'sk-test-super-secret-key-12345' }

// ─── S11: Zero-Secret-Knowledge — coordinator never sees apiKey ────────

describe('S11: coordinator zero-secret-knowledge invariant', () => {
  it('response body NEVER contains apiKey field', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    const bodyStr = JSON.stringify(result.body)
    expect(bodyStr).not.toContain('apiKey')
    expect(bodyStr).not.toContain('sk-test')
    expect(bodyStr).not.toContain('super-secret')
  })

  it('error responses do not leak K8s Secret names', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, null)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    const bodyStr = JSON.stringify(result.body)
    expect(bodyStr).not.toContain('openai-secret')
    expect(bodyStr).not.toContain('secretName')
  })

  it('error responses when Secret exists but lacks apiKey do not leak secretName', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, { unrelatedField: 'value' })
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(500)
    const bodyStr = JSON.stringify(result.body)
    expect(bodyStr).not.toContain('openai-secret')
  })

  it('400 error for invalid provider does not leak ConfigMap data (BUG-11/V9 fix)', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    // BUG-11/V9 fix: invalid providers are rejected BEFORE ConfigMap lookup (400, not 404)
    // This is better from a security standpoint — the ConfigMap is never touched
    const result = await handler.handle(
      { stepId: 's1', provider: 'unknown', model: 'x' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('Invalid provider')
    // Should not reveal any ConfigMap data
    expect(JSON.stringify(result.body)).not.toContain('openai__gpt-4')
    expect(JSON.stringify(result.body)).not.toContain('openai-secret')
  })

  it('404 error for valid provider but unknown model does not leak ConfigMap data', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-99-nonexistent' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(404)
    expect(JSON.stringify(result.body)).not.toContain('openai-secret')
  })
})

// ─── V3: Error message sanitization ────────────────────────────────────

describe('V3: mcp_host connection error sanitization', () => {
  it('does not leak connection strings in 502 error response', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const mcpHost: McpHostClient = {
      configure: vi
        .fn()
        .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:8080 — apiKey=sk-test-123')),
    }
    const handler = new ModelConfigHandler(k8s, mcpHost)

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(502)
    // V3 fix: no detail field, no internal error info
    expect(result.body).not.toHaveProperty('detail')
    expect(JSON.stringify(result.body)).not.toContain('10.0.0.5')
    expect(JSON.stringify(result.body)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(result.body)).not.toContain('sk-test')
  })

  it('does not leak stack traces in error response', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const err = new Error('network error')
    err.stack =
      'Error: network error\n    at TLSSocket._finishInit (node:_tls_wrap:123)\n    at TLSWrap.ssl.onhandshakedone'
    const mcpHost: McpHostClient = {
      configure: vi.fn().mockRejectedValue(err),
    }
    const handler = new ModelConfigHandler(k8s, mcpHost)

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(502)
    expect(JSON.stringify(result.body)).not.toContain('TLSSocket')
    expect(JSON.stringify(result.body)).not.toContain('node:')
  })
})

// ─── S10: apiKey travels ONLY on WRC→mcp_host leg ─────────────────────

describe('S10: apiKey only on WRC→mcp_host leg', () => {
  it('sends apiKey to mcp_host in configure body', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, { apiKey: 'sk-production-key' })
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    const configureCall = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(configureCall[2].apiKey).toBe('sk-production-key')
  })

  it('supports api-key (hyphenated) as alternative Secret field name', async () => {
    // Post-refactor: the ConfigMap value is `"secretName/keyName"` — the keyName is
    // addressable per-entry, so hyphenated names work the same as camelCase.
    const k8s = mockK8s({ 'openai__gpt-4': 'openai-secret/api-key' }, { 'api-key': 'sk-alt-key' })
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    const configureCall = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(configureCall[2].apiKey).toBe('sk-alt-key')
  })

  it('forwards WRC configure token to mcp_host (not coordinator token)', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'wrc-only-token'
    )
    const tokenArg = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(tokenArg).toBe('wrc-only-token')
  })
})

// ─── Log-level secret leak prevention ──────────────────────────────────

describe('secret leak prevention in logs', () => {
  it('console.warn for SOUL failure does not contain apiKey', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const storage: ObjectStorageReader = { download: vi.fn().mockRejectedValue(new Error('net')) }
    const handler = new ModelConfigHandler(k8s, mockMcpHost(), storage)

    await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-4',
        soulStorageRef: { bucket: 'b', key: 'k' },
      },
      'http://mcp:8080',
      'tok'
    )

    const allLogs = warnSpy.mock.calls.flat().join(' ')
    expect(allLogs).not.toContain('sk-test')
    expect(allLogs).not.toContain('apiKey')
    warnSpy.mockRestore()
  })

  it('does not log apiKey at any level during successful configure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const k8s = mockK8s(DEFAULT_CONFIGMAP, { apiKey: 'EXTREMELY-SECRET-KEY' })
    const handler = new ModelConfigHandler(k8s, mockMcpHost())
    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )

    const allLogs = [
      ...logSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ].join(' ')
    expect(allLogs).not.toContain('EXTREMELY-SECRET-KEY')

    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

// ─── SOUL content injection boundary ───────────────────────────────────

describe('SOUL content security', () => {
  it('SOUL download failure does not block model configuration', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const storage: ObjectStorageReader = {
      download: vi.fn().mockRejectedValue(new Error('timeout')),
    }
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost, storage)

    const result = await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-4',
        soulStorageRef: { bucket: 'b', key: 'k' },
      },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
    // apiKey was still sent to mcp_host
    expect(mcpHost.configure).toHaveBeenCalled()
  })

  it('SOUL content null from storage is omitted from configure body', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const storage: ObjectStorageReader = { download: vi.fn().mockResolvedValue(null) }
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost, storage)

    await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-4',
        soulStorageRef: { bucket: 'b', key: 'k' },
      },
      'http://mcp:8080',
      'tok'
    )
    const body = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(body.soulContent).toBeUndefined()
  })
})
