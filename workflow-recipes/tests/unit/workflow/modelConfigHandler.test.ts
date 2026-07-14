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

function mockObjectStorage(content: string | null = 'SOUL content'): ObjectStorageReader {
  return {
    download: vi.fn().mockResolvedValue(content),
  }
}

const DEFAULT_CONFIGMAP = { 'openai__gpt-4': 'openai-secret/apiKey' }
const DEFAULT_SECRET = { apiKey: 'sk-test-123' }

describe('POST /configure-model — ConfigMap resolution', () => {
  it('reads clerum-model-secret-mapping ConfigMap from mcp-host namespace', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    expect(k8s.readConfigMap).toHaveBeenCalledWith('mcp-host', 'clerum-model-secret-mapping')
  })

  it('resolves provider/model key to secretName from secretName/keyName format', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    expect(k8s.readSecret).toHaveBeenCalledWith('mcp-host', 'openai-secret')
  })

  it('returns 500 when mapping is malformed (missing / separator)', async () => {
    const k8s = mockK8s({ 'openai__gpt-4': 'openai-secret' }, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    expect(result.status).toBe(500)
    expect(result.body.error).toContain('Malformed')
    // V2 invariant: must not leak the mapping value
    expect(JSON.stringify(result.body)).not.toContain('openai-secret')
  })

  it('returns 500 when mapping has leading / (empty secretName)', async () => {
    const k8s = mockK8s({ 'openai__gpt-4': '/apiKey' }, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    expect(result.status).toBe(500)
    expect(result.body.error).toContain('Malformed')
  })

  it('returns 500 when mapping has trailing / (empty keyName)', async () => {
    const k8s = mockK8s({ 'openai__gpt-4': 'openai-secret/' }, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    expect(result.status).toBe(500)
    expect(result.body.error).toContain('Malformed')
  })

  it("resolves non-canonical keyName (not 'apiKey') from Secret", async () => {
    const k8s = mockK8s(
      { 'zai__glm-4.7': 'chatllm-api-keys/zai-api-key' },
      { 'zai-api-key': 'sk-zai-real', 'openai-api-key': 'sk-openai-other' }
    )
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    await handler.handle(
      { stepId: 's1', provider: 'zai', model: 'glm-4.7' },
      'http://mcp:8080',
      'tok'
    )
    expect(k8s.readSecret).toHaveBeenCalledWith('mcp-host', 'chatllm-api-keys')
    const body = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(body.apiKey).toBe('sk-zai-real')
    expect(body.llmSecretName).toBe('chatllm-api-keys')
    expect(JSON.stringify(body)).not.toContain('zai-api-key')
  })

  it('returns 404 when provider/model mapping not found in ConfigMap', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'claude', model: 'opus' },
      'http://mcp:8080',
      'token'
    )
    expect(result.status).toBe(404)
    expect(result.body.error).toContain('No secret mapping')
  })
})

describe('POST /configure-model — Secret read', () => {
  it('reads Secret by name (get only, not list)', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    expect(k8s.readSecret).toHaveBeenCalledTimes(1)
  })

  it('extracts apiKey from Secret data', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, { apiKey: 'sk-real-key' })
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    const configureCall = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(configureCall[2].apiKey).toBe('sk-real-key')
  })

  it('returns 500 when Secret not found', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, null)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    expect(result.status).toBe(500)
    expect(result.body.error).toContain('Secret resolution failed')
  })

  it('does not log apiKey value at any log level', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const k8s = mockK8s(DEFAULT_CONFIGMAP, { apiKey: 'SUPER-SECRET' })
    const handler = new ModelConfigHandler(k8s, mockMcpHost())
    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )

    const allLogs = [...consoleSpy.mock.calls.flat(), ...warnSpy.mock.calls.flat()].join(' ')
    expect(allLogs).not.toContain('SUPER-SECRET')

    consoleSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('POST /configure-model — SOUL override', () => {
  it('downloads SOUL content when step declares different storageRef', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const storage = mockObjectStorage('Custom SOUL')
    const handler = new ModelConfigHandler(k8s, mockMcpHost(), storage)

    await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-4',
        soulStorageRef: { bucket: 'souls', key: 'custom.md' },
      },
      'http://mcp:8080',
      'token'
    )
    expect(storage.download).toHaveBeenCalledWith('souls', 'custom.md')
  })

  it('includes soulContent in configure request when present', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const mcpHost = mockMcpHost()
    const storage = mockObjectStorage('Custom SOUL')
    const handler = new ModelConfigHandler(k8s, mcpHost, storage)

    await handler.handle(
      {
        stepId: 's1',
        provider: 'openai',
        model: 'gpt-4',
        soulStorageRef: { bucket: 'souls', key: 'custom.md' },
      },
      'http://mcp:8080',
      'token'
    )
    const body = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(body.soulContent).toBe('Custom SOUL')
  })

  it('omits soulContent when step uses global SOUL', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'token'
    )
    const body = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(body.soulContent).toBeUndefined()
  })

  it('continues without SOUL when download fails (non-blocking)', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const storage: ObjectStorageReader = {
      download: vi.fn().mockRejectedValue(new Error('network')),
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
      'token'
    )
    expect(result.status).toBe(202) // succeeds without SOUL
  })
})

describe('POST /configure-model — mcp_host delegation', () => {
  it('POSTs to mcp_host /configure with correct body', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, { apiKey: 'sk-test' })
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(mcpHost.configure).toHaveBeenCalledWith('http://mcp:8080', 'tok', {
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'sk-test',
      llmSecretName: 'openai-secret',
    })
    const body = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(JSON.stringify(body)).not.toContain('openai-secret/apiKey')
  })

  it('uses configure scoped token for mcp_host call', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'wrc-configure-token-123'
    )
    const tokenArg = (mcpHost.configure as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(tokenArg).toBe('wrc-configure-token-123')
  })

  it('returns 202 to coordinator after mcp_host returns 200', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost(200))

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
  })

  it('returns 502 to coordinator when mcp_host /configure returns 5xx', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost(500))

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(502)
  })

  it('never includes apiKey in response to coordinator', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.body).not.toHaveProperty('apiKey')
    expect(JSON.stringify(result.body)).not.toContain('sk-test')
  })
})

describe('POST /configure-model — security invariants', () => {
  it('coordinator request body does not contain apiKey field', async () => {
    // This is a design invariant — the coordinator sends { stepId, provider, model } only
    const req = { stepId: 's1', provider: 'openai', model: 'gpt-4' }
    expect(req).not.toHaveProperty('apiKey')
  })

  it('response to coordinator does not contain apiKey field', async () => {
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
  })
})
