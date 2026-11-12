import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicKey } from 'node:crypto'
import { once } from 'node:events'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { toResponse } from '../../gfs-controller/src/api/envelope.js'
import { GfsError, type GfsErrorCode } from '../../gfs-controller/src/api/errors.js'
import { loadVerificationKey } from '../../gfs-controller/src/auth/keys.js'
import { verifyGfsToken } from '../../gfs-controller/src/auth/verify.js'
import { config } from '../src/config.js'
import { resolveExternalGfsAuthority } from '../src/gfs/externalAuthority.js'
import { mintExternalGfsReadToken, readGfsc } from '../src/gfs/externalGfsRead.js'

// Error envelopes are serialized by gfsc's own `toResponse`, the function its
// server uses for every failure. The 403 with `reason: 'principal_denied'`
// is the envelope gfsc produces for that GfsError; gfsc does not raise it on
// a principal denial yet.

const RID = '0123456789abcdef0123456789abcdef'

let server: Server
let baseUrl = ''
let nextError: GfsError | null = null
let hang = false
// Raw 2xx behaviours of a misbehaving upstream, outside gfsc's envelope.
let rawOk: 'stalled-body' | 'not-json' | null = null
let lastRequest: { url?: string; authorization?: string; requestId?: string } = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    lastRequest = {
      url: req.url,
      authorization: req.headers.authorization,
      requestId: req.headers['x-request-id'] as string | undefined,
    }
    if (hang) return
    if (rawOk === 'stalled-body') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{')
      return
    }
    if (rawOk === 'not-json') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('not json')
      return
    }
    if (!nextError) {
      res.writeHead(500).end()
      return
    }
    const { status, body } = toResponse(nextError)
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

async function readWith(
  error: GfsError | null,
  options: { signal?: AbortSignal; timeoutMs?: number; base?: string } = {}
) {
  nextError = error
  const previous = config.gfscBaseUrl
  config.gfscBaseUrl = options.base ?? baseUrl
  try {
    return await readGfsc(
      RID,
      'token-value',
      'request-id-value',
      options.signal ?? new AbortController().signal,
      options.timeoutMs ?? 2_000
    )
  } finally {
    config.gfscBaseUrl = previous
  }
}

