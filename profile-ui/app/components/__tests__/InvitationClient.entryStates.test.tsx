import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PROFILE_ROUTES } from '@constants/routes'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    acceptInvitation: vi.fn(),
    setupAcceptedInvitationPasswordWithToken: vi.fn(),
    setupInvitationPasswordWithToken: vi.fn(),
  }
})

const baseInvitation: InvitationPreview = {
  id: 'entry-state-row',
  teamId: null,
  teamName: null,
  email: 'entry-state@example.invalid',
  role: 'member',
  purpose: 'member_invitation',
  status: 'pending',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  acceptedAt: null,
  userId: 'entry-state-user',
  passwordPending: true,
}

afterEach(cleanup)

describe('InvitationClient entry states', () => {
  it('shows the expired state without a password form', () => {
    render(
      <InvitationClient
        invitationToken="expired-invitation-token"
        initialInvitation={{
          ...baseInvitation,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }}
        initialError=""
      />
    )

    expect(
      screen.getByText('This invitation has expired.', { selector: '.message--error-plain' })
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set password and continue' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      PROFILE_ROUTES.login({ email: baseInvitation.email })
    )
  })

  it('shows the used state for an invitation whose password was already set', () => {
    render(
      <InvitationClient
        invitationToken="used-invitation-token"
        initialInvitation={{
          ...baseInvitation,
          status: 'accepted',
          passwordPending: false,
          acceptedAt: new Date().toISOString(),
        }}
        initialError=""
      />
    )

    expect(screen.getByText('This invitation has already been used.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      PROFILE_ROUTES.login({ email: baseInvitation.email })
    )
    expect(screen.queryByRole('link', { name: 'Request a new recovery link' })).toBeNull()
  })

  it('shows the used state with a fresh-link path for a redeemed recovery link', () => {
    render(
      <InvitationClient
        invitationToken="used-recovery-token"
        initialInvitation={{
          ...baseInvitation,
          purpose: 'password_reset',
          status: 'accepted',
          passwordPending: false,
          acceptedAt: new Date().toISOString(),
        }}
        initialError=""
      />
    )

    expect(screen.getByText('This invitation has already been used.')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Request a new recovery link' }).getAttribute('href')
    ).toBe(PROFILE_ROUTES.forgotPassword({ email: baseInvitation.email }))
  })

  it('shows the not-found state for an invented token without a password form', () => {
    render(
      <InvitationClient
        invitationToken="invented-invitation-token"
        initialInvitation={null}
        initialError="Invitation not found."
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Invitation not found.')
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Password updated' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      PROFILE_ROUTES.login()
    )
  })

  it('shows the not-found state for an expired link the authority already hides', () => {
    render(
      <InvitationClient
        invitationToken="expired-authority-token"
        initialInvitation={null}
        initialError="Invitation not found."
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Invitation not found.')
    expect(screen.queryByLabelText('Password')).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })
})
