import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AuthState } from '@components/AuthContext/types'
import { ProfileAppFrame } from '@components/ProfileAppFrame'
import { OIDC_REFUSAL_MESSAGES } from '@constants/oidc'
import OidcResultPage from '../../oidc/result/page'
import OidcSignedInPage from '../../oidc/signed-in/page'

const navigationState = vi.hoisted(() => ({
  pathname: '/',
  search: '',
  replace: vi.fn(),
}))

const api = vi.hoisted(() => ({
  clearUnconfirmedLogout: vi.fn(),
}))

/** Signed out: the state a stale logout fence or a refused OIDC sign-in leaves. */
const authState = vi.hoisted(
  (): AuthState => ({
    isLoggedIn: false,
    isLoading: false,
    me: null,
  })
)

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({ replace: navigationState.replace }),
  useSearchParams: () => new URLSearchParams(navigationState.search),
}))

vi.mock('@lib/api', () => ({
  clearUnconfirmedLogout: api.clearUnconfirmedLogout,
}))

vi.mock('next/image', () => ({
  default: ({ alt = '', ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    authState,
    checkAuth: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

vi.mock('@components/ProfileAccessContext', () => ({
  ProfileAccessProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/LoginPanel', () => ({
  LoginPanel: () => <div data-testid="profile-login-panel">login-panel</div>,
}))

const MARKER_COOKIE = '__Host-ef_oidc_signed_in'

let cookieHeader = ''
const locationReplace = vi.fn()

beforeEach(() => {
  navigationState.pathname = '/'
  navigationState.search = ''
  navigationState.replace.mockClear()
  api.clearUnconfirmedLogout.mockReset()
  authState.isLoggedIn = false
  authState.isLoading = false
  authState.me = null
  cookieHeader = ''
  locationReplace.mockReset()
  // jsdom serves http, so it would drop the Secure marker cookie: serve the jar directly.
  vi.spyOn(document, 'cookie', 'get').mockImplementation(() => cookieHeader)
  vi.spyOn(document, 'cookie', 'set').mockImplementation(() => undefined)
  vi.stubGlobal('location', { ...window.location, replace: locationReplace })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ProfileAppFrame OIDC pages for a signed-out browser', () => {
  it('shows the refusal message on /oidc/result, not the login panel', async () => {
    navigationState.pathname = '/oidc/result'
    navigationState.search = 'reason=no_account'
    const page = await OidcResultPage({
      searchParams: Promise.resolve({ reason: 'no_account' }),
    })

    render(<ProfileAppFrame>{page}</ProfileAppFrame>)

    expect(screen.getByText(OIDC_REFUSAL_MESSAGES.no_account)).toBeInTheDocument()
    expect(screen.queryByTestId('profile-login-panel')).not.toBeInTheDocument()
  })

  it('mounts OidcSignedIn on /oidc/signed-in, which releases a stale fence with the marker', () => {
    navigationState.pathname = '/oidc/signed-in'
    cookieHeader = `${MARKER_COOKIE}=1`

    render(
      <ProfileAppFrame>
        <OidcSignedInPage />
      </ProfileAppFrame>
    )

    expect(screen.getByText('Signing you in...')).toBeInTheDocument()
    expect(screen.queryByTestId('profile-login-panel')).not.toBeInTheDocument()
    expect(api.clearUnconfirmedLogout).toHaveBeenCalledTimes(1)
    expect(locationReplace).toHaveBeenCalledWith('/')
  })

  it('on /oidc/signed-in opened by hand it leaves the fence and still goes to /', () => {
    navigationState.pathname = '/oidc/signed-in'

    render(
      <ProfileAppFrame>
        <OidcSignedInPage />
      </ProfileAppFrame>
    )

    expect(screen.getByText('Signing you in...')).toBeInTheDocument()
    expect(api.clearUnconfirmedLogout).not.toHaveBeenCalled()
    expect(locationReplace).toHaveBeenCalledWith('/')
  })

  it('keeps an authenticated route behind the login panel when signed out', () => {
    navigationState.pathname = '/members'

    render(
      <ProfileAppFrame>
        <div>members-page</div>
      </ProfileAppFrame>
    )

    expect(screen.getByTestId('profile-login-panel')).toBeInTheDocument()
    expect(screen.queryByText('members-page')).not.toBeInTheDocument()
  })
})
