import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createPublicKey } from 'node:crypto'
import request from 'supertest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminSharedFilesystemsRouter } from '../src/routes/admin/sharedFilesystems.js'
import { K8sNotFoundError } from '../src/services/resourceService.js'
import {
  WFC_BROWSING_READ_SCOPE,
  WFC_BROWSING_WRITE_SCOPE,
} from '../src/utils/auth/wfcBrowsingToken.js'

/**
 * HTTP tests for the admin /shared-filesystems router. Covers:
 *   - list / get pass-throughs to the K8sGateway in mcp-host namespace
 *   - 404 handling when the SharedFileSystem doesn't exist
 *   - browsing-token mint shape, signing key, and audience claim
 *   - reverse proxy forwarding (method, body, response status)
 */

const adminAuthFromHeader = (req: express.Request): { sub: string } | null => {
  const auth = req.header('authorization') || ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m) return null
  return { sub: 'admin-test' }
}

function buildApp(gateway: K8sGateway) {
  const app = express()
  app.use(express.json())
  // Stand-in for the requireAuthForControlUI middleware that mounts in app.ts.
  // The real middleware sets req.adminAuth from a verified admin JWT; we just
  // accept any bearer token and stamp a fixed subject so the router can read it.
  app.use((req, _res, next) => {
    const auth = adminAuthFromHeader(req)
    if (auth) (req as unknown as { adminAuth: { sub: string } }).adminAuth = auth
    next()
  })
  app.use(createAdminSharedFilesystemsRouter(gateway))
  return app
}

