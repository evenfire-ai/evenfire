import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PROFILE_ROUTES } from '@constants/routes'
import { ProfileApiError } from '@lib/api'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  setupAcceptedInvitationPasswordWithToken: vi.fn(),
  setupInvitationPasswordWithToken: vi.fn(),
}))

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    acceptInvitation: mocks.acceptInvitation,
    setupAcceptedInvitationPasswordWithToken: mocks.setupAcceptedInvitationPasswordWithToken,
    setupInvitationPasswordWithToken: mocks.setupInvitationPasswordWithToken,
  }
})

const passwordReset: InvitationPreview = {
  id: 'reset-1',
  teamId: null,
  teamName: null,
  email: 'member@example.invalid',
  role: 'member',
  purpose: 'password_reset',
  status: 'pending',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  acceptedAt: null,
  userId: 'user-1',
  passwordPending: true,
}

const acceptedMemberInvitation: InvitationPreview = {
  ...passwordReset,
  purpose: 'member_invitation',
  status: 'accepted',
  passwordPending: true,
}

const acceptedAdminDesktopInvitation: InvitationPreview = {
  ...passwordReset,
  id: 'admin-invite-1',
  email: 'admin@example.invalid',
  role: 'admin',
  purpose: 'admin_desktop_access',
  status: 'accepted',
  passwordPending: true,
  userId: 'admin-user-1',
}

function fillPassword() {
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'new-synthetic-password' },
  })
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: 'new-synthetic-password' },
  })
}

function expectPasswordUpdatedScreen(email: string) {
  expect(screen.getByRole('heading', { name: 'Password updated' })).toBeInTheDocument()
  expect(
    screen.getByText('Your password has been updated. Sign in with your new password to continue.')
  ).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
    PROFILE_ROUTES.login({ email })
  )
  expect(screen.queryByLabelText('Password')).toBeNull()
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.acceptInvitation.mockReset()
  mocks.setupAcceptedInvitationPasswordWithToken.mockReset().mockResolvedValue({
    ...acceptedMemberInvitation,
    passwordPending: false,
    passwordUpdated: true,
  })
  mocks.setupInvitationPasswordWithToken.mockReset().mockResolvedValue({
    ...passwordReset,
    status: 'accepted',
    passwordPending: false,
    passwordUpdated: true,
  })
})

afterEach(cleanup)

