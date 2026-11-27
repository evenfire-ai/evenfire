import type { Response } from 'express'
import { type ControlApiError, ControlApiNonJsonResponseError } from '../controlApiClient.js'

const UNSIGNED_INTEGER_HEADER = /^\d{1,10}$/
const MAX_RETRY_AFTER_SECONDS = 86_400

/** A header written as an unsigned decimal integer, or nothing for any other form. */
export function unsignedIntegerHeader(raw: string | undefined): number | undefined {
  if (!raw || !UNSIGNED_INTEGER_HEADER.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * control-api's Retry-After as whole seconds from 1 to 86400, or nothing when it sent none or
 * another form (an HTTP date). Only this bounded number is ever relayed, never the header text.
 */
export function controlApiRetryAfterSeconds(error: ControlApiError): number | undefined {
  const seconds = unsignedIntegerHeader(error.headers['retry-after'])
  return seconds !== undefined && seconds >= 1 && seconds <= MAX_RETRY_AFTER_SECONDS
    ? seconds
    : undefined
}

/**
 * A 429 control-api answered. Its external route limiters answer with a text body, which the
 * client turns into a ControlApiNonJsonResponseError carrying the status that came back.
 */
export function isControlApiRateLimited(error: ControlApiError): boolean {
  return (
    error.status === 429 ||
    (error instanceof ControlApiNonJsonResponseError && error.upstreamStatus === 429)
  )
}

/**
 * Relays control-api's 429 in the shape the edge's own limiter answers, so a client handles
 * both alike. `fallbackSeconds` stands in when control-api sent no usable Retry-After.
 */
export function sendControlApiRateLimited(
  error: ControlApiError,
  res: Response,
  fallbackSeconds: number
): void {
  const retryAfterSeconds = controlApiRetryAfterSeconds(error) ?? fallbackSeconds
  res.setHeader('Retry-After', String(retryAfterSeconds))
  res.status(429).json({ error: 'rate_limited', retryAfterSeconds })
}
