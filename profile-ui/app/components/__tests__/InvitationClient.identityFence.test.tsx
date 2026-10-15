import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

const mocks = vi.hoisted(() => ({
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
    acceptInvitation: vi.fn(),
    getEvenfireDownloadUrl: () => 'https://downloads.example.invalid/evenfire',
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
  mocks.checkAuth.mockReset()
  mocks.routerReplace.mockReset()
  mocks.setupInvitationPasswordWithToken.mockReset().mockResolvedValue({
    ...invitation,
    status: 'accepted',
    passwordUpdated: true,
    userId: 'r6-other-user',
  })
})

afterEach(cleanup)

describe('R6 reset response identity fence', () => {
  it('does not hydrate or navigate when the committed reset response names another user', async () => {
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

    expect(
      await screen.findByText(
        'Your password was updated, but the signed-in account does not match this recovery link.'
      )
    ).toBeTruthy()
    expect(mocks.setupInvitationPasswordWithToken).toHaveBeenCalledOnce()
    expect(mocks.checkAuth).not.toHaveBeenCalled()
    expect(mocks.routerReplace).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })
})
