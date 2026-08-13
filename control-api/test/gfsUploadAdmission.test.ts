import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { Readable } from 'node:stream'
import request from 'supertest'
import {
  createObservedGfsUploadPartBody,
  declaredGfsUploadPartBytes,
  gfsUploadAdmission,
} from '../src/middleware/gfsUploadAdmission.js'
import {
  requireInternalService,
  requireInternalToken,
} from '../src/middleware/internalServiceAuth.js'

const {
  acquireMock,
  checkMock,
  metricActiveInc,
  metricBytesInc,
  metricDec,
  metricRequestsInc,
  releaseMock,
} = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  checkMock: vi.fn(),
  metricActiveInc: vi.fn(),
  metricBytesInc: vi.fn(),
  metricDec: vi.fn(),
  metricRequestsInc: vi.fn(),
  releaseMock: vi.fn(),
}))

vi.mock('../src/config.js', () => ({
  config: {
    gfsUploadRequestPerMinute: 120,
    gfsUploadIpRequestPerMinute: 600,
    gfsUploadByteUnitBytes: 1024 * 1024,
    gfsUploadByteUnitsPerMinute: 512,
    gfsUploadIpByteUnitsPerMinute: 2048,
    gfsUploadMaxActivePerSubject: 8,
    gfsUploadMaxActivePerIp: 16,
    gfsUploadMaxActiveGlobal: 32,
    gfsUploadMaxPartBytes: 16 * 1024 * 1024,
    internalServiceTokens: {
      'external-rest-api': 'dev-external-rest-api-token',
      'rpc-proxy': 'dev-rpc-proxy-token',
    },
  },
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  acquireRateLimitConcurrencyLease: acquireMock,
  checkAndIncrement: checkMock,
}))

vi.mock('../src/observability/metrics.js', () => ({
  gfsUploadAdmissionActiveRequests: { inc: metricActiveInc, dec: metricDec },
  gfsUploadAdmissionBytesTotal: { inc: metricBytesInc },
  gfsUploadAdmissionRequestsTotal: { inc: metricRequestsInc },
}))

function rateCheck(
  overrides: Partial<{
    allowed: boolean
    backendAvailable: boolean
    count: number
    remaining: number
    resetMs: number
  }> = {}
) {
  const now = Date.now()
  return {
    allowed: true,
    backendAvailable: true,
    count: 1,
    remaining: 119,
    resetMs: now + 30_000,
    windowStartMs: now,
    ...overrides,
  }
}

function buildPartApp(serviceName?: string) {
  const app = express()
  app.put(
    '/external/gfs/uploads/:id/parts/:part',
    (req, _res, next) => {
      ;(req as typeof req & { externalAuth: { userId: string } }).externalAuth = {
        userId: 'user-1',
      }
      if (serviceName) req.internalService = { name: serviceName }
      next()
    },
    gfsUploadAdmission,
    (req, res) => {
      req.resume()
      req.once('end', () => res.status(204).end())
    }
  )
  return app
}

function buildLifecycleApp() {
  const app = express()
  app.get(
    '/external/gfs/capabilities',
    (req, _res, next) => {
      ;(req as typeof req & { externalAuth: { userId: string } }).externalAuth = {
        userId: 'user-1',
      }
      next()
    },
    gfsUploadAdmission,
    (_req, res) => res.status(200).json({ ok: true })
  )
  return app
}

function buildAuthenticatedPartApp() {
  const app = express()
  app.put(
    '/external/gfs/uploads/:id/parts/:part',
    requireInternalToken,
    requireInternalService('external-rest-api'),
    (req, _res, next) => {
      ;(req as typeof req & { externalAuth: { userId: string } }).externalAuth = {
        userId: 'user-1',
      }
      next()
    },
    gfsUploadAdmission,
    (req, res) => {
      req.resume()
      req.once('end', () => res.status(204).end())
    }
  )
  return app
}

