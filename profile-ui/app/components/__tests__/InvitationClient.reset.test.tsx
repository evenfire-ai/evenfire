import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PROFILE_ROUTES } from '@constants/routes'
import { ProfileApiError } from '@lib/api'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  checkAuth: vi.fn(),
  routerReplace: vi.fn(),
  setupAcceptedInvitationPasswordWithToken: vi.fn(),
  setupInvitationPasswordWithToken: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({ checkAuth: mocks.checkAuth }),
}))

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    acceptInvitation: mocks.acceptInvitation,
    getEvenfireDownloadUrl: () => 'https://downloads.example.invalid/evenfire',
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

beforeEach(() => {
  mocks.acceptInvitation.mockReset()
  mocks.checkAuth.mockReset().mockResolvedValue({
    status: 'authenticated',
    me: { id: 'user-1', email: 'member@example.invalid' },
  })
  mocks.routerReplace.mockReset()
  mocks.setupAcceptedInvitationPasswordWithToken.mockReset().mockResolvedValue({
    ...acceptedMemberInvitation,
    passwordPending: false,
    passwordUpdated: true,
  })
  mocks.setupInvitationPasswordWithToken.mockReset().mockResolvedValue({
    ...passwordReset,
    status: 'accepted',
    passwordUpdated: true,
  })
})

afterEach(cleanup)

describe('InvitationClient verified password recovery', () => {
  it('omits the expiry notice when the invitation timestamp is invalid', () => {
    render(
      <InvitationClient
        invitationToken="invalid-expiry-proof"
        initialInvitation={{
          ...passwordReset,
          purpose: 'member_invitation',
          expiresAt: 'not-a-date',
        }}
        initialError=""
      />
    )

    expect(screen.queryByText('This invitation will expire in 48 hours.')).toBeNull()
    expect(screen.queryByText('This invitation will expire in .')).toBeNull()
  })

  it('navigates to the authenticated home after reset completes', async () => {
    render(
      <InvitationClient
        invitationToken="verified-reset-proof"
        initialInvitation={passwordReset}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() => expect(mocks.routerReplace).toHaveBeenCalledWith(PROFILE_ROUTES.home))
    expect(mocks.checkAuth).toHaveBeenCalledOnce()
    expect(mocks.checkAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.routerReplace.mock.invocationCallOrder[0]
    )
    expect(mocks.acceptInvitation).not.toHaveBeenCalled()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledWith(
      'verified-reset-proof',
      'member@example.invalid',
      'reset-1',
      'new-synthetic-password'
    )
  })

  it('keeps a committed reset retryable when session hydration fails, without resubmitting it', async () => {
    mocks.checkAuth
      .mockReset()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({
        status: 'authenticated',
        me: { id: 'user-1', email: 'member@example.invalid' },
      })
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
        'Your password was updated, but we could not verify your account session. Try again.'
      )
    ).toBeTruthy()
    expect(mocks.routerReplace).not.toHaveBeenCalled()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Retry account session check' }))

    await waitFor(() => expect(mocks.routerReplace).toHaveBeenCalledWith(PROFILE_ROUTES.home))
    expect(mocks.checkAuth).toHaveBeenCalledTimes(2)
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
  })

  it('does not navigate when hydrated identity differs from the recovered member', async () => {
    mocks.checkAuth.mockResolvedValueOnce({
      status: 'authenticated',
      me: { id: 'different-user', email: 'other@example.invalid' },
    })
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
        'Your password was updated, but the signed-in account does not match this recovery link.'
      )
    ).toBeTruthy()
    expect(mocks.routerReplace).not.toHaveBeenCalled()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
  })

  it('keeps member invitation password setup on its existing page flow', async () => {
    mocks.setupInvitationPasswordWithToken.mockRejectedValue(
      new ProfileApiError(409, 'invitation_not_pending', '409 Conflict - invitation_not_pending')
    )
    render(
      <InvitationClient
        invitationToken="member-invitation-proof"
        initialInvitation={acceptedMemberInvitation}
        initialError=""
      />
    )

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Set password and continue' }))

    await waitFor(() => expect(screen.getByText('You are now registered with Evenfire.')))
    expect(mocks.routerReplace).not.toHaveBeenCalled()
    expect(mocks.setupAcceptedInvitationPasswordWithToken).toHaveBeenCalledWith(
      'member-invitation-proof',
      'member@example.invalid',
      'reset-1',
      'new-synthetic-password'
    )
    expect(mocks.setupInvitationPasswordWithToken).not.toHaveBeenCalled()
  })

  it('keeps admin desktop password setup on the ordinary invitation operation', async () => {
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

    await waitFor(() => expect(screen.getByText('You are now registered with Evenfire.')))
    expect(mocks.setupAcceptedInvitationPasswordWithToken).toHaveBeenCalledWith(
      'admin-invitation-proof',
      'admin@example.invalid',
      'admin-invite-1',
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
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeEnabled()
    expect(mocks.checkAuth).not.toHaveBeenCalled()
    expect(mocks.routerReplace).not.toHaveBeenCalled()
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

    expect(await screen.findByText('This recovery link is invalid or expired.')).toBeTruthy()
    expect(mocks.checkAuth).not.toHaveBeenCalled()
    expect(mocks.routerReplace).not.toHaveBeenCalled()
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
    ).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Try signing in' }).getAttribute('href')).toBe(
      PROFILE_ROUTES.login({ email: 'member@example.invalid' })
    )
    expect(
      screen.getByRole('link', { name: 'Request a new recovery link' }).getAttribute('href')
    ).toBe(PROFILE_ROUTES.forgotPassword({ email: 'member@example.invalid' }))
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
    expect(mocks.checkAuth).not.toHaveBeenCalled()
    expect(mocks.routerReplace).not.toHaveBeenCalled()
  })
})
