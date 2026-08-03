import { afterEach, describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { LlmErrorCode } from '../../core/errors'
import { type CompletionResponse, FinishReason } from '../../core/types'
import type { SingleTurnProvider, createLLMProvider } from '../../llm'
import type { ApiKeys, ModelConfig } from '../../types'
import { PluginWorkloadError } from '../domain/errors'
import type { PromptBridgeTarget } from '../domain/types'
import { PluginWorkloadSdkServer } from '../server/sdkServer'
import type { PluginWorkloadSdkControlApiClient } from './controlApiClient'
import type { BrokeredCredential } from './credentialBrokerClient'
import { PromptBridgeHandler } from './handler'
import { LlmBridge, type PromptBridgeCredentialResolver } from './llmBridge'

const PRIMARY: PromptBridgeTarget = {
  targetRef: 'primary-zai',
  provider: 'zai',
  model: 'glm-5.1',
  credentialSlot: 'zai-api-key',
}
const FALLBACK: PromptBridgeTarget = {
  targetRef: 'fallback-openai',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  credentialSlot: 'openai-api-key',
}
const UNAUTHORIZED: PromptBridgeTarget = {
  targetRef: 'unlisted-anthropic',
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  credentialSlot: 'claude-api-key',
}
const POLICY_HASH = 'b'.repeat(64)
const TOKEN = 'runtime-http-test-token'
const CALLER_REF = 'sdk-caller'

const OK: CompletionResponse = {
  content: 'deterministic fallback completion',
  usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  finish_reason: FinishReason.Stop,
}

type Scenario = 'fallback-success' | 'all-targets-fail' | 'credential-terminal'

class FakeProvider implements Partial<SingleTurnProvider> {
  readonly completeSingleTurn = vi.fn(async (): Promise<CompletionResponse> => {
    if (this.failure) throw new Error(this.failure)
    return OK
  })

  constructor(private readonly failure?: string) {}

  classifyError() {
    return {
      code: LlmErrorCode.RateLimited,
      retryable: true,
      message: 'redacted provider failure',
    }
  }
}

interface RuntimeHarness {
  server: PluginWorkloadSdkServer
  stop: () => Promise<void>
  issuedTickets: string[]
  credentialCalls: string[]
  providerCalls: string[]
  reportedStatuses: string[]
  usage: Array<Record<string, unknown>>
  secretStore: ReadonlyMap<string, string>
}

function makeHarness(scenario: Scenario): RuntimeHarness {
  const issuedTickets: string[] = []
  const credentialCalls: string[] = []
  const providerCalls: string[] = []
  const reportedStatuses: string[] = []
  const usage: Array<Record<string, unknown>> = []
  // This store deliberately contains a configured third credential. The
  // resolver is only given the signed authorized target, so the third entry is
  // never enumerated or looked up by the SDK runtime.
  const secretStore = new Map<string, string>([
    [PRIMARY.targetRef, 'primary-secret'],
    [FALLBACK.targetRef, 'fallback-secret'],
    [UNAUTHORIZED.targetRef, 'unlisted-secret'],
  ])

  const providers = new Map<string, FakeProvider>([
    [PRIMARY.model, new FakeProvider('primary down')],
    [
      FALLBACK.model,
      new FakeProvider(scenario === 'all-targets-fail' ? 'fallback down' : undefined),
    ],
  ])
  const credentialResolver: PromptBridgeCredentialResolver = {
    resolve: vi.fn(async input => {
      credentialCalls.push(input.target.targetRef)
      if (scenario === 'credential-terminal') {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'authorized provider credentials are unavailable',
          false,
          'credential_unavailable'
        )
      }
      const secret = secretStore.get(input.target.targetRef)
      if (!secret) {
        throw new PluginWorkloadError(
          'provider_unavailable',
          'authorized provider credentials are unavailable',
          false,
          'credential_unavailable'
        )
      }
      return {
        target: input.target,
        keys: {
          [input.target.provider]: { [input.target.credentialSlot]: secret },
        } as ApiKeys,
        llmSecretName: 'test-only-provider-secret',
      } satisfies BrokeredCredential
    }),
  }
  const createProvider = ((_keys: ApiKeys, model: ModelConfig) => {
    providerCalls.push(`${model.provider}/${model.name}`)
    return (providers.get(model.name) ?? null) as unknown as SingleTurnProvider | null
  }) as typeof createLLMProvider

  const llmBridge = new LlmBridge(credentialResolver, { createProvider })
  const authorizePromptBridge = vi.fn(async (body: { targetRef?: string }) => {
    if (body.targetRef === UNAUTHORIZED.targetRef) {
      throw new PluginWorkloadError(
        'target_not_allowed',
        'requested target is not authorized',
        false
      )
    }
    return {
      contractVersion: 2,
      invocationId: 'inv-runtime-http',
      replay: false,
      providerCallRequired: true,
      status: 'in_progress',
      model: PRIMARY.model,
      modelPolicy: null,
      selectedTarget: PRIMARY,
      authorizedTargets: [PRIMARY, FALLBACK],
      attemptGeneration: 1,
      policyRevision: 9,
      policyHash: POLICY_HASH,
      maxOutputTokens: 256,
    }
  })
  const controlApiClient = {
    ensurePromptBridgeCapabilities: vi.fn().mockResolvedValue(undefined),
    authorizePromptBridge,
    reissuePromptBridgeCredentialTicket: vi.fn(
      async ({ target }: { target: PromptBridgeTarget }) => {
        issuedTickets.push(target.targetRef)
        return {
          invocationId: 'inv-runtime-http',
          attemptGeneration: 1,
          providerAttemptId: `attempt-${target.targetRef}`,
          providerAttemptIndex: issuedTickets.length,
          targetRef: target.targetRef,
          credentialTicket: `ticket-${target.targetRef}`,
          policyRevision: 9,
          policyHash: POLICY_HASH,
          expiresInSeconds: 30,
        }
      }
    ),
    reportProviderAttemptStatus: vi.fn().mockResolvedValue(undefined),
    reportInvocationStatus: vi.fn(
      async (_id: string, _ns: string, _recipe: string, status: string) => {
        reportedStatuses.push(status)
      }
    ),
  } as unknown as PluginWorkloadSdkControlApiClient

  const promptBridgeHandler = new PromptBridgeHandler({
    controlApiClient,
    llmBridge,
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'runtime-http',
    promptTimeoutMs: 5_000,
    getBootstrapTarget: () => ({ provider: PRIMARY.provider, model: PRIMARY.model }),
    onUsage: event => usage.push(event as unknown as Record<string, unknown>),
  })
  const clientNotificationsHandler = {
    handle: vi.fn(),
    listRecipients: vi.fn(async () => []),
  }
  const server = new PluginWorkloadSdkServer({
    port: 0,
    recipeName: 'runtime-http',
    workloadTokens: new Map([[TOKEN, CALLER_REF]]),
    promptBridgeHandler,
    clientNotificationsHandler: clientNotificationsHandler as never,
  })

  return {
    server,
    stop: async () => server.stop(),
    issuedTickets,
    credentialCalls,
    providerCalls,
    reportedStatuses,
    usage,
    secretStore,
  }
}

