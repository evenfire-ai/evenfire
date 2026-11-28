import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PROFILE_ROUTES } from '@constants/routes'
import type { AcceptInvitationResponse, InvitationPreview } from '@/app/types/api'
import { edgeRecord, edgeResponse } from '@/test/edgeFixtures'
import { InvitationClient } from '../../invitations/[token]/InvitationClient'

const mocks = vi.hoisted(() => ({ acceptInvitation: vi.fn() }))

// The real getOidcSignInMethod runs, so the stubbed fetch below is the only configuration source.
vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    acceptInvitation: mocks.acceptInvitation,
    setupAcceptedInvitationPasswordWithToken: vi.fn(),
    setupInvitationPasswordWithToken: vi.fn(),
  }
})

const CONFIGURATION_PATH = '/external-rest-api/api/v1/oidc/profile-flow/configuration'
const CONFIGURATION_ACTIVATED = 'GET /api/v1/oidc/profile-flow/configuration activated'
const LABEL = (edgeRecord(CONFIGURATION_ACTIVATED).body as { displayLabel: string }).displayLabel
const CONTINUE = `Continue with ${LABEL}`
/** Printable ASCII, with characters a urlencoded form escapes, so any re-encoding shows. */
const INVITATION_TOKEN = 'fixture-invitation-token+/=%20&~'

const fetchMock = vi.fn()

const pendingInvitation: InvitationPreview = {
  id: 'oidc-invitation-row',
  teamId: null,
  teamName: null,
  email: 'invitee@example.invalid',
  role: 'member',
  purpose: 'member_invitation',
  status: 'pending',
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  acceptedAt: null,
  userId: null,
  passwordPending: true,
}
const expiredInvitation: InvitationPreview = {
  ...pendingInvitation,
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
}
const usedInvitation: InvitationPreview = {
  ...pendingInvitation,
  status: 'accepted',
  acceptedAt: new Date().toISOString(),
  userId: 'oidc-invitation-user',
  passwordPending: false,
}
const passwordPendingInvitation: InvitationPreview = { ...usedInvitation, passwordPending: true }
const passwordReset: InvitationPreview = {
  ...pendingInvitation,
  purpose: 'password_reset',
  userId: 'oidc-reset-user',
}

function renderInvitation(initialInvitation: InvitationPreview | null, initialError = '') {
  return render(
    <InvitationClient
      invitationToken={INVITATION_TOKEN}
      initialInvitation={initialInvitation}
      initialError={initialError}
    />
  )
}

function answerActivated() {
  fetchMock.mockImplementation(async () => edgeResponse(CONFIGURATION_ACTIVATED))
}

/** Lets a pending configuration answer and its state update settle before a negative check. */
async function settle() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function expectConfigurationFetchedOnce() {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  expect(fetchMock.mock.calls[0]?.[0]).toBe(CONFIGURATION_PATH)
  await settle()
}

async function findProviderForm(): Promise<{ button: HTMLButtonElement; form: HTMLFormElement }> {
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: CONTINUE })
  const form = button.closest('form')
  if (!form) throw new Error('expected the provider button inside a form')
  return { button, form }
}

