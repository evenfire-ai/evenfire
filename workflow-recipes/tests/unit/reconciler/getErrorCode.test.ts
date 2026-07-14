/**
 * Tests for getErrorCode() in k8sErrors.ts
 * Step 4.2 (G-05)
 */
import { describe, expect, it } from 'vitest'
import { getErrorCode } from '../../../src/reconciler/k8sErrors'

describe('getErrorCode', () => {
  it('returns code from { code: 404 }', () => {
    expect(getErrorCode({ code: 404 })).toBe(404)
  })

  it('returns statusCode from { response: { statusCode: 409 } }', () => {
    expect(getErrorCode({ response: { statusCode: 409 } })).toBe(409)
  })

  it('returns alternate Kubernetes client HTTP status shapes', () => {
    expect(getErrorCode({ statusCode: 503 })).toBe(503)
    expect(getErrorCode({ status: 429 })).toBe(429)
    expect(getErrorCode({ body: { code: 500 } })).toBe(500)
    expect(getErrorCode({ body: { statusCode: 501 } })).toBe(501)
    expect(getErrorCode({ body: { status: 429 } })).toBe(429)
    expect(getErrorCode({ response: { status: 502 } })).toBe(502)
    expect(getErrorCode({ response: { body: { code: 504 } } })).toBe(504)
    expect(getErrorCode({ response: { body: { statusCode: 503 } } })).toBe(503)
    expect(getErrorCode({ response: { body: { status: 429 } } })).toBe(429)
  })

  it('code wins over response.statusCode when both present', () => {
    expect(getErrorCode({ code: 404, response: { statusCode: 500 } })).toBe(404)
  })

  it('returns undefined for empty object {}', () => {
    expect(getErrorCode({})).toBeUndefined()
  })

  it('returns undefined for a plain string error', () => {
    expect(getErrorCode('something went wrong')).toBeUndefined()
  })

  it('returns undefined for an object with no code or response', () => {
    expect(getErrorCode({ message: 'oops' })).toBeUndefined()
  })

  it('returns code from nested response when code is undefined', () => {
    expect(getErrorCode({ response: { statusCode: 422 } })).toBe(422)
  })
})
