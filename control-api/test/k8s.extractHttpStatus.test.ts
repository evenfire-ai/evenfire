import { describe, expect, it } from 'vitest'
import { extractHttpStatus } from '../src/k8s.js'
// Fixtures are derived from the REAL producers (T1): the service layer throws
// these classes, which expose their status ONLY via `readonly httpStatus`, with
// no `code`/`statusCode`. Hand-building `{ httpStatus: 404 }` would encode a
// belief about their shape instead of the shape they actually emit.
import { K8sConflictError, K8sNotFoundError } from '../src/services/resourceService.js'

describe('extractHttpStatus', () => {
  it('reads httpStatus from a real K8sNotFoundError (was null before the fix)', () => {
    // Consumer: routes/admin/secrets.ts:462 branches on === 404 to answer a
    // rotation against a missing Secret with a proper 404 instead of throwing.
    expect(extractHttpStatus(new K8sNotFoundError('Secret "x" not found'))).toBe(404)
  })

  it('reads httpStatus from a real K8sConflictError', () => {
    expect(extractHttpStatus(new K8sConflictError('resourceVersion conflict'))).toBe(409)
  })

  it('still prefers statusCode when present (precedence unchanged)', () => {
    expect(extractHttpStatus({ statusCode: 500 })).toBe(500)
  })
})
