import { describe, expect, it, vi } from 'vitest'
import { ClientNotificationsHandler } from './clientNotifications/handler'
import type { PluginWorkloadSdkControlApiClient } from './promptBridge/controlApiClient'
import { PromptBridgeHandler } from './promptBridge/handler'
import type { LlmBridge } from './promptBridge/llmBridge'

// Plan §6.2 security invariants that are otherwise guaranteed only by the
// response TYPE construction. These runtime assertions are a regression guard:
// a future field added to a result shape that leaks a provider key, a raw
// channel address, or user-info would fail here.

// Substrings that must NEVER appear anywhere in a result returned to a plugin
// workload (keys, bearer tokens, raw contact identifiers, control-api internals).
const FORBIDDEN_SUBSTRINGS = [
  'sk-provider-secret', // a provider API key value
  'Bearer ', // a bearer token
  'user@example.com', // a raw email address (channel identifier / PII)
  '+15551234567', // a raw phone number (channel identifier / PII)
  'recipe-bound-jwt', // the mcp-host runtime JWT
]

function deepKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k)
      deepKeys(v, acc)
    }
  } else if (Array.isArray(value)) {
    for (const v of value) deepKeys(v, acc)
  }
  return acc
}

describe('Plugin Workload SDK — §6.2 response-shape security invariants', () => {
  it('promptBridge result contains no provider key, token, or user-info', async () => {
    const target = {
      targetRef: 'primary-zai',
      provider: 'zai',
      model: 'glm-4.7',
      credentialSlot: 'zai-api-key',
    }
    const controlApiClient = {
      ensurePromptBridgeCapabilities: vi.fn().mockResolvedValue(undefined),
      authorizePromptBridge: vi.fn().mockResolvedValue({
        contractVersion: 2,
        invocationId: 'inv-1',
        replay: false,
        providerCallRequired: true,
        status: 'in_progress',
        model: 'glm-4.7',
        // Even if control-api leaked a key into the authorization envelope,
        // the handler must not surface it in the result.
        modelPolicy: { provider: 'zai', model: 'glm-4.7', apiKey: 'sk-provider-secret' },
        selectedTarget: target,
        authorizedTargets: [target],
        attemptGeneration: 1,
        policyRevision: 1,
        policyHash: 'a'.repeat(64),
        maxOutputTokens: null,
      }),
      reportProviderAttemptStatus: vi.fn().mockResolvedValue(undefined),
      reportInvocationStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkloadSdkControlApiClient
    const llmBridge = {
      complete: vi.fn().mockResolvedValue({
        model: 'glm-4.7',
        servedTarget: target,
        fallbackUsed: false,
        llmSecretName: 'zai-secret',
        content: 'the summary',
        usage: { inputTokens: 4, outputTokens: 2 },
        finishReason: 'complete',
      }),
    } as unknown as LlmBridge

    const handler = new PromptBridgeHandler({
      controlApiClient,
      llmBridge,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
      promptTimeoutMs: 1_000,
    })

    const result = await handler.handle(
      {
        purpose: 'summarization',
        idempotencyKey: 'key-1',
        messages: [{ role: 'user', content: 'summarize' }],
      },
      'api'
    )

    const serialized = JSON.stringify(result)
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(serialized).not.toContain(forbidden)
    }
    // Provider identity is deliberately returned as non-secret servedTarget
    // telemetry; credential values/tickets and policy internals must not leak.
    const keys = deepKeys(result)
    expect(keys.has('apiKey')).toBe(false)
    expect(keys.has('modelPolicy')).toBe(false)
    expect(keys.has('credentialTicket')).toBe(false)
    // User-info invariant: no user identity fields surface.
    for (const userInfoField of ['userId', 'email', 'phone', 'teamId', 'sender']) {
      expect(keys.has(userInfoField)).toBe(false)
    }
  })

  it('clientNotifications result echoes only the opaque refs the caller supplied', async () => {
    const controlApiClient = {
      submitClientNotification: vi.fn().mockResolvedValue({
        notificationId: 'not-1',
        replay: false,
        status: 'accepted',
        eventType: 'lead.followup.due',
        // control-api must only echo opaque refs; even if it returned a raw
        // address, the handler builds the result from the validated request.
        target: { targetRef: 'team.sales' },
      }),
    } as unknown as PluginWorkloadSdkControlApiClient

    const handler = new ClientNotificationsHandler({
      controlApiClient,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'r1',
    })

    const result = await handler.handle(
      {
        eventType: 'lead.followup.due',
        target: { targetRef: 'team.sales' },
        idempotencyKey: 'key-2',
        notification: { title: 'Follow up', body: 'Lead is due' },
      },
      'api'
    )

    const serialized = JSON.stringify(result)
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(serialized).not.toContain(forbidden)
    }
    // The result's target carries only the opaque targetRef the caller passed.
    expect(result.target).toEqual({ targetRef: 'team.sales', userRef: undefined })
    const keys = deepKeys(result)
    for (const userInfoField of [
      'userId',
      'email',
      'phone',
      'providerChannelId',
      'providerUserId',
    ]) {
      expect(keys.has(userInfoField)).toBe(false)
    }
  })
})
