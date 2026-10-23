import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAllowedGrokVerificationUri } from '../grokSubscription'
import { loadGrokSubscriptionCapability } from '../grokSubscriptionFeature'
import { loadSubscriptionCapabilities } from '../subscriptionCapabilities'

vi.mock('../subscriptionCapabilities', () => ({
  loadSubscriptionCapabilities: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('loadGrokSubscriptionCapability', () => {
  it('reads only the shared Grok integration flag', async () => {
    vi.mocked(loadSubscriptionCapabilities).mockResolvedValue({
      providers: {
        'codex-subscription': { enabled: false },
        'grok-subscription': { enabled: true },
      },
    })
    await expect(loadGrokSubscriptionCapability()).resolves.toEqual({ enabled: true })
  })

  it('reports disabled when the integration flag is false', async () => {
    vi.mocked(loadSubscriptionCapabilities).mockResolvedValue({
      providers: {
        'codex-subscription': { enabled: true },
        'grok-subscription': { enabled: false },
      },
    })
    await expect(loadGrokSubscriptionCapability()).resolves.toEqual({ enabled: false })
  })

  it('rethrows transient discovery failures instead of reporting the flag as off', async () => {
    const failure = Object.assign(new Error('capability read unavailable'), { status: 429 })
    vi.mocked(loadSubscriptionCapabilities).mockRejectedValueOnce(failure)
    await expect(loadGrokSubscriptionCapability()).rejects.toBe(failure)
  })
})

describe('isAllowedGrokVerificationUri', () => {
  it('accepts https URIs on auth.x.ai, including the returned device path', () => {
    expect(isAllowedGrokVerificationUri('https://auth.x.ai')).toBe(true)
    expect(isAllowedGrokVerificationUri('https://auth.x.ai/device?user_code=ABCD')).toBe(true)
  })

  it('accepts the live xAI device verification page on accounts.x.ai', () => {
    expect(isAllowedGrokVerificationUri('https://accounts.x.ai/oauth2/device')).toBe(true)
    expect(isAllowedGrokVerificationUri('https://accounts.x.ai/oauth2/device?user_code=ABCD')).toBe(
      true
    )
  })

  it('rejects other schemes, hosts and look-alike hosts', () => {
    expect(isAllowedGrokVerificationUri('http://auth.x.ai/device')).toBe(false)
    expect(isAllowedGrokVerificationUri('https://auth.x.ai.evil.example/device')).toBe(false)
    expect(isAllowedGrokVerificationUri('https://evil.example/?next=https://auth.x.ai')).toBe(false)
    expect(isAllowedGrokVerificationUri('javascript:alert(1)')).toBe(false)
    expect(isAllowedGrokVerificationUri('not a url')).toBe(false)
  })
})
