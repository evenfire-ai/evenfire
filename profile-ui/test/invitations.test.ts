import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInvitationHeading, formatRemaining, resolveInvitationToken } from '../lib/invitations'
import './approvalChannels.test'
import './loadingStyles.test'
import './profileAccess.test'
import './profileAppFrame.test'
import './profileSettings.test'
import './routes.test'

test('formatRemaining returns a human-readable duration', () => {
  const now = Date.parse('2026-04-20T12:00:00.000Z')
  const expiresAt = '2026-04-21T15:30:00.000Z'

  assert.equal(formatRemaining(expiresAt, now), '1 day, 3 hours')
})

test('formatRemaining reports expired invitations', () => {
  const now = Date.parse('2026-04-20T12:00:00.000Z')

  assert.equal(formatRemaining('2026-04-20T11:59:59.000Z', now), 'expired')
})

test('buildInvitationHeading includes the team name', () => {
  assert.equal(buildInvitationHeading('marketing'), 'Join marketing team')
  assert.equal(buildInvitationHeading(undefined), 'Join Evenfire')
})

test('resolveInvitationToken trims the route token', () => {
  assert.equal(resolveInvitationToken(' invite-token '), 'invite-token')
})
