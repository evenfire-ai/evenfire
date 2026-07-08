import { describe, expect, it } from 'vitest'
import { sameOriginRedirect } from '../sameOriginRedirect'

describe('sameOriginRedirect', () => {
  it('returns a relative Location header so the browser keeps the current origin', () => {
    const response = sameOriginRedirect('/admin-password-resets/complete?login=admin')

    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/admin-password-resets/complete?login=admin')
  })

  it('rejects absolute redirect targets', () => {
    expect(() => sameOriginRedirect('https://example.com/settings')).toThrow(
      'sameOriginRedirect requires a relative same-origin path'
    )
  })

  it('rejects protocol-relative redirect targets', () => {
    expect(() => sameOriginRedirect('//evil.com/steal-creds')).toThrow(
      'sameOriginRedirect requires a relative same-origin path'
    )
  })

  it('uses the provided status code', () => {
    const response = sameOriginRedirect('/settings', 302)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/settings')
  })
})
