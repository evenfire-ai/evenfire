import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore, PROVIDER_ENV_NAMES } from '../../config/configStore'
import { ALL_PROVIDERS, type LlmProvider, descriptorFor } from '../../llm/registryCore'
import { agentToolEnvProvider } from '../agentToolEnv'

/** Build a full, valid secret payload for a provider from its registry slots. */
function secretForProvider(provider: LlmProvider): Record<string, string> {
  const data: Record<string, string> = {}
  for (const slot of descriptorFor(provider).credentialSlots) {
    data[slot.dataKey] = `secret-${slot.dataKey}`
  }
  return data
}

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
    'redacts EVERY credential slot env var for every provider (registry-derived): %s',
    async provider => {
      store = build({
        provider,
        secrets: { 'chatllm-api-keys': secretForProvider(provider) },
      })
      await store.start()

      const toolEnv = agentToolEnvProvider(store)
      // Every slot of the configured provider must be gone (multi-slot: Bedrock
      // has TWO — both must be absent, not just the primary).
      for (const slot of descriptorFor(provider).credentialSlots) {
        expect(toolEnv, `provider=${provider} leaked ${slot.envName}`).not.toHaveProperty(
          slot.envName
        )
      }
      // Defense-in-depth: NONE of the known provider slot env names leak.
      for (const envName of PROVIDER_ENV_NAMES) {
        expect(toolEnv, `provider=${provider} leaked ${envName}`).not.toHaveProperty(envName)
      }
    }
  )

  it('leak test — N credentials of DIFFERENT providers present, only one active: none reach the subprocess', async () => {
    // The Secret carries credentials for four providers simultaneously: openai +
    // claude API keys, the Vertex service-account JSON, and BOTH Bedrock AWS
    // keys. Only `bedrock` is the active provider. The boundary must exclude
    // every provider credential (spec §3-R4.3), not just the active one's.
    store = build({
      provider: 'bedrock',
      secrets: {
        'chatllm-api-keys': {
          'openai-api-key': 'sk-openai',
          'claude-api-key': 'sk-ant-claude',
          'vertex-service-account-json': '{"client_email":"x","private_key":"y"}',
          'aws-access-key-id': 'AKIAEXAMPLE',
          'aws-secret-access-key': 'aws-secret-value',
        },
        'host-trader-env-secret': { GITHUB_TOKEN: 'ghp_secret' },
      },
    })
    await store.start()

    const toolEnv = agentToolEnvProvider(store)
    // Non-provider secret still flows through.
    expect(toolEnv.GITHUB_TOKEN).toBe('ghp_secret')
    // Not one provider credential env name — for ANY provider — is present.
    for (const envName of PROVIDER_ENV_NAMES) {
      expect(toolEnv, `leaked ${envName}`).not.toHaveProperty(envName)
    }
    // And no credential VALUE leaks under any key either.
    const values = Object.values(toolEnv)
    for (const secret of [
      'sk-openai',
      'sk-ant-claude',
      'AKIAEXAMPLE',
      'aws-secret-value',
      '{"client_email":"x","private_key":"y"}',
    ]) {
      expect(values, `leaked value ${secret}`).not.toContain(secret)
    }
  })

  it('excludes a provider credential env name even when injected via a NON-llm tier (registry-wide RESERVED)', async () => {
    // A misconfiguration/attack puts a provider credential env NAME into the
    // per-Host env secret while a DIFFERENT provider is active. The registry
    // half of the boundary (RESERVED_SECRET_ENV_NAMES) must still strip it —
    // the exclusion is registry-wide, not "active provider only".
    store = build({
      provider: 'openai',
      secrets: {
        'chatllm-api-keys': { 'openai-api-key': 'sk-openai' },
        'host-trader-env-secret': {
          AWS_SECRET_ACCESS_KEY: 'sneaky-aws-secret',
          CLAUDE_API_KEY: 'sneaky-claude',
          GITHUB_TOKEN: 'ghp_secret',
        },
      },
    })
    await store.start()

    const toolEnv = agentToolEnvProvider(store)
    expect(toolEnv.GITHUB_TOKEN).toBe('ghp_secret')
    // Injected provider credential names are stripped despite coming from the
    // host-secret tier, not the active provider's llm-secret slots.
    expect(toolEnv).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(toolEnv).not.toHaveProperty('CLAUDE_API_KEY')
    expect(Object.values(toolEnv)).not.toContain('sneaky-aws-secret')
    expect(Object.values(toolEnv)).not.toContain('sneaky-claude')
  })

  it('returns {} for null/undefined store', () => {
    expect(agentToolEnvProvider(null)).toEqual({})
    expect(agentToolEnvProvider(undefined)).toEqual({})
  })
})
