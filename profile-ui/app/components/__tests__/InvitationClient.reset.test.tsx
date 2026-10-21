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

  it('shows a recovery-link error instead of blaming the new password', async () => {
    mocks.setupInvitationPasswordWithToken.mockRejectedValue(
      new ProfileApiError(400, 'invalid_invitation', '400 Bad Request - recovery link rejected')
    )
    render(
      <InvitationClient
        invitationToken="invalid-reset-proof"
        initialInvitation={passwordReset}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(await screen.findByText('This recovery link is invalid or expired.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Password updated' })).toBeNull()
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
