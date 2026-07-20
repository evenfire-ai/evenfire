import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from './configStore'

// ─── Minimal test doubles (mirrors configStore.test.ts) ────────────────

function makeFakeWatch() {
  return {
    watch: vi.fn(async () => ({ abort: () => {} })),
  }
}

function makeFakeCoreApi(secrets: Record<string, Record<string, string>>) {
  return {
    readNamespacedSecret: vi.fn(async (req: { name: string }) => {
      const data = secrets[req.name]
      if (!data) throw { code: 404, statusCode: 404 }
      return { data }
    }),
    readNamespacedConfigMap: vi.fn(async () => {
      throw { code: 404, statusCode: 404 }
    }),
  }
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64')
}

function build(opts: {
  provider: 'claude' | 'openai'
  secretData: Record<string, string>
  fallbackCredentialSlots?: string[]
}): ConfigStore {
  const api = makeFakeCoreApi({ 'chatllm-api-keys': opts.secretData })
  const watch = makeFakeWatch()
  return new ConfigStore({
    namespace: 'mcp-host',
    hostRef: 'trader',
    llmSecretRef: 'chatllm-api-keys',
    provider: opts.provider,
    allowlistConfigMapName: null,
    fallbackCredentialSlots: opts.fallbackCredentialSlots,
    coreApi: api as unknown as ConstructorParameters<typeof ConfigStore>[0]['coreApi'],
    watch: watch as unknown as ConstructorParameters<typeof ConfigStore>[0]['watch'],
  })
}

describe('ConfigStore — R5 fallback credential slots', () => {
  let store: ConfigStore | null = null
  afterEach(() => {
    store?.stop()
    store = null
  })

  it('exposes a fallback slot value via fallbackSlotValue, but NEVER via the env snapshots (leak test)', async () => {
    store = build({
      provider: 'claude',
      secretData: {
        'claude-api-key': b64('PRIMARY-KEY'),
        'claude-api-key-fb1': b64('FALLBACK-KEY'),
        'openai-api-key': b64('CROSS-PROVIDER-KEY'),
      },
      // Same-provider-other-key + a cross-provider fallback.
      fallbackCredentialSlots: ['claude-api-key-fb1', 'openai-api-key'],
    })
    await store.start()

    // Readable by the fallback provider factory…
    expect(store.fallbackSlotValue('claude-api-key-fb1')).toBe('FALLBACK-KEY')
    expect(store.fallbackSlotValue('openai-api-key')).toBe('CROSS-PROVIDER-KEY')

    // …but NEVER merged into the effective env (would reach a tool subprocess).
    const userEnv = store.userEnvSnapshot()
    const full = store.snapshot()
    for (const bag of [userEnv, full]) {
      const values = Object.values(bag)
      expect(values).not.toContain('FALLBACK-KEY')
      expect(values).not.toContain('CROSS-PROVIDER-KEY')
    }
    // The active primary key is also excluded from the user (subprocess) env.
    expect(Object.values(userEnv)).not.toContain('PRIMARY-KEY')
  })

  it('redacts fallback slot values from tool output (defense in depth)', async () => {
    store = build({
      provider: 'claude',
      secretData: {
        'claude-api-key': b64('PRIMARY-KEY'),
        'claude-api-key-fb1': b64('FALLBACK-KEY'),
      },
      fallbackCredentialSlots: ['claude-api-key-fb1'],
    })
    await store.start()
    expect(store.listSecretValues()).toContain('FALLBACK-KEY')
    expect(store.listSecretEntries().some(e => e.value === 'FALLBACK-KEY')).toBe(true)
  })

  it('returns undefined for a referenced slot absent from the Secret', async () => {
    store = build({
      provider: 'claude',
      secretData: { 'claude-api-key': b64('PRIMARY-KEY') },
      fallbackCredentialSlots: ['claude-api-key-fb1'],
    })
    await store.start()
    expect(store.fallbackSlotValue('claude-api-key-fb1')).toBeUndefined()
  })

  it('is inert when no fallback slots are configured (byte-identical)', async () => {
    store = build({
      provider: 'claude',
      secretData: { 'claude-api-key': b64('PRIMARY-KEY') },
    })
    await store.start()
    expect(store.fallbackSlotValue('claude-api-key-fb1')).toBeUndefined()
    expect(store.listSecretValues()).toEqual(['PRIMARY-KEY'])
  })
})
