import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { clearAdminAuthToken, setControlUIReadPrincipal } from '../../api'
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

  describe('when the confirmed principal changes while the consumer stays mounted', () => {
    const sessionOneBody = {
      providers: {
        'codex-subscription': { enabled: true },
        'grok-subscription': { enabled: false },
      },
    }
    const sessionTwoBody = {
      providers: {
        'codex-subscription': { enabled: false },
        'grok-subscription': { enabled: true },
      },
    }

    function capabilitiesResponse(body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    function deferredResponse() {
      let resolve!: (response: Response) => void
      const promise = new Promise<Response>(onResolve => {
        resolve = onResolve
      })
      return { promise, resolve }
    }

    it('drops the completed result of the previous session and loads for the new one', async () => {
      fetchMock.mockResolvedValueOnce(capabilitiesResponse(sessionOneBody))
      const consumer = renderHook(() => useSubscriptionCapabilities())
      await waitFor(() => expect(consumer.result.current.capabilities).toEqual(sessionOneBody))

      const sessionTwoRead = deferredResponse()
      fetchMock.mockReturnValueOnce(sessionTwoRead.promise)
      act(() => setControlUIReadPrincipal('admin-two', 'admin'))
      // Until the new session's read answers, nothing from the old one shows.
      await waitFor(() => expect(capabilityReads(fetchMock)).toBe(2))
      expect(consumer.result.current.capabilities).toBeNull()
      expect(consumer.result.current.loading).toBe(true)

      await act(async () => sessionTwoRead.resolve(capabilitiesResponse(sessionTwoBody)))
      await waitFor(() => expect(consumer.result.current.capabilities).toEqual(sessionTwoBody))
      expect(consumer.result.current.loading).toBe(false)
      expect(consumer.result.current.error).toBeNull()
    })

    it('replaces a read still pending for the previous session', async () => {
      const sessionOneRead = deferredResponse()
      fetchMock.mockReturnValueOnce(sessionOneRead.promise)
      const consumer = renderHook(() => useSubscriptionCapabilities())
      await waitFor(() => expect(capabilityReads(fetchMock)).toBe(1))

      fetchMock.mockResolvedValueOnce(capabilitiesResponse(sessionTwoBody))
      act(() => setControlUIReadPrincipal('admin-two', 'admin'))
      await act(async () => sessionOneRead.resolve(capabilitiesResponse(sessionOneBody)))

      // A replacement read for the new session runs and settles the consumer;
      // it never ends with unknown capabilities and no load or error.
      await waitFor(() => expect(consumer.result.current.capabilities).toEqual(sessionTwoBody))
      expect(capabilityReads(fetchMock)).toBe(2)
      expect(consumer.result.current.loading).toBe(false)
      expect(consumer.result.current.error).toBeNull()
    })

    it('waits for a confirmed session after the principal is cleared', async () => {
      fetchMock.mockResolvedValueOnce(capabilitiesResponse(sessionOneBody))
      const consumer = renderHook(() => useSubscriptionCapabilities())
      await waitFor(() => expect(consumer.result.current.capabilities).toEqual(sessionOneBody))

      act(() => clearAdminAuthToken())
      expect(consumer.result.current.capabilities).toBeNull()
      expect(consumer.result.current.loading).toBe(true)
      act(() => consumer.result.current.retry())
      expect(capabilityReads(fetchMock)).toBe(1)

      fetchMock.mockResolvedValueOnce(capabilitiesResponse(sessionTwoBody))
      act(() => setControlUIReadPrincipal('admin-two', 'admin'))
      await waitFor(() => expect(consumer.result.current.capabilities).toEqual(sessionTwoBody))
      expect(capabilityReads(fetchMock)).toBe(2)
    })
  })
})
