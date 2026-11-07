import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'
import type { GfsVerifiedClaims } from '../auth/verify'
import { RateLimiter } from '../quota/rateLimit'
import { GfsServingHandler, type ServingDeps } from './serve'

class FakeResponse extends Writable {
  statusCode = 0
  headers: Record<string, string> = {}
  private chunks: Buffer[] = []

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status
    if (headers) Object.assign(this.headers, headers)
    return this
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

const resourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const claims: GfsVerifiedClaims = {
  sub: '11111111-1111-4111-8111-111111111111',
  drive: 'main',
  scopes: ['gfs.read'],
  pathBindings: [],
  principalType: 'user',
  authGeneration: 1,
  iat: 1,
  exp: 4_102_444_800,
}

function dependencies(overrides: Partial<ServingDeps> = {}): ServingDeps {
  return {
    verifyToken: () => claims,
    resolveContext: vi.fn(async () => {
      throw new Error('the route must resolve authority inside its snapshot owner')
    }),
    authorize: async () => ({ allowed: true }),
    store: { getResource: async () => null, listChildren: async () => [] },
    blobs: { read: async () => Readable.from(Buffer.alloc(0)) },
    rateLimit: {
      reads: new RateLimiter({ limit: 100, windowMs: 60_000 }),
      writes: new RateLimiter({ limit: 100, windowMs: 60_000 }),
    },
    ...overrides,
  }
}

async function request(deps: ServingDeps, path: string, method = 'GET'): Promise<FakeResponse> {
  const req = {
    url: path,
    method,
    headers: { authorization: 'Bearer verified' },
  } as unknown as IncomingMessage
  const res = new FakeResponse()
  await new GfsServingHandler(deps).tryHandle(req, res as unknown as ServerResponse)
  return res
}

describe('GFS convergence-location route', () => {
  it('routes the exact saved GFS target to the snapshot owner without early context resolution', async () => {
    const resolveConvergenceLocation = vi.fn(async () => ({ available: false as const }))
    const deps = dependencies({ resolveConvergenceLocation })
    const response = await request(
      deps,
      `/v1/convergence-location?uri=${encodeURIComponent(`gfs://main/${resourceId.replaceAll('-', '')}`)}`
    )

    expect(response.statusCode).toBe(200)
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, data: { available: false } })
    expect(resolveConvergenceLocation).toHaveBeenCalledWith(
      claims,
      undefined,
      resourceId.replaceAll('-', '')
    )
    expect(deps.resolveContext).not.toHaveBeenCalled()
  })

  it('rejects cross-drive targets before invoking the resolver', async () => {
    const resolveConvergenceLocation = vi.fn(async () => ({ available: false as const }))
    const response = await request(
      dependencies({ resolveConvergenceLocation }),
      `/v1/convergence-location?uri=${encodeURIComponent(`gfs://other/${resourceId.replaceAll('-', '')}`)}`
    )

    expect(response.statusCode).toBe(403)
    expect(resolveConvergenceLocation).not.toHaveBeenCalled()
  })

  it('does not serve the resolver for unsupported methods', async () => {
    const resolveConvergenceLocation = vi.fn(async () => ({ available: false as const }))
    const response = await request(
      dependencies({ resolveConvergenceLocation }),
      `/v1/convergence-location?uri=${encodeURIComponent(`gfs://main/${resourceId.replaceAll('-', '')}`)}`,
      'POST'
    )

    expect(response.statusCode).toBe(404)
    expect(resolveConvergenceLocation).not.toHaveBeenCalled()
  })
})
