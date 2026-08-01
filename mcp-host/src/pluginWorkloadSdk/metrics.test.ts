import { describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import { CircuitBreaker } from './domain/circuitBreaker'
import { PluginWorkloadError } from './domain/errors'
import {
  pluginSdkPromptBridgeRequestsTotal,
  pluginSdkPromptBridgeTokensTotal,
  recordCircuitBreakerState,
} from './metrics'
import type { PluginWorkloadSdkControlApiClient } from './promptBridge/controlApiClient'
import { PromptBridgeHandler } from './promptBridge/handler'
import type { LlmBridge } from './promptBridge/llmBridge'

const validBody = {
  purpose: 'summarization',
  idempotencyKey: 'key-1',
  messages: [{ role: 'user', content: 'summarize this' }],
}

function makeHandler(recipeName: string, complete?: ReturnType<typeof vi.fn>) {
  const target = {
    targetRef: 'primary-zai',
    provider: 'zai',
    model: 'glm-4.7',
    credentialSlot: 'zai-api-key',
  }
  const controlApiClient = {
    authorizePromptBridge: vi.fn().mockResolvedValue({
      invocationId: 'inv-1',
      replay: false,
      status: 'in_progress',
      model: 'glm-4.7',
      modelPolicy: null,
      selectedTarget: target,
      authorizedTargets: [target],
      authorizedTargetTickets: [{ targetRef: target.targetRef, credentialTicket: 'ticket' }],
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
      maxOutputTokens: null,
    }),
    reportInvocationStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as PluginWorkloadSdkControlApiClient
  const llmBridge = {
    complete:
      complete ??
      vi.fn().mockResolvedValue({
        model: 'glm-4.7',
        servedTarget: target,
        fallbackUsed: false,
        llmSecretName: 'zai-secret',
        content: 'ok',
        usage: { inputTokens: 7, outputTokens: 3 },
        finishReason: 'complete',
      }),
  } as unknown as LlmBridge
  return new PromptBridgeHandler({
    controlApiClient,
    llmBridge,
    recipeNamespace: 'sandbox-recipes',
    recipeName,
    promptTimeoutMs: 1_000,
  })
}

async function counterValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name)
  if (!metric) return 0
  const data = await metric.get()
  const match = data.values.find(v =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val)
  )
  return match?.value ?? 0
}

describe('Plugin Workload SDK metrics (plan §5.3 gate)', () => {
  it('records request + token counters after a successful promptBridge call', async () => {
    const recipe = `metrics-ok-${Date.now()}`
    await makeHandler(recipe).handle(validBody, 'api')
    expect(
      await counterValue('clerum_plugin_workload_sdk_prompt_bridge_requests_total', {
        recipe,
        model: 'glm-4.7',
        status: 'complete',
      })
    ).toBe(1)
    expect(
      await counterValue('clerum_plugin_workload_sdk_prompt_bridge_tokens_total', {
        recipe,
        model: 'glm-4.7',
        direction: 'input',
      })
    ).toBe(7)
    expect(
      await counterValue('clerum_plugin_workload_sdk_prompt_bridge_tokens_total', {
        recipe,
        model: 'glm-4.7',
        direction: 'output',
      })
    ).toBe(3)
    void pluginSdkPromptBridgeTokensTotal
  })

  it('records the structured error code as the request status on failure', async () => {
    const recipe = `metrics-fail-${Date.now()}`
    const complete = vi
      .fn()
      .mockRejectedValue(new PluginWorkloadError('provider_unavailable', 'down', true))
    await expect(makeHandler(recipe, complete).handle(validBody, 'api')).rejects.toThrow()
    expect(
      await counterValue('clerum_plugin_workload_sdk_prompt_bridge_requests_total', {
        recipe,
        status: 'provider_unavailable',
      })
    ).toBe(1)
    void pluginSdkPromptBridgeRequestsTotal
  })

  it('exposes the SDK counters through the prom-client register (scrape gate)', async () => {
    const recipe = `metrics-scrape-${Date.now()}`
    await makeHandler(recipe).handle(validBody, 'api')
    const scraped = await register.metrics()
    expect(scraped).toContain('clerum_plugin_workload_sdk_prompt_bridge_requests_total')
    expect(scraped).toContain('clerum_plugin_workload_sdk_prompt_bridge_duration_seconds')
    expect(scraped).toContain('clerum_plugin_workload_sdk_circuit_breaker_state')
  })

  it('mirrors circuit breaker transitions into the state gauge', async () => {
    const transitions: boolean[] = []
    let t = 0
    const breaker = new CircuitBreaker({
      now: () => t,
      minSamples: 2,
      resetMs: 60_000,
      onStateChange: open => {
        transitions.push(open)
        recordCircuitBreakerState('test-gateway', open)
      },
    })
    breaker.record(false)
    breaker.record(false)
    expect(breaker.allow()).toBe(false)
    t = 61_000
    expect(breaker.allow()).toBe(true)
    expect(transitions).toEqual([true, false])
    expect(
      await counterValue('clerum_plugin_workload_sdk_circuit_breaker_state', {
        gateway: 'test-gateway',
        state: 'open',
      })
    ).toBe(0)
    expect(
      await counterValue('clerum_plugin_workload_sdk_circuit_breaker_state', {
        gateway: 'test-gateway',
        state: 'closed',
      })
    ).toBe(1)
  })
})