describe('readGfsc', () => {
  it('sends the token and the request id to the stat endpoint', async () => {
    await readWith(new GfsError('not_found', 'missing'))
    expect(lastRequest).toEqual({
      url: `/v1/resources/${RID}`,
      authorization: 'Bearer token-value',
      requestId: 'request-id-value',
    })
  })

  it('flags principalDenied only for a 403 that carries that reason', async () => {
    expect(await readWith(new GfsError('forbidden', 'principal', 'principal_denied'))).toEqual({
      status: 403,
      principalDenied: true,
      responded: true,
    })
    expect(await readWith(new GfsError('forbidden', 'resource'))).toEqual({
      status: 403,
      principalDenied: false,
      responded: true,
    })
  })

  it.each([
    ['not_found', 404],
    ['gone', 410],
    ['unauthorized', 401],
  ] as const)('maps %s to %i', async (code, status) => {
    expect(
      await readWith(new GfsError(code, code, code === 'gone' ? 'resource_deleted' : undefined))
    ).toEqual({
      status,
      principalDenied: false,
      responded: true,
    })
  })

  it.each([
    'conflict',
    'rate_limited',
    'not_mounted',
    'internal',
    'path_invalid',
  ] as GfsErrorCode[])('maps %s to transient with a response', async code => {
    const result = await readWith(new GfsError(code, code))
    expect(result).toEqual({
      status: 'transient',
      httpStatus: new GfsError(code, code).status,
      principalDenied: false,
      responded: true,
    })
  })

  it('is transient without a response when gfsc is unreachable', async () => {
    expect(await readWith(null, { base: 'http://127.0.0.1:1' })).toEqual({
      status: 'transient',
      principalDenied: false,
      responded: false,
    })
  })

  it('does not call gfsc when the signal is already aborted', async () => {
    lastRequest = {}
    expect(await readWith(null, { signal: AbortSignal.abort() })).toEqual({
      status: 'transient',
      principalDenied: false,
      responded: false,
    })
    expect(lastRequest).toEqual({})
  })

  it('resolves transient at its deadline when gfsc never answers', async () => {
    hang = true
    try {
      const started = performance.now()
      expect(await readWith(null, { timeoutMs: 100 })).toEqual({
        status: 'transient',
        principalDenied: false,
        responded: false,
      })
      expect(performance.now() - started).toBeLessThan(2_000)
    } finally {
      hang = false
      server.closeAllConnections()
    }
  })

  it('resolves transient at its deadline when the 200 headers arrive but the body stalls', async () => {
    rawOk = 'stalled-body'
    try {
      const started = performance.now()
      expect(await readWith(null, { timeoutMs: 100 })).toEqual({
        status: 'transient',
        httpStatus: 200,
        principalDenied: false,
        responded: true,
      })
      expect(performance.now() - started).toBeLessThan(2_000)
    } finally {
      rawOk = null
      server.closeAllConnections()
    }
  })

  it('treats a 2xx body that is not JSON as transient', async () => {
    rawOk = 'not-json'
    try {
      expect(await readWith(null)).toEqual({
        status: 'transient',
        httpStatus: 200,
        principalDenied: false,
        responded: true,
      })
    } finally {
      rawOk = null
    }
  })

  it('resolves transient when the caller aborts mid-read', async () => {
    hang = true
    try {
      const controller = new AbortController()
      const pending = readWith(null, { signal: controller.signal, timeoutMs: 5_000 })
      setTimeout(() => controller.abort(), 50)
      expect(await pending).toEqual({
        status: 'transient',
        principalDenied: false,
        responded: false,
      })
    } finally {
      hang = false
      server.closeAllConnections()
    }
  })
})

describe('mintExternalGfsReadToken for a linked operator', () => {
  it('signs a control-admin read token with the brokered authority gfsc verifies', async () => {
    // The authority comes from the real resolver; the link row is the shape
    // gfsDesktopOperatorLinkService returns (same seam as the resolver suite).
    const authority = await resolveExternalGfsAuthority('11111111-1111-4111-8111-111111111111', {
      linkingEnabled: true,
      isDesktopUserActive: async () => true,
      resolveActiveLink: async desktopUserId => ({
        desktopUserId,
        controlAdminId: '22222222-2222-4222-8222-222222222222',
        source: 'initial_setup',
        lineageId: '33333333-3333-4333-8333-333333333333',
        generation: 4,
        desktopUserGeneration: 5,
        controlAdminGeneration: 6,
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
      }),
    })
    expect(authority.kind).toBe('linked-admin')
    const minted = await mintExternalGfsReadToken(undefined, authority, 'main')
    if (!minted) throw new Error('linked operator mint returned null')
    const publicKey = String(
      createPublicKey(config.rpcJwtPrivateKey).export({ type: 'spki', format: 'pem' })
    )
    const claims = verifyGfsToken(minted.token, {
      key: loadVerificationKey(publicKey),
      audience: config.gfsTokenAudience,
      issuer: config.rpcJwtIssuer,
    })
    expect(claims).toMatchObject({
      sub: '22222222-2222-4222-8222-222222222222',
      drive: 'main',
      scopes: ['gfs.read'],
      principalType: 'control-admin',
      authGeneration: 6,
      brokeredAuthority: {
        desktopUserId: '11111111-1111-4111-8111-111111111111',
        controlAdminId: '22222222-2222-4222-8222-222222222222',
        authoritySource: 'linked-admin',
        linkLineageId: '33333333-3333-4333-8333-333333333333',
        linkGeneration: 4,
        desktopUserGeneration: 5,
      },
    })
  })
})
