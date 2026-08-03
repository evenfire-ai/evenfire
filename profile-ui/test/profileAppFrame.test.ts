import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isPublicProfileUiPath,
  isPublicProfileUiRequest,
  profileRouteForPathname,
} from '../lib/profileAppFrame'

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

test('root inviteToken redirects stay public without making every root query public', () => {
  assert.equal(isPublicProfileUiRequest('/', new URLSearchParams('inviteToken=abc')), true)
  assert.equal(isPublicProfileUiRequest('/', new URLSearchParams('inviteToken=a%2Fb%20c')), true)
  assert.equal(isPublicProfileUiRequest('/', new URLSearchParams('inviteToken=')), false)
  assert.equal(isPublicProfileUiRequest('/', new URLSearchParams('email=a%40example.com')), false)
  assert.equal(isPublicProfileUiRequest('/members', new URLSearchParams('inviteToken=abc')), false)
})

test('profileRouteForPathname derives the active persistent sidebar route', () => {
  assert.equal(profileRouteForPathname('/'), 'home')
  assert.equal(profileRouteForPathname('/members/member-1'), 'members')
  assert.equal(profileRouteForPathname('/approval-channels'), 'approvalChannels')
  assert.equal(profileRouteForPathname('/connected-accounts'), 'connectedAccounts')
  assert.equal(profileRouteForPathname('/settings'), 'settings')
})
