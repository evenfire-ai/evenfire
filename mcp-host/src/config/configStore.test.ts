import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_PROVIDERS } from '../llm/registryCore'
import { ConfigStore, PROVIDER_ENV_NAMES } from './configStore'

// ─── Test doubles ─────────────────────────────────────────────────────

interface FakeWatchHandle {
  abort: () => void
  emit: (type: string, obj: unknown) => void
  fail: (err: Error) => void
}

interface FakeWatch {
  watch: ReturnType<typeof vi.fn>
  /** All watches keyed by `${path}|${fieldSelector}`. */
  active: Map<string, FakeWatchHandle>
}

function makeFakeWatch(): FakeWatch {
  const active = new Map<string, FakeWatchHandle>()
  const watch = vi.fn(
    async (
      path: string,
      params: { fieldSelector?: string },
      onEvent: (type: string, obj: unknown) => void,
      onDone: (err: Error | null | undefined) => void
    ) => {
      const key = `${path}|${params.fieldSelector ?? ''}`
      let aborted = false
      const handle: FakeWatchHandle = {
        abort: () => {
          if (aborted) return
          aborted = true
          active.delete(key)
          onDone(null)
        },
        emit: (type, obj) => {
          if (aborted) return
          onEvent(type, obj)
        },
        fail: err => {
          if (aborted) return
          aborted = true
          active.delete(key)
          onDone(err)
        },
      }
      active.set(key, handle)
      return { abort: handle.abort }
    }
  )
  return { watch, active }
}

interface FakeCoreApi {
  readNamespacedSecret: ReturnType<typeof vi.fn>
  readNamespacedConfigMap: ReturnType<typeof vi.fn>
}

function makeFakeCoreApi(initial: {
  secrets?: Record<string, Record<string, string>>
  configMaps?: Record<string, Record<string, string>>
}): FakeCoreApi {
  const secrets = { ...(initial.secrets ?? {}) }
  const configMaps = { ...(initial.configMaps ?? {}) }
  return {
    readNamespacedSecret: vi.fn(async (req: { name: string }) => {
      const data = secrets[req.name]
      if (!data) {
        const err: { code?: number; statusCode?: number } = { code: 404, statusCode: 404 }
        throw err
      }
      return { data }
    }),
    readNamespacedConfigMap: vi.fn(async (req: { name: string }) => {
      const data = configMaps[req.name]
      if (!data) {
        const err: { code?: number; statusCode?: number } = { code: 404, statusCode: 404 }
        throw err
      }
      return { data }
    }),
  }
}

