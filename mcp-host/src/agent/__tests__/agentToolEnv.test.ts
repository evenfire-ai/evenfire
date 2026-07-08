import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore, PROVIDER_ENV_NAME, PROVIDER_ENV_NAMES } from '../../config/configStore'
import { ALL_PROVIDERS, type LlmProvider } from '../../llm/registryCore'
import { agentToolEnvProvider } from '../agentToolEnv'

// ─── Test doubles ─────────────────────────────────────────────────────
// Mirror config/configStore.test.ts so we exercise a REAL ConfigStore: the
// boundary we lock here is the difference between snapshot() and
// userEnvSnapshot(), which only a real store can demonstrate.

interface FakeWatchHandle {
  abort: () => void
}

function makeFakeWatch(): { watch: ReturnType<typeof vi.fn> } {
  const watch = vi.fn(
    async (
      path: string,
      params: { fieldSelector?: string },
      _onEvent: (type: string, obj: unknown) => void,
      _onDone: (err: Error | null | undefined) => void
    ) => {
      const handle: FakeWatchHandle = { abort: () => undefined }
      void path
      void params
      return { abort: handle.abort }
    }
  )
  return { watch }
}

function makeFakeCoreApi(initial: {
  secrets?: Record<string, Record<string, string>>
  configMaps?: Record<string, Record<string, string>>
}) {
  const secrets = { ...(initial.secrets ?? {}) }
  const configMaps = { ...(initial.configMaps ?? {}) }
  return {
    readNamespacedSecret: vi.fn(async (req: { name: string }) => {
      const data = secrets[req.name]
      if (!data) throw { code: 404, statusCode: 404 }
      return { data }
    }),
    readNamespacedConfigMap: vi.fn(async (req: { name: string }) => {
      const data = configMaps[req.name]
      if (!data) throw { code: 404, statusCode: 404 }
      return { data }
    }),
  }
}

function build(opts: {
  provider: LlmProvider
  secrets?: Record<string, Record<string, string>>
  configMaps?: Record<string, Record<string, string>>
}): ConfigStore {
  const watch = makeFakeWatch()
  const api = makeFakeCoreApi({ secrets: opts.secrets, configMaps: opts.configMaps })
  return new ConfigStore({
    namespace: 'mcp-host',
    hostRef: 'trader',
    llmSecretRef: 'chatllm-api-keys',
    provider: opts.provider,
    coreApi: api as unknown as ConstructorParameters<typeof ConfigStore>[0]['coreApi'],
    watch: watch as unknown as ConstructorParameters<typeof ConfigStore>[0]['watch'],
  })
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('agentToolEnvProvider', () => {
  let store: ConfigStore | null = null

  afterEach(() => {
    store?.stop()
    store = null
  })

  it('exposes non-provider secrets but NEVER the provider API key (catches snapshot() regression)', async () => {
    store = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
        'host-trader-env-secret': { GITHUB_TOKEN: 'ghp_secret' },
      },
    })
    await store.start()

    const toolEnv = agentToolEnvProvider(store)
    // Non-provider secret must flow through to tool subprocesses.
    expect(toolEnv.GITHUB_TOKEN).toBe('ghp_secret')
    // Provider API key must NOT be in the tool env.
    expect(toolEnv).not.toHaveProperty('OPENAI_API_KEY')

    // Prove the difference is real: snapshot() DOES carry the provider key, so a
    // regression that wires agentToolEnvProvider to snapshot() would fail above.
    const full = store.snapshot()
    expect(full.OPENAI_API_KEY).toBe('sk-openai')
    expect(full.GITHUB_TOKEN).toBe('ghp_secret')
  })

  it.each(ALL_PROVIDERS)(
    'redacts the provider env var for every provider (registry-derived): %s',
    async provider => {
      const dataKey = `${provider}-api-key`
      store = build({
        provider,
        secrets: {
          'chatllm-api-keys': { [dataKey]: `secret-${provider}` },
        },
      })
      await store.start()

      const toolEnv = agentToolEnvProvider(store)
      // The configured provider's env-var name (derived from the registry) is gone.
      expect(toolEnv).not.toHaveProperty(PROVIDER_ENV_NAME[provider])
      // Defense-in-depth: none of the four known provider env names leak either.
      for (const envName of PROVIDER_ENV_NAMES) {
        expect(toolEnv, `provider=${provider} leaked ${envName}`).not.toHaveProperty(envName)
      }
    }
  )

  it('returns {} for null/undefined store', () => {
    expect(agentToolEnvProvider(null)).toEqual({})
    expect(agentToolEnvProvider(undefined)).toEqual({})
  })
})
