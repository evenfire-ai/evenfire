import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import { ALL_PROVIDERS, descriptorFor } from '../llm/registryCore'
import {
  CATALOG_REVISION_ANNOTATION,
  CONNECTION_REVISION_ANNOTATION,
  ConfigStore,
  PROVIDER_ENV_NAMES,
} from './configStore'

const ALLOWLIST_CM = 'clerum-llm-allowed-models'
const ALLOWLIST_WATCH_KEY = `/api/v1/namespaces/mcp-host/configmaps|metadata.name=${ALLOWLIST_CM}`

async function counterValue(name: string): Promise<number> {
  const metric = register.getSingleMetric(name)
  if (!metric) return 0
  const data = await metric.get()
  return data.values.reduce((sum, v) => sum + v.value, 0)
}

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
  configMapAnnotations?: Record<string, Record<string, string>>
}): FakeCoreApi {
  const secrets = { ...(initial.secrets ?? {}) }
  const configMaps = { ...(initial.configMaps ?? {}) }
  const configMapAnnotations = { ...(initial.configMapAnnotations ?? {}) }
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
      return {
        data,
        metadata: { name: req.name, annotations: configMapAnnotations[req.name] },
      }
    }),
  }
}

function build(opts: {
  llmSecretRef?: string | null
  provider?: 'openai' | 'claude' | 'zai' | 'bailian' | 'codex-subscription' | null
  connectionRef?: string | null
  secrets?: Record<string, Record<string, string>>
  configMaps?: Record<string, Record<string, string>>
  configMapAnnotations?: Record<string, Record<string, string>>
  allowlistConfigMapName?: string | null
}): { store: ConfigStore; watch: FakeWatch; api: FakeCoreApi } {
  const watch = makeFakeWatch()
  const api = makeFakeCoreApi({
    secrets: opts.secrets,
    configMaps: opts.configMaps,
    configMapAnnotations: opts.configMapAnnotations,
  })
  const store = new ConfigStore({
    namespace: 'mcp-host',
    hostRef: 'trader',
    llmSecretRef: opts.llmSecretRef ?? 'chatllm-api-keys',
    provider: opts.provider ?? 'openai',
    connectionRef: opts.connectionRef,
    allowlistConfigMapName: opts.allowlistConfigMapName,
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
    expect(handler).toHaveBeenCalledWith({
      llmKeyChanged: true,
      envChanged: false,
      allowlistChanged: false,
    })
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
    expect(handler).toHaveBeenCalledWith({
      llmKeyChanged: false,
      envChanged: true,
      allowlistChanged: false,
    })
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

  it('exports every provider credential slot env name (all slots, all providers)', () => {
    expect(PROVIDER_ENV_NAMES.has('OPENAI_API_KEY')).toBe(true)
    expect(PROVIDER_ENV_NAMES.has('CLAUDE_API_KEY')).toBe(true)
    expect(PROVIDER_ENV_NAMES.has('ZAI_API_KEY')).toBe(true)
    expect(PROVIDER_ENV_NAMES.has('BAILIAN_API_KEY')).toBe(true)
    // Multi-slot (R4): Vertex's JSON slot and Bedrock's TWO AWS key slots.
    expect(PROVIDER_ENV_NAMES.has('VERTEX_SERVICE_ACCOUNT_JSON')).toBe(true)
    expect(PROVIDER_ENV_NAMES.has('AWS_ACCESS_KEY_ID')).toBe(true)
    expect(PROVIDER_ENV_NAMES.has('AWS_SECRET_ACCESS_KEY')).toBe(true)
    // One entry per credential slot across every provider (Bedrock = 2).
    const totalSlots = ALL_PROVIDERS.reduce(
      (n, p) => n + descriptorFor(p).credentialSlots.length,
      0
    )
    expect(PROVIDER_ENV_NAMES.size).toBe(totalSlots)
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

// ─── Allowlist tier (R3) ──────────────────────────────────────────────
// The allowlist CM `data` fixtures below mirror control-api buildConfigMapData
// (control-api/src/services/llmAllowedModelsConfigMap.ts) — keep in sync.

describe('ConfigStore — allowlist tier (R3)', () => {
  let store: ConfigStore | null = null

  afterEach(() => {
    store?.stop()
    store = null
  })

  it('is disabled (no 4th watch, unavailable) when no CM name is configured', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      // allowlistConfigMapName omitted → tier disabled
    })
    store = built.store
    await store.start()

    // Only the 3 existing tiers watch.
    expect(built.watch.watch).toHaveBeenCalledTimes(3)
    expect(store.allowlistAvailable()).toBe(false)
    expect(store.allowedModels().size).toBe(0)
  })

  it('bootstraps the allowlist and exposes per-provider entries', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {
        [ALLOWLIST_CM]: {
          openai: JSON.stringify([
            {
              model: 'gpt-5.4',
              displayName: 'GPT 5.4',
              contextWindowTokens: 400000,
              vendor: 'OpenAI',
            },
          ]),
          claude: JSON.stringify([{ model: 'claude-opus-4-8' }]),
        },
      },
    })
    store = built.store
    await store.start()

    // 4th watch is now active.
    expect(built.watch.watch).toHaveBeenCalledTimes(4)
    expect(store.allowlistAvailable()).toBe(true)
    expect(store.allowedModels().get('openai')).toEqual([
      { model: 'gpt-5.4', displayName: 'GPT 5.4', contextWindowTokens: 400000, vendor: 'OpenAI' },
    ])
    expect(store.allowedModels().get('claude')).toEqual([{ model: 'claude-opus-4-8' }])
    expect(store.codexPolicyBinding()).toBeNull()
  })

  it('exposes Codex catalog/credential revisions from allowlist annotations', async () => {
    const built = build({
      provider: 'openai',
      connectionRef: 'deployment-default',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {
        [ALLOWLIST_CM]: { openai: JSON.stringify([{ model: 'gpt-5.4' }]) },
      },
      configMapAnnotations: {
        [ALLOWLIST_CM]: {
          [CATALOG_REVISION_ANNOTATION]: '7',
          [CONNECTION_REVISION_ANNOTATION]: '3',
        },
      },
    })
    store = built.store
    await store.start()

    expect(store.codexPolicyBinding()).toEqual({
      catalogRevision: 7,
      credentialRevision: 3,
      connectionKey: 'deployment-default',
    })

    const handle = built.watch.active.get(ALLOWLIST_WATCH_KEY)
    expect(handle).toBeDefined()
    handle!.emit('MODIFIED', {
      metadata: {
        name: ALLOWLIST_CM,
        annotations: {
          [CATALOG_REVISION_ANNOTATION]: '8',
          [CONNECTION_REVISION_ANNOTATION]: '3',
        },
      },
      data: { openai: JSON.stringify([{ model: 'gpt-5.4' }]) },
    })
    expect(store.codexPolicyBinding()).toEqual({
      catalogRevision: 8,
      credentialRevision: 3,
      connectionKey: 'deployment-default',
    })

    handle!.emit('DELETED', { metadata: { name: ALLOWLIST_CM } })
    expect(store.codexPolicyBinding()).toBeNull()
  })

  it('hot-reloads: a MODIFIED event makes the new allowlist visible + fires allowlistChanged', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {
        [ALLOWLIST_CM]: { openai: JSON.stringify([{ model: 'gpt-5.4' }]) },
      },
    })
    store = built.store
    const handler = vi.fn()
    store.onChange(handler)
    await store.start()

    expect(store.allowedModels().get('openai')).toEqual([{ model: 'gpt-5.4' }])

    const handle = built.watch.active.get(ALLOWLIST_WATCH_KEY)
    expect(handle).toBeDefined()
    handle!.emit('MODIFIED', {
      metadata: { name: ALLOWLIST_CM },
      data: { openai: JSON.stringify([{ model: 'gpt-5.4' }, { model: 'gpt-6' }]) },
    })

    expect(store.allowedModels().get('openai')).toEqual([{ model: 'gpt-5.4' }, { model: 'gpt-6' }])
    expect(handler).toHaveBeenCalledWith({
      llmKeyChanged: false,
      envChanged: false,
      allowlistChanged: true,
    })
  })

  it('does NOT re-fire allowlistChanged when a byte-identical CM is re-delivered', async () => {
    const payload = { openai: JSON.stringify([{ model: 'gpt-5.4', displayName: 'GPT 5.4' }]) }
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: { [ALLOWLIST_CM]: { ...payload } },
    })
    store = built.store
    await store.start()
    const handler = vi.fn()
    store.onChange(handler)

    const handle = built.watch.active.get(ALLOWLIST_WATCH_KEY)
    // Re-deliver the exact same content (routine watch churn / reconnect replay).
    handle!.emit('MODIFIED', { metadata: { name: ALLOWLIST_CM }, data: { ...payload } })
    handle!.emit('ADDED', { metadata: { name: ALLOWLIST_CM }, data: { ...payload } })

    expect(handler).not.toHaveBeenCalled()

    // A real content change still fires.
    handle!.emit('MODIFIED', {
      metadata: { name: ALLOWLIST_CM },
      data: { openai: JSON.stringify([{ model: 'gpt-5.4' }, { model: 'gpt-6' }]) },
    })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({
      llmKeyChanged: false,
      envChanged: false,
      allowlistChanged: true,
    })
  })

  it('CM absent (404) → allowlistAvailable false + increments the missing metric', async () => {
    const before = await counterValue('clerum_llm_allowlist_missing_total')
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {}, // CM does not exist
    })
    store = built.store
    await store.start()

    expect(store.allowlistAvailable()).toBe(false)
    expect(store.allowedModels().size).toBe(0)
    const after = await counterValue('clerum_llm_allowlist_missing_total')
    expect(after).toBe(before + 1)
  })

  it('DELETED event flips back to unavailable and fires allowlistChanged', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: { [ALLOWLIST_CM]: { openai: JSON.stringify([{ model: 'gpt-5.4' }]) } },
    })
    store = built.store
    await store.start()
    expect(store.allowlistAvailable()).toBe(true)

    const handler = vi.fn()
    store.onChange(handler)
    const handle = built.watch.active.get(ALLOWLIST_WATCH_KEY)
    handle!.emit('DELETED', { metadata: { name: ALLOWLIST_CM } })

    expect(store.allowlistAvailable()).toBe(false)
    expect(store.allowedModels().size).toBe(0)
    expect(handler).toHaveBeenCalledWith({
      llmKeyChanged: false,
      envChanged: false,
      allowlistChanged: true,
    })
  })

  it('isolates a provider key with invalid JSON — other keys still parse', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A distinctive raw value that must NOT surface in the log (a V8 SyntaxError
    // can embed a snippet of the offending value — see the no-log-value policy).
    const badValue = '{ not valid json SECRETish-snippet'
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {
        [ALLOWLIST_CM]: {
          openai: badValue,
          claude: JSON.stringify([{ model: 'claude-opus-4-8' }]),
        },
      },
    })
    store = built.store
    await store.start()

    // The CM is delivered (available), but the bad key is dropped.
    expect(store.allowlistAvailable()).toBe(true)
    expect(store.allowedModels().has('openai')).toBe(false)
    expect(store.allowedModels().get('claude')).toEqual([{ model: 'claude-opus-4-8' }])

    // The corrupt-key event logs the key at ERROR but never the raw value.
    const logged = errorSpy.mock.calls.flat().join(' ')
    expect(logged).toContain("allowlist key 'openai'")
    expect(logged).not.toContain('SECRETish-snippet')
    errorSpy.mockRestore()
  })

  it('drops malformed entries (non-object / missing model) but keeps valid ones', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {
        [ALLOWLIST_CM]: {
          openai: JSON.stringify(['not-an-object', { noModel: true }, { model: 'gpt-5.4' }]),
          zai: JSON.stringify({ not: 'an-array' }),
        },
      },
    })
    store = built.store
    await store.start()

    expect(store.allowedModels().get('openai')).toEqual([{ model: 'gpt-5.4' }])
    // Non-array value for a key is skipped entirely.
    expect(store.allowedModels().has('zai')).toBe(false)
  })

  it('re-warns/re-increments the missing metric only on transitions', async () => {
    const built = build({
      provider: 'openai',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: { [ALLOWLIST_CM]: { openai: JSON.stringify([{ model: 'gpt-5.4' }]) } },
    })
    store = built.store
    await store.start()

    const handle = built.watch.active.get(ALLOWLIST_WATCH_KEY)
    const before = await counterValue('clerum_llm_allowlist_missing_total')

    // First DELETE → one increment.
    handle!.emit('DELETED', { metadata: { name: ALLOWLIST_CM } })
    // A second DELETE without an intervening ADD must NOT re-increment.
    handle!.emit('DELETED', { metadata: { name: ALLOWLIST_CM } })
    expect(await counterValue('clerum_llm_allowlist_missing_total')).toBe(before + 1)

    // Re-add, then delete again → a fresh transition re-increments.
    handle!.emit('MODIFIED', {
      metadata: { name: ALLOWLIST_CM },
      data: { openai: JSON.stringify([{ model: 'gpt-5.4' }]) },
    })
    expect(store.allowlistAvailable()).toBe(true)
    handle!.emit('DELETED', { metadata: { name: ALLOWLIST_CM } })
    expect(await counterValue('clerum_llm_allowlist_missing_total')).toBe(before + 2)
  })

  it('filters Codex models to the assigned grant catalog, not the union', async () => {
    const built = build({
      provider: 'codex-subscription',
      connectionRef: 'personal-pro',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {
        [ALLOWLIST_CM]: {
          'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex' }, { model: 'gpt-5.1' }]),
        },
      },
      configMapAnnotations: {
        [ALLOWLIST_CM]: {
          'clerum.io/catalog-revision': '4',
          'clerum.io/connection-revision': '2',
          'clerum.io/codex-connections': JSON.stringify({
            'personal-pro': {
              catalogRevision: 4,
              connectionRevision: 2,
              models: ['gpt-5.1'],
            },
            'team-plus': {
              catalogRevision: 3,
              connectionRevision: 8,
              models: ['gpt-5.3-codex'],
            },
          }),
        },
      },
    })
    store = built.store
    await store.start()
    expect(store.allowedModels().get('codex-subscription')).toEqual([{ model: 'gpt-5.1' }])
    expect(store.codexPolicyBinding()?.connectionKey).toBe('personal-pro')
    expect(store.codexPolicyBinding()?.models).toEqual(['gpt-5.1'])
  })

  it('does not inherit another grant when the assigned connection is missing from the map', async () => {
    const built = build({
      provider: 'codex-subscription',
      connectionRef: 'ghost-grant',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {
        [ALLOWLIST_CM]: {
          'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex' }]),
        },
      },
      configMapAnnotations: {
        [ALLOWLIST_CM]: {
          'clerum.io/catalog-revision': '4',
          'clerum.io/connection-revision': '2',
          'clerum.io/codex-connections': JSON.stringify({
            'personal-pro': {
              catalogRevision: 4,
              connectionRevision: 2,
              models: ['gpt-5.3-codex'],
            },
          }),
        },
      },
    })
    store = built.store
    await store.start()
    expect(store.codexPolicyBinding()).toBeNull()
    expect(store.allowedModels().get('codex-subscription')).toEqual([])
  })

  it('does not inherit deployment-default when the Host has no connectionRef', async () => {
    const built = build({
      provider: 'codex-subscription',
      secrets: { 'chatllm-api-keys': { 'openai-api-key': 'sk' } },
      allowlistConfigMapName: ALLOWLIST_CM,
      configMaps: {
        [ALLOWLIST_CM]: {
          'codex-subscription': JSON.stringify([{ model: 'gpt-5.3-codex' }]),
        },
      },
      configMapAnnotations: {
        [ALLOWLIST_CM]: {
          'clerum.io/catalog-revision': '4',
          'clerum.io/connection-revision': '2',
          'clerum.io/codex-connections': JSON.stringify({
            'deployment-default': {
              catalogRevision: 4,
              connectionRevision: 2,
              models: ['gpt-5.3-codex'],
            },
          }),
        },
      },
    })
    store = built.store
    await store.start()
    expect(store.codexPolicyBinding()).toBeNull()
    expect(store.allowedModels().get('codex-subscription')).toEqual([])
  })
})
