import { describe, expect, it } from 'vitest'
import { ControlApiError } from '../controlApiClient.js'
import { sanitizeControlApiPublicError } from '../http/publicApiError.js'

const STATUS_CODES = [
  [400, 'invalid_request'],
  [401, 'invalid_session'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [408, 'request_timeout'],
  [409, 'conflict'],
  [410, 'gone'],
  [411, 'length_required'],
  [412, 'precondition_failed'],
  [413, 'payload_too_large'],
  [422, 'invalid_request'],
  [425, 'too_early'],
  [429, 'rate_limited'],
  [500, 'internal_error'],
  [502, 'upstream_unavailable'],
  [503, 'authority_unavailable'],
  [504, 'upstream_timeout'],
  [507, 'insufficient_storage'],
] as const

describe('public error mapping mutation sensitivity', () => {
  it.each(STATUS_CODES)('accepts the canonical code for status %s', (status, expectedCode) => {
    const result = sanitizeControlApiPublicError(
      new ControlApiError('private', status, { error: { code: expectedCode } }),
      new Set([status])
    )

    expect(result?.body).toMatchObject({ error: { code: expectedCode } })
  })

  it.each(STATUS_CODES)('selects the canonical fallback for status %s', (status, expectedCode) => {
    const result = sanitizeControlApiPublicError(
      new ControlApiError('private', status, { error: { code: 'not_allowed' } }),
      new Set([status])
    )

    expect(result?.body).toMatchObject({ error: { code: expectedCode } })
  })
})
