import { beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import crypto from 'crypto'
import http from 'http'
import jwt from 'jsonwebtoken'
import type { AddressInfo } from 'net'

// Generate RSA keypair for test tokens
let publicKey: string
let privateKey: string

beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  publicKey = pair.publicKey
  privateKey = pair.privateKey
})

function signToken(
  claims: Record<string, unknown>,
  opts?: { key?: string; algorithm?: jwt.Algorithm }
): string {
  return jwt.sign(claims, opts?.key ?? privateKey, {
    algorithm: opts?.algorithm ?? 'RS256',
    issuer: 'control-api',
    audience: 'mcp-host',
    expiresIn: '5m',
  })
}

async function createTestApp(
  scope: string,
  authEnabled: boolean,
  hostName: string = 'my-host'
): Promise<{ baseUrl: string; server: http.Server }> {
  // Dynamic import to allow config mocking
  vi.resetModules()

  // Mock config before importing middleware
  vi.doMock('../config', () => ({
    config: {
      enableAuth: authEnabled,
      authJwtPublicKey: publicKey,
      authJwtIssuer: 'control-api',
      authJwtAudience: 'mcp-host',
      hostName,
    },
  }))

  const { requireScope } = await import('../server/authMiddleware')

  const app = express()
  app.use(express.json())
  app.get('/test', requireScope(scope), (req: express.Request, res: express.Response) => {
    const auth = (req as express.Request & { auth?: unknown }).auth
    res.json({ ok: true, auth })
  })

  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const addr = server.address() as AddressInfo
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server })
    })
  })
}

