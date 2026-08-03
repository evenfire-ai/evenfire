import assert from 'node:assert/strict'
import test from 'node:test'
import { isPublicProfileUiPath, profileRouteForPathname } from '../lib/profileAppFrame'

test('public profile routes stay outside the authenticated application frame', () => {
  for (const pathname of ['/desktop-setup', '/forgot-password', '/invitations/token']) {
    assert.equal(isPublicProfileUiPath(pathname), true, pathname)
  }
})

test('authenticated profile routes use the persistent application frame', () => {
  for (const pathname of ['/', '/members', '/approval-channels', '/connected-accounts']) {
    assert.equal(isPublicProfileUiPath(pathname), false, pathname)
  }
})

test('profileRouteForPathname derives the active persistent sidebar route', () => {
  assert.equal(profileRouteForPathname('/'), 'home')
  assert.equal(profileRouteForPathname('/members/member-1'), 'members')
  assert.equal(profileRouteForPathname('/approval-channels'), 'approvalChannels')
  assert.equal(profileRouteForPathname('/connected-accounts'), 'connectedAccounts')
  assert.equal(profileRouteForPathname('/settings'), 'settings')
})
