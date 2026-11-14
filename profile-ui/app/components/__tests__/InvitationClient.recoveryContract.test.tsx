import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PROFILE_ROUTES } from '@constants/routes'
import { ProfileApiError } from '@lib/api'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  setupInvitationPasswordWithToken: vi.fn(),
}))

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    acceptInvitation: mocks.acceptInvitation,
    setupInvitationPasswordWithToken: mocks.setupInvitationPasswordWithToken,
  }
})

const LOGOUT_FENCE_KEY = 'profile_logout_unconfirmed'

const passwordReset: InvitationPreview = {
  id: 'r6-reset-1',
  teamId: null,
  teamName: null,
  email: 'r6-member@example.invalid',
  role: 'member',
  purpose: 'password_reset',
  status: 'pending',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  acceptedAt: null,
  userId: 'r6-user-1',
  passwordPending: true,
}

const updatedResponse = {
  ...passwordReset,
  status: 'accepted',
  passwordPending: false,
  passwordUpdated: true,
}

function renderReset() {
  render(
    <InvitationClient
      invitationToken="r6-one-use-reset-proof"
      initialInvitation={passwordReset}
      initialError=""
    />
  )
}

function fillPassword() {
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'R6-synthetic-new-password' },
  })
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: 'R6-synthetic-new-password' },
  })
}

function submitReset() {
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
}

function expectPasswordUpdatedScreen() {
  expect(screen.getByRole('heading', { name: 'Password updated' })).toBeInTheDocument()
  expect(screen.getByText('Your password has been updated.')).toBeInTheDocument()
  expect(
    screen.getByText('Your password has been updated. Sign in with your new password to continue.')
  ).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
    PROFILE_ROUTES.login({ email: passwordReset.email })
  )
  expect(screen.queryByLabelText('Password')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull()
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.acceptInvitation.mockReset()
  mocks.setupInvitationPasswordWithToken.mockReset().mockResolvedValue(updatedResponse)
})

afterEach(cleanup)

describe('R6 recovery outcome and guided reauthentication', () => {
  it('moves a committed reset to the password-updated screen', async () => {
    renderReset()
    fillPassword()
    submitReset()

    await waitFor(expectPasswordUpdatedScreen)
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledWith(
      'r6-one-use-reset-proof',
      passwordReset.email,
      passwordReset.id,
      'R6-synthetic-new-password'
    )
    expect(mocks.acceptInvitation).not.toHaveBeenCalled()
  })

  it.each([
    ['transport TypeError', new TypeError('socket closed after dispatch')],
    ['response SyntaxError', new SyntaxError('upstream response was not JSON')],
    [
      'unknown post-dispatch outcome',
      new ProfileApiError(503, 'recovery_outcome_unknown', 'temporary service message'),
    ],
    ['unclassified 500 failure', new ProfileApiError(500, 'upstream_failure', 'private detail')],
  ])('does not replay a reset after %s', async (_label, error) => {
    mocks.setupInvitationPasswordWithToken.mockRejectedValueOnce(error)
    renderReset()
    fillPassword()
    submitReset()

    expect(
      await screen.findByText(
        'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.',
        { exact: true }
      )
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.getByRole('link', { name: 'Try signing in' })).toBeInTheDocument()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
  })

  it.each([
    ['rate limit', new ProfileApiError(429, 'rate_limited', 'upstream wording changed')],
    [
      'definite authority rejection',
      new ProfileApiError(503, 'authority_unavailable', 'temporary authority message'),
    ],
    ['definite internal failure', new ProfileApiError(500, 'internal_error', 'private detail')],
  ])('keeps a definite %s retryable rather than ambiguous', async (_label, error) => {
    mocks.setupInvitationPasswordWithToken
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(updatedResponse)
    renderReset()
    fillPassword()
    submitReset()

    expect(await screen.findByRole('button', { name: 'Reset password' })).toBeEnabled()
    expect(screen.queryByRole('heading', { name: 'Password updated' })).toBeNull()

    fillPassword()
    submitReset()
    await waitFor(expectPasswordUpdatedScreen)
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledTimes(2)
  })

  it('keeps the logout fence on the recovery preview and clears it after the reset is accepted', async () => {
    window.localStorage.setItem(LOGOUT_FENCE_KEY, 'true')
    expect(window.localStorage.getItem(LOGOUT_FENCE_KEY)).toBe('true')

    renderReset()

    // Opening the link is not an authoritative recovery result.
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeInTheDocument()
    expect(window.localStorage.getItem(LOGOUT_FENCE_KEY)).toBe('true')

    fillPassword()
    submitReset()
    await waitFor(expectPasswordUpdatedScreen)
    expect(window.localStorage.getItem(LOGOUT_FENCE_KEY)).toBeNull()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
  })
})
