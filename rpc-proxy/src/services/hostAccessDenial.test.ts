import { describe, expect, it } from 'vitest'
import { hostAccessDenied, isHostAccessDenied } from './hostAccessDenial.js'

describe('isHostAccessDenied', () => {
  it('recognizes the typed Host access denial', () => {
    expect(isHostAccessDenied(hostAccessDenied('host_access_denied'))).toBe(true)
  })

  it('does not treat a missing Host resolution as a denial object', () => {
    expect(isHostAccessDenied(null)).toBe(false)
  })
})
