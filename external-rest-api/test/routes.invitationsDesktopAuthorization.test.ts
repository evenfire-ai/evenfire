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
})
