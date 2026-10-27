import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROFILE_ROUTES } from '@constants/routes'
import { ProfileApiError } from '@lib/api'
import type { InvitationPreview } from '@/app/types/api'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

type ContractEntry = {
  route: 'password' | 'password-reset'
  previewPurpose?: string
  serviceError?: string
  acceptError?: string
  status: number
  body: Record<string, string>
  componentPreview: 'reset' | 'accepted_member'
  terminal: boolean
  uiMessage: string
}

// Read at runtime, not imported: the image build type-checks this file with
// only profile-ui/ in its context, where the repository contract is absent.
// jsdom gives import.meta.url a non-file scheme, so resolve from the package root.
const contract = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../tests/contracts/invitation-password-public-errors.json'),
    'utf8'
  )
) as Record<string, ContractEntry>

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

function stubEdgeResponse(status: number, body: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        statusText: 'Synthetic Edge Status',
        headers: { 'content-type': 'application/json' },
      })
    )
  )
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('InvitationClient guided password reauthentication', () => {
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

  it.each(Object.entries(contract))(
    'turns the real %s edge response into terminal actions from the parsed body',
    async (_name, entry) => {
      const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
      const preview = entry.componentPreview === 'reset' ? passwordReset : acceptedMemberInvitation
      if (entry.componentPreview === 'reset') {
        mocks.setupInvitationPasswordWithToken.mockImplementation(
          async (invitationUrlId: string, email: string, invitationId: string, password: string) =>
            actual.setupInvitationPasswordWithToken(invitationUrlId, email, invitationId, password)
        )
      } else {
        mocks.setupAcceptedInvitationPasswordWithToken.mockImplementation(
          async (invitationUrlId: string, email: string, invitationId: string, password: string) =>
            actual.setupAcceptedInvitationPasswordWithToken(
              invitationUrlId,
              email,
              invitationId,
              password
            )
        )
      }
      stubEdgeResponse(entry.status, entry.body)

      render(
        <InvitationClient
          invitationToken="invalidated-invitation-proof"
          initialInvitation={preview}
          initialError=""
        />
      )

      const submitLabel =
        entry.componentPreview === 'reset' ? 'Reset password' : 'Set password and continue'
      // The initial preview rendered the live form; the proof dies afterwards.
      expect(screen.getByRole('button', { name: submitLabel })).toBeInTheDocument()
      fillPassword()
      fireEvent.click(screen.getByRole('button', { name: submitLabel }))

      expect(await screen.findByText(entry.uiMessage)).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Password updated' })).toBeNull()
      expect(screen.queryByLabelText('Password')).toBeNull()
      expect(screen.queryByRole('button', { name: submitLabel })).toBeNull()
      expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
        PROFILE_ROUTES.login({ email: preview.email })
      )
      expect(
        screen.getByRole('link', { name: 'Request a new recovery link' }).getAttribute('href')
      ).toBe(PROFILE_ROUTES.forgotPassword({ email: preview.email }))
      expect(fetch).toHaveBeenCalledOnce()
    }
  )

  it('keeps the logout fence on every preview and clears it only after the reset is accepted', async () => {
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
    // Even a current pending preview is a page view, not an authoritative
    // server result: a stale snapshot and a slow browser clock cannot release
    // the fence here.
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeInTheDocument()
    expect(window.localStorage.getItem('profile_logout_unconfirmed')).toBe('true')

    fillPassword()
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
    await waitFor(() => expectPasswordUpdatedScreen(passwordReset.email))
    // Only the accepted reset releases the surviving session.
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