function makeGatewayStub(overrides: Partial<K8sGateway> = {}): K8sGateway {
  return {
    listResource: vi.fn(async () => []),
    getResource: vi.fn(async () => ({}) as never),
    createResource: vi.fn(async (body: unknown) => body),
    updateResource: vi.fn(async (body: unknown) => body),
    deleteResource: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as K8sGateway
}

async function readWebStreamBody(body: unknown): Promise<string> {
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const chunks: Buffer[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('GET /admin/shared-filesystems', () => {
  it('lists from the mcp-host namespace via the gateway', async () => {
    const list = vi.fn(async () => [
      { metadata: { name: 'team-mission' }, spec: {}, status: { phase: 'Ready' } },
    ])
    const gw = makeGatewayStub({ listResource: list as never })
    const app = buildApp(gw)
    const res = await request(app)
      .get('/admin/shared-filesystems')
      .set('authorization', 'Bearer test')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(list).toHaveBeenCalledWith('sharedfilesystems', config.sharedFilesystemsNamespace)
  })
})

describe('POST /admin/shared-filesystems', () => {
  it('creates the CRD with the provided spec fields', async () => {
    const create = vi.fn(async (_plural, body: unknown) => body)
    const app = buildApp(makeGatewayStub({ createResource: create as never }))
    const res = await request(app)
      .post('/admin/shared-filesystems')
      .set('authorization', 'Bearer test')
      .send({
        name: 'team-mission',
        size: '5Gi',
        accessModes: ['ReadWriteMany'],
        directories: ['docs'],
        retainOnDelete: true,
      })
    expect(res.status).toBe(201)
    expect(create).toHaveBeenCalledWith(
      'sharedfilesystems',
      expect.objectContaining({
        metadata: { name: 'team-mission' },
        spec: expect.objectContaining({
          size: '5Gi',
          accessModes: ['ReadWriteMany'],
          directories: ['docs'],
          retainOnDelete: true,
        }),
      }),
      config.sharedFilesystemsNamespace
    )
  })

  it('400s when name is missing or invalid', async () => {
    const app = buildApp(makeGatewayStub())
    const res = await request(app)
      .post('/admin/shared-filesystems')
      .set('authorization', 'Bearer test')
      .send({ size: '5Gi' })
    expect(res.status).toBe(400)
  })

  it('returns 409 if a SharedFileSystem with the same name already exists', async () => {
    const create = vi.fn(async () => {
      throw new Error('SharedFileSystem already exists in namespace')
    })
    const app = buildApp(makeGatewayStub({ createResource: create as never }))
    const res = await request(app)
      .post('/admin/shared-filesystems')
      .set('authorization', 'Bearer test')
      .send({ name: 'dup' })
    expect(res.status).toBe(409)
  })
})

describe('DELETE /admin/shared-filesystems/:name', () => {
  it('204s on success', async () => {
    const del = vi.fn(async () => ({ ok: true }))
    const app = buildApp(makeGatewayStub({ deleteResource: del as never }))
    const res = await request(app)
      .delete('/admin/shared-filesystems/team-mission')
      .set('authorization', 'Bearer test')
    expect(res.status).toBe(204)
    expect(del).toHaveBeenCalledWith(
      'sharedfilesystems',
      'team-mission',
      config.sharedFilesystemsNamespace
    )
  })

  it('404s when missing', async () => {
    const del = vi.fn(async () => {
      throw new K8sNotFoundError('not found')
    })
    const app = buildApp(makeGatewayStub({ deleteResource: del as never }))
    const res = await request(app)
      .delete('/admin/shared-filesystems/missing')
      .set('authorization', 'Bearer test')
    expect(res.status).toBe(404)
  })
})

describe('GET /admin/shared-filesystems/:name', () => {
  it('returns the CRD body on success', async () => {
    const get = vi.fn(async () => ({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'SharedFileSystem',
      metadata: { name: 'team-mission', namespace: 'mcp-host' },
      spec: { size: '5Gi' },
      status: { phase: 'Ready' },
    }))
    const app = buildApp(makeGatewayStub({ getResource: get as never }))
    const res = await request(app)
      .get('/admin/shared-filesystems/team-mission')
      .set('authorization', 'Bearer test')
    expect(res.status).toBe(200)
    expect(res.body.metadata.name).toBe('team-mission')
    expect(res.body.status.phase).toBe('Ready')
    expect(get).toHaveBeenCalledWith(
      'sharedfilesystems',
      'team-mission',
      config.sharedFilesystemsNamespace
    )
  })

  it('404s when the CRD is missing', async () => {
    const get = vi.fn(async () => {
      throw new K8sNotFoundError('not found')
    })
    const app = buildApp(makeGatewayStub({ getResource: get as never }))
    const res = await request(app)
      .get('/admin/shared-filesystems/missing')
      .set('authorization', 'Bearer test')
    expect(res.status).toBe(404)
  })
})

describe('POST /admin/shared-filesystems/:name/token', () => {
  it('mints a browsing JWT with the expected claims', async () => {
    const get = vi.fn(async () => ({
      metadata: { name: 'team-mission', namespace: 'mcp-host' },
      spec: {},
    }))
    const app = buildApp(makeGatewayStub({ getResource: get as never }))
    const res = await request(app)
      .post('/admin/shared-filesystems/team-mission/token')
      .set('authorization', 'Bearer test')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      audience: config.wfcJwtAudience,
      expiresInSeconds: config.wfcTokenTtlSeconds,
    })
    expect(typeof res.body.token).toBe('string')
    expect(res.body.serviceUrl).toMatch(/^http:\/\/wfc-[a-f0-9]{10}\.mcp-host\.svc/)

    // Verify the signature with the public key derived from the dev signing
    // key — the wfc verifier uses the public counterpart at runtime.
    const pubKey = createPublicKey(config.rpcJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    }) as string
    const decoded = jwt.verify(res.body.token, pubKey, {
      algorithms: ['RS256'],
      audience: config.wfcJwtAudience,
      issuer: config.rpcJwtIssuer,
    }) as Record<string, unknown>
    expect(decoded.sharedFileSystem).toBe('team-mission')
    expect(decoded.sharedFileSystemNamespace).toBe(config.sharedFilesystemsNamespace)
    expect(decoded.scopes).toEqual([WFC_BROWSING_READ_SCOPE, WFC_BROWSING_WRITE_SCOPE])
    expect(decoded.sub).toBe('admin-test')
  })

  it('mints a browsing JWT with requested restricted scopes', async () => {
    const get = vi.fn(async () => ({
      metadata: { name: 'team-mission', namespace: 'mcp-host' },
      spec: {},
    }))
    const app = buildApp(makeGatewayStub({ getResource: get as never }))
    const res = await request(app)
      .post('/admin/shared-filesystems/team-mission/token')
      .set('authorization', 'Bearer test')
      .send({ scopes: [WFC_BROWSING_READ_SCOPE] })
    expect(res.status).toBe(200)

    const pubKey = createPublicKey(config.rpcJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    }) as string
    const decoded = jwt.verify(res.body.token, pubKey, {
      algorithms: ['RS256'],
      audience: config.wfcJwtAudience,
      issuer: config.rpcJwtIssuer,
    }) as Record<string, unknown>
    expect(decoded.sharedFileSystem).toBe('team-mission')
    expect(decoded.sharedFileSystemNamespace).toBe(config.sharedFilesystemsNamespace)
    expect(decoded.scopes).toEqual([WFC_BROWSING_READ_SCOPE])
  })

  it('rejects invalid requested browsing scopes', async () => {
    const get = vi.fn(async () => ({
      metadata: { name: 'team-mission', namespace: 'mcp-host' },
      spec: {},
    }))
    const app = buildApp(makeGatewayStub({ getResource: get as never }))

    for (const scopes of [
      [],
      ['files:admin'],
      [WFC_BROWSING_READ_SCOPE, WFC_BROWSING_READ_SCOPE],
    ]) {
      const res = await request(app)
        .post('/admin/shared-filesystems/team-mission/token')
        .set('authorization', 'Bearer test')
        .send({ scopes })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_wfc_browsing_scopes')
    }
  })

  it('refuses to mint a token if the SharedFileSystem does not exist (404)', async () => {
    const get = vi.fn(async () => {
      throw new K8sNotFoundError('not found')
    })
    const app = buildApp(makeGatewayStub({ getResource: get as never }))
    const res = await request(app)
      .post('/admin/shared-filesystems/missing/token')
      .set('authorization', 'Bearer test')
    expect(res.status).toBe(404)
  })
})

