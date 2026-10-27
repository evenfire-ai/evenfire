/**
 * Non-secret provider env set under Control UI Host → Environment lands in the
 * per-Host `host-<ref>-env` ConfigMap / `-env-secret` Secret, which HCC does NOT
 * `envFrom` into the pod — mcp-host only sees it through ConfigStore. These
 * tests prove the drivers resolve it from there (mirroring main.ts's
 * `hostProviderEnv` wiring), that only declared names flow, and that a Host →
 * Environment edit is detected for the provider rebuild.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../../config/configStore'
import { buildBedrockClientConfig } from '../drivers/bedrockConverse'
import { buildVertexClientOptions } from '../drivers/googleGenerative'
import { createLLMProvider } from '../index'
import {
  createProviderEnvChangeDetector,
  processEnvLookup,
  providerEnvLookup,
} from '../providerEnv'
import type { LlmProvider } from '../registryCore'

const ENV_NAMES = [
  'AWS_REGION',
  'VERTEX_PROJECT_ID',
  'VERTEX_LOCATION',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_VERSION',
] as const

interface FakeWatchHandle {
  emit: (type: string, obj: unknown) => void
}

function makeFakeWatch() {
  const active = new Map<string, FakeWatchHandle>()
  return {
    active,
    watch: vi.fn(
      async (
        path: string,
        params: { fieldSelector?: string },
        onEvent: (type: string, obj: unknown) => void
      ) => {
        active.set(`${path}|${params.fieldSelector ?? ''}`, { emit: onEvent })
        return { abort: () => {} }
      }
    ),
  }
}

function makeFakeCoreApi(
  secrets: Record<string, Record<string, string>>,
  configMaps: Record<string, Record<string, string>>
) {
  const notFound = () => {
    const err: { code?: number } = { code: 404 }
    throw err
  }
  return {
    readNamespacedSecret: vi.fn(async (req: { name: string }) =>
      secrets[req.name] ? { data: secrets[req.name] } : notFound()
    ),
    readNamespacedConfigMap: vi.fn(async (req: { name: string }) =>
      configMaps[req.name] ? { data: configMaps[req.name] } : notFound()
    ),
  }
}

const SA_JSON_NO_PROJECT = JSON.stringify({
  client_email: 'svc@example.iam.gserviceaccount.com',
  // Placeholder only — the driver checks presence, never parses the key.
  private_key: 'test-placeholder-not-a-real-key',
})

describe('per-Host env (Host → Environment) reaches the provider drivers', () => {
  let store: ConfigStore | null = null
  const saved: Record<string, string | undefined> = {}
  let watch: ReturnType<typeof makeFakeWatch>

  beforeEach(() => {
    for (const n of ENV_NAMES) {
      saved[n] = process.env[n]
      delete process.env[n]
    }
    watch = makeFakeWatch()
  })

  afterEach(() => {
    store?.stop()
    store = null
    for (const n of ENV_NAMES) {
      if (saved[n] === undefined) delete process.env[n]
      else process.env[n] = saved[n]
    }
  })

  async function startStore(
    provider: LlmProvider,
    llmSecret: Record<string, string>,
    hostEnv: Record<string, string>,
    hostEnvSecret?: Record<string, string>
  ): Promise<ConfigStore> {
    const secrets: Record<string, Record<string, string>> = { 'chatllm-api-keys': llmSecret }
    if (hostEnvSecret) secrets['host-trader-env-secret'] = hostEnvSecret
    store = new ConfigStore({
      namespace: 'mcp-host',
      hostRef: 'trader',
      llmSecretRef: 'chatllm-api-keys',
      provider,
      coreApi: makeFakeCoreApi(secrets, { 'host-trader-env': hostEnv }) as never,
      watch: watch as never,
    })
    await store.start()
    return store
  }

  /** Mirrors main.ts `hostProviderEnv` + `createLLMProvider` wiring. */
  function buildFromStore(s: ConfigStore, provider: LlmProvider, model: string) {
    const llm = s.llmCredentials()!
    return createLLMProvider(
      { [llm.provider]: llm.credentials },
      { provider, name: model },
      { env: providerEnvLookup(provider, name => s.get(name)) }
    )
  }

  it('bedrock: AWS_REGION set only in host-<ref>-env constructs the provider', async () => {
    const s = await startStore(
      'bedrock',
      { 'aws-access-key-id': 'AKIAEXAMPLE', 'aws-secret-access-key': 'secret-example' },
      { AWS_REGION: 'eu-west-1' }
    )
    expect(buildFromStore(s, 'bedrock', 'anthropic.claude-3-5-sonnet')).not.toBeNull()
    expect(
      buildBedrockClientConfig(
        { 'aws-access-key-id': 'AKIAEXAMPLE', 'aws-secret-access-key': 'secret-example' },
        providerEnvLookup('bedrock', name => s.get(name))
      ).region
    ).toBe('eu-west-1')
  })

  it('bedrock: without an env source the region is still only read from process.env', async () => {
    const s = await startStore(
      'bedrock',
      { 'aws-access-key-id': 'AKIAEXAMPLE', 'aws-secret-access-key': 'secret-example' },
      { AWS_REGION: 'eu-west-1' }
    )
    const llm = s.llmCredentials()!
    expect(
      createLLMProvider({ [llm.provider]: llm.credentials }, { provider: 'bedrock', name: 'm' })
    ).toBeNull()
  })

  it('vertex: VERTEX_PROJECT_ID/VERTEX_LOCATION from host env (secret tier wins over CM)', async () => {
    const s = await startStore(
      'vertex',
      { 'vertex-service-account-json': SA_JSON_NO_PROJECT },
      { VERTEX_PROJECT_ID: 'proj-cm', VERTEX_LOCATION: 'europe-west4' },
      { VERTEX_PROJECT_ID: 'proj-secret' }
    )
    const opts = buildVertexClientOptions(
      { 'vertex-service-account-json': SA_JSON_NO_PROJECT },
      providerEnvLookup('vertex', name => s.get(name))
    )
    expect(opts.project).toBe('proj-secret')
    expect(opts.location).toBe('europe-west4')
    expect(buildFromStore(s, 'vertex', 'gemini-2.5-pro')).not.toBeNull()
  })

  it('azure: AZURE_OPENAI_ENDPOINT from host env constructs the provider', async () => {
    const s = await startStore(
      'azure',
      { 'azure-openai-api-key': 'az-key' },
      { AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com/' }
    )
    expect(buildFromStore(s, 'azure', 'my-deployment')).not.toBeNull()
  })

  it('falls back to process.env when the host env does not set the name', async () => {
    process.env.AWS_REGION = 'us-east-2'
    const s = await startStore(
      'bedrock',
      { 'aws-access-key-id': 'AKIAEXAMPLE', 'aws-secret-access-key': 'secret-example' },
      {}
    )
    expect(
      buildBedrockClientConfig(
        { 'aws-access-key-id': 'AKIAEXAMPLE', 'aws-secret-access-key': 'secret-example' },
        providerEnvLookup('bedrock', name => s.get(name))
      ).region
    ).toBe('us-east-2')
  })

  it('only the provider-declared non-secret names resolve through the lookup', async () => {
    const s = await startStore(
      'bedrock',
      { 'aws-access-key-id': 'AKIAEXAMPLE', 'aws-secret-access-key': 'secret-example' },
      { AWS_REGION: 'eu-west-1', VERTEX_PROJECT_ID: 'proj' },
      { GITHUB_TOKEN: 'ghp_example' }
    )
    const env = providerEnvLookup('bedrock', name => s.get(name))
    expect(env('AWS_REGION')).toBe('eu-west-1')
    expect(env('GITHUB_TOKEN')).toBeUndefined()
    expect(env('AWS_SECRET_ACCESS_KEY')).toBeUndefined()
    expect(env('VERTEX_PROJECT_ID')).toBeUndefined()
    // Never written into the process environment (would reach child processes).
    expect(process.env.AWS_REGION).toBeUndefined()
  })

  it('a Host → Environment edit of AWS_REGION is detected; unrelated env edits are not', async () => {
    const s = await startStore(
      'bedrock',
      { 'aws-access-key-id': 'AKIAEXAMPLE', 'aws-secret-access-key': 'secret-example' },
      { AWS_REGION: 'eu-west-1', LOG_LEVEL: 'info' }
    )
    const changed = createProviderEnvChangeDetector('bedrock', name => s.get(name))
    const rebuilds: string[] = []
    s.onChange(({ envChanged }) => {
      if (envChanged && changed()) {
        rebuilds.push(
          buildBedrockClientConfig(
            { 'aws-access-key-id': 'AKIAEXAMPLE', 'aws-secret-access-key': 'secret-example' },
            providerEnvLookup('bedrock', name => s.get(name))
          ).region
        )
      }
    })
    const cmWatch = [...watch.active.entries()].find(([k]) =>
      k.endsWith('metadata.name=host-trader-env')
    )
    expect(cmWatch).toBeDefined()
    const emit = cmWatch![1].emit

    emit('MODIFIED', {
      metadata: { name: 'host-trader-env' },
      data: { AWS_REGION: 'eu-west-1', LOG_LEVEL: 'debug' },
    })
    expect(rebuilds).toEqual([])

    emit('MODIFIED', {
      metadata: { name: 'host-trader-env' },
      data: { AWS_REGION: 'ap-southeast-2', LOG_LEVEL: 'debug' },
    })
    expect(rebuilds).toEqual(['ap-southeast-2'])
  })

  it('processEnvLookup reads the pod environment (dev-mode default)', () => {
    process.env.AWS_REGION = 'us-west-2'
    expect(processEnvLookup('AWS_REGION')).toBe('us-west-2')
  })
})