beforeEach(() => {
  acquireMock.mockReset()
  checkMock.mockReset()
  metricActiveInc.mockReset()
  metricBytesInc.mockReset()
  metricDec.mockReset()
  metricRequestsInc.mockReset()
  releaseMock.mockReset()
  checkMock.mockResolvedValue(rateCheck())
  acquireMock.mockResolvedValue({
    allowed: true,
    backendAvailable: true,
    release: releaseMock.mockResolvedValue(undefined),
  })
})

describe('GFS upload admission', () => {
  it('returns a stable 429 with Retry-After when the replica-safe request budget is exhausted', async () => {
    checkMock
      .mockResolvedValueOnce(rateCheck({ allowed: false, remaining: 0, count: 121 }))
      .mockResolvedValueOnce(rateCheck())

    const response = await request(buildLifecycleApp()).get('/external/gfs/capabilities')

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toMatch(/^\d+$/)
    expect(response.body).toMatchObject({
      error: 'gfs_upload_rate_limited',
      limit: 'principal_requests',
    })
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it('records a rejected part-body request without charging the byte counter', async () => {
    const response = await request(buildPartApp())
      .put('/external/gfs/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0')
      .set('content-type', 'application/offset+octet-stream')
      .set('content-length', '4')
      .set('upload-chunk-length', '3')
      .send(Buffer.from('abc'))

    expect(response.status).toBe(400)
    expect(metricRequestsInc).toHaveBeenCalledWith({ limit: 'part_body', result: 'rejected' }, 1)
    expect(metricRequestsInc).toHaveBeenCalledTimes(1)
    expect(metricBytesInc).not.toHaveBeenCalled()
    expect(metricActiveInc).not.toHaveBeenCalled()
  })

  it('charges part bytes in fixed 1 MiB units before forwarding and releases its active slot', async () => {
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0x61)
    const response = await request(buildPartApp())
      .put('/external/gfs/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0')
      .set('content-type', 'application/offset+octet-stream')
      .set('upload-chunk-length', String(bytes.length))
      .send(bytes)

    expect(response.status).toBe(204)
    expect(checkMock).toHaveBeenCalledTimes(4)
    expect(checkMock.mock.calls[2][0]).toBe('gfs-upload:bytes:user:user-1')
    expect(checkMock.mock.calls[2][1]).toBe(512)
    expect(checkMock.mock.calls[2][3]).toBe(2)
    expect(checkMock.mock.calls[3][0]).toMatch(/^gfs-upload:bytes:ip:/)
    expect(checkMock.mock.calls[3][3]).toBe(2)
    expect(acquireMock).toHaveBeenCalledWith([
      { bucketKey: 'gfs-upload:active:global', maxConcurrent: 32 },
      { bucketKey: 'gfs-upload:active:user:user-1', maxConcurrent: 8 },
      expect.objectContaining({
        bucketKey: expect.stringMatching(/^gfs-upload:active:ip:/),
        maxConcurrent: 16,
      }),
    ])
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('ignores a spoofed source IP unless the authenticated external relay asserted it', async () => {
    const bytes = Buffer.from('a')
    await request(buildPartApp())
      .put('/external/gfs/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0')
      .set('content-type', 'application/offset+octet-stream')
      .set('upload-chunk-length', String(bytes.length))
      .set('x-gfs-upload-source-ip', '203.0.113.7')
      .send(bytes)

    expect(checkMock.mock.calls[1][0]).not.toBe('gfs-upload:req:ip:203.0.113.7')
    checkMock.mockClear()

    await request(buildPartApp('external-rest-api'))
      .put('/external/gfs/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0')
      .set('content-type', 'application/offset+octet-stream')
      .set('upload-chunk-length', String(bytes.length))
      .set('x-gfs-upload-source-ip', '203.0.113.7')
      .send(bytes)

    expect(checkMock.mock.calls[1][0]).toBe('gfs-upload:req:ip:203.0.113.7')
  })

  it('binds source-IP assertion to the real internal service token wiring', async () => {
    const app = buildAuthenticatedPartApp()
    const path = '/external/gfs/uploads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/parts/0'
    const headers = {
      'content-type': 'application/offset+octet-stream',
      'upload-chunk-length': '1',
      'x-gfs-upload-source-ip': '203.0.113.7',
    }
    await request(app)
      .put(path)
      .auth('dev-rpc-proxy-token', { type: 'bearer' })
      .set('x-service-token', 'rpc-proxy')
      .set(headers)
      .send(Buffer.from('a'))
      .expect(401)

    checkMock.mockClear()
    await request(app)
      .put(path)
      .auth('dev-external-rest-api-token', { type: 'bearer' })
      .set('x-service-token', 'external-rest-api')
      .set(headers)
      .send(Buffer.from('a'))
      .expect(204)
    expect(checkMock.mock.calls[1][0]).toBe('gfs-upload:req:ip:203.0.113.7')
  })

  it('does not consume an active stream slot for lifecycle requests', async () => {
    acquireMock.mockResolvedValueOnce({
      allowed: false,
      backendAvailable: true,
      release: releaseMock,
    })
    const response = await request(buildLifecycleApp()).get('/external/gfs/capabilities')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(acquireMock).not.toHaveBeenCalled()
    expect(metricActiveInc).not.toHaveBeenCalled()
  })

  it('fails closed when PostgreSQL admission is unavailable', async () => {
    checkMock.mockResolvedValue(rateCheck({ backendAvailable: false }))
    const response = await request(buildLifecycleApp()).get('/external/gfs/capabilities')
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'gfs_upload_admission_unavailable' })
    expect(acquireMock).not.toHaveBeenCalled()
  })
})

describe('GFS upload declared and observed byte guards', () => {
  it('rejects missing, mismatched, and oversized declared lengths before streaming', () => {
    const requestLike = (headers: Record<string, string>) =>
      ({ headers }) as unknown as Parameters<typeof declaredGfsUploadPartBytes>[0]

    expect(declaredGfsUploadPartBytes(requestLike({}))).toEqual({
      ok: false,
      status: 411,
      error: 'upload_content_length_required',
    })
    expect(
      declaredGfsUploadPartBytes(requestLike({ 'content-length': '4', 'upload-chunk-length': '3' }))
    ).toEqual({ ok: false, status: 400, error: 'upload_length_mismatch' })
    expect(
      declaredGfsUploadPartBytes(
        requestLike({
          'content-length': String(16 * 1024 * 1024 + 1),
          'upload-chunk-length': String(16 * 1024 * 1024 + 1),
        })
      )
    ).toEqual({ ok: false, status: 413, error: 'payload_too_large' })
  })

  it('passes exact observed bytes without buffering the complete part', async () => {
    const observed = createObservedGfsUploadPartBody(
      Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
      4,
      16
    )
    const chunks: Buffer[] = []
    for await (const chunk of observed.body) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks).toString()).toBe('abcd')
    expect(observed.validationError()).toBeNull()
  })

  it.each([
    [
      'more than declared',
      [Buffer.from('abc'), Buffer.from('de')],
      4,
      16,
      'upload_length_mismatch',
    ],
    ['less than declared', [Buffer.from('abc')], 4, 16, 'upload_length_mismatch'],
    ['more than the hard part limit', [Buffer.from('abcde')], 5, 4, 'payload_too_large'],
  ])('rejects observed bytes that contain %s', async (_case, chunks, declared, max, code) => {
    const observed = createObservedGfsUploadPartBody(Readable.from(chunks), declared, max)
    await expect(async () => {
      for await (const _chunk of observed.body) {
        /* drain */
      }
    }).rejects.toMatchObject({ code })
    expect(observed.validationError()).toMatchObject({ code })
  })
})
