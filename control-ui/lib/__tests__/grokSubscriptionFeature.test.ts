import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAllowedGrokVerificationUri, listGrokSubscriptionConnections } from '../grokSubscription'
import { loadGrokSubscriptionCapability } from '../grokSubscriptionFeature'

vi.mock('../grokSubscription', async importOriginal => {
  const actual = await importOriginal<typeof import('../grokSubscription')>()
  return {
    ...actual,
    listGrokSubscriptionConnections: vi.fn(),
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('loadGrokSubscriptionCapability', () => {
  it('is enabled only after the keyed connections list succeeds', async () => {
    vi.mocked(listGrokSubscriptionConnections).mockResolvedValue([])
    await expect(loadGrokSubscriptionCapability()).resolves.toEqual({ enabled: true })
  })

  it('maps a 404 or a disabled code to the disabled capability', async () => {
    vi.mocked(listGrokSubscriptionConnections).mockRejectedValueOnce({ status: 404 })
    await expect(loadGrokSubscriptionCapability()).resolves.toEqual({ enabled: false })
    vi.mocked(listGrokSubscriptionConnections).mockRejectedValueOnce({
      status: 403,
      code: 'disabled',
    })
    await expect(loadGrokSubscriptionCapability()).resolves.toEqual({ enabled: false })
  })

  it('rethrows non-disabled probe failures instead of reporting the flag as off', async () => {
    const failure = Object.assign(new Error('control-api unavailable'), { status: 500 })
    vi.mocked(listGrokSubscriptionConnections).mockRejectedValueOnce(failure)
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
    expect(isAllowedGrokVerificationUri('http://accounts.x.ai/oauth2/device')).toBe(false)
    expect(isAllowedGrokVerificationUri('https://accounts.x.ai.evil.example/oauth2/device')).toBe(
      false
    )
    expect(isAllowedGrokVerificationUri('https://evil.x.ai/oauth2/device')).toBe(false)
  })

  it('rejects other schemes, hosts and look-alike hosts', () => {
    expect(isAllowedGrokVerificationUri('http://auth.x.ai/device')).toBe(false)
    expect(isAllowedGrokVerificationUri('https://auth.x.ai.evil.example/device')).toBe(false)
    expect(isAllowedGrokVerificationUri('https://evil.example/?next=https://auth.x.ai')).toBe(false)
    expect(isAllowedGrokVerificationUri('javascript:alert(1)')).toBe(false)
    expect(isAllowedGrokVerificationUri('not a url')).toBe(false)
  })
})
