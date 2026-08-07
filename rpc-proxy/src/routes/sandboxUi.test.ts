import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../config.js'
import { _clearSandboxUiRegistryCache } from '../services/sandboxUiRegistry.js'
import { createSandboxUiSession, verifySandboxUiSession } from '../services/sandboxUiSession.js'
import { createSandboxUiSessionRouter, rewriteLocationHeader } from './sandboxUi.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))
vi.mock('../authToken.js', () => authTokenMock)

const httpProxyMock = vi.hoisted(() => {
  const events = new Map<string, ((...args: unknown[]) => void)[]>()
  const web = vi.fn()
  const proxy = {
    web,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = events.get(event) ?? []
      list.push(cb)
      events.set(event, list)
    }),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = events.get(event) ?? []
      list.push(cb)
      events.set(event, list)
    }),
    off: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = events.get(event) ?? []
      events.set(
        event,
        list.filter(fn => fn !== cb)
      )
    }),
    emit: (event: string, ...args: unknown[]) => {
      const list = events.get(event) ?? []
      for (const fn of list) fn(...args)
    },
    _clearListeners: () => events.clear(),
  }
  return {
    default: { createProxyServer: () => proxy },
    _proxy: proxy,
  }
})
vi.mock('http-proxy', () => httpProxyMock)

const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['sandbox:ui:view'],
  hostRefs: ['ignored-for-sandbox-ui'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const USER_SCOPED_CLAIMS = {
  ...VALID_CLAIMS,
  accessScope: 'user' as const,
  teamId: null,
  hostRefs: ['sandbox-ui'],
}

const fetchSpy = vi.fn()

function makeApp() {
  const app = express()
  app.use(express.json())
  // Mount under /api/v1 so the cookie Path attribute matches the runtime mount.
  app.use('/api/v1', createSandboxUiSessionRouter())
  return app
}

const REGISTRY_OK = {
  appRef: 'sandbox-recipes/r1',
  service: { name: 'web', namespace: config.sandboxUiNamespace, port: 8080 },
  ready: true,
  defaultPath: '/',
}

beforeEach(() => {
  authTokenMock.verifyRpcToken.mockReset()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
  _clearSandboxUiRegistryCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/v1/sandbox-ui/:ns/:name/session', () => {
  it('returns 401 without a bearer token', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(null)
    await request(makeApp()).post('/api/v1/sandbox-ui/sandbox-recipes/r1/session').expect(401)
  })

  it('returns 401 when the JWT is invalid', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(null)
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer bad-token')
      .expect(401)
  })

  it('returns 403 when the JWT lacks sandbox:ui:view', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['desktop:view'],
    })
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer scoped-token')
      .expect(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 404 when the registry says the recipe is missing', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'recipe_not_found' }))
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer t')
      .expect(404)
  })

  it('returns 403 when the registry rejects the user-bound ACL check', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, { error: 'recipe_acl_denied' }))
    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer t')
      .expect(403)
    expect(res.body.error).toBe('recipe_acl_denied')
  })

  it('returns 409 when the registry says the recipe is not yet ready', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(409, { error: 'recipe_not_ready', reason: 'phase is "deploying"' })
    )
    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer t')
      .expect(409)
    expect(res.body.reason).toBe('phase is "deploying"')
  })

  it('returns 500 when the registry lookup fails', async () => {
    fetchSpy.mockRejectedValue(new Error('connect timeout'))
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer t')
      .expect(500)
  })

  it('returns 204 with a signed Set-Cookie on the happy path', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, REGISTRY_OK))
    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer t')
      .expect(204)

    const cookies = res.headers['set-cookie'] as unknown
    const cookieList = Array.isArray(cookies) ? cookies : cookies ? [String(cookies)] : []
    expect(cookieList).toHaveLength(1)
    const cookie = cookieList[0]
    expect(cookie).toContain(`${config.sandboxUiCookieName}=`)
    expect(cookie).toContain('Path=/api/v1/sandbox-ui/sandbox-recipes/r1/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain(`Max-Age=${config.sandboxUiCookieMaxAgeSec}`)

    // Cookie value verifies and binds to (recipeNs, recipeName)
    const value = cookie.split(';')[0].split('=', 2)[1]
    const claims = verifySandboxUiSession(value, 'sandbox-recipes', 'r1')
    expect(claims).not.toBeNull()
    expect(claims!.sub).toBe(VALID_CLAIMS.sub)
  })

  it('forwards the user and team ids to control-api for the per-recipe ACL check', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, REGISTRY_OK))
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer t')
      .expect(204)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain(`forUser=${encodeURIComponent(VALID_CLAIMS.sub)}`)
    expect(url).toContain(`forTeam=${encodeURIComponent(VALID_CLAIMS.teamId)}`)
  })

  it('allows user-scoped tokens and omits team ids from the ACL check', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(USER_SCOPED_CLAIMS)
    fetchSpy.mockResolvedValue(jsonResponse(200, REGISTRY_OK))

    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/session')
      .set('Authorization', 'Bearer t')
      .expect(204)

    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain(`forUser=${encodeURIComponent(USER_SCOPED_CLAIMS.sub)}`)
    expect(url).not.toContain('forTeam=')
  })
})