describe('* /admin/shared-filesystems/:name/proxy', () => {
  // Forwards request to a stand-in fetch; the real upstream is the per-SFS
  // wfc Service. We swap config.wfcServiceUrlTemplate at module level via
  // monkey-patching `globalThis.fetch` so the proxy's fetch lands on us.
  it('forwards GET with auth header and returns the upstream body', async () => {
    const fetchSpy = vi.fn(
      async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
        expect(init.method).toBe('GET')
        // Proxy must NOT forward the admin token; it mints a per-SFS browsing
        // JWT server-side. We assert it minted *something* and that it is not
        // the admin token the browser sent in.
        const auth = init.headers?.['authorization'] ?? ''
        expect(auth).toMatch(/^Bearer eyJ/)
        expect(auth).not.toBe('Bearer admin-token')
        const body = JSON.stringify({ ok: true, data: { entries: [] } })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        })
      }
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const app = buildApp(makeGatewayStub())
      const res = await request(app)
        .get('/admin/shared-filesystems/team-mission/proxy/v1/files')
        .set('authorization', 'Bearer admin-token')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const calledUrl = fetchSpy.mock.calls[0][0] as string
      expect(calledUrl).toMatch(/\/v1\/files$/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('forwards JSON POST body to the upstream', async () => {
    const fetchSpy = vi.fn(
      async (
        _url: string,
        init: { method?: string; body?: string; headers?: Record<string, string> }
      ) => {
        expect(init.method).toBe('POST')
        expect(init.body).toBe(JSON.stringify({ path: 'docs' }))
        expect(init.headers?.['content-type']).toContain('application/json')
        return new Response(JSON.stringify({ ok: true, data: { path: 'docs' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const app = buildApp(makeGatewayStub())
      const res = await request(app)
        .post('/admin/shared-filesystems/team-mission/proxy/v1/files/mkdir')
        .set('authorization', 'Bearer admin-token')
        .send({ path: 'docs' })
      expect(res.status).toBe(201)
      expect(res.body.data.path).toBe('docs')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('forwards multipart POST body to the upstream as a readable stream', async () => {
    const fetchSpy = vi.fn(
      async (
        _url: string,
        init: { method?: string; body?: unknown; headers?: Record<string, string> }
      ) => {
        expect(init.method).toBe('POST')
        expect(init.headers?.['content-type']).toContain('multipart/form-data')
        const body = await readWebStreamBody(init.body)
        expect(body).toContain('name="path"')
        expect(body).toContain('docs/probe.txt')
        expect(body).toContain('hello multipart')
        return new Response(JSON.stringify({ ok: true, data: { path: 'docs/probe.txt' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const app = buildApp(makeGatewayStub())
      const res = await request(app)
        .post('/admin/shared-filesystems/team-mission/proxy/v1/files/upload')
        .set('authorization', 'Bearer admin-token')
        .field('path', 'docs/probe.txt')
        .attach('file', Buffer.from('hello multipart'), 'probe.txt')
      expect(res.status).toBe(201)
      expect(res.body.data.path).toBe('docs/probe.txt')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('mints a fresh browsing token bound to the SharedFileSystem in the path', async () => {
    let capturedAuth = ''
    const fetchSpy = vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      capturedAuth = init.headers?.['authorization'] ?? ''
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const app = buildApp(makeGatewayStub())
      await request(app)
        .get('/admin/shared-filesystems/team-mission/proxy/v1/files')
        .set('authorization', 'Bearer admin-token')
    } finally {
      globalThis.fetch = originalFetch
    }
    const token = capturedAuth.replace(/^Bearer\s+/, '')
    const pubKey = createPublicKey(config.rpcJwtPrivateKey).export({
      type: 'spki',
      format: 'pem',
    }) as string
    const decoded = jwt.verify(token, pubKey, {
      algorithms: ['RS256'],
      audience: config.wfcJwtAudience,
      issuer: config.rpcJwtIssuer,
    }) as Record<string, unknown>
    expect(decoded.sharedFileSystem).toBe('team-mission')
    expect(decoded.sharedFileSystemNamespace).toBe(config.sharedFilesystemsNamespace)
    expect(decoded.scopes).toEqual([WFC_BROWSING_READ_SCOPE, WFC_BROWSING_WRITE_SCOPE])
    expect(decoded.sub).toBe('admin-test')
  })

  it('propagates upstream non-2xx', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'x' } }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }
      )
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const app = buildApp(makeGatewayStub())
      const res = await request(app)
        .get('/admin/shared-filesystems/team-mission/proxy/v1/files')
        .set('authorization', 'Bearer expired')
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('unauthorized')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
