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
    setupInvitationPasswordWithToken: mocks.setupInvitationPasswordWithToken,
  }
})

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
    [
      'unknown post-dispatch outcome',
      new ProfileApiError(503, 'recovery_outcome_unknown', 'temporary service message'),
    ],
    ['unclassified 500 failure', new ProfileApiError(500, 'upstream_failure', 'private detail')],
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
    ['rate limit', new ProfileApiError(429, 'rate_limited', 'upstream wording changed')],
    [
      'definite authority rejection',
      new ProfileApiError(503, 'authority_unavailable', 'temporary authority message'),
    ],
    ['definite internal failure', new ProfileApiError(500, 'internal_error', 'private detail')],
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