// ─── OAuth authorize-url passthrough (spec §9.9) ───────────────────
describe('POST /api/v1/sandbox-ui/:ns/:name/oauth/authorize-url', () => {
  it('returns 401 without a bearer token', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(null)
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .send({ oauthClientId: 'sf' })
      .expect(401)
  })

  it('returns 403 when the JWT lacks sandbox:ui:view', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['desktop:view'],
    })
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'sf' })
      .expect(403)
  })

  it('returns 400 when oauthClientId is missing', async () => {
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({})
      .expect(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 404 when the registry says the recipe is missing', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(404, { error: 'recipe_not_found' }))
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'sf' })
      .expect(404)
  })

  it('returns 403 when the registry denies the per-user ACL check', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(403, { error: 'recipe_acl_denied' }))
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'sf' })
      .expect(403)
  })

  it('forwards 200 { authorizeUrl } from control-api to the desktop caller', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, REGISTRY_OK)).mockResolvedValueOnce(
      jsonResponse(200, {
        authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize?...',
      })
    )

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'salesforce-prod' })
      .expect(200)

    expect(res.body.authorizeUrl).toBe('https://login.salesforce.com/services/oauth2/authorize?...')

    // Second call is the control-api forward — verify body shape.
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit]
    expect(url).toContain('/internal/sandbox-ui/oauth/authorize-url')
    const parsedBody = JSON.parse(String(init.body)) as Record<string, string>
    expect(parsedBody.recipeNs).toBe('sandbox-recipes')
    expect(parsedBody.recipeName).toBe('r1')
    expect(parsedBody.oauthClientId).toBe('salesforce-prod')
    expect(parsedBody.userId).toBe(VALID_CLAIMS.sub)
    // redirect_uri is STABLE: control-api's public URL + /oauth-callback/{oauthClientId}
    // only. The recipe ns/name no longer appear (recovered from the signed state on
    // callback), so one redirect URI per client is registered regardless of instance.
    expect(parsedBody.redirectUri).toMatch(/\/api\/v1\/oauth-callback\/salesforce-prod$/)
    expect(parsedBody.redirectUri).not.toContain('sandbox-recipes')
    expect(parsedBody.redirectUri).not.toContain('/r1')
  })

  it('allows user-scoped tokens and omits team ids from the authorize-url ACL check', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(USER_SCOPED_CLAIMS)
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, REGISTRY_OK)).mockResolvedValueOnce(
      jsonResponse(200, {
        authorizeUrl: 'https://login.example.test/oauth',
      })
    )

    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'salesforce-prod' })
      .expect(200)

    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain(`forUser=${encodeURIComponent(USER_SCOPED_CLAIMS.sub)}`)
    expect(url).not.toContain('forTeam=')
  })

  it('coerces 401/403 from control-api to 502 (service-token misconfig is not a user error)', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(200, REGISTRY_OK))
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_service_token' }))

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('control_api_auth_failed')
  })

  it('forwards control-api 4xx errors verbatim (recipe_not_found / unknown_oauth_client / …)', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(200, REGISTRY_OK))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'unknown_oauth_client' }))

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'wat' })
      .expect(400)
    expect(res.body.error).toBe('unknown_oauth_client')
  })

  it('returns 502 when control-api returns 200 without authorizeUrl', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(200, REGISTRY_OK))
      .mockResolvedValueOnce(jsonResponse(200, { wat: 'no authorizeUrl key' }))

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('control_api_invalid_response')
  })

  it('returns 502 when control-api is unreachable', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(200, REGISTRY_OK))
      .mockRejectedValueOnce(new Error('connect timeout'))

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('control_api_unreachable')
  })

  it('includes background:true in the control-api payload when the body sets it', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(200, REGISTRY_OK))
      .mockResolvedValueOnce(
        jsonResponse(200, { authorizeUrl: 'https://accounts.google.com/oauth?...' })
      )

    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'google-gmail', background: true })
      .expect(200)

    // Second call is the control-api forward
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit]
    const parsedBody = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(parsedBody.background).toBe(true)
    // userId must come from req.auth.sub (not the body)
    expect(parsedBody.userId).toBe(VALID_CLAIMS.sub)
  })

  it('includes background:false in the control-api payload when background is omitted', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(200, REGISTRY_OK))
      .mockResolvedValueOnce(
        jsonResponse(200, { authorizeUrl: 'https://accounts.google.com/oauth?...' })
      )

    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/authorize-url')
      .set('Authorization', 'Bearer t')
      .send({ oauthClientId: 'google-gmail' })
      .expect(200)

    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit]
    const parsedBody = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(parsedBody.background).toBe(false)
  })
})

