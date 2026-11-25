import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthState } from '@components/AuthContext/types'
import { DesktopSetupPanel } from '@components/DesktopSetupPanel'
import { ProfileApiError } from '@lib/api'
import type { DesktopAuthorizationResponse } from '@/app/types/api'
import type { Me } from '@/app/types/profile'
import DesktopSetupPage from '../../desktop-setup/page'

const mocks = vi.hoisted(() => ({
  authState: { isLoggedIn: true, isLoading: false, me: null } as AuthState,
  createDesktopAuthorization: vi.fn(),
  navigateToDesktopApp: vi.fn(),
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    authState: mocks.authState,
    checkAuth: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    signOutIncomplete: false,
    signOutPending: false,
    retrySignOut: vi.fn(),
  }),
}))

vi.mock('@components/LoginPanel', () => ({
  LoginPanel: ({ returnTo }: { returnTo?: string }) => (
    <div data-return-to={returnTo}>login-panel</div>
  ),
}))

vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return { ...actual, createDesktopAuthorization: mocks.createDesktopAuthorization }
})

vi.mock('@lib/desktopAppLinks', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/desktopAppLinks')>()
  return { ...actual, navigateToDesktopApp: mocks.navigateToDesktopApp }
})

const SESSION_EMAIL = 'member@example.test'
const QUERY_EMAIL = 'other@example.test'
const AUTHORIZE_BUTTON = `Authorize Desktop for ${SESSION_EMAIL}`
const HUB_404_COPY =
  "Desktop setup by invitation isn't available for this account. Use Settings → Setup desktop app instead."

const sessionMember: Me = {
  id: 'user-1',
  email: SESSION_EMAIL,
  name: 'Fixture Member',
  role: 'member',
  teamId: null,
  teamName: null,
  profile: {
    displayName: 'Fixture Member',
    channels: {
      emails: [],
      telegramHandles: [],
      slackUserNames: [],
      telegramIds: [],
      discordUserNames: [],
      whatsappNumbers: [],
    },
  },
}

// The public chain's 200 body for this route, as
// control-api/test/passwordRecovery.http.contract.test.ts ('authorizes desktop setup without a
// password') pins it through the edge. The route is not in the recorded edge.json chain.
const authorization: DesktopAuthorizationResponse = {
  authorizationToken: 'fixture-desktop-authorization-token',
  expiresInSeconds: 120,
}

// What apiSend throws for the edge's 404 `{ error: 'Invitation setup not found' }`, pinned by the
// same contract test ('maps the producer desktop-registration not-found code ...').
function hubNotFound(): ProfileApiError {
  return new ProfileApiError(
    404,
    'Invitation setup not found',
    '404 Not Found - Invitation setup not found'
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => {
    resolve = next
  })
  return { promise, resolve }
}

