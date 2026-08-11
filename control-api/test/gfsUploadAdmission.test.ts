import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { Readable } from 'node:stream'
import request from 'supertest'
import {
  createObservedGfsUploadPartBody,
  declaredGfsUploadPartBytes,
  gfsUploadAdmission,
} from '../src/middleware/gfsUploadAdmission.js'

const { acquireMock, checkMock, metricDec, metricInc, releaseMock } = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  checkMock: vi.fn(),
  metricDec: vi.fn(),
  metricInc: vi.fn(),
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
  },
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  acquireRateLimitConcurrencyLease: acquireMock,
  checkAndIncrement: checkMock,
}))

vi.mock('../src/observability/metrics.js', () => ({
  gfsUploadAdmissionActiveRequests: { inc: metricInc, dec: metricDec },
  gfsUploadAdmissionBytesTotal: { inc: metricInc },
  gfsUploadAdmissionRequestsTotal: { inc: metricInc },
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

function buildPartApp() {
  const app = express()
  app.put(
    '/external/gfs/uploads/:id/parts/:part',
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

beforeEach(() => {
  acquireMock.mockReset()
  checkMock.mockReset()
  metricDec.mockReset()
  metricInc.mockReset()
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

  it('returns the same 429 contract when the active-request budget is exhausted', async () => {
    acquireMock.mockResolvedValueOnce({
      allowed: false,
      backendAvailable: true,
      release: releaseMock,
    })
    const response = await request(buildLifecycleApp()).get('/external/gfs/capabilities')
    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBe('1')
    expect(response.body).toEqual({
      error: 'gfs_upload_rate_limited',
      limit: 'active_requests',
      retryAfterSeconds: 1,
    })
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