// ─── OAuth token passthrough (spec §9.9, embed-side cookie-auth) ───
describe('POST /api/v1/sandbox-ui/:ns/:name/oauth/token', () => {
  const issueCookie = (recipeNs = 'sandbox-recipes', recipeName = 'r1') =>
    createSandboxUiSession(VALID_CLAIMS.sub, recipeNs, recipeName)

  it('returns 401 when the sandbox-ui cookie is missing', async () => {
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .send({ oauthClientId: 'sf' })
      .expect(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 401 when the cookie value is invalid', async () => {
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=garbage`)
      .send({ oauthClientId: 'sf' })
      .expect(401)
  })

  it('returns 401 when the cookie was minted for a different recipe (claim binding)', async () => {
    const cookie = issueCookie('sandbox-recipes', 'OTHER-RECIPE')
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(401)
  })

  it('returns 400 when oauthClientId is missing', async () => {
    const cookie = issueCookie()
    await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({})
      .expect(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards 200 { accessToken, expiresAt } from control-api to the embed', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, { accessToken: 'AT-1234', expiresAt: '2026-01-01T00:00:00Z' })
    )
    const cookie = issueCookie()

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'salesforce-prod' })
      .expect(200)

    expect(res.body.accessToken).toBe('AT-1234')
    expect(res.body.expiresAt).toBe('2026-01-01T00:00:00Z')

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/internal/sandbox-ui/oauth/token')
    const parsedBody = JSON.parse(String(init.body)) as Record<string, string>
    // userId comes from the cookie's `sub`, NOT the body — so a malicious
    // page that somehow stole the cookie cannot mint tokens for another user.
    expect(parsedBody.userId).toBe(VALID_CLAIMS.sub)
    expect(parsedBody.recipeNs).toBe('sandbox-recipes')
    expect(parsedBody.recipeName).toBe('r1')
    expect(parsedBody.oauthClientId).toBe('salesforce-prod')
  })

  it('returns null expiresAt when control-api omits it (Slack bot tokens never expire)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { accessToken: 'AT', expiresAt: null }))
    const cookie = issueCookie()

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'slack-bot' })
      .expect(200)
    expect(res.body.expiresAt).toBeNull()
  })

  it('forwards 404 no_grant verbatim (caller treats as needs-reauth)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(404, { error: 'no_grant' }))
    const cookie = issueCookie()

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(404)
    expect(res.body.error).toBe('no_grant')
  })

  it('forwards 502 refresh_failed (provider rejected the refresh token)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(502, { error: 'refresh_failed', status: 401, detail: 'invalid_grant' })
    )
    const cookie = issueCookie()

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('refresh_failed')
  })

  it('coerces 401/403 from control-api to 502 (service-token misconfig)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(403, { error: 'invalid_service_token' }))
    const cookie = issueCookie()

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('control_api_auth_failed')
  })

  it('returns 502 when control-api is unreachable', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('connect timeout'))
    const cookie = issueCookie()

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('control_api_unreachable')
  })

  it('returns 502 when control-api returns 200 without accessToken', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { wat: 'no accessToken' }))
    const cookie = issueCookie()

    const res = await request(makeApp())
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('control_api_invalid_response')
  })
})

// ─── OAuth disconnect (spec §9.9, embed-side cookie-auth) ──────────
describe('DELETE /api/v1/sandbox-ui/:ns/:name/oauth/grant', () => {
  const issueCookie = (recipeNs = 'sandbox-recipes', recipeName = 'r1') =>
    createSandboxUiSession(VALID_CLAIMS.sub, recipeNs, recipeName)

  it('returns 401 when the sandbox-ui cookie is missing', async () => {
    await request(makeApp())
      .delete('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/grant')
      .send({ oauthClientId: 'sf' })
      .expect(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 401 when the cookie was minted for a different recipe', async () => {
    const cookie = issueCookie('sandbox-recipes', 'OTHER-RECIPE')
    await request(makeApp())
      .delete('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/grant')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(401)
  })

  it('returns 400 when oauthClientId is missing', async () => {
    const cookie = issueCookie()
    await request(makeApp())
      .delete('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/grant')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({})
      .expect(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards 204 from control-api to the embed', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const cookie = issueCookie()

    await request(makeApp())
      .delete('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/grant')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'salesforce-prod' })
      .expect(204)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/internal/sandbox-ui/oauth/grant')
    expect(init.method).toBe('DELETE')
    const parsedBody = JSON.parse(String(init.body)) as Record<string, string>
    // userId comes from the cookie's `sub`, not the body — same defence
    // as the token endpoint.
    expect(parsedBody.userId).toBe(VALID_CLAIMS.sub)
    expect(parsedBody.recipeNs).toBe('sandbox-recipes')
    expect(parsedBody.recipeName).toBe('r1')
    expect(parsedBody.oauthClientId).toBe('salesforce-prod')
  })

  it('coerces 401/403 from control-api to 502 (service-token misconfig)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(403, { error: 'invalid_service_token' }))
    const cookie = issueCookie()

    const res = await request(makeApp())
      .delete('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/grant')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('control_api_auth_failed')
  })

  it('returns 502 when control-api is unreachable', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('connect timeout'))
    const cookie = issueCookie()

    const res = await request(makeApp())
      .delete('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/grant')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .send({ oauthClientId: 'sf' })
      .expect(502)
    expect(res.body.error).toBe('control_api_unreachable')
  })
})

// ─── view/* reverse proxy ──────────────────────────────────────────

describe('ANY /api/v1/sandbox-ui/:ns/:name/view/*', () => {
  function viewApp() {
    return makeApp()
  }

  function cookieHeader(ns: string, name: string, sub = 'u-1'): string {
    const value = createSandboxUiSession(sub, ns, name)
    return `${config.sandboxUiCookieName}=${value}`
  }

  beforeEach(() => {
    httpProxyMock._proxy._clearListeners()
    httpProxyMock._proxy.web.mockReset()
    fetchSpy.mockResolvedValue(jsonResponse(200, REGISTRY_OK))
  })

  it('rejects WebSocket upgrades with 426 (spec §9.5)', async () => {
    const res = await request(viewApp())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/anywhere')
      .set('Cookie', cookieHeader('sandbox-recipes', 'r1'))
      .set('Connection', 'Upgrade')
      .set('Upgrade', 'websocket')
      .expect(426)
    expect(res.body.code).toBe('websocket_not_supported')
    expect(httpProxyMock._proxy.web).not.toHaveBeenCalled()
  })

  it('rejects requests without a session cookie with 401', async () => {
    await request(viewApp()).get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/').expect(401)
    expect(httpProxyMock._proxy.web).not.toHaveBeenCalled()
  })

  it('rejects a cookie minted for a different recipe with 401', async () => {
    await request(viewApp())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/')
      // cookie was minted for r2
      .set('Cookie', cookieHeader('sandbox-recipes', 'r2'))
      .expect(401)
    expect(httpProxyMock._proxy.web).not.toHaveBeenCalled()
  })

  it('rejects a path-traversal attempt with 400 BEFORE proxying', async () => {
    await request(viewApp())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/..%2Fetc%2Fpasswd')
      .set('Cookie', cookieHeader('sandbox-recipes', 'r1'))
      .expect(400)
    expect(httpProxyMock._proxy.web).not.toHaveBeenCalled()
  })

  it('returns 410 with JSON when client sends Accept: application/json', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'recipe_not_found' }))
    const res = await request(viewApp())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/')
      .set('Cookie', cookieHeader('sandbox-recipes', 'r1'))
      .set('Accept', 'application/json')
      .expect(410)
    expect(res.body.error).toBe('recipe_gone')
  })

  it('returns 410 with the styled HTML page when the WebContentsView (Accept: text/html) lands here', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'recipe_not_found' }))
    const res = await request(viewApp())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/')
      .set('Cookie', cookieHeader('sandbox-recipes', 'r1'))
      .set('Accept', 'text/html,application/xhtml+xml')
      .expect(410)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('sandbox-recipes/r1')
    expect(res.text).toContain('no longer available')
  })

  it('returns 503 with JSON when client sends Accept: application/json', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(409, { error: 'recipe_not_ready', reason: 'phase=deploying' })
    )
    const res = await request(viewApp())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/')
      .set('Cookie', cookieHeader('sandbox-recipes', 'r1'))
      .set('Accept', 'application/json')
      .expect(503)
    expect(res.body.error).toBe('recipe_updating')
    expect(res.body.reason).toBe('phase=deploying')
  })

  it('returns 503 with the styled HTML page and a Retry-After header for browser clients', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(409, { error: 'recipe_not_ready', reason: 'phase=deploying' })
    )
    const res = await request(viewApp())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/')
      .set('Cookie', cookieHeader('sandbox-recipes', 'r1'))
      .set('Accept', 'text/html')
      .expect(503)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['retry-after']).toBe('5')
    expect(res.text).toContain('sandbox-recipes/r1')
    expect(res.text).toContain('updating')
  })

  it('proxies the request to the upstream Service in sandbox-ui on the happy path', async () => {
    // The proxy mock would otherwise leave the response hanging; close it so
    // supertest sees a 200 and we can assert on the mock's call args.
    httpProxyMock._proxy.web.mockImplementation(
      (_req: unknown, res: { status: (n: number) => { end: () => void } }) => {
        res.status(200).end()
      }
    )

    await request(viewApp())
      .get('/api/v1/sandbox-ui/sandbox-recipes/r1/view/dashboard?x=1')
      .set('Cookie', cookieHeader('sandbox-recipes', 'r1'))
      .expect(200)
    expect(httpProxyMock._proxy.web).toHaveBeenCalledTimes(1)
    const [reqArg, , opts] = httpProxyMock._proxy.web.mock.calls[0] as [
      { url?: string; headers: Record<string, unknown> },
      unknown,
      { target: string },
    ]
    expect(opts.target).toBe(`http://web.${config.sandboxUiNamespace}.svc.cluster.local:8080`)
    expect(reqArg.url).toBe('/dashboard?x=1')
    // Strip step: the inbound request map no longer carries cookie /
    // authorization headers when http-proxy receives it.
    expect(reqArg.headers.cookie).toBeUndefined()
    expect(reqArg.headers.authorization).toBeUndefined()
  })
})

// ─── GET /api/v1/sandbox-ui/apps ───────────────────────────────────

describe('GET /api/v1/sandbox-ui/apps', () => {
  beforeEach(() => {
    httpProxyMock._proxy._clearListeners()
    httpProxyMock._proxy.web.mockReset()
  })

  it('returns 401 without a bearer token', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(null)
    await request(makeApp()).get('/api/v1/sandbox-ui/apps').expect(401)
  })

  it('returns 403 when the JWT lacks sandbox:ui:view', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      ...VALID_CLAIMS,
      scopes: ['desktop:view'],
    })
    await request(makeApp())
      .get('/api/v1/sandbox-ui/apps')
      .set('Authorization', 'Bearer t')
      .expect(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('forwards the user and team ids to control-api and returns the apps list', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        apps: [
          {
            appRef: 'sandbox-recipes/r1',
            title: 'App One',
            icon: 'data:image/png;base64,AAA',
            defaultPath: '/dashboard',
            ready: true,
            updatedAt: '2026-05-08T00:00:00Z',
          },
          {
            appRef: 'sandbox-recipes/r2',
            title: 'App Two',
            defaultPath: '/',
            ready: false,
            updatedAt: null,
          },
        ],
      })
    )
    const res = await request(makeApp())
      .get('/api/v1/sandbox-ui/apps')
      .set('Authorization', 'Bearer t')
      .expect(200)

    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain('/internal/sandbox-ui/apps')
    expect(url).toContain(`forUser=${encodeURIComponent(VALID_CLAIMS.sub)}`)
    expect(url).toContain(`forTeam=${encodeURIComponent(VALID_CLAIMS.teamId)}`)
    expect(res.body.apps).toHaveLength(2)
    expect(res.body.apps[0].appRef).toBe('sandbox-recipes/r1')
    expect(res.body.apps[0].ready).toBe(true)
    expect(res.body.apps[1].ready).toBe(false)
  })

  it('forwards user-scoped app listings without a team id', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(USER_SCOPED_CLAIMS)
    fetchSpy.mockResolvedValue(jsonResponse(200, { apps: [] }))

    await request(makeApp())
      .get('/api/v1/sandbox-ui/apps')
      .set('Authorization', 'Bearer t')
      .expect(200)

    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toContain(`forUser=${encodeURIComponent(USER_SCOPED_CLAIMS.sub)}`)
    expect(url).not.toContain('forTeam=')
  })

  it('returns 502 when control-api is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'))
    await request(makeApp())
      .get('/api/v1/sandbox-ui/apps')
      .set('Authorization', 'Bearer t')
      .expect(502)
  })

  it('returns 500 when control-api returns a malformed body', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { not: 'apps' }))
    await request(makeApp())
      .get('/api/v1/sandbox-ui/apps')
      .set('Authorization', 'Bearer t')
      .expect(500)
  })
})

