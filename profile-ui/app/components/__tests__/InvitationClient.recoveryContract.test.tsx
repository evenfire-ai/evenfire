import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PROFILE_ROUTES } from '@constants/routes'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  checkAuth: vi.fn(),
  routerReplace: vi.fn(),
  setupInvitationPasswordWithToken: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({ checkAuth: mocks.checkAuth }),
}))

vi.mock('@lib/api', () => ({
  acceptInvitation: mocks.acceptInvitation,
  getEvenfireDownloadUrl: () => 'https://downloads.example.invalid/evenfire',
  setupInvitationPasswordWithToken: mocks.setupInvitationPasswordWithToken,
}))

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

beforeEach(() => {
  mocks.acceptInvitation.mockReset()
  mocks.checkAuth.mockReset().mockResolvedValue({ status: 'unavailable' })
  mocks.routerReplace.mockReset()
  mocks.setupInvitationPasswordWithToken.mockReset().mockResolvedValue({
    ...passwordReset,
    status: 'accepted',
    passwordUpdated: true,
    userId: passwordReset.userId,
  })
})

afterEach(cleanup)

describe('R6 recovery outcome and identity fences', () => {
  it.each([
    ['transport TypeError', new TypeError('socket closed after dispatch')],
    ['response SyntaxError', new SyntaxError('upstream response was not JSON')],
    ['unknown post-dispatch outcome', new Error('503 unavailable - recovery_outcome_unknown')],
  ])('does not replay a reset after %s', async (_label, error) => {
    mocks.setupInvitationPasswordWithToken.mockRejectedValueOnce(error)
    renderReset()
    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(
      await screen.findByText(
        'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.',
        { exact: true }
      )
    ).toBeTruthy()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
    expect(mocks.checkAuth).not.toHaveBeenCalled()
    expect(mocks.routerReplace).not.toHaveBeenCalled()
  })

  it.each([
    ['rate limit', new Error('429 Too Many Requests - rate_limited')],
    ['definite authority rejection', new Error('503 Service Unavailable - authority_unavailable')],
  ])('keeps a definite %s retryable rather than ambiguous', async (_label, error) => {
    mocks.setupInvitationPasswordWithToken.mockRejectedValueOnce(error).mockResolvedValueOnce({
      ...passwordReset,
      status: 'accepted',
      passwordUpdated: true,
      userId: passwordReset.userId,
    })
    mocks.checkAuth.mockResolvedValueOnce({
      status: 'authenticated',
      me: { id: passwordReset.userId, email: passwordReset.email },
    })
    renderReset()
    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(await screen.findByRole('button', { name: 'Reset password' })).toBeEnabled()
    expect(mocks.checkAuth).not.toHaveBeenCalled()
    expect(mocks.routerReplace).not.toHaveBeenCalled()

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
    await waitFor(() => expect(mocks.routerReplace).toHaveBeenCalledWith(PROFILE_ROUTES.home))
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledTimes(2)
  })
})
