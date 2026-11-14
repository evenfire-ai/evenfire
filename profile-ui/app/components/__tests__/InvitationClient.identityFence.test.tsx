import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PROFILE_ROUTES } from '@constants/routes'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

const mocks = vi.hoisted(() => ({
  setupInvitationPasswordWithToken: vi.fn(),
}))

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    acceptInvitation: vi.fn(),
    setupInvitationPasswordWithToken: mocks.setupInvitationPasswordWithToken,
  }
})

const invitation: InvitationPreview = {
  id: 'r6-identity-reset',
  teamId: null,
  teamName: null,
  email: 'r6-member@example.invalid',
  role: 'member',
  purpose: 'password_reset',
  status: 'pending',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  acceptedAt: null,
  userId: 'r6-expected-user',
  passwordPending: true,
}

beforeEach(() => {
  mocks.setupInvitationPasswordWithToken.mockReset().mockResolvedValue({
    ...invitation,
    status: 'accepted',
    passwordUpdated: true,
    userId: 'r6-other-user',
  })
})

afterEach(cleanup)

describe('R6 reset response session boundary', () => {
  it('shows the password-updated screen from the reset response without navigating', async () => {
    render(
      <InvitationClient
        invitationToken="r6-one-use-reset-proof"
        initialInvitation={invitation}
        initialError=""
      />
    )
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'R6-synthetic-new-password' },
    })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'R6-synthetic-new-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Password updated' })).toBeInTheDocument()
    )
    expect(
      screen.getByText(
        'Your password has been updated. Sign in with your new password to continue.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      PROFILE_ROUTES.login({ email: invitation.email })
    )
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
  })
})
