import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { PROFILE_SESSION_COOKIE } from '../src/sessionCookie.js'

const clientMock = vi.hoisted(() => ({ controlApiRequest: vi.fn() }))
vi.mock('../src/controlApiClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/controlApiClient.js')>()
  return { ...actual, controlApiRequest: clientMock.controlApiRequest }
})

const authTokenMock = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../src/authToken.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/authToken.js')>()
  return { ...actual, verifyToken: authTokenMock.verifyToken }
})

const TRUSTED_ORIGIN = 'https://edge-fixture.example.test'

describe('POST /api/v1/invitations/desktop-authorization', () => {
  let previousCorsOrigin: typeof config.corsOrigin

  beforeEach(() => {
    clientMock.controlApiRequest.mockReset()
    authTokenMock.verifyToken.mockReset()
    // A live session: without the browser-mutation guard, the request would
    // reach control-api.
    authTokenMock.verifyToken.mockReturnValue({
      userId: 'user-1',
      email: 'member@example.invalid',
      teamId: null,
      role: 'member',
      exp: 9999999999,
    })
    previousCorsOrigin = config.corsOrigin
    config.corsOrigin = [TRUSTED_ORIGIN]
  })

  afterEach(() => {
    config.corsOrigin = previousCorsOrigin
  })

  it('refuses a cross-origin cookie request before forwarding', async () => {
    const response = await request(createApp())
      .post('/api/v1/invitations/desktop-authorization')
      .set('cookie', `${PROFILE_SESSION_COOKIE}=fixture-session-cookie`)
      .set('origin', 'https://attacker.example')
      .set('sec-fetch-site', 'cross-site')
      .send({})

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ error: { code: 'forbidden' } })
    expect(clientMock.controlApiRequest).toHaveBeenCalledTimes(0)
  })

  describe("control-api's 401", () => {
    // The real client reads control-api's answer from fetch, so the refusal header it keeps or
    // drops decides the route's answer.
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('../src/controlApiClient.js')>(
        '../src/controlApiClient.js'
      )
      clientMock.controlApiRequest.mockImplementation(actual.controlApiRequest)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function controlApiAnswers(headers: Record<string, string> = {}) {
      // control-api's bare 401 (control-api/src/routes/external/invitations.ts and
      // control-api/src/middleware/internalServiceAuth.ts write the same body).
      fetchMock = vi.fn(async () =>
        Response.json({ error: 'Unauthorized' }, { status: 401, headers })
      )
      vi.stubGlobal('fetch', fetchMock)
    }

    function authorize() {
      return request(createApp())
        .post('/api/v1/invitations/desktop-authorization')
        .set('authorization', 'Bearer fixture-token')
        .send({})
    }

    it('sends a session without an active account to sign in, not to a retryable 503', async () => {
      controlApiAnswers()

      const response = await authorize()

      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'Unauthorized' })
      expect(response.headers['retry-after']).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
      expect(new URL(url).pathname).toMatch(/\/external\/invitations\/desktop-authorization$/)
      expect(init.method).toBe('POST')
    })

    it("keeps a refusal of the edge's own service credential an outage", async () => {
      controlApiAnswers({ 'x-internal-service-auth-refusal': 'service_credential_rejected' })

      const response = await authorize()

      expect(response.status).toBe(503)
      expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 2 })
      expect(response.headers['retry-after']).toBe('2')
      expect(response.headers['x-internal-service-auth-refusal']).toBeUndefined()
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })
})
