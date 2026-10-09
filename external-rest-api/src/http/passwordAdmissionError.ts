import type { Response } from 'express'
import { ControlApiError } from '../controlApiClient.js'

/** Only the bounded public authority contract crosses this credential seam. */
export function sendPasswordAuthorityError(error: unknown, res: Response): boolean {
  if (!(error instanceof ControlApiError) || ![429, 503].includes(error.status)) return false
  const recoveryOutcomeUnknown =
    error.status === 503 &&
    error.body !== null &&
    typeof error.body === 'object' &&
    'error' in error.body &&
    error.body.error === 'recovery_outcome_unknown'
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
    error:
      error.status === 429
        ? 'rate_limited'
        : recoveryOutcomeUnknown
          ? 'recovery_outcome_unknown'
          : 'authority_unavailable',
    retryAfterSeconds,
  })
  return true
}
