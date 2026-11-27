import { describe, expect, it } from 'vitest'
import { hostAccessDenied, isHostResolveRefusal } from './hostAccessDenial.js'

describe('isHostResolveRefusal', () => {
  it.each([
    ['a denial', hostAccessDenied('host_access_denied')],
    ['a rejection', { rejected: true, status: 401 }],
    ['an unavailable authority', { unavailable: true, cause: 'timeout' }],
  ])('recognizes %s', (_label, value) => {
    expect(isHostResolveRefusal(value)).toBe(true)
  })

  it('does not treat a resolved connection as a refusal', () => {
    expect(isHostResolveRefusal({ name: 'chatllm', url: 'http://host.invalid', headers: {} })).toBe(
      false
    )
  })
})