beforeEach(() => {
  fetchMock.mockReset()
  mocks.acceptInvitation.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('InvitationClient provider sign-in', () => {
  it('offers Continue with the provider when the preview failed', async () => {
    answerActivated()

    renderInvitation(null, 'Invitation not found.')

    const { button, form } = await findProviderForm()
    await expectConfigurationFetchedOnce()
    const signIn = screen.getByRole('link', { name: 'Sign in' })
    expect(signIn.getAttribute('href')).toBe(PROFILE_ROUTES.login({}))
    // Below the action panel.
    expect(signIn.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(form.getAttribute('action')).toBe(PROFILE_ROUTES.oidcStart)
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post')
    expect(button.getAttribute('type')).toBe('submit')
    // The secondary variant: no primary modifier.
    expect(button).toHaveClass('cu-btn')
    expect(button).not.toHaveClass('cu-btn--primary')
  })

  it('posts the invitation token to /api/oidc/start', async () => {
    for (const [mode, preview, panelControl] of [
      ['link-error', null, () => screen.getByRole('link', { name: 'Sign in' })],
      [
        'accept',
        pendingInvitation,
        () => screen.getByRole('button', { name: 'Accept invitation' }),
      ],
      [
        'expired',
        expiredInvitation,
        () =>
          screen.getByText('This invitation has expired.', { selector: '.message--error-plain' }),
      ],
      ['used', usedInvitation, () => screen.getByRole('link', { name: 'Download Evenfire' })],
    ] as const) {
      fetchMock.mockReset()
      answerActivated()

      renderInvitation(preview, preview ? '' : 'Invitation not found.')

      const { button, form } = await findProviderForm()
      await expectConfigurationFetchedOnce()
      expect(panelControl()).toBeInTheDocument()
      const fields = form.querySelectorAll<HTMLInputElement>('input')
      expect(fields, mode).toHaveLength(1)
      expect(fields[0]?.type, mode).toBe('hidden')
      expect(fields[0]?.name, mode).toBe('invitationToken')
      expect(fields[0]?.value, mode).toBe(INVITATION_TOKEN)
      // What the browser submits, the button included: only the token, exactly as given.
      expect([...new FormData(form, button).entries()], mode).toEqual([
        ['invitationToken', INVITATION_TOKEN],
      ])
      expect(form.getAttribute('action'), mode).toBe(PROFILE_ROUTES.oidcStart)
      cleanup()
    }
  })

  it('offers no provider button and makes no configuration fetch for a password reset whose preview loaded, or during password setup', async () => {
    for (const [label, preview, panelControl] of [
      [
        'a password reset',
        passwordReset,
        () => screen.getByRole('button', { name: 'Reset password' }),
      ],
      [
        'a used password reset',
        { ...passwordReset, status: 'accepted', passwordPending: false },
        () => screen.getByRole('link', { name: 'Request a new recovery link' }),
      ],
      [
        'an expired password reset',
        { ...passwordReset, expiresAt: new Date(Date.now() - 60_000).toISOString() },
        () =>
          screen.getByText('This invitation has expired.', { selector: '.message--error-plain' }),
      ],
      [
        'an accepted invitation waiting for its password',
        passwordPendingInvitation,
        () => screen.getByRole('button', { name: 'Set password and continue' }),
      ],
    ] as const) {
      fetchMock.mockReset()
      answerActivated()

      renderInvitation(preview)
      await settle()

      expect(panelControl(), label).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Continue with/ }), label).toBeNull()
      expect(fetchMock, label).not.toHaveBeenCalled()
      cleanup()
    }

    // The same answer does reach a page that opens on Accept, and accepting moves it to the
    // password panel, which offers no provider button and fetches nothing more.
    fetchMock.mockReset()
    answerActivated()
    const accepted: AcceptInvitationResponse = {
      ...passwordPendingInvitation,
      accepted: true,
    }
    mocks.acceptInvitation.mockResolvedValue(accepted)
    renderInvitation(pendingInvitation)
    await findProviderForm()
    await expectConfigurationFetchedOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))

    expect(
      await screen.findByRole('button', { name: 'Set password and continue' })
    ).toBeInTheDocument()
    expect(mocks.acceptInvitation).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('offers the provider button again after a failed accept', async () => {
    answerActivated()
    mocks.acceptInvitation.mockRejectedValue(new Error('forbidden'))
    renderInvitation(pendingInvitation)
    await findProviderForm()
    await expectConfigurationFetchedOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invitation email does not match.')
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CONTINUE })).toBeInTheDocument()
    expect(mocks.acceptInvitation).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('offers no provider button and shows no error when the configuration request fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))

    renderInvitation(pendingInvitation)

    await expectConfigurationFetchedOnce()
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
