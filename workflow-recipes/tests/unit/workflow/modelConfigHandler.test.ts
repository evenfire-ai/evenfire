import { describe, expect, it, vi } from 'vitest'
import {
  type K8sSecretReader,
  type McpHostClient,
  ModelConfigHandler,
  type ObjectStorageReader,
} from '../../../src/workflow/modelConfigHandler'

// ─── Mock Factories ─────────────────────────────────────────────────────

// The allowlist ConfigMap is read via `readConfigMapWithPresence`; the
// secret-mapping ConfigMap via `readConfigMap` (dispatched by name). `allowlist`
// defaults to null → `{ exists: false }` (absent → degraded mode, which proceeds
// when no `validateDegraded` hook is passed to `handle`). A non-null object →
// `{ exists: true, data }`, so an empty object models an existing-but-empty CM
// (deny-all), preserving the exists-vs-empty distinction the gate depends on.
// Fixture allowlist values mirror control-api buildConfigMapData
// (llmAllowedModelsConfigMap.ts) — keep in sync.
function mockK8s(
  configMap: Record<string, string> | null = null,
  secret: Record<string, string> | null = null,
  allowlist: Record<string, string> | null = null,
  allowlistAnnotations: Record<string, string> = {}
): K8sSecretReader {
  return {
    readConfigMap: vi.fn(async (_namespace: string, name: string) =>
      name === 'clerum-llm-allowed-models' ? allowlist : configMap
    ),
    readConfigMapWithPresence: vi.fn(async () =>
      allowlist === null
        ? ({ exists: false } as const)
        : ({ exists: true, data: allowlist, annotations: allowlistAnnotations } as const)
    ),
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

// New format (R1): the mapping key is the provider, not `provider__model`.
const DEFAULT_CONFIGMAP = { openai: 'openai-secret/apiKey' }
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
    const k8s = mockK8s({ openai: 'openai-secret' }, DEFAULT_SECRET)
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
    const k8s = mockK8s({ openai: '/apiKey' }, DEFAULT_SECRET)
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
    const k8s = mockK8s({ openai: 'openai-secret/' }, DEFAULT_SECRET)
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
      { zai: 'chatllm-api-keys/zai-api-key' },
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

describe('POST /configure-model — provider mapping dual-read (R1)', () => {
  it('resolves the new per-provider key', async () => {
    const k8s = mockK8s({ zai: 'chatllm-api-keys/zai-api-key' }, { 'zai-api-key': 'sk-zai' })
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'zai', model: 'glm-4.7' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
    expect(k8s.readSecret).toHaveBeenCalledWith('mcp-host', 'chatllm-api-keys')
  })

  it('falls back to the legacy provider__model key when the provider key is absent', async () => {
    const k8s = mockK8s(
      { 'zai__glm-4.7': 'chatllm-api-keys/zai-api-key' },
      { 'zai-api-key': 'sk-zai' }
    )
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'zai', model: 'glm-4.7' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
    expect(k8s.readSecret).toHaveBeenCalledWith('mcp-host', 'chatllm-api-keys')
  })

  it('prefers the new per-provider key over the legacy key when both are present', async () => {
    const k8s = mockK8s(
      {
        zai: 'chatllm-api-keys/zai-api-key',
        'zai__glm-4.7': 'legacy-secret/legacy-key',
      },
      { 'zai-api-key': 'sk-zai' }
    )
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'zai', model: 'glm-4.7' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
    expect(k8s.readSecret).toHaveBeenCalledWith('mcp-host', 'chatllm-api-keys')
  })

  it('returns 404 when neither the provider key nor the legacy key is present', async () => {
    const k8s = mockK8s({ openai: 'openai-secret/apiKey' }, DEFAULT_SECRET)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'zai', model: 'glm-4.7' },
      'http://mcp:8080',
      'tok'
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

describe('POST /configure-model — R3 allowlist gate', () => {
  it('allows a model listed in the allowlist ConfigMap → 202', async () => {
    const allowlist = { openai: JSON.stringify([{ model: 'gpt-4' }, { model: 'gpt-4o' }]) }
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, allowlist)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
  })

  it('configures codex-subscription without reading a Secret', async () => {
    const allowlist = { 'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex' }]) }
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, allowlist)
    const mcpHost = mockMcpHost()
    const handler = new ModelConfigHandler(k8s, mcpHost)

    const result = await handler.handle(
      { stepId: 's1', provider: 'codex-subscription', model: 'gpt-5.3-codex' },
      'http://mcp:8080',
      'tok',
      { codexConnectionKey: 'team-plus' }
    )

    expect(result.status).toBe(202)
    expect(result.body).toEqual({
      configured: true,
      provider: 'codex-subscription',
      model: 'gpt-5.3-codex',
      identityBound: true,
      grantRedeemable: true,
    })
    expect(k8s.readSecret).not.toHaveBeenCalled()
    expect(mcpHost.configure).toHaveBeenCalledWith('http://mcp:8080', 'tok', {
      provider: 'codex-subscription',
      model: 'gpt-5.3-codex',
    })
    expect(JSON.stringify(result.body)).not.toContain('sk-test')
    expect(result.body).not.toHaveProperty('apiKey')
  })

  it('treats HTTP 200 with configured:false as a configure failure', async () => {
    const allowlist = { 'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex' }]) }
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, allowlist)
    const mcpHost = mockMcpHost(200, { configured: false, message: 'apiKey is required' })
    const handler = new ModelConfigHandler(k8s, mcpHost)

    const result = await handler.handle(
      { stepId: 's1', provider: 'codex-subscription', model: 'gpt-5.3-codex' },
      'http://mcp:8080',
      'tok',
      { codexConnectionKey: 'team-plus' }
    )

    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: 'mcp_host configure failed', mcpHostStatus: 200 })
  })

  it('rejects a model absent from the allowlist → 403 model_not_allowed', async () => {
    const allowlist = { openai: JSON.stringify([{ model: 'gpt-4' }]) }
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, allowlist)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-3.5-turbo' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(403)
    expect(result.body.code).toBe('model_not_allowed')
    // Fail-closed BEFORE secret resolution — no Secret read on a denied model.
    expect(k8s.readSecret).not.toHaveBeenCalled()
    // Must not leak any secret/mapping material.
    expect(JSON.stringify(result.body)).not.toContain('openai-secret')
    expect(JSON.stringify(result.body)).not.toContain('sk-test')
  })

  it('rejects when the provider has no allowlist entry at all → 403', async () => {
    const allowlist = { claude: JSON.stringify([{ model: 'claude-opus-4' }]) }
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, allowlist)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(403)
    expect(result.body.code).toBe('model_not_allowed')
  })

  it('keeps 400 (invalid provider), 403 (not allowed) and 404 (no mapping) distinct', async () => {
    // 400 — invalid provider, rejected before any ConfigMap read.
    const k8s400 = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, {
      openai: JSON.stringify([{ model: 'gpt-4' }]),
    })
    const r400 = await new ModelConfigHandler(k8s400, mockMcpHost()).handle(
      { stepId: 's1', provider: 'bogus', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(r400.status).toBe(400)

    // 403 — valid provider, model not in allowlist.
    const r403 = await new ModelConfigHandler(k8s400, mockMcpHost()).handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4o' },
      'http://mcp:8080',
      'tok'
    )
    expect(r403.status).toBe(403)

    // 404 — model IS allowed but no secret mapping exists for the provider.
    const k8s404 = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, {
      claude: JSON.stringify([{ model: 'claude-opus-4' }]),
    })
    const r404 = await new ModelConfigHandler(k8s404, mockMcpHost()).handle(
      { stepId: 's1', provider: 'claude', model: 'claude-opus-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(r404.status).toBe(404)
    expect(r404.body.error).toContain('No secret mapping')
  })

  it('existing-but-empty allowlist CM denies ALL models → 403 (not degraded)', async () => {
    // control-api materializes an allowlist with zero enabled rows as `data: {}`
    // (which kube-apiserver then omits). readConfigMapWithPresence reports it as
    // { exists: true, data: {} }, so the gate must deny every model — NOT fall
    // open into degraded mode. Regression guard for the fail-open High finding.
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, {})
    // Even with a validateDegraded hook that would allow, the gate never reaches
    // degraded mode because the CM exists.
    const result = await new ModelConfigHandler(k8s, mockMcpHost()).handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok',
      { validateDegraded: async () => null }
    )
    expect(result.status).toBe(403)
    expect(result.body.code).toBe('model_not_allowed')
    // Fail-closed before secret resolution.
    expect(k8s.readSecret).not.toHaveBeenCalled()
  })

  it('absent allowlist CM (404) drops into degraded mode, not deny-all', async () => {
    // The mock returns { exists: false } when allowlist is null (real 404). With
    // no validateDegraded hook the broker proceeds — the exists-vs-empty
    // distinction is what separates this from the deny-all case above.
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, null)
    const result = await new ModelConfigHandler(k8s, mockMcpHost()).handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
  })

  it('isolates a corrupt allowlist entry to its own provider', async () => {
    // openai entry is corrupt JSON → openai treated as having no allowed models;
    // claude entry is valid and still resolves normally.
    const allowlist = {
      openai: 'this is not json {{',
      claude: JSON.stringify([{ model: 'claude-opus-4' }]),
    }
    const k8s = mockK8s(
      { claude: 'chatllm-api-keys/claude-api-key' },
      { 'claude-api-key': 'sk-claude' },
      allowlist
    )

    const denied = await new ModelConfigHandler(k8s, mockMcpHost()).handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(denied.status).toBe(403)
    expect(denied.body.code).toBe('model_not_allowed')

    const allowed = await new ModelConfigHandler(k8s, mockMcpHost()).handle(
      { stepId: 's1', provider: 'claude', model: 'claude-opus-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(allowed.status).toBe(202)
  })
})

