import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthExpiredError, setGlobalAuthErrorHandler, submitRegistryClaim } from '../api'

function makeRes(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: async () => body,
    text: async () => JSON.stringify(body ?? ''),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  // Clean up global handler so it does not leak into other tests
  setGlobalAuthErrorHandler(() => {})
})

describe('registry connect api — claim 401 overload', () => {
  it('surfaces claim_rejected (401) as a coded error instead of forcing logout', async () => {
    const handler = vi.fn()
    setGlobalAuthErrorHandler(handler)
    // A1 returns HTTP 401 { error: 'claim_rejected' } when the registry rejects
    // the claim (invalid_pop / invalid_claim_token). The wrapper must surface the
    // code so the panel can render an inline "token was rejected" message.
    fetchMock.mockResolvedValueOnce(makeRes(401, { error: 'claim_rejected' }))
    const err = await submitRegistryClaim({ claimToken: 'bad' }).catch(e => e)
    expect(err).not.toBeInstanceOf(AuthExpiredError)
    expect(err.status).toBe(401)
    expect(err.code).toBe('claim_rejected')
    // Must NOT bounce the operator to login.
    expect(handler).not.toHaveBeenCalled()
  })

  it('still forces logout on a genuine 401 (unauthorized session expiry)', async () => {
    const handler = vi.fn()
    setGlobalAuthErrorHandler(handler)
    fetchMock.mockResolvedValueOnce(makeRes(401, { error: 'unauthorized' }))
    const err = await submitRegistryClaim({ claimToken: 'x' }).catch(e => e)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(AuthExpiredError)
  })

  it('surfaces claim_expired (410) as a coded error', async () => {
    fetchMock.mockResolvedValueOnce(makeRes(410, { error: 'claim_expired' }))
    const err = await submitRegistryClaim({ claimToken: 'x' }).catch(e => e)
    expect(err.status).toBe(410)
    expect(err.code).toBe('claim_expired')
  })
})
