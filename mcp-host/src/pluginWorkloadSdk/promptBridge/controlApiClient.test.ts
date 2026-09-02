import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import { CircuitBreaker } from '../domain/circuitBreaker'
import { PluginWorkloadError } from '../domain/errors'
import { replaceSdkOnlyCodexBinding } from '../sdkOnlyCodexBinding'
import { PluginWorkloadSdkControlApiClient } from './controlApiClient'

const promptBody = {
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'r1',
  callerRef: 'api',
  purpose: 'summarization',
  idempotencyKey: 'k1',
  messages: [{ role: 'user', content: 'hi' }],
}
const target = {
  targetRef: 'primary-zai',
  provider: 'zai',
  model: 'glm-5.1',
  credentialSlot: 'zai-api-key',
}

function authorizedBody(invocationId: string) {
  return {
    contractVersion: 2,
    invocationId,
    replay: false,
    providerCallRequired: true,
    status: 'in_progress',
    model: target.model,
    modelPolicy: null,
    selectedTarget: target,
    authorizedTargets: [target],
    attemptGeneration: 1,
    policyRevision: 2,
    policyHash: 'a'.repeat(64),
    maxOutputTokens: null,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeClient(fetchImpl: typeof fetch, breaker?: CircuitBreaker) {
  return new PluginWorkloadSdkControlApiClient({
    baseUrl: 'http://gateway:8092/',
    getAccessToken: () => 'jwt-access',
    fetchImpl,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    breaker,
  })
}

function installCodexBinding(model = 'gpt-5.1') {
  const binding = {
    connectionKey: 'team-plus',
    catalogRevision: 4,
    credentialRevision: 1,
    model,
    bindingHash: computeCodexPolicyHash({
      model,
      catalogRevision: 4,
      credentialRevision: 1,
      connectionKey: 'team-plus',
    }),
  }
  replaceSdkOnlyCodexBinding(binding)
  return binding
}

afterEach(() => {
  replaceSdkOnlyCodexBinding(null)
})

describe('PluginWorkloadSdkControlApiClient', () => {
  it('posts to the gateway with the mcp-host bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, authorizedBody('inv-1')))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.authorizePromptBridge(promptBody)
    expect(result.invocationId).toBe('inv-1')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://gateway:8092/api/v1/mcp-host/plugin-workload-sdk/prompt-bridge/v2')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-access')
  })

  it('maps a structured 4xx error code to PluginWorkloadError without leaking internals', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(429, { error: 'quota_exceeded', message: 'limit hit', retryable: false })
      )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(client.authorizePromptBridge(promptBody)).rejects.toMatchObject({
      code: 'quota_exceeded',
      retryable: false,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1) // 4xx is not retried
  })

  it('accepts identity-only bootstrap before an operator grant exists', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        contractVersion: 2,
        supportedContractVersions: [2],
        targetAwarePromptBridge: true,
        attemptLedger: true,
        credentialTickets: true,
        policyState: 'missing',
        policyRevision: 0,
        policyHash: null,
        defaultTargetRef: null,
        defaultProvider: null,
        defaultModel: null,
        v2Ready: false,
        clientNotificationsPolicyState: 'missing',
        clientNotificationsReady: false,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)

    await expect(client.verifyPromptBridgeBootstrapV2('openai', 'gpt-5.4-mini')).resolves.toEqual({
      ready: true,
      contractVersion: 2,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      policyReady: false,
      policyState: 'missing',
      policyReason: 'grant_missing',
      clientNotificationsPolicyReady: false,
      clientNotificationsPolicyState: 'missing',
      clientNotificationsPolicyReason: 'grant_missing',
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/mcp-host/plugin-workload-sdk/capabilities',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('requires reservation-only Codex capabilities before marking policy ready', async () => {
    installCodexBinding()
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        contractVersion: 3,
        supportedContractVersions: [2, 3],
        reservationOnlyOauthBroker: true,
        targetAwarePromptBridge: true,
        attemptLedger: true,
        credentialTickets: true,
        policyState: 'active',
        policyRevision: 2,
        policyHash: 'a'.repeat(64),
        defaultTargetRef: 'codex-primary',
        defaultProvider: 'codex-subscription',
        defaultModel: 'gpt-5.1',
        defaultConnectionRef: 'team-plus',
        v2Ready: true,
        clientNotificationsPolicyState: 'missing',
        clientNotificationsReady: false,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)

    await expect(
      client.verifyPromptBridgeBootstrapV2('codex-subscription', 'gpt-5.1')
    ).resolves.toMatchObject({
      ready: true,
      contractVersion: 3,
      policyReady: true,
      policyState: 'active',
      codexBindingReady: true,
    })
  })

  it('keeps Codex policy not ready when an old API advertises contract v2', async () => {
    installCodexBinding()
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        contractVersion: 2,
        supportedContractVersions: [2, 3],
        targetAwarePromptBridge: true,
        attemptLedger: true,
        credentialTickets: true,
        policyState: 'active',
        policyRevision: 2,
        policyHash: 'a'.repeat(64),
        defaultTargetRef: 'codex-primary',
        defaultProvider: 'codex-subscription',
        defaultModel: 'gpt-5.1',
        defaultConnectionRef: 'team-plus',
        v2Ready: true,
        clientNotificationsPolicyState: 'missing',
        clientNotificationsReady: false,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)

    await expect(
      client.verifyPromptBridgeBootstrapV2('codex-subscription', 'gpt-5.1')
    ).resolves.toMatchObject({
      ready: true,
      contractVersion: 3,
      policyReady: false,
      policyReason: 'codex_execution_binding_missing',
      codexBindingReady: false,
    })
  })

  it('keeps request-time policy readiness separate from identity bootstrap', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        contractVersion: 2,
        supportedContractVersions: [2],
        targetAwarePromptBridge: true,
        attemptLedger: true,
        credentialTickets: true,
        policyState: 'missing',
        policyRevision: 0,
        policyHash: null,
        defaultTargetRef: null,
        defaultProvider: null,
        defaultModel: null,
        v2Ready: false,
        clientNotificationsPolicyState: 'missing',
        clientNotificationsReady: false,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)

    await expect(client.ensurePromptBridgeCapabilities()).rejects.toMatchObject({
      code: 'provider_policy_denied',
      retryable: false,
    })
  })

  it('proves provider-free clientNotifications readiness from the capabilities contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        contractVersion: 2,
        supportedContractVersions: [2],
        targetAwarePromptBridge: true,
        attemptLedger: true,
        credentialTickets: true,
        policyState: 'missing',
        policyRevision: 0,
        policyHash: null,
        defaultTargetRef: null,
        defaultProvider: null,
        defaultModel: null,
        v2Ready: false,
        clientNotificationsPolicyState: 'active',
        clientNotificationsReady: true,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)

    await expect(client.verifyClientNotificationsBootstrap()).resolves.toEqual({
      ready: true,
      contractVersion: 2,
      policyReady: true,
      policyState: 'active',
    })
  })

  it('accepts a policy-only authorization envelope and leaves ticket issuance to the attempt path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, authorizedBody('inv-1')))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(client.authorizePromptBridge(promptBody)).resolves.toMatchObject({
      invocationId: 'inv-1',
      authorizedTargets: [target],
    })
  })

  it('rejects a response missing the v2 provider-call disposition', async () => {
    const { providerCallRequired: _omitted, ...incompleteBody } =
      authorizedBody('legacy-invocation')
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, incompleteBody))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(client.authorizePromptBridge(promptBody)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
  })

  it('serializes provider and target selectors without supplying a host default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, authorizedBody('inv-1')))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await client.authorizePromptBridge({
      ...promptBody,
      provider: 'zai',
      model: 'glm-5.1',
      targetRef: 'primary-zai',
    })
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      provider: 'zai',
      model: 'glm-5.1',
      targetRef: 'primary-zai',
    })
  })

  it('reissues a ticket bound to the authorized recipe, invocation, target, and policy snapshot', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptId: 'attempt-1',
        providerAttemptIndex: 1,
        targetRef: target.targetRef,
        credentialTicket: 'fresh-signed-ticket',
        policyRevision: 2,
        policyHash: 'a'.repeat(64),
        expiresInSeconds: 60,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)

    await expect(
      client.reissuePromptBridgeCredentialTicket({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        invocationId: 'inv-1',
        attemptGeneration: 1,
        target,
        policyRevision: 2,
        policyHash: 'a'.repeat(64),
      })
    ).resolves.toMatchObject({ credentialTicket: 'fresh-signed-ticket' })

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://gateway:8092/api/v1/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket'
    )
    expect(JSON.parse(String(init.body))).toEqual({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
      invocationId: 'inv-1',
      targetRef: target.targetRef,
      attemptGeneration: 1,
    })
  })

  it('rejects a reissued ticket that does not match the original authorization snapshot', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptId: 'attempt-1',
        providerAttemptIndex: 1,
        targetRef: 'different-target',
        credentialTicket: 'fresh-signed-ticket',
        policyRevision: 2,
        policyHash: 'a'.repeat(64),
        expiresInSeconds: 60,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(
      client.reissuePromptBridgeCredentialTicket({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        invocationId: 'inv-1',
        attemptGeneration: 1,
        target,
        policyRevision: 2,
        policyHash: 'a'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: false })
  })

  it('retries 5xx and returns provider_unavailable after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, {}))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(client.authorizePromptBridge(promptBody)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('retries network failures and succeeds on a later attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(201, authorizedBody('inv-2')))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.authorizePromptBridge(promptBody)
    expect(result.invocationId).toBe('inv-2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('short-circuits with provider_unavailable while the breaker is open', async () => {
    let t = 0
    const breaker = new CircuitBreaker({ now: () => t, minSamples: 2 })
    breaker.record(false)
    breaker.record(false)
    const fetchImpl = vi.fn()
    const client = makeClient(fetchImpl as unknown as typeof fetch, breaker)
    await expect(client.authorizePromptBridge(promptBody)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps 401 to unauthorized', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(client.authorizePromptBridge(promptBody)).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  describe('refresh-on-401 (runtime-token durability)', () => {
    const successBody = authorizedBody('inv-ok')

    function makeRefreshingClient(
      fetchImpl: typeof fetch,
      refreshOnUnauthorized: () => Promise<void>
    ) {
      return new PluginWorkloadSdkControlApiClient({
        baseUrl: 'http://gateway:8092/',
        getAccessToken: () => 'jwt-access',
        refreshOnUnauthorized,
        fetchImpl,
        maxRetries: 2,
        retryBaseDelayMs: 1,
      })
    }

    it('refreshes once on a 401 then retries and succeeds with the fresh token', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
        .mockResolvedValueOnce(jsonResponse(201, successBody))
      const refresh = vi.fn().mockResolvedValue(undefined)
      const client = makeRefreshingClient(fetchImpl as unknown as typeof fetch, refresh)
      const result = await client.authorizePromptBridge(promptBody)
      expect(result.invocationId).toBe('inv-ok')
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(fetchImpl).toHaveBeenCalledTimes(2) // original 401 + post-refresh retry
    })

    it('propagates unauthorized when the retry also 401s (bad credential, no loop)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }))
      const refresh = vi.fn().mockResolvedValue(undefined)
      const client = makeRefreshingClient(fetchImpl as unknown as typeof fetch, refresh)
      await expect(client.authorizePromptBridge(promptBody)).rejects.toMatchObject({
        code: 'unauthorized',
      })
      expect(refresh).toHaveBeenCalledTimes(1) // exactly one refresh, then surface the error
    })

    it('coalesces concurrent 401s onto a single refresh (refresh JTI burned once)', async () => {
      let attempts = 0
      const fetchImpl = vi.fn().mockImplementation(() => {
        attempts += 1
        // The two concurrent originals 401; both post-refresh retries succeed.
        return Promise.resolve(
          attempts <= 2
            ? jsonResponse(401, { error: 'Unauthorized' })
            : jsonResponse(201, successBody)
        )
      })
      let release: () => void = () => {}
      const gate = new Promise<void>(res => {
        release = res
      })
      const refresh = vi.fn().mockImplementation(() => gate)
      const client = makeRefreshingClient(fetchImpl as unknown as typeof fetch, refresh)
      const p1 = client.authorizePromptBridge(promptBody)
      const p2 = client.authorizePromptBridge(promptBody)
      // Let both originals 401 and reach triggerRefresh before the refresh resolves.
      await new Promise(res => setTimeout(res, 10))
      release()
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.invocationId).toBe('inv-ok')
      expect(r2.invocationId).toBe('inv-ok')
      expect(refresh).toHaveBeenCalledTimes(1) // coalesced, not once per caller
    })

    it('still surfaces 401 as unauthorized when no refresh hook is wired', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }))
      const client = makeClient(fetchImpl as unknown as typeof fetch)
      await expect(client.authorizePromptBridge(promptBody)).rejects.toMatchObject({
        code: 'unauthorized',
      })
      expect(fetchImpl).toHaveBeenCalledTimes(1) // no refresh, no retry
    })
  })

  it('reportInvocationStatus surfaces a rejected terminal acknowledgement', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}))
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(
      client.reportInvocationStatus('inv-1', 'sandbox-recipes', 'r1', 'complete', 1)
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true })
  })

  it('finalizes one provider attempt with an idempotent exact usage receipt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        invocationId: 'inv-1',
        providerAttemptId: 'attempt-1',
        status: 'complete',
        outcome: 'exact',
        idempotent: false,
        usageAccepted: true,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const result = await client.finalizePromptBridge({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
      invocationId: 'inv-1',
      attemptGeneration: 1,
      providerAttemptId: 'attempt-1',
      providerAttemptIndex: 1,
      status: 'complete',
      reason: 'provider_completed',
      target,
      usage: {
        llmSecretName: 'zai-api-key',
        callerRef: 'api',
        fallbackUsed: false,
        attemptCount: 1,
        inputTokens: 3,
        outputTokens: 4,
      },
    })
    expect(result).toMatchObject({ outcome: 'exact', usageAccepted: true })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'http://gateway:8092/api/v1/mcp-host/plugin-workload-sdk/invocations/inv-1/finalize'
    )
    expect(JSON.parse(String(init.body))).toMatchObject({
      invocationId: 'inv-1',
      providerAttemptId: 'attempt-1',
      status: 'complete',
      usage: { inputTokens: 3, outputTokens: 4 },
    })
  })

  it('surfaces ledger_pending as the retryable-with-reason finalize triple', async () => {
    // The handler retries a finalize ONLY on this exact triple. If control-api
    // ever stops sending `reason`, or the client stops mapping it, the retry
    // silently disappears — so the triple is asserted end to end here.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        error: 'provider_unavailable',
        message: 'linked Codex attempt has not finalized usage yet',
        retryable: true,
        reason: 'provider_unavailable',
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    const failure = await client
      .finalizePromptBridge({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptId: 'attempt-1',
        providerAttemptIndex: 1,
        status: 'complete',
        reason: 'provider_completed',
        target,
      })
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(PluginWorkloadError)
    expect(failure).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      reason: 'provider_unavailable',
    })
    // A 409 is not retried by the transport itself; the ledger retry lives in
    // the handler, where the deadline can bound it.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('threads a caller deadline into the finalize request and stops retrying once aborted', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        invocationId: 'inv-1',
        providerAttemptId: 'attempt-1',
        status: 'complete',
        outcome: 'exact',
        idempotent: false,
        usageAccepted: true,
      })
    )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await client.finalizePromptBridge(
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptId: 'attempt-1',
        providerAttemptIndex: 1,
        status: 'complete',
        reason: 'provider_completed',
        target,
      },
      { signal: controller.signal }
    )
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)

    // An already-expired deadline must not buy a single transport attempt: the
    // AbortError would otherwise be swallowed by the network-retry branch.
    const abortedFetch = vi.fn()
    const abortedClient = makeClient(abortedFetch as unknown as typeof fetch)
    await expect(
      abortedClient.finalizePromptBridge(
        {
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'r1',
          invocationId: 'inv-1',
          attemptGeneration: 1,
          providerAttemptId: 'attempt-1',
          providerAttemptIndex: 1,
          status: 'complete',
          reason: 'provider_completed',
          target,
        },
        { signal: AbortSignal.abort() }
      )
    ).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true })
    expect(abortedFetch).not.toHaveBeenCalled()
  })

  it('submitClientNotification maps event_type_not_allowed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(403, { error: 'event_type_not_allowed', message: 'nope', retryable: false })
      )
    const client = makeClient(fetchImpl as unknown as typeof fetch)
    await expect(
      client.submitClientNotification({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'r1',
        callerRef: 'api',
        eventType: 'x.y',
        target: { targetRef: 'team.sales' },
        idempotencyKey: 'k2',
        notification: { title: 't', body: 'b' },
      })
    ).rejects.toBeInstanceOf(PluginWorkloadError)
  })

  describe('listClientNotificationRecipients', () => {
    const recipientsBody = {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
      callerRef: 'api',
    }

    it('posts the recipe binding and returns the resolved recipient list', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          recipients: [{ userRef: 'u-1', displayName: 'Ada Lovelace' }],
        })
      )
      const client = makeClient(fetchImpl as unknown as typeof fetch)
      const result = await client.listClientNotificationRecipients(recipientsBody)
      expect(result.recipients).toEqual([{ userRef: 'u-1', displayName: 'Ada Lovelace' }])
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(
        'http://gateway:8092/api/v1/mcp-host/plugin-workload-sdk/client-notification/recipients'
      )
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-access')
    })

    it('rejects an unexpected response shape as provider_unavailable', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { recipients: [{ userRef: 'u-1' }] }))
      const client = makeClient(fetchImpl as unknown as typeof fetch)
      await expect(client.listClientNotificationRecipients(recipientsBody)).rejects.toMatchObject({
        code: 'provider_unavailable',
      })
    })

    it('refreshes once on a 401 then retries (shares the durable refresh path)', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
        .mockResolvedValueOnce(jsonResponse(200, { recipients: [] }))
      const refresh = vi.fn().mockResolvedValue(undefined)
      const client = new PluginWorkloadSdkControlApiClient({
        baseUrl: 'http://gateway:8092/',
        getAccessToken: () => 'jwt-access',
        refreshOnUnauthorized: refresh,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxRetries: 2,
        retryBaseDelayMs: 1,
      })
      const result = await client.listClientNotificationRecipients(recipientsBody)
      expect(result.recipients).toEqual([])
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
  })
})
