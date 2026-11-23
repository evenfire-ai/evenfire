import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChildProcess, spawn } from 'node:child_process'
import http, { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_SESSION_PUBLIC_KEY, signSessionJwt, signWithWrongKey } from './helpers/jwt.js'
import { getFreePort } from './helpers/ports.js'

type ControlApiMode = 'ok' | 'unauthorized' | 'forbidden' | 'error'
type LastControlApiCall = {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
} | null

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function requestJson(
  baseUrl: string,
  endpoint: string,
  init: RequestInit = {},
  bearerToken?: string
): Promise<{ status: number; body: any; raw: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`
  }
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...init,
    headers,
  })
  const raw = await response.text()
  let body: unknown = raw
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    // noop
  }
  return { status: response.status, body, raw }
}

describe('external-rest-api e2e security suite', () => {
  let controlApiServer: http.Server | null = null
  let controlApiMode: ControlApiMode = 'ok'
  let lastControlApiCall: LastControlApiCall = null
  let externalApiProcess: ChildProcess | null = null
  let externalApiBaseUrl = ''

  beforeAll(async () => {
    const controlApiPort = await getFreePort()
    const externalApiPort = await getFreePort()
    externalApiBaseUrl = `http://127.0.0.1:${externalApiPort}`

    controlApiServer = http.createServer((req, res) => {
      void (async () => {
        if (!req.url || !req.method) {
          json(res, 400, { error: 'bad request' })
          return
        }
        const body = await readBody(req)
        lastControlApiCall = {
          method: req.method,
          path: req.url,
          headers: req.headers,
          body,
        }

        if (controlApiMode === 'unauthorized') {
          json(res, 401, { error: 'Unauthorized' })
          return
        }
        if (controlApiMode === 'forbidden') {
          json(res, 403, { error: 'Forbidden' })
          return
        }
        if (controlApiMode === 'error') {
          json(res, 500, { error: 'simulated upstream failure secret=e2e-secret' })
          return
        }

        if (req.method === 'POST' && req.url === '/api/v1/external/auth/google-login') {
          json(res, 200, {
            token: 'google-session-token',
            me: {
              id: 'user-e2e-1',
              email: 'dev@clerum.local',
              name: 'Google User',
              picture: null,
              teamId: 'team-e2e-1',
              teamName: 'best team',
              role: 'admin',
            },
            isNewUser: false,
          })
          return
        }

        if (
          req.method === 'GET' &&
          req.url.startsWith('/api/v1/external/users/') &&
          req.url.includes('/me')
        ) {
          json(res, 200, {
            id: 'user-e2e-1',
            email: 'dev@clerum.local',
            name: 'Dev User',
            picture: null,
            teamId: 'team-e2e-1',
            teamName: 'best team',
            role: 'admin',
            profile: {
              displayName: 'dev',
              channels: { emails: ['dev@clerum.local'], slackUserNames: [], telegramIds: [] },
            },
          })
          return
        }

        if (
          req.method === 'GET' &&
          req.url.startsWith('/api/v1/external/users/') &&
          req.url.endsWith('/contexts')
        ) {
          json(res, 200, { userId: 'user-e2e-1', contextIds: ['context1'] })
          return
        }

        if (
          req.method === 'GET' &&
          req.url.startsWith('/api/v1/external/users/') &&
          req.url.endsWith('/agents')
        ) {
          json(res, 200, { userId: 'user-e2e-1', agentNames: ['agent2', 'chatllm'] })
          return
        }

        if (
          req.method === 'GET' &&
          req.url.startsWith('/api/v1/external/teams/') &&
          req.url.endsWith('/contexts')
        ) {
          json(res, 200, { teamId: 'team-e2e-1', contextIds: ['context1'] })
          return
        }

        if (
          req.method === 'GET' &&
          req.url.startsWith('/api/v1/external/teams/') &&
          req.url.endsWith('/agents')
        ) {
          json(res, 200, { teamId: 'team-e2e-1', agentNames: ['agent2', 'chatllm'] })
          return
        }

        if (req.method === 'GET' && req.url.startsWith('/api/v1/external/directory/search')) {
          json(res, 200, {
            items: [{ id: 'user-e2e-2', email: 'other@clerum.local', name: 'Other' }],
          })
          return
        }

        if (req.method === 'POST' && req.url === '/api/v1/external/rpc/token') {
          const payload = body as { scopes?: unknown; hostRefs?: unknown }
          const scopes = Array.isArray(payload?.scopes) ? payload.scopes : []
          const hostRefs = Array.isArray(payload?.hostRefs) ? payload.hostRefs : []
          const hasWildcard = hostRefs.some(v => String(v).trim() === '*')
          const badScope = scopes.some(
            v =>
              ![
                'mcp:servers:list',
                'mcp:server:invoke',
                'host:health:read',
                'host:status:read',
                'host:activity:read',
                'host:message:invoke',
              ].includes(String(v))
          )
          if (hasWildcard || badScope || scopes.length === 0 || hostRefs.length === 0) {
            json(res, 403, { error: 'No permitted scopes/hostRefs for requested RPC token' })
            return
          }
          json(res, 200, {
            token: 'rpc-access-token-e2e',
            teamId: 'team-e2e-1',
            scopes,
            hostRefs,
            expiresInSeconds: 120,
          })
          return
        }

        if (
          req.method === 'PUT' &&
          req.url.startsWith('/api/v1/external/users/') &&
          req.url.endsWith('/profile')
        ) {
          const payload = body as { displayName?: string | null; channels?: unknown }
          json(res, 200, {
            userId: 'user-e2e-1',
            displayName: payload.displayName ?? null,
            channels: payload.channels ?? { emails: [], slackUserNames: [], telegramIds: [] },
          })
          return
        }

        json(res, 404, { error: `Unhandled stub route: ${req.method} ${req.url}` })
      })().catch(error => {
        json(res, 500, { error: String(error) })
      })
    })
    await new Promise<void>((resolve, reject) => {
      controlApiServer!.listen(controlApiPort, '127.0.0.1', () => resolve())
      controlApiServer!.on('error', reject)
    })

    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const externalApiDir = path.resolve(__dirname, '../../../external-rest-api')
    externalApiProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: externalApiDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        EXTERNAL_REST_API_PORT: String(externalApiPort),
        EXTERNAL_REST_API_CORS_ORIGIN: 'http://localhost:3000',
        EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'e2e-google-client-id',
        EXTERNAL_REST_API_CONTROL_API_BASE_URL: `http://127.0.0.1:${controlApiPort}/api/v1`,
        EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'e2e-service-token',
        EXTERNAL_REST_API_CONTROL_API_SERVICE_NAME: 'external-rest-api',
        EXTERNAL_REST_API_JWT_PUBLIC_KEY: TEST_SESSION_PUBLIC_KEY,
        EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
        EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const started = Date.now()
    while (Date.now() - started < 20_000) {
      try {
        const response = await fetch(`${externalApiBaseUrl}/health`)
        if (response.ok) return
      } catch {
        // wait for startup
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('external-rest-api did not start in time')
  })

  afterAll(async () => {
    if (externalApiProcess) {
      externalApiProcess.kill('SIGTERM')
      externalApiProcess = null
    }
    await new Promise<void>(resolve => {
      if (!controlApiServer) {
        resolve()
        return
      }
      controlApiServer.close(() => resolve())
    })
  })

  it('GET /health returns 200', async () => {
    const res = await requestJson(externalApiBaseUrl, '/health', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('POST /auth/google rejects missing idToken', async () => {
    const res = await requestJson(externalApiBaseUrl, '/api/v1/auth/google', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'idToken is required' })
  })

  it('rejects missing/non-bearer/oversized/malformed JWT on protected route', async () => {
    const missing = await requestJson(externalApiBaseUrl, '/api/v1/me', { method: 'GET' })
    const nonBearer = await requestJson(externalApiBaseUrl, '/api/v1/me', {
      method: 'GET',
      headers: { authorization: 'Basic abc' },
    })
    const oversized = await requestJson(
      externalApiBaseUrl,
      '/api/v1/me',
      { method: 'GET' },
      'a'.repeat(5000)
    )
    const malformed = await requestJson(
      externalApiBaseUrl,
      '/api/v1/me',
      { method: 'GET' },
      'not-a-jwt'
    )

    expect(missing.status).toBe(401)
    expect(nonBearer.status).toBe(401)
    expect(oversized.status).toBe(401)
    expect(malformed.status).toBe(401)
  })

  it('rejects wrong signature, issuer, audience, expired token, and missing claims', async () => {
    const badSig = signWithWrongKey()
    const badIss = signSessionJwt({ issuer: 'wrong-iss' })
    const badAud = signSessionJwt({ audience: 'wrong-aud' })
    const expired = signSessionJwt({
      issuedAt: Math.floor(Date.now() / 1000) - 3600,
      expiresInSeconds: 60,
    })
    const missingTeam = signSessionJwt({
      extraClaims: { teamId: undefined },
    })

    const [r1, r2, r3, r4, r5] = await Promise.all([
      requestJson(externalApiBaseUrl, '/api/v1/me', { method: 'GET' }, badSig),
      requestJson(externalApiBaseUrl, '/api/v1/me', { method: 'GET' }, badIss),
      requestJson(externalApiBaseUrl, '/api/v1/me', { method: 'GET' }, badAud),
      requestJson(externalApiBaseUrl, '/api/v1/me', { method: 'GET' }, expired),
      requestJson(externalApiBaseUrl, '/api/v1/me', { method: 'GET' }, missingTeam),
    ])

    expect(r1.status).toBe(401)
    expect(r2.status).toBe(401)
    expect(r3.status).toBe(401)
    expect(r4.status).toBe(401)
    expect(r5.status).toBe(401)
  })

  it('returns /me and forwards user claim safely to control-api', async () => {
    const token = signSessionJwt({
      userId: 'user-e2e-1',
      email: 'dev@clerum.local',
      teamId: 'team-e2e-1',
    })
    const res = await requestJson(externalApiBaseUrl, '/api/v1/me', { method: 'GET' }, token)
    expect(res.status).toBe(200)
    expect(lastControlApiCall?.path).toContain('/external/users/user-e2e-1/me')
    expect(String(lastControlApiCall?.headers['x-user-session-token'] || '')).toContain(
      token.slice(0, 20)
    )
  })

  it('enforces claim-binding on /me/profile self update', async () => {
    const token = signSessionJwt({ userId: 'user-e2e-1' })
    const forbidden = await requestJson(
      externalApiBaseUrl,
      '/api/v1/me/profile',
      {
        method: 'PUT',
        body: JSON.stringify({
          userId: 'another-user',
          displayName: 'x',
          channels: { emails: [], slackUserNames: [], telegramIds: [] },
        }),
      },
      token
    )
    expect(forbidden.status).toBe(403)
  })

  it('team and me access endpoints return authorized data', async () => {
    const token = signSessionJwt({ teamId: 'team-e2e-1', userId: 'user-e2e-1' })
    const [ctx, agents, teamCtx, teamAgents, dir] = await Promise.all([
      requestJson(externalApiBaseUrl, '/api/v1/me/contexts', { method: 'GET' }, token),
      requestJson(externalApiBaseUrl, '/api/v1/me/agents', { method: 'GET' }, token),
      requestJson(externalApiBaseUrl, '/api/v1/team/contexts', { method: 'GET' }, token),
      requestJson(externalApiBaseUrl, '/api/v1/team/agents', { method: 'GET' }, token),
      requestJson(externalApiBaseUrl, '/api/v1/directory/search?q=dev', { method: 'GET' }, token),
    ])
    expect(ctx.status).toBe(200)
    expect(agents.status).toBe(200)
    expect(teamCtx.status).toBe(200)
    expect(teamAgents.status).toBe(200)
    expect(dir.status).toBe(200)
  })

  it('rpc token brokerage succeeds for valid scopes/hostRefs and includes TTL', async () => {
    const token = signSessionJwt()
    const res = await requestJson(
      externalApiBaseUrl,
      '/api/v1/rpc/token',
      {
        method: 'POST',
        body: JSON.stringify({
          scopes: ['mcp:servers:list', 'mcp:server:invoke'],
          hostRefs: ['agent2', 'chatllm'],
        }),
      },
      token
    )
    expect(res.status).toBe(200)
    expect(res.body?.token).toBeTruthy()
    expect(Array.isArray(res.body?.scopes)).toBe(true)
    expect(Array.isArray(res.body?.hostRefs)).toBe(true)
    expect(typeof res.body?.expiresInSeconds).toBe('number')
  })

  it('rpc token brokerage rejects invalid scopes/hostRefs and wildcard hostRefs', async () => {
    const token = signSessionJwt()
    const invalidScope = await requestJson(
      externalApiBaseUrl,
      '/api/v1/rpc/token',
      {
        method: 'POST',
        body: JSON.stringify({
          scopes: ['mcp:servers:list', 'admin:all'],
          hostRefs: ['agent2'],
        }),
      },
      token
    )
    const empty = await requestJson(
      externalApiBaseUrl,
      '/api/v1/rpc/token',
      {
        method: 'POST',
        body: JSON.stringify({
          scopes: [],
          hostRefs: [],
        }),
      },
      token
    )
    const wildcard = await requestJson(
      externalApiBaseUrl,
      '/api/v1/rpc/token',
      {
        method: 'POST',
        body: JSON.stringify({
          scopes: ['mcp:servers:list'],
          hostRefs: ['*'],
        }),
      },
      token
    )
    expect(invalidScope.status).toBe(403)
    expect(empty.status).toBe(403)
    expect(wildcard.status).toBe(403)
  })

  it('maps control-api failures safely and does not leak service token', async () => {
    controlApiMode = 'error'
    const token = signSessionJwt()
    const res = await requestJson(
      externalApiBaseUrl,
      '/api/v1/me/contexts',
      { method: 'GET' },
      token
    )
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('e2e-service-token')
    controlApiMode = 'ok'
  })
})
