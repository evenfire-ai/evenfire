import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { DesktopSessionService } from '../services/desktopSessionService.js'
import { createDesktopRouter, handleDesktopUpgrade, parseCookies } from './desktopProxy.js'

// ── Hoisted mocks ───────────────────────────────────────────────────
const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)

// Mock http-proxy to avoid real proxy connections
vi.mock('http-proxy', () => ({
  default: {
    createProxyServer: () => ({
      web: vi.fn(),
      ws: vi.fn(),
      on: vi.fn(),
    }),
  },
}))

// ── Helpers ─────────────────────────────────────────────────────────
const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['desktop:view'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const sessionService = new DesktopSessionService(
  'test-secret-32-chars-minimum!!',
  60_000,
  'clerum_desktop_session'
)

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createDesktopRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
    }
  )
  return app
}

/**
 * Returns a fake bearer token value and primes the `verifyRpcToken` mock
 * to resolve that token to the requested scopes/hostRefs. Keeps the test
 * surface aligned with the mock-based pattern already used in this file.
 */
function signTestJwt(scopes: string[], hostRefs: string[]): string {
  const token = `fake-jwt.${scopes.join(',')}.${hostRefs.join(',')}`
  authTokenMock.verifyRpcToken.mockImplementation((t: string) => {
    if (t !== token) return null
    return { ...VALID_CLAIMS, scopes, hostRefs }
  })
  return token
}

// ── Setup / Teardown ────────────────────────────────────────────────
const originalFetch = globalThis.fetch

beforeEach(() => {
  authTokenMock.verifyRpcToken.mockReset()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ── Tests ───────────────────────────────────────────────────────────

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    expect(parseCookies('foo=bar')).toEqual({ foo: 'bar' })
  })

  it('parses multiple cookies', () => {
    expect(parseCookies('foo=bar; baz=qux')).toEqual({ foo: 'bar', baz: 'qux' })
  })

  it('handles cookies with = in value', () => {
    expect(parseCookies('tok=abc=def')).toEqual({ tok: 'abc=def' })
  })

  it('handles empty string', () => {
    expect(parseCookies('')).toEqual({})
  })
})

describe('POST /desktop/:hostRef/session (JWT-only)', () => {
  const mockHcc = vi.fn()
  beforeEach(() => {
    mockHcc.mockReset()
    global.fetch = mockHcc as any
  })

  it('issues session cookie when desktop is running', async () => {
    mockHcc.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'running', hostRef: 'chatllm' }),
    })

    const app = makeApp()

    const token = signTestJwt(['desktop:view'], ['chatllm'])
    const res = await request(app)
      .post('/desktop/chatllm/session')
      .set('authorization', `Bearer ${token}`)
      .send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, hostRef: 'chatllm' })
    expect(res.headers['set-cookie']?.[0]).toMatch(
      /^clerum_desktop_session=.+; Path=\/api\/v1\/desktop\/chatllm; HttpOnly; SameSite=Strict; Max-Age=\d+$/
    )
    // No Secure flag in dev/test (NODE_ENV !== production); cookie must work over HTTP port-forwards.
    expect(res.headers['set-cookie']?.[0]).not.toMatch(/; Secure/)
  })

  it('adds Secure flag to session cookie when NODE_ENV=production', async () => {
    const prevEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      mockHcc.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'running', hostRef: 'chatllm' }),
      })

      const app = makeApp()
      const token = signTestJwt(['desktop:view'], ['chatllm'])
      const res = await request(app)
        .post('/desktop/chatllm/session')
        .set('authorization', `Bearer ${token}`)
        .send({})

      expect(res.status).toBe(200)
      expect(res.headers['set-cookie']?.[0]).toMatch(/; Secure;/)
    } finally {
      process.env.NODE_ENV = prevEnv
    }
    expect(mockHcc).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/desktop/chatllm'),
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('returns 503 when HCC reports desktop not running', async () => {
    mockHcc.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'inactive', hostRef: 'chatllm' }),
    })

    const app = makeApp()

    const token = signTestJwt(['desktop:view'], ['chatllm'])
    const res = await request(app)
      .post('/desktop/chatllm/session')
      .set('authorization', `Bearer ${token}`)
      .send({})

    expect(res.status).toBe(503)
    expect(res.body.error).toBe('Desktop not running')
  })

  it('returns 502 when HCC is unreachable', async () => {
    mockHcc.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const app = makeApp()

    const token = signTestJwt(['desktop:view'], ['chatllm'])
    const res = await request(app)
      .post('/desktop/chatllm/session')
      .set('authorization', `Bearer ${token}`)
      .send({})

    expect(res.status).toBe(502)
  })

  it('returns 401 when JWT is missing', async () => {
    const app = makeApp()

    const res = await request(app).post('/desktop/chatllm/session').send({})

    expect(res.status).toBe(401)
  })

  it('returns 403 when JWT lacks desktop:view scope', async () => {
    const app = makeApp()

    const token = signTestJwt(['host:status:read'], ['chatllm'])
    const res = await request(app)
      .post('/desktop/chatllm/session')
      .set('authorization', `Bearer ${token}`)
      .send({})

    expect(res.status).toBe(403)
  })

  it('returns 403 when hostRef not in JWT hostRefs', async () => {
    const app = makeApp()

    const token = signTestJwt(['desktop:view'], ['other-host'])
    const res = await request(app)
      .post('/desktop/chatllm/session')
      .set('authorization', `Bearer ${token}`)
      .send({})

    expect(res.status).toBe(403)
  })
})

describe('ALL /desktop/:hostRef/view/*', () => {
  it('returns 401 without session cookie', async () => {
    const app = makeApp()
    const res = await request(app).get('/desktop/chatllm/view/index.html')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Desktop session required')
  })

  it('returns 401 with invalid session cookie', async () => {
    const app = makeApp()
    const res = await request(app)
      .get('/desktop/chatllm/view/index.html')
      .set('Cookie', 'clerum_desktop_session=invalid.cookie')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid desktop session')
  })

  it('returns 401 when cookie hostRef does not match URL hostRef', async () => {
    const cookie = sessionService.createSession('other-host', 'user-123')
    const app = makeApp()
    const res = await request(app)
      .get('/desktop/chatllm/view/index.html')
      .set('Cookie', `clerum_desktop_session=${cookie}`)
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid desktop session')
  })
})

describe('handleDesktopUpgrade', () => {
  it('returns false for non-desktop URLs', () => {
    const req = { url: '/api/v1/rpc', headers: {} } as any
    const socket = { write: vi.fn(), destroy: vi.fn() } as any
    expect(handleDesktopUpgrade(req, socket, Buffer.alloc(0))).toBe(false)
  })

  it('destroys socket when no cookie present', () => {
    const req = {
      url: '/api/v1/desktop/chatllm/view/websockify',
      headers: {},
    } as any
    const socket = { write: vi.fn(), destroy: vi.fn() } as any
    const result = handleDesktopUpgrade(req, socket, Buffer.alloc(0))
    expect(result).toBe(true)
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n')
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('destroys socket when cookie is invalid', () => {
    const req = {
      url: '/api/v1/desktop/chatllm/view/websockify',
      headers: { cookie: 'clerum_desktop_session=bad.value' },
    } as any
    const socket = { write: vi.fn(), destroy: vi.fn() } as any
    const result = handleDesktopUpgrade(req, socket, Buffer.alloc(0))
    expect(result).toBe(true)
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 401 Unauthorized\r\n\r\n')
    expect(socket.destroy).toHaveBeenCalled()
  })
})
