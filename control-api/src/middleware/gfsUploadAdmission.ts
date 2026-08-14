import type { NextFunction, Response } from 'express'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { config } from '../config.js'
import {
  gfsUploadAdmissionActiveRequests,
  gfsUploadAdmissionBytesTotal,
  gfsUploadAdmissionRequestsTotal,
} from '../observability/metrics.js'
import {
  type RateLimitCheck,
  acquireRateLimitConcurrencyLease,
  checkAndIncrement,
} from '../services/rateLimiterService.js'
import type { ExternalAuthedRequest } from './externalSessionAuth.js'

export type GfsUploadAdmissionRequest = ExternalAuthedRequest & {
  gfsUploadDeclaredBytes?: number
}

export class GfsUploadBodyValidationError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: 'upload_length_mismatch' | 'payload_too_large'
  ) {
    super(code)
    this.name = 'GfsUploadBodyValidationError'
  }
}

/**
 * Count the bytes that actually cross the Control API → GFSC stream without
 * materializing a part. The declared byte budget is charged before this runs;
 * this guard makes lying in either direction fail before GFSC can commit it.
 */
export function createObservedGfsUploadPartBody(
  source: AsyncIterable<unknown>,
  declaredBytes: number,
  maxPartBytes: number
): { body: Readable; validationError: () => GfsUploadBodyValidationError | null } {
  const validation: { error: GfsUploadBodyValidationError | null } = { error: null }
  const body = Readable.from(
    (async function* countObservedBytes(): AsyncGenerator<Buffer> {
      let observedBytes = 0
      for await (const rawChunk of source) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array)
        observedBytes += chunk.byteLength
        if (observedBytes > maxPartBytes) {
          validation.error = new GfsUploadBodyValidationError(413, 'payload_too_large')
          throw validation.error
        }
        if (observedBytes > declaredBytes) {
          validation.error = new GfsUploadBodyValidationError(400, 'upload_length_mismatch')
          throw validation.error
        }
        yield chunk
      }
      if (observedBytes !== declaredBytes) {
        validation.error = new GfsUploadBodyValidationError(400, 'upload_length_mismatch')
        throw validation.error
      }
    })()
  )
  return { body, validationError: () => validation.error }
}

function sourceIp(req: ExternalAuthedRequest): string {
  // Only the authenticated external-rest-api service may assert the original
  // edge address. Direct callers of Control API (including other valid
  // service identities) must use the socket/proxy-derived address so they
  // cannot rotate an arbitrary forwarded header to evade the IP bucket.
  const forwarded =
    req.internalService?.name === 'external-rest-api'
      ? String(req.headers['x-gfs-upload-source-ip'] || '').trim()
      : ''
  if (forwarded && forwarded.length <= 64 && isIP(forwarded)) return forwarded
  const direct = String(req.ip || req.socket.remoteAddress || 'unknown').trim()
  return direct.length <= 64 ? direct : 'unknown'
}

export function declaredGfsUploadPartBytes(
  req: ExternalAuthedRequest
): { ok: true; bytes: number } | { ok: false; status: 400 | 411 | 413; error: string } {
  const rawContentLength = String(req.headers['content-length'] || '')
  const rawChunkLength = String(req.headers['upload-chunk-length'] || '')
  if (!/^[0-9]+$/.test(rawContentLength) || !/^[0-9]+$/.test(rawChunkLength)) {
    return { ok: false, status: 411, error: 'upload_content_length_required' }
  }
  const contentLength = Number(rawContentLength)
  const chunkLength = Number(rawChunkLength)
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > config.gfsUploadMaxPartBytes
  ) {
    return { ok: false, status: 413, error: 'payload_too_large' }
  }
  if (!Number.isSafeInteger(chunkLength) || chunkLength !== contentLength) {
    return { ok: false, status: 400, error: 'upload_length_mismatch' }
  }
  return { ok: true, bytes: contentLength }
}

function retryAfterSeconds(check: RateLimitCheck): number {
  return Math.max(1, Math.ceil((check.resetMs - Date.now()) / 1000))
}

function sendBackendUnavailable(res: Response): void {
  res.status(503).json({ error: 'gfs_upload_admission_unavailable' })
}

function sendRateLimited(res: Response, limit: string, retryAfter: number, max: number): void {
  res.setHeader('Retry-After', String(retryAfter))
  res.setHeader('X-RateLimit-Limit', String(max))
  res.setHeader('X-GFS-RateLimit-Scope', limit)
  res.setHeader('X-RateLimit-Remaining', '0')
  res.status(429).json({
    error: 'gfs_upload_rate_limited',
    limit,
    retryAfterSeconds: retryAfter,
  })
}

/**
 * Replica-safe upload-v2 admission. Fixed-window request/weighted-byte
 * counters and active stream slots all live in PostgreSQL; the incoming part
 * stream is not consumed here. `proxyUploadToGfsc` separately counts observed
 * bytes while forwarding so a false Content-Length cannot bypass this charge.
 * The active slot is intentionally acquired only for a part PUT: lifecycle
 * reads/actions must remain available to pause, reconcile, or cancel a stream
 * that is already consuming a slot.
 */
