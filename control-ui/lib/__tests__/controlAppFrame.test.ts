import { describe, expect, it } from 'vitest'
import { isPublicControlUiPath } from '../controlAppFrame'

describe('isPublicControlUiPath', () => {
  it.each([
    '/',
    '/admin-email-confirmations',
    '/admin-email-confirmations/token',
    '/admin-invitations',
    '/admin-invitations/token',
    '/admin-password-resets',
    '/admin-password-resets/token',
  ])('keeps %s outside the authenticated application frame', pathname => {
    expect(isPublicControlUiPath(pathname)).toBe(true)
  })

  it.each([
    '/agents',
    '/settings/ui',
    '/registry',
    '/profile-admin/users',
    '/admin-invitations-extra/token',
    '/admin-password-resets-extra/token',
    '/admin-email-confirmations-extra/token',
  ])('keeps %s inside the authenticated application frame', pathname => {
    expect(isPublicControlUiPath(pathname)).toBe(false)
  })
})
