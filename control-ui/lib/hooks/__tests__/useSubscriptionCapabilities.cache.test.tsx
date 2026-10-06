import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { setControlUIReadPrincipal } from '../../api'
import { __resetReadRequestCacheForTests } from '../../readRequestCache'
import { SUBSCRIPTION_CAPABILITIES_API_PATH } from '../../subscriptionCapabilities'
import { useSubscriptionCapabilities } from '../useSubscriptionCapabilities'

const capabilitiesBody = {
  providers: {
    'codex-subscription': { enabled: true },
    'grok-subscription': { enabled: true },
  },
}

function capabilityReads(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes(SUBSCRIPTION_CAPABILITIES_API_PATH)
  ).length
}

describe('useSubscriptionCapabilities with the real read cache', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetReadRequestCacheForTests()
    setControlUIReadPrincipal('admin-one', 'admin')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    __resetReadRequestCacheForTests()
    vi.unstubAllGlobals()
  })

  it('answers Retry from a result another consumer already cached instead of reading again', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    )
    const failed = renderHook(() => useSubscriptionCapabilities())
    await waitFor(() => expect(failed.result.current.error?.status).toBe(503))

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(capabilitiesBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    const recovered = renderHook(() => useSubscriptionCapabilities())
    await waitFor(() => expect(recovered.result.current.capabilities).not.toBeNull())
    expect(capabilityReads(fetchMock)).toBe(2)

    act(() => failed.result.current.retry())
    // Witness: the failed consumer recovers and shows the cached capabilities.
    await waitFor(() => expect(failed.result.current.capabilities).toEqual(capabilitiesBody))
    expect(failed.result.current.error).toBeNull()
    expect(capabilityReads(fetchMock)).toBe(2)
  })
})