function build(opts: {
  llmSecretRef?: string | null
  provider?: 'openai' | 'claude' | 'zai' | 'bailian' | null
  secrets?: Record<string, Record<string, string>>
  configMaps?: Record<string, Record<string, string>>
}): { store: ConfigStore; watch: FakeWatch; api: FakeCoreApi } {
  const watch = makeFakeWatch()
  const api = makeFakeCoreApi({ secrets: opts.secrets, configMaps: opts.configMaps })
  const store = new ConfigStore({
    namespace: 'mcp-host',
    hostRef: 'trader',
    llmSecretRef: opts.llmSecretRef ?? 'chatllm-api-keys',
    provider: opts.provider ?? 'openai',
    coreApi: api as unknown as ConstructorParameters<typeof ConfigStore>[0]['coreApi'],
    watch: watch as unknown as ConstructorParameters<typeof ConfigStore>[0]['watch'],
  })
  return { store, watch, api }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('ConfigStore', () => {
  let store: ConfigStore | null = null

  afterEach(() => {
    store?.stop()
    store = null
  })

  it('translates LLM secret data key to shell-style env var name', async () => {
    const built = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
      },
    })
    store = built.store
    await store.start()

    expect(store.llmKey()).toEqual({ name: 'OPENAI_API_KEY', value: 'sk-openai' })
    expect(store.isLlmKeyConfigured()).toBe(true)
    expect(store.get('OPENAI_API_KEY')).toBe('sk-openai')
  })

  it('exposes only the provider-matching key from a multi-provider Secret', async () => {
    const previousProviderEnv = new Map(
      Array.from(PROVIDER_ENV_NAMES, name => [name, process.env[name]])
    )
    for (const name of PROVIDER_ENV_NAMES) delete process.env[name]
    try {
      const built = build({
        provider: 'zai',
        secrets: {
          'chatllm-api-keys': {
            'openai-api-key': 'sk-openai',
            'zai-api-key': 'zai-secret',
            'claude-api-key': 'sk-ant-claude',
          },
        },
      })
      store = built.store
      await store.start()

      expect(store.llmKey()).toEqual({ name: 'ZAI_API_KEY', value: 'zai-secret' })
      expect(store.get('OPENAI_API_KEY')).toBeUndefined()
      expect(store.get('CLAUDE_API_KEY')).toBeUndefined()
    } finally {
      for (const name of PROVIDER_ENV_NAMES) {
        const previous = previousProviderEnv.get(name)
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }
    }
  })

  it('decodes base64-encoded secret values', async () => {
    const encoded = Buffer.from('plain-value').toString('base64')
    const built = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': encoded },
      },
    })
    store = built.store
    await store.start()

    expect(store.llmKey()?.value).toBe('plain-value')
  })

  it('reports degraded when LLM Secret is missing the configured-provider key', async () => {
    const built = build({
      provider: 'claude',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
      },
    })
    store = built.store
    await store.start()

    expect(store.isLlmKeyConfigured()).toBe(false)
    expect(store.llmKey()).toBeNull()
  })

  it('reports degraded when LLM Secret does not exist (404)', async () => {
    const built = build({ provider: 'openai', secrets: {} })
    store = built.store
    await store.start()

    expect(store.isLlmKeyConfigured()).toBe(false)
  })

  it('merges per-Host CM and Secret with shell-style keys', async () => {
    const built = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
        'host-trader-env-secret': { GITHUB_TOKEN: 'ghp_secret' },
      },
      configMaps: {
        'host-trader-env': { FEATURE_FLAG: '1' },
      },
    })
    store = built.store
    await store.start()

    expect(store.get('GITHUB_TOKEN')).toBe('ghp_secret')
    expect(store.get('FEATURE_FLAG')).toBe('1')
    expect(store.get('OPENAI_API_KEY')).toBe('sk-openai')
  })

  it('honors precedence: per-Host Secret > CM > LLM Secret > process.env', async () => {
    const built = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
        'host-trader-env-secret': { OVERRIDE: 'from-secret' },
      },
      configMaps: {
        'host-trader-env': { OVERRIDE: 'from-cm', CM_ONLY: 'cm-val' },
      },
    })
    store = built.store
    await store.start()

    // Per-Host Secret wins over CM.
    expect(store.get('OVERRIDE')).toBe('from-secret')
    // CM-only key flows through.
    expect(store.get('CM_ONLY')).toBe('cm-val')
  })

  it('falls back to process.env only when no in-store value exists', async () => {
    const built = build({ provider: 'openai', secrets: {} })
    store = built.store
    process.env.__TEST_PASSTHRU__ = 'env-val'
    try {
      await store.start()
      expect(store.get('__TEST_PASSTHRU__')).toBe('env-val')
    } finally {
      delete process.env.__TEST_PASSTHRU__
    }
  })

  it('listSecretValues includes LLM key + per-Host secrets, never CM values', async () => {
    const built = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
        'host-trader-env-secret': { GITHUB_TOKEN: 'ghp_secret' },
      },
      configMaps: {
        'host-trader-env': { FEATURE_FLAG: '1' },
      },
    })
    store = built.store
    await store.start()

    const values = store.listSecretValues()
    expect(values).toContain('sk-openai')
    expect(values).toContain('ghp_secret')
    expect(values).not.toContain('1') // CM value
    expect(values).not.toContain('FEATURE_FLAG')
  })

  it('fires onChange with llmKeyChanged=true when LLM Secret rotates', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk-old' } },
    })
    store = built.store
    const handler = vi.fn()
    store.onChange(handler)
    await store.start()

    expect(store.get('OPENAI_API_KEY')).toBe('sk-old')

    // Simulate watch event for the LLM Secret
    const watchKey = `/api/v1/namespaces/mcp-host/secrets|metadata.name=chatllm-api-keys`
    const handle = built.watch.active.get(watchKey)
    expect(handle).toBeDefined()
    handle!.emit('MODIFIED', {
      metadata: { name: 'chatllm-api-keys' },
      data: { 'openai-api-key': 'sk-new' },
    })

    expect(store.get('OPENAI_API_KEY')).toBe('sk-new')
    expect(handler).toHaveBeenCalledWith({ llmKeyChanged: true, envChanged: false })
  })

  it('fires onChange with envChanged=true when per-Host Secret changes', async () => {
    const built = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-fixed' },
        'host-trader-env-secret': { GITHUB_TOKEN: 'old-token' },
      },
    })
    store = built.store
    const handler = vi.fn()
    store.onChange(handler)
    await store.start()

    const watchKey = `/api/v1/namespaces/mcp-host/secrets|metadata.name=host-trader-env-secret`
    const handle = built.watch.active.get(watchKey)
    expect(handle).toBeDefined()
    handle!.emit('MODIFIED', {
      metadata: { name: 'host-trader-env-secret' },
      data: { GITHUB_TOKEN: 'new-token', NEW_KEY: 'added' },
    })

    expect(store.get('GITHUB_TOKEN')).toBe('new-token')
    expect(store.get('NEW_KEY')).toBe('added')
    expect(handler).toHaveBeenCalledWith({ llmKeyChanged: false, envChanged: true })
  })

  it('does not fire onChange when nothing actually changed', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk-same' } },
    })
    store = built.store
    const handler = vi.fn()
    await store.start()
    store.onChange(handler)

    const watchKey = `/api/v1/namespaces/mcp-host/secrets|metadata.name=chatllm-api-keys`
    const handle = built.watch.active.get(watchKey)
    handle!.emit('MODIFIED', {
      metadata: { name: 'chatllm-api-keys' },
      data: { 'openai-api-key': 'sk-same' },
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('handles DELETED events for the LLM Secret by clearing llmKey', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk-openai' } },
    })
    store = built.store
    await store.start()
    expect(store.isLlmKeyConfigured()).toBe(true)

    const watchKey = `/api/v1/namespaces/mcp-host/secrets|metadata.name=chatllm-api-keys`
    const handle = built.watch.active.get(watchKey)
    handle!.emit('DELETED', {
      metadata: { name: 'chatllm-api-keys' },
      data: { 'openai-api-key': 'sk-openai' },
    })

    expect(store.isLlmKeyConfigured()).toBe(false)
    expect(store.llmKey()).toBeNull()
  })

  it('reconnects on watch disconnect', async () => {
    vi.useFakeTimers()
    try {
      const built = build({
        provider: 'openai',
        secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk-old' } },
      })
      store = built.store
      await store.start()

      expect(built.watch.watch).toHaveBeenCalledTimes(3)

      const watchKey = `/api/v1/namespaces/mcp-host/secrets|metadata.name=chatllm-api-keys`
      const handle = built.watch.active.get(watchKey)
      handle!.fail(new Error('connection reset'))

      // Initial backoff is 500 ms
      await vi.advanceTimersByTimeAsync(500)

      expect(built.watch.watch).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports the four reserved provider env names', () => {
    expect(PROVIDER_ENV_NAMES.has('OPENAI_API_KEY')).toBe(true)
    expect(PROVIDER_ENV_NAMES.has('CLAUDE_API_KEY')).toBe(true)
    expect(PROVIDER_ENV_NAMES.has('ZAI_API_KEY')).toBe(true)
    expect(PROVIDER_ENV_NAMES.has('BAILIAN_API_KEY')).toBe(true)
    expect(PROVIDER_ENV_NAMES.size).toBe(ALL_PROVIDERS.length)
  })

  it('snapshot exposes effective merged env vars', async () => {
    const built = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
        'host-trader-env-secret': { GITHUB_TOKEN: 'ghp_x' },
      },
      configMaps: { 'host-trader-env': { FEATURE_FLAG: '1' } },
    })
    store = built.store
    await store.start()

    const snap = store.snapshot()
    expect(snap).toEqual({
      OPENAI_API_KEY: 'sk-openai',
      GITHUB_TOKEN: 'ghp_x',
      FEATURE_FLAG: '1',
    })
  })

  it('userEnvSnapshot omits the LLM provider key (security boundary)', async () => {
    const built = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
        'host-trader-env-secret': { GITHUB_TOKEN: 'ghp_x' },
      },
      configMaps: { 'host-trader-env': { FEATURE_FLAG: '1' } },
    })
    store = built.store
    await store.start()

    const userEnv = store.userEnvSnapshot()
    expect(userEnv).toEqual({
      GITHUB_TOKEN: 'ghp_x',
      FEATURE_FLAG: '1',
    })
    expect(userEnv).not.toHaveProperty('OPENAI_API_KEY')
  })

  it('userEnvSnapshot omits the provider key for every supported provider', async () => {
    for (const [provider, secretKey, envName, value] of [
      ['openai', 'openai-api-key', 'OPENAI_API_KEY', 'sk-openai'],
      ['claude', 'claude-api-key', 'CLAUDE_API_KEY', 'sk-ant-claude'],
      ['zai', 'zai-api-key', 'ZAI_API_KEY', 'zai-secret'],
      ['bailian', 'bailian-api-key', 'BAILIAN_API_KEY', 'bailian-secret'],
    ] as const) {
      const built = build({
        provider,
        secrets: {
          'chatllm-api-keys': { [secretKey]: value },
        },
        configMaps: {},
      })
      const s = built.store
      await s.start()
      const userEnv = s.userEnvSnapshot()
      expect(userEnv, `provider=${provider}`).not.toHaveProperty(envName)
      s.stop()
    }
  })
})