export function gfsUploadAdmission(
  req: GfsUploadAdmissionRequest,
  res: Response,
  next: NextFunction
): void {
  void (async () => {
    const userId = req.externalAuth?.userId || '__no_user__'
    const ip = sourceIp(req)
    const isPart = req.method === 'PUT' && /\/uploads\/[^/]+\/parts\/[0-9]+$/.test(req.path)
    let declaredBytes = 0
    if (isPart) {
      const parsed = declaredGfsUploadPartBytes(req)
      if (!parsed.ok) {
        gfsUploadAdmissionRequestsTotal.inc({ limit: 'part_body', result: 'rejected' }, 1)
        res.status(parsed.status).json({ error: parsed.error })
        return
      }
      declaredBytes = parsed.bytes
      req.gfsUploadDeclaredBytes = declaredBytes
    }

    const requestChecks = await Promise.all([
      checkAndIncrement(`gfs-upload:req:user:${userId}`, config.gfsUploadRequestPerMinute),
      checkAndIncrement(`gfs-upload:req:ip:${ip}`, config.gfsUploadIpRequestPerMinute),
    ])
    const requestLimits = [
      { name: 'principal_requests', max: config.gfsUploadRequestPerMinute },
      { name: 'source_ip_requests', max: config.gfsUploadIpRequestPerMinute },
    ]
    for (let index = 0; index < requestChecks.length; index += 1) {
      const check = requestChecks[index]!
      const limit = requestLimits[index]!
      if (!check.backendAvailable) {
        gfsUploadAdmissionRequestsTotal.inc({ limit: limit.name, result: 'unavailable' }, 1)
        sendBackendUnavailable(res)
        return
      }
      if (!check.allowed) {
        gfsUploadAdmissionRequestsTotal.inc({ limit: limit.name, result: 'denied' }, 1)
        if (declaredBytes) gfsUploadAdmissionBytesTotal.inc({ result: 'rejected' }, declaredBytes)
        sendRateLimited(res, limit.name, retryAfterSeconds(check), limit.max)
        return
      }
    }

    if (declaredBytes) {
      const units = Math.ceil(declaredBytes / config.gfsUploadByteUnitBytes)
      const byteChecks = await Promise.all([
        checkAndIncrement(
          `gfs-upload:bytes:user:${userId}`,
          config.gfsUploadByteUnitsPerMinute,
          Date.now(),
          units
        ),
        checkAndIncrement(
          `gfs-upload:bytes:ip:${ip}`,
          config.gfsUploadIpByteUnitsPerMinute,
          Date.now(),
          units
        ),
      ])
      const byteLimits = [
        { name: 'principal_bytes', max: config.gfsUploadByteUnitsPerMinute },
        { name: 'source_ip_bytes', max: config.gfsUploadIpByteUnitsPerMinute },
      ]
      for (let index = 0; index < byteChecks.length; index += 1) {
        const check = byteChecks[index]!
        const limit = byteLimits[index]!
        if (!check.backendAvailable) {
          gfsUploadAdmissionRequestsTotal.inc({ limit: limit.name, result: 'unavailable' }, 1)
          gfsUploadAdmissionBytesTotal.inc({ result: 'rejected' }, declaredBytes)
          sendBackendUnavailable(res)
          return
        }
        if (!check.allowed) {
          gfsUploadAdmissionRequestsTotal.inc({ limit: limit.name, result: 'denied' }, 1)
          gfsUploadAdmissionBytesTotal.inc({ result: 'rejected' }, declaredBytes)
          sendRateLimited(res, limit.name, retryAfterSeconds(check), limit.max)
          return
        }
      }
    }

    if (!isPart) {
      gfsUploadAdmissionRequestsTotal.inc({ limit: 'all', result: 'allowed' }, 1)
      next()
      return
    }

    const lease = await acquireRateLimitConcurrencyLease([
      { bucketKey: 'gfs-upload:active:global', maxConcurrent: config.gfsUploadMaxActiveGlobal },
      {
        bucketKey: `gfs-upload:active:user:${userId}`,
        maxConcurrent: config.gfsUploadMaxActivePerSubject,
      },
      {
        bucketKey: `gfs-upload:active:ip:${ip}`,
        maxConcurrent: config.gfsUploadMaxActivePerIp,
      },
    ])
    if (!lease.backendAvailable) {
      gfsUploadAdmissionRequestsTotal.inc({ limit: 'active_requests', result: 'unavailable' }, 1)
      if (declaredBytes) gfsUploadAdmissionBytesTotal.inc({ result: 'rejected' }, declaredBytes)
      sendBackendUnavailable(res)
      return
    }
    if (!lease.allowed) {
      gfsUploadAdmissionRequestsTotal.inc({ limit: 'active_requests', result: 'denied' }, 1)
      if (declaredBytes) gfsUploadAdmissionBytesTotal.inc({ result: 'rejected' }, declaredBytes)
      sendRateLimited(res, 'active_requests', 1, config.gfsUploadMaxActiveGlobal)
      return
    }

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      gfsUploadAdmissionActiveRequests.dec(1)
      void lease.release()
    }
    res.once('finish', release)
    res.once('close', release)
    gfsUploadAdmissionActiveRequests.inc(1)
    gfsUploadAdmissionRequestsTotal.inc({ limit: 'all', result: 'allowed' }, 1)
    if (declaredBytes) gfsUploadAdmissionBytesTotal.inc({ result: 'accepted' }, declaredBytes)
    next()
  })().catch(next)
}
