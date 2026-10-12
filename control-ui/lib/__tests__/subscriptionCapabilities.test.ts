import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setControlUIReadPrincipal } from '../api'
import { loadCodexSubscriptionCapability } from '../codexSubscriptionFeature'
import { loadGrokSubscriptionCapability } from '../grokSubscriptionFeature'
import { __resetReadRequestCacheForTests } from '../readRequestCache'
import {
  loadSubscriptionCapabilities,
  sanitizeSubscriptionCapabilities,
} from '../subscriptionCapabilities'

const producerBody = {
  providers: {
    'codex-subscription': { enabled: true },
    'grok-subscription': { enabled: false },
  },
}

beforeEach(() => {
  __resetReadRequestCacheForTests()
  setControlUIReadPrincipal('capability-admin', 'admin')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(producerBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  )
})

afterEach(() => {
  __resetReadRequestCacheForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('subscription capabilities', () => {
  it('sanitizes only safe integration flags', () => {
    expect(sanitizeSubscriptionCapabilities(producerBody)).toEqual(producerBody)
    expect(
      sanitizeSubscriptionCapabilities({
        providers: {
          'codex-subscription': { enabled: false, account: 'must-not-escape' },
          'grok-subscription': { enabled: true },
        },
      })
    ).toEqual({
      providers: {
        'codex-subscription': { enabled: false },
        'grok-subscription': { enabled: true },
      },
    })
  })

  it('rejects incomplete or invalid capability payloads', () => {
    expect(() =>
      sanitizeSubscriptionCapabilities({ providers: { 'codex-subscription': { enabled: true } } })
    ).toThrow('Subscription capabilities response is incomplete')
    expect(() =>
      sanitizeSubscriptionCapabilities({
        providers: {
          'codex-subscription': { enabled: 'yes' },
          'grok-subscription': { enabled: true },
        },
      })
    ).toThrow('Subscription capability for codex-subscription is invalid')
  })

  it('reads the shared authenticated endpoint once for both provider helpers', async () => {
    await expect(loadCodexSubscriptionCapability()).resolves.toEqual({ enabled: true })
    await expect(loadGrokSubscriptionCapability()).resolves.toEqual({ enabled: false })
    await expect(loadSubscriptionCapabilities()).resolves.toEqual(producerBody)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce()
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe(
      '/control-api/api/v1/admin/llm/providers/capabilities'
    )
  })
})
