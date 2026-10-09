import type { NextFunction, Request, Response } from 'express'
import { isIP } from 'node:net'
import { z } from 'zod'
import { PASSWORD_ADMISSION_POLICY } from '../services/auth/passwordAdmissionState.js'
import { PasswordAdmissionError } from '../services/auth/passwordCredentialVerification.js'
import { clearRateLimitHeaders, rateLimitMiddleware } from './rateLimitMiddleware.js'

const credentials = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(256),
})

export function sendPasswordAdmissionError(error: unknown, res: Response): boolean {
  if (!(error instanceof PasswordAdmissionError)) return false
  clearRateLimitHeaders(res)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Retry-After', String(error.retryAfterSeconds))
  res.status(error.status).json({
    error: error.publicError,
    retryAfterSeconds: error.retryAfterSeconds,
  })
  return true
}

export function validatePasswordLogin(req: Request, res: Response, next: NextFunction): void {
  const parsed = credentials.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request' })
    return
  }
  req.body = { ...req.body, email: parsed.data.email.toLowerCase(), password: parsed.data.password }
  next()
}

export const passwordLoginSourceAdmission = rateLimitMiddleware({
  bucketType: 'external_authentication_attempt',
  maxPerMinute: PASSWORD_ADMISSION_POLICY.sourceAttemptsPerMinute,
  onBackendUnavailable: 'closed',
  getBucketKey: req => {
    // Trust only the authenticated External REST producer. Support its current
    // dev header and the Task 106 header during eventual integration.
    const asserted =
      req.internalService?.name === 'external-rest-api'
        ? req.header('x-evenfire-client-ip') || req.header('x-external-client-ip')
        : undefined
    const ip =
      asserted && isIP(asserted.trim())
        ? asserted.trim()
        : req.ip || req.socket?.remoteAddress || 'unknown'
    return `external_authentication_attempt:ip:${String(ip).slice(0, 128)}`
  },
  onLimited: (_req, res, retryAfterSeconds) => {
    sendPasswordAdmissionError(
      new PasswordAdmissionError(429, Math.min(60, retryAfterSeconds), 'source_rate'),
      res
    )
  },
})