// ─── rewriteLocationHeader (3xx redirect rewrite) ──────────────────

describe('rewriteLocationHeader', () => {
  const NS = 'sandbox-recipes'
  const NAME = 'r1'
  const HOST = 'web.sandbox-ui.svc.cluster.local:8080'

  it('prefixes a relative absolute path with the view base', () => {
    expect(rewriteLocationHeader('/foo/bar', NS, NAME, HOST)).toBe(
      '/api/v1/sandbox-ui/sandbox-recipes/r1/view/foo/bar'
    )
  })

  it('strips the upstream origin from a same-origin absolute URL', () => {
    expect(rewriteLocationHeader(`http://${HOST}/foo`, NS, NAME, HOST)).toBe(
      '/api/v1/sandbox-ui/sandbox-recipes/r1/view/foo'
    )
  })

  it('drops an off-origin redirect (returns null)', () => {
    expect(rewriteLocationHeader('https://attacker.example.com/x', NS, NAME, HOST)).toBeNull()
  })

  it('drops a protocol-relative redirect (returns null)', () => {
    expect(rewriteLocationHeader('//attacker.example.com/x', NS, NAME, HOST)).toBeNull()
  })

  it('keeps an empty string unchanged', () => {
    expect(rewriteLocationHeader('', NS, NAME, HOST)).toBe('')
  })
})