describe('requireScope middleware', () => {
  describe('when auth is disabled', () => {
    it('passes through without token', async () => {
      const { baseUrl, server } = await createTestApp('host:health:read', false)
      try {
        const res = await fetch(`${baseUrl}/test`)
        expect(res.status).toBe(200)
      } finally {
        server.close()
      }
    })

    it('passes through with invalid token', async () => {
      const { baseUrl, server } = await createTestApp('host:health:read', false)
      try {
        const res = await fetch(`${baseUrl}/test`, {
          headers: { Authorization: 'Bearer garbage' },
        })
        expect(res.status).toBe(200)
      } finally {
        server.close()
      }
    })
  })

  describe('when auth is enabled', () => {
    it('returns 401 when no Authorization header', async () => {
      const { baseUrl, server } = await createTestApp('host:health:read', true)
      try {
        const res = await fetch(`${baseUrl}/test`)
        expect(res.status).toBe(401)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('Missing token')
      } finally {
        server.close()
      }
    })

    it('returns 401 when token is not Bearer format', async () => {
      const { baseUrl, server } = await createTestApp('host:health:read', true)
      try {
        const res = await fetch(`${baseUrl}/test`, {
          headers: { Authorization: 'Basic abc123' },
        })
        expect(res.status).toBe(401)
      } finally {
        server.close()
      }
    })

    it('returns 401 when token has invalid signature', async () => {
      const { baseUrl, server } = await createTestApp('host:health:read', true)
      try {
        // Sign with a different key
        const otherKey = crypto.generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        })
        const badToken = signToken(
          { sub: 'rpc-proxy', typ: 'service', scopes: ['host:health:read'] },
          { key: otherKey.privateKey }
        )
        const res = await fetch(`${baseUrl}/test`, {
          headers: { Authorization: `Bearer ${badToken}` },
        })
        expect(res.status).toBe(401)
      } finally {
        server.close()
      }
    })

    it('returns 401 when token issuer does not match', async () => {
      const { baseUrl, server } = await createTestApp('host:health:read', true)
      try {
        const token = jwt.sign(
          { sub: 'rpc-proxy', typ: 'service', scopes: ['host:health:read'] },
          privateKey,
          { algorithm: 'RS256', issuer: 'wrong-issuer', audience: 'mcp-host', expiresIn: '5m' }
        )
        const res = await fetch(`${baseUrl}/test`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(401)
      } finally {
        server.close()
      }
    })

    it('returns 401 when token audience does not match', async () => {
      const { baseUrl, server } = await createTestApp('host:health:read', true)
      try {
        const token = jwt.sign(
          { sub: 'rpc-proxy', typ: 'service', scopes: ['host:health:read'] },
          privateKey,
          { algorithm: 'RS256', issuer: 'control-api', audience: 'wrong-audience', expiresIn: '5m' }
        )
        const res = await fetch(`${baseUrl}/test`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(401)
      } finally {
        server.close()
      }
    })

    it('returns 403 when token is valid but missing required scope', async () => {
      const { baseUrl, server } = await createTestApp('host:message:invoke', true)
      try {
        const token = signToken({
          sub: 'rpc-proxy',
          typ: 'service',
          scopes: ['host:health:read'],
        })
        const res = await fetch(`${baseUrl}/test`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(403)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('Missing scope: host:message:invoke')
      } finally {
        server.close()
      }
    })

    it('returns 403 when hostRefs does not include requested host', async () => {
      // Create POST app to test body parsing
      vi.resetModules()
      vi.doMock('../config', () => ({
        config: {
          enableAuth: true,
          authJwtPublicKey: publicKey,
          authJwtIssuer: 'control-api',
          authJwtAudience: 'mcp-host',
          hostName: 'my-host',
        },
      }))
      const { requireScope } = await import('../server/authMiddleware')
      const app = express()
      app.use(express.json())
      app.post('/test', requireScope('host:message:invoke'), (_req, res) => {
        res.json({ ok: true })
      })

      const server = await new Promise<http.Server>(resolve => {
        const s = app.listen(0, () => resolve(s))
      })
      const addr = server.address() as AddressInfo
      const baseUrl = `http://127.0.0.1:${addr.port}`

      try {
        const token = signToken({
          sub: 'rpc-proxy',
          typ: 'service',
          scopes: ['host:message:invoke'],
          hostRefs: ['other-host'],
        })
        const res = await fetch(`${baseUrl}/test`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ hostRef: 'my-host' }),
        })
        expect(res.status).toBe(403)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('Host not in hostRefs')
      } finally {
        server.close()
      }
    })

    // Regression coverage for hostRefs authorization on body-less GET routes.
    // GET routes (sessions list/messages) have no body. Before the fix,
    // body.hostRef was the only thing checked, so a token bound to another
    // host could read this host's session catalog. The fix enforces
    // claims.hostRefs against config.hostName independent of body/URL.
    it('returns 403 on GET when bounded hostRefs does not include this host (no body)', async () => {
      const { baseUrl, server } = await createTestApp('host:session:read', true, 'my-host')
      try {
        const token = signToken({
          sub: 'user-attacker',
          typ: 'user',
          scopes: ['host:session:read'],
          hostRefs: ['other-host'], // bounded, but does NOT include "my-host"
        })
        const res = await fetch(`${baseUrl}/test`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(403)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('Host not in hostRefs')
      } finally {
        server.close()
      }
    })

    it('passes GET when bounded hostRefs includes this host', async () => {
      const { baseUrl, server } = await createTestApp('host:session:read', true, 'my-host')
      try {
        const token = signToken({
          sub: 'user-legit',
          typ: 'user',
          scopes: ['host:session:read'],
          hostRefs: ['my-host', 'other-host'],
        })
        const res = await fetch(`${baseUrl}/test`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(200)
      } finally {
        server.close()
      }
    })

    it('passes GET when token has wildcard hostRefs', async () => {
      const { baseUrl, server } = await createTestApp('host:session:read', true, 'my-host')
      try {
        const token = signToken({
          sub: 'rpc-proxy',
          typ: 'service',
          scopes: ['host:session:read'],
          hostRefs: ['*'],
        })
        const res = await fetch(`${baseUrl}/test`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(200)
      } finally {
        server.close()
      }
    })

    it('passes through and sets req.auth when token is valid with correct scope', async () => {
      const { baseUrl, server } = await createTestApp('host:health:read', true)
      try {
        const token = signToken({
          sub: 'rpc-proxy',
          typ: 'service',
          scopes: ['host:health:read', 'host:status:read'],
          service: 'rpc-proxy',
          teamId: 'team-1',
        })
        const res = await fetch(`${baseUrl}/test`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          ok: boolean
          auth: { sub: string; typ: string; scopes: string[]; service: string; teamId: string }
        }
        expect(body.ok).toBe(true)
        expect(body.auth.sub).toBe('rpc-proxy')
        expect(body.auth.typ).toBe('service')
        expect(body.auth.scopes).toContain('host:health:read')
        expect(body.auth.service).toBe('rpc-proxy')
        expect(body.auth.teamId).toBe('team-1')
      } finally {
        server.close()
      }
    })
  })
})
