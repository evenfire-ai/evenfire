import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GROK_SUBSCRIPTION_API_BASE, syncGrokSubscriptionCatalog } from '../grokSubscription'

const connectionKey = 'team/grok primary'
const encodedKey = encodeURIComponent(connectionKey)

const readyConnection = {
  connectionKey,
  displayName: 'Grok primary',
  status: 'connected',
  credentialRevision: 4,
  catalogRevision: 9,
  catalogStatus: 'ready',
  catalogSyncedAt: '2026-09-22T10:00:00.000Z',
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('Grok subscription catalog sync client', () => {
  // The fixture carries exactly what the Grok branch of the route sends —
  // `{ outcome, connection }`, no counters. That is what `GrokCatalogSyncView`
  // omits them for. A fixture that invented counters would assert a producer
  // behaviour that does not exist, and would keep passing if the real response
  // ever drifted.
  it('POSTs to the connection-scoped catalog sync endpoint on the Grok base', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        outcome: 'ready',
        connection: readyConnection,
      })
    )

    const view = await syncGrokSubscriptionCatalog(connectionKey)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      `/control-api${GROK_SUBSCRIPTION_API_BASE}/connections/${encodedKey}/catalog/sync`
    )
    expect(url).toContain('/grok-subscription/')
    expect(url).not.toContain('/codex-subscription/')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()

    // `toEqual` is exact, so this also pins the absence of the counters: if the
    // sanitizer ever puts `added`/`refreshed`/`staled` back into the Grok view,
    // this line fails instead of silently handing a caller three zeros.
    expect(view).toEqual({
      outcome: 'ready',
      connection: expect.objectContaining({ connectionKey, catalogStatus: 'ready' }),
    })
  })

  it('surfaces a non-ready outcome the endpoint reports with 200 instead of hiding it', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        outcome: 'auth-rejected',
        added: 0,
        refreshed: 0,
        staled: 0,
        connection: {
          ...readyConnection,
          status: 'reauth_required',
          catalogStatus: 'auth-rejected',
        },
      })
    )

    const view = await syncGrokSubscriptionCatalog(connectionKey)

    expect(view.outcome).toBe('auth-rejected')
    expect(view.connection?.status).toBe('reauth_required')
  })

  it('propagates the endpoint error taxonomy with its status and machine code', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(409, { error: 'stale_revision' }))

    const rejection = (await syncGrokSubscriptionCatalog(connectionKey).then(
      () => null,
      (err: unknown) => err
    )) as (Error & { status?: number; code?: string }) | null

    // Liveness witness: the request was actually issued, so the rejection comes
    // from the endpoint's response and not from an unreached code path.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection?.status).toBe(409)
    expect(rejection?.code).toBe('stale_revision')
  })

  it('refuses a response that leaks a credential field instead of returning it', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        outcome: 'ready',
        added: 0,
        refreshed: 1,
        staled: 0,
        connection: { ...readyConnection, refreshToken: 'xai-refresh-token' },
      })
    )

    await expect(syncGrokSubscriptionCatalog(connectionKey)).rejects.toThrow(
      /leaked forbidden field/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
