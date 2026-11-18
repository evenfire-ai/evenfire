import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { AuthState } from '@components/AuthContext/types'
import { ProfileAppFrame } from '@components/ProfileAppFrame'
import Page from '../../page'

const navigationState = vi.hoisted(() => ({
  pathname: '/',
  search: '',
  replace: vi.fn(),
}))

const api = vi.hoisted(() => ({
  getDesktopEnvironment: vi.fn(),
  getDesktopRelease: vi.fn(),
}))

const authState = vi.hoisted(
  (): AuthState => ({
    isLoggedIn: true,
    isLoading: false,
    me: {
      id: 'user-1',
      email: 'admin@example.com',
      name: 'Ada Admin',
      role: 'admin',
      teamId: 'team-1',
      teamName: 'Core Team',
      profile: {
        displayName: 'Ada Admin',
        channels: {
          emails: [],
          telegramHandles: [],
          slackUserNames: [],
          telegramIds: [],
          discordUserNames: [],
          whatsappNumbers: [],
        },
      },
    },
  })
)

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({ replace: navigationState.replace }),
  useSearchParams: () => new URLSearchParams(navigationState.search),
}))

vi.mock('@lib/api', () => ({
  getDesktopEnvironment: api.getDesktopEnvironment,
  getDesktopRelease: api.getDesktopRelease,
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
  useProfileAccess: () => ({
    approvalTargets: [],
    approvalTargetsError: false,
    approvalTargetsLoading: false,
    canManageMembers: false,
    manageableTeams: [],
    manageableTeamsError: false,
    manageableTeamsLoading: false,
    refreshApprovalTargets: vi.fn(),
    refreshManageableTeams: vi.fn(),
  }),
}))

vi.mock('@components/LoginPanel', () => ({
  LoginPanel: () => <div data-testid="profile-login-panel">login-panel</div>,
}))

function renderRootPage() {
  return render(
    <ProfileAppFrame>
      <Page />
    </ProfileAppFrame>
  )
}

beforeEach(() => {
  api.getDesktopEnvironment.mockReset().mockReturnValue(new Promise(() => {}))
  api.getDesktopRelease.mockReset().mockReturnValue(new Promise(() => {}))
  navigationState.pathname = '/'
  navigationState.search = ''
  navigationState.replace.mockClear()
  authState.isLoggedIn = true
  authState.isLoading = false
  authState.me = {
    id: 'user-1',
    email: 'admin@example.com',
    name: 'Ada Admin',
    role: 'admin',
    teamId: 'team-1',
    teamName: 'Core Team',
    profile: {
      displayName: 'Ada Admin',
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
})

afterEach(cleanup)

describe('ProfileAppFrame root invite redirects', () => {
  it('redirects signed-in root invite links before rendering the app shell', async () => {
    navigationState.search = 'inviteToken=abc'

    const view = renderRootPage()

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith('/invitations/abc')
    })
    expect(navigationState.replace).not.toHaveBeenCalledWith('/channels')
    expect(view.container.querySelectorAll('.cu-sidebar')).toHaveLength(0)
  })

  it('redirects logged-out root invite links before showing login', async () => {
    navigationState.search = 'inviteToken=abc'
    authState.isLoggedIn = false
    authState.me = null

    renderRootPage()

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith('/invitations/abc')
    })
    expect(screen.queryByTestId('profile-login-panel')).not.toBeInTheDocument()
  })

  it('sends signed-in users from the root to the Social channels section inside a single shell', async () => {
    const view = renderRootPage()

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith('/channels')
    })
    expect(view.container.querySelectorAll('.cu-sidebar')).toHaveLength(1)
    expect(navigationState.replace).not.toHaveBeenCalledWith(
      expect.stringContaining('/invitations')
    )
  })

  it('keeps unrelated root query strings protected and lands on Social channels', async () => {
    navigationState.search = 'next=%2Fmembers'

    renderRootPage()

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith('/channels')
    })
    expect(navigationState.replace).not.toHaveBeenCalledWith(
      expect.stringContaining('/invitations')
    )
  })

  it('keeps empty invite tokens protected and lands on Social channels', async () => {
    navigationState.search = 'inviteToken='

    renderRootPage()

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith('/channels')
    })
    expect(navigationState.replace).not.toHaveBeenCalledWith(
      expect.stringContaining('/invitations')
    )
  })
})