describe('InvitationClient guided password reauthentication', () => {
  it('moves a completed reset to the password-updated screen with a login link', async () => {
    render(
      <InvitationClient
        invitationToken="verified-reset-proof"
        initialInvitation={passwordReset}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() => expectPasswordUpdatedScreen(passwordReset.email))
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledWith(
      'verified-reset-proof',
      passwordReset.email,
      passwordReset.id,
      'new-synthetic-password'
    )
    expect(mocks.acceptInvitation).not.toHaveBeenCalled()
    expect(mocks.setupAcceptedInvitationPasswordWithToken).not.toHaveBeenCalled()
  })

  it('moves a completed member invitation password setup to the password-updated screen', async () => {
    render(
      <InvitationClient
        invitationToken="member-invitation-proof"
        initialInvitation={acceptedMemberInvitation}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Set password and continue' }))

    await waitFor(() => expectPasswordUpdatedScreen(acceptedMemberInvitation.email))
    expect(mocks.setupAcceptedInvitationPasswordWithToken).toHaveBeenCalledWith(
      'member-invitation-proof',
      acceptedMemberInvitation.email,
      acceptedMemberInvitation.id,
      'new-synthetic-password'
    )
    expect(mocks.setupInvitationPasswordWithToken).not.toHaveBeenCalled()
  })

  it('moves a completed admin desktop password setup to the password-updated screen', async () => {
    mocks.setupAcceptedInvitationPasswordWithToken.mockResolvedValue({
      ...acceptedAdminDesktopInvitation,
      passwordPending: false,
      passwordUpdated: true,
    })
    render(
      <InvitationClient
        invitationToken="admin-invitation-proof"
        initialInvitation={acceptedAdminDesktopInvitation}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Set password and continue' }))

    await waitFor(() => expectPasswordUpdatedScreen(acceptedAdminDesktopInvitation.email))
    expect(mocks.setupAcceptedInvitationPasswordWithToken).toHaveBeenCalledWith(
      'admin-invitation-proof',
      acceptedAdminDesktopInvitation.email,
      acceptedAdminDesktopInvitation.id,
      'new-synthetic-password'
    )
    expect(mocks.setupInvitationPasswordWithToken).not.toHaveBeenCalled()
  })

  it('shows a retryable message when bounded recovery admission is busy', async () => {
    mocks.setupInvitationPasswordWithToken.mockRejectedValue(
      new ProfileApiError(429, 'rate_limited', '429 Too Many Requests - upstream wording changed')
    )
    render(
      <InvitationClient
        invitationToken="verified-reset-proof"
        initialInvitation={passwordReset}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(
      await screen.findByText(
        'Account recovery is temporarily busy. Please wait a moment and try again.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeEnabled()
    expect(screen.queryByRole('heading', { name: 'Password updated' })).toBeNull()
  })

  it.each([
    [
      'invitation_not_pending',
      409,
      '409 Conflict - invitation already used',
      'This invitation has already been used.',
    ],
    [
      'invalid_invitation',
      400,
      '400 Bad Request - recovery link rejected',
      'This recovery link is invalid or expired.',
    ],
    ['not_found', 404, '404 Not Found - recovery link unknown', 'Invitation not found.'],
  ] as const)(
    'turns a %s submit failure into usable terminal actions instead of blaming the new password',
    async (code, status, detail, message) => {
      mocks.setupInvitationPasswordWithToken.mockRejectedValue(
        new ProfileApiError(status, code, detail)
      )
      render(
        <InvitationClient
          invitationToken="invalidated-reset-proof"
          initialInvitation={passwordReset}
          initialError=""
        />
      )

      // The initial preview rendered the live form; the proof dies afterwards.
      expect(screen.getByRole('button', { name: 'Reset password' })).toBeInTheDocument()
      fillPassword()
      fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Password updated' })).toBeNull()
      expect(screen.queryByLabelText('Password')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull()
      expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
        PROFILE_ROUTES.login({ email: passwordReset.email })
      )
      expect(
        screen.getByRole('link', { name: 'Request a new recovery link' }).getAttribute('href')
      ).toBe(PROFILE_ROUTES.forgotPassword({ email: passwordReset.email }))
      expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
    }
  )

  it('offers only sign in when a member invitation proof is invalidated after preview', async () => {
    mocks.setupAcceptedInvitationPasswordWithToken.mockRejectedValue(
      new ProfileApiError(409, 'invitation_not_pending', '409 Conflict - invitation_not_pending')
    )
    render(
      <InvitationClient
        invitationToken="invalidated-member-proof"
        initialInvitation={acceptedMemberInvitation}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Set password and continue' }))

    expect(await screen.findByText('This invitation has already been used.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      PROFILE_ROUTES.login({ email: acceptedMemberInvitation.email })
    )
    expect(screen.queryByRole('link', { name: 'Request a new recovery link' })).toBeNull()
    expect(mocks.setupAcceptedInvitationPasswordWithToken).toHaveBeenCalledOnce()
  })

  it('releases the logout fence only for a current pending recovery capability', () => {
    window.localStorage.setItem('profile_logout_unconfirmed', 'true')

    const { rerender } = render(
      <InvitationClient
        invitationToken="used-recovery-proof"
        initialInvitation={{
          ...passwordReset,
          status: 'accepted',
          passwordPending: false,
          acceptedAt: new Date().toISOString(),
        }}
        initialError=""
      />
    )
    // A redeemed link is visible but cannot recover: the fence must survive.
    expect(screen.getByText('This invitation has already been used.')).toBeInTheDocument()
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')

    rerender(
      <InvitationClient
        invitationToken="expired-recovery-proof"
        initialInvitation={{
          ...passwordReset,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }}
        initialError=""
      />
    )
    expect(
      screen.getByText('This invitation has expired.', { selector: '.message--error-plain' })
    ).toBeInTheDocument()
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')

    rerender(
      <InvitationClient
        invitationToken="unmatched-recovery-proof"
        initialInvitation={null}
        initialError="Invitation not found."
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Invitation not found.')
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')

    rerender(
      <InvitationClient
        invitationToken="current-recovery-proof"
        initialInvitation={{
          ...passwordReset,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }}
        initialError=""
      />
    )
    // A current pending capability is the only case that releases the fence.
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeInTheDocument()
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBeNull()
  })

  it('does not resubmit a reset proof after an ambiguous recovery outcome', async () => {
    mocks.setupInvitationPasswordWithToken.mockRejectedValue(
      new ProfileApiError(
        503,
        'recovery_outcome_unknown',
        '503 Service Unavailable - mutation result unavailable'
      )
    )
    render(
      <InvitationClient
        invitationToken="verified-reset-proof"
        initialInvitation={passwordReset}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(
      await screen.findByText(
        'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.',
        { exact: true }
      )
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Try signing in' }).getAttribute('href')).toBe(
      PROFILE_ROUTES.login({ email: passwordReset.email })
    )
    expect(
      screen.getByRole('link', { name: 'Request a new recovery link' }).getAttribute('href')
    ).toBe(PROFILE_ROUTES.forgotPassword({ email: passwordReset.email }))
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
  })
})