function openedLink(): URL {
  expect(mocks.navigateToDesktopApp).toHaveBeenCalledOnce()
  return new URL(String(mocks.navigateToDesktopApp.mock.calls[0]?.[0]))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authState = { isLoggedIn: true, isLoading: false, me: sessionMember }
  mocks.createDesktopAuthorization.mockResolvedValue(authorization)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('DesktopSetupPanel', () => {
  it('builds the link from the session email when the query email differs', async () => {
    window.history.replaceState(null, '', `/desktop-setup?email=${encodeURIComponent(QUERY_EMAIL)}`)
    render(<DesktopSetupPanel />)

    expect(screen.getByText(SESSION_EMAIL)).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(QUERY_EMAIL))).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: AUTHORIZE_BUTTON }))

    await waitFor(() => expect(mocks.navigateToDesktopApp).toHaveBeenCalled())
    expect(mocks.createDesktopAuthorization).toHaveBeenCalledOnce()
    expect(mocks.createDesktopAuthorization).toHaveBeenCalledWith()
    const link = openedLink()
    expect(link.protocol).toBe('evenfire:')
    expect(link.hostname).toBe('desktop-setup')
    expect(link.searchParams.get('email')).toBe(SESSION_EMAIL)
    expect(link.searchParams.get('authorizationToken')).toBe(authorization.authorizationToken)
    expect(link.href).not.toContain(encodeURIComponent(QUERY_EMAIL))
    expect(link.href).not.toContain(QUERY_EMAIL)
  })

  it('shows no password field and no copy-token button', async () => {
    const view = render(<DesktopSetupPanel />)

    const authorize = screen.getByRole('button', { name: AUTHORIZE_BUTTON })
    expect(authorize).toBeEnabled()
    expect(view.container.querySelector('input[type="password"]')).toBeNull()
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()

    // The old page offered its copy-token button only after a token was minted.
    fireEvent.click(authorize)
    await waitFor(() => expect(mocks.navigateToDesktopApp).toHaveBeenCalled())

    expect(screen.getByRole('button', { name: AUTHORIZE_BUTTON })).toBeEnabled()
    expect(view.container.querySelector('input[type="password"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
    expect(view.container.textContent).not.toContain(authorization.authorizationToken)
  })

  it('explains a hub 404', async () => {
    mocks.createDesktopAuthorization.mockRejectedValueOnce(hubNotFound())
    const view = render(<DesktopSetupPanel />)

    fireEvent.click(screen.getByRole('button', { name: AUTHORIZE_BUTTON }))

    expect(await screen.findByText(HUB_404_COPY)).toBeInTheDocument()
    expect(mocks.createDesktopAuthorization).toHaveBeenCalledOnce()
    expect(mocks.navigateToDesktopApp).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain('Invitation setup not found')
    // A retry is the documented path.
    expect(screen.getByRole('button', { name: AUTHORIZE_BUTTON })).toBeEnabled()
  })

  it('disables the button while the request is pending', async () => {
    const pending = deferred<DesktopAuthorizationResponse>()
    mocks.createDesktopAuthorization.mockReturnValueOnce(pending.promise)
    render(<DesktopSetupPanel />)

    const authorize = screen.getByRole('button', { name: AUTHORIZE_BUTTON })
    fireEvent.click(authorize)
    expect(authorize).toBeDisabled()
    fireEvent.click(authorize)
    expect(mocks.createDesktopAuthorization).toHaveBeenCalledOnce()

    pending.resolve(authorization)
    await waitFor(() => expect(authorize).toBeEnabled())
    expect(openedLink().searchParams.get('authorizationToken')).toBe(
      authorization.authorizationToken
    )
    expect(mocks.createDesktopAuthorization).toHaveBeenCalledOnce()
  })

  it('shows a generic message for any other failure, logs nothing and allows a retry', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
      vi.spyOn(console, method)
    )
    mocks.createDesktopAuthorization.mockRejectedValueOnce(
      new ProfileApiError(
        503,
        'authority_unavailable',
        '503 Service Unavailable - authority_unavailable'
      )
    )
    const view = render(<DesktopSetupPanel />)

    fireEvent.click(screen.getByRole('button', { name: AUTHORIZE_BUTTON }))

    expect(
      await screen.findByText("Desktop setup couldn't be authorized. Try again.")
    ).toBeVisible()
    expect(view.container.textContent).not.toContain('authority_unavailable')
    expect(view.container.textContent).not.toContain(HUB_404_COPY)
    expect(mocks.navigateToDesktopApp).not.toHaveBeenCalled()
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()

    const authorize = screen.getByRole('button', { name: AUTHORIZE_BUTTON })
    expect(authorize).toBeEnabled()
    fireEvent.click(authorize)
    await waitFor(() => expect(mocks.navigateToDesktopApp).toHaveBeenCalled())
    expect(mocks.createDesktopAuthorization).toHaveBeenCalledTimes(2)
    expect(screen.queryByText("Desktop setup couldn't be authorized. Try again.")).toBeNull()
  })
})

describe('/desktop-setup page', () => {
  it('shows the sign-in panel returning to /desktop-setup when signed out', () => {
    mocks.authState = { isLoggedIn: false, isLoading: false, me: null }
    render(<DesktopSetupPage />)

    expect(screen.getByText('login-panel')).toHaveAttribute('data-return-to', 'desktop-setup')
    expect(screen.queryByRole('button', { name: /Authorize Desktop/ })).toBeNull()
  })

  it('shows the authorize button for the signed-in member', () => {
    render(<DesktopSetupPage />)

    expect(screen.getByRole('button', { name: AUTHORIZE_BUTTON })).toBeEnabled()
    expect(screen.queryByText('login-panel')).toBeNull()
  })
})