describe('POST /configure-model — R3.5 degraded mode (allowlist ConfigMap absent)', () => {
  it('proceeds when the declared-model validator passes (returns null) → 202', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, null)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok',
      { validateDegraded: async () => null }
    )
    expect(result.status).toBe(202)
  })

  it('rejects when the declared-model validator returns an error', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, null)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok',
      {
        validateDegraded: async () => ({
          status: 422,
          body: { error: 'Requested provider/model does not match the declared step agent' },
        }),
      }
    )
    expect(result.status).toBe(422)
    // Rejected before secret resolution.
    expect(k8s.readSecret).not.toHaveBeenCalled()
  })

  it('proceeds without any validator (broker used by an already-validated caller)', async () => {
    const k8s = mockK8s(DEFAULT_CONFIGMAP, DEFAULT_SECRET, null)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'openai', model: 'gpt-4' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
  })
})

describe('POST /configure-model — allowlist composes with R1 dual-read', () => {
  it('allowlisted model resolves via the legacy provider__model mapping key', async () => {
    const k8s = mockK8s(
      { 'zai__glm-4.7': 'chatllm-api-keys/zai-api-key' },
      { 'zai-api-key': 'sk-zai' },
      { zai: JSON.stringify([{ model: 'glm-4.7' }]) }
    )
    const handler = new ModelConfigHandler(k8s, mockMcpHost())

    const result = await handler.handle(
      { stepId: 's1', provider: 'zai', model: 'glm-4.7' },
      'http://mcp:8080',
      'tok'
    )
    expect(result.status).toBe(202)
    expect(k8s.readSecret).toHaveBeenCalledWith('mcp-host', 'chatllm-api-keys')
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

  it('rejects a Codex model that only another grant offers', async () => {
    const allowlist = {
      'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex' }, { model: 'gpt-5.1' }]),
    }
    const annotations = {
      'clerum.io/codex-connections': JSON.stringify({
        'team-plus': {
          status: 'connected',
          catalogRevision: 3,
          connectionRevision: 8,
          models: ['gpt-5.3-codex'],
        },
        'personal-pro': {
          status: 'connected',
          catalogRevision: 4,
          connectionRevision: 2,
          models: ['gpt-5.1'],
        },
      }),
    }
    const k8s = mockK8s({}, null, allowlist, annotations)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())
    const denied = await handler.handle(
      { stepId: 's1', provider: 'codex-subscription', model: 'gpt-5.3-codex' },
      'http://mcp:8080',
      'tok',
      { codexConnectionKey: 'personal-pro' }
    )
    expect(denied.status).toBe(202)
    expect(denied.body.identityBound).toBe(true)
    expect(denied.body.grantRedeemable).toBe(false)

    const allowed = await handler.handle(
      { stepId: 's1', provider: 'codex-subscription', model: 'gpt-5.1' },
      'http://mcp:8080',
      'tok',
      { codexConnectionKey: 'personal-pro' }
    )
    expect(allowed.status).toBe(202)
    expect(allowed.body.configured).toBe(true)
    expect(allowed.body.grantRedeemable).toBe(true)
  })

  it('does not let an unassigned recipe inherit the flat Codex catalog', async () => {
    const allowlist = {
      'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex' }]),
    }
    const k8s = mockK8s({}, null, allowlist)
    const handler = new ModelConfigHandler(k8s, mockMcpHost())
    const identityOnly = await handler.handle(
      { stepId: 's1', provider: 'codex-subscription', model: 'gpt-5.3-codex' },
      'http://mcp:8080',
      'tok'
    )
    expect(identityOnly.status).toBe(202)
    expect(identityOnly.body.configured).toBe(true)
    expect(identityOnly.body.identityBound).toBe(true)
    expect(identityOnly.body.grantRedeemable).toBe(false)
  })
})
