import { describe, expect, it } from 'vitest'
import { isPublicControlUiPath } from '../controlAppFrame'

describe('isPublicControlUiPath', () => {
  it.each([
    '/',
    '/admin-email-confirmations/token',
    '/admin-invitations/token',
    '/admin-password-resets/token',
  ])('keeps %s outside the authenticated application frame', pathname => {
    expect(isPublicControlUiPath(pathname)).toBe(true)
  })

  it.each(['/agents', '/settings/ui', '/registry', '/profile-admin/users'])(
    'keeps %s inside the authenticated application frame',
    pathname => {
      expect(isPublicControlUiPath(pathname)).toBe(false)
    }
  )
})
