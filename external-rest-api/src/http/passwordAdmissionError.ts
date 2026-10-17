import type { Response } from 'express'
import { ControlApiError } from '../controlApiClient.js'

const SESSION_ISSUANCE_UNAVAILABLE_CODE = 'session_issuance_temporarily_unavailable'

function isSessionIssuanceUnavailable(error: ControlApiError): boolean {
  if (!error.body || typeof error.body !== 'object') return false
  const rawError = (error.body as Record<string, unknown>).error
  if (rawError === SESSION_ISSUANCE_UNAVAILABLE_CODE) return true
  if (!rawError || typeof rawError !== 'object') return false
  return (rawError as Record<string, unknown>).code === SESSION_ISSUANCE_UNAVAILABLE_CODE
}

/** Only the bounded public authority contract crosses this credential seam. */
export function sendPasswordAuthorityError(error: unknown, res: Response): boolean {
  if (!(error instanceof ControlApiError) || ![429, 503].includes(error.status)) return false
  if (error.status === 503 && isSessionIssuanceUnavailable(error)) return false
  const retry = Number(error.headers['retry-after'])
  const retryAfterSeconds =
    Number.isFinite(retry) && retry > 0 ? Math.min(900, Math.max(1, Math.ceil(retry))) : 2
  for (const name of [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'RateLimit',
    'RateLimit-Policy',
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
  ])
    res.removeHeader(name)
  res.setHeader('Retry-After', String(retryAfterSeconds))
  res.setHeader('Cache-Control', 'no-store')
  res.status(error.status).json({
    error: error.status === 429 ? 'rate_limited' : 'authority_unavailable',
    retryAfterSeconds,
  })
  return true
}
