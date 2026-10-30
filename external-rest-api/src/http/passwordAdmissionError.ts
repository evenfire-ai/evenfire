import type { ErrorRequestHandler, Response } from 'express'
import {
  ControlApiError,
  ControlApiTransportError,
  ControlApiUnexpectedResponseError,
} from '../controlApiClient.js'

function sendPublicPasswordAuthorityError(
  res: Response,
  status: 429 | 503,
  error: 'rate_limited' | 'authority_unavailable' | 'recovery_outcome_unknown',
  retryHeader?: string
): void {
  const retry = Number(retryHeader)
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
  res.status(status).json({ error, retryAfterSeconds })
}

/** Only the bounded public authority contract crosses this credential seam. */
export function sendPasswordAuthorityError(error: unknown, res: Response): boolean {
  if (error instanceof ControlApiTransportError) {
    sendPublicPasswordAuthorityError(res, 503, 'authority_unavailable')
    return true
  }
  if (error instanceof ControlApiUnexpectedResponseError) {
    res.status(502).json({ error: 'Password recovery service returned an invalid response' })
    return true
  }
  if (!(error instanceof ControlApiError)) {
    if (!(error instanceof Error)) return false
    res.status(500).json({ error: 'Internal Server Error' })
    return true
  }
  if (error.status === 429) {
    sendPublicPasswordAuthorityError(res, 429, 'rate_limited', error.headers['retry-after'])
    return true
  }
  if (error.status === 503) {
    const recoveryOutcomeUnknown = error.code === 'recovery_outcome_unknown'
    sendPublicPasswordAuthorityError(
      res,
      503,
      recoveryOutcomeUnknown ? 'recovery_outcome_unknown' : 'authority_unavailable',
      error.headers['retry-after']
    )
    return true
  }
  if (error.status === 500 && error.code === 'internal_error') {
    for (const name of [
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'RateLimit',
      'RateLimit-Policy',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ]) {
      res.removeHeader(name)
    }
    res.setHeader('Cache-Control', 'no-store')
    res.status(500).json({ error: 'internal_error' })
    return true
  }
  if (error.status >= 500) {
    sendPublicPasswordAuthorityError(
      res,
      503,
      'authority_unavailable',
      error.headers['retry-after']
    )
    return true
  }
  return false
}

export const invitationPasswordErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (sendPasswordAuthorityError(error, res)) return
  if (error instanceof ControlApiError) {
    res.status(error.status).json({ error: 'Invitation is invalid or unavailable' })
    return
  }
  if (error instanceof Error) {
    res.status(500).json({ error: 'Internal Server Error' })
    return
  }
  next(error)
}

/** Sends a generic authority failure when an invitation Control API call cannot be verified. */
export function sendPasswordAuthorityUnavailable(res: Response): void {
  sendPublicPasswordAuthorityError(res, 503, 'authority_unavailable')
}