async function start(harness: RuntimeHarness): Promise<string> {
  await harness.server.start()
  const server = (harness.server as unknown as { server: http.Server | null }).server
  const address = server?.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function postPrompt(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/sdk/v1/prompt-bridge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      purpose: 'summarization',
      idempotencyKey: 'runtime-http-1',
      messages: [{ role: 'user', content: 'hello' }],
      ...body,
    }),
  })
}

describe('Plugin Workload SDK promptBridge deterministic HTTP runtime', () => {
  let active: RuntimeHarness | undefined

  afterEach(async () => {
    await active?.stop()
    active = undefined
  })

  it('executes only the ordered authorized suffix and reports the served fallback target', async () => {
    active = makeHarness('fallback-success')
    const baseUrl = await start(active)

    const response = await postPrompt(baseUrl, {})
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>

    expect(body).toMatchObject({
      invocationId: 'inv-runtime-http',
      servedTarget: FALLBACK,
      fallbackUsed: true,
      usage: { inputTokens: 11, outputTokens: 7 },
    })
    expect(active.issuedTickets).toEqual([PRIMARY.targetRef, FALLBACK.targetRef])
    expect(active.credentialCalls).toEqual([PRIMARY.targetRef, FALLBACK.targetRef])
    expect(active.providerCalls).toEqual([
      `${PRIMARY.provider}/${PRIMARY.model}`,
      `${FALLBACK.provider}/${FALLBACK.model}`,
    ])
    expect(active.reportedStatuses).toEqual(['complete'])
    expect(active.usage[0]).toMatchObject({
      provider: FALLBACK.provider,
      model: FALLBACK.model,
      servedTarget: FALLBACK,
      fallbackUsed: true,
      attemptCount: 2,
    })
    expect(JSON.stringify(body)).not.toContain('secret')
    expect(active.credentialCalls).not.toContain(UNAUTHORIZED.targetRef)
    expect(active.secretStore.has(UNAUTHORIZED.targetRef)).toBe(true)
  })

  it('returns a bounded provider_unavailable after every authorized target fails', async () => {
    active = makeHarness('all-targets-fail')
    const baseUrl = await start(active)

    const response = await postPrompt(baseUrl, { idempotencyKey: 'runtime-http-all-fail' })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'provider_unavailable',
      message: 'LLM provider error: LLM_RATE_LIMITED',
      retryable: true,
      reason: 'rate_limited',
    })
    expect(active.issuedTickets).toEqual([PRIMARY.targetRef, FALLBACK.targetRef])
    expect(active.credentialCalls).toEqual([PRIMARY.targetRef, FALLBACK.targetRef])
    expect(active.providerCalls).toEqual([
      `${PRIMARY.provider}/${PRIMARY.model}`,
      `${FALLBACK.provider}/${FALLBACK.model}`,
    ])
    expect(active.reportedStatuses).toEqual(['provider_unavailable'])
  })

  it('stops before fallback when the selected credential is terminally unavailable', async () => {
    active = makeHarness('credential-terminal')
    const baseUrl = await start(active)

    const response = await postPrompt(baseUrl, { idempotencyKey: 'runtime-http-credential' })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'provider_unavailable',
      message: 'authorized provider credentials are unavailable',
      retryable: false,
      reason: 'credential_unavailable',
    })
    expect(active.issuedTickets).toEqual([PRIMARY.targetRef])
    expect(active.credentialCalls).toEqual([PRIMARY.targetRef])
    expect(active.providerCalls).toEqual([])
    expect(active.reportedStatuses).toEqual(['provider_unavailable'])
  })

  it('rejects an unauthorized target before ticket, credential, or provider lookup', async () => {
    active = makeHarness('fallback-success')
    const baseUrl = await start(active)

    const response = await postPrompt(baseUrl, {
      idempotencyKey: 'runtime-http-unauthorized',
      targetRef: UNAUTHORIZED.targetRef,
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: 'target_not_allowed',
      message: 'requested target is not authorized',
      retryable: false,
    })
    expect(active.issuedTickets).toEqual([])
    expect(active.credentialCalls).toEqual([])
    expect(active.providerCalls).toEqual([])
  })
})
