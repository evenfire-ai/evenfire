import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ProfileAppFrame } from '@components/ProfileAppFrame'
import Page from '../../page'

const navigationState = vi.hoisted(() => ({
  pathname: '/',
  search: '',
  replace: vi.fn(),
}))

const authState = vi.hoisted(() => ({
  isLoggedIn: true,
  isLoading: false,
  me: {
    id: 'user-1',
    email: 'admin@example.com',
    name: 'Ada Admin',
    role: 'admin',
    profile: {
      displayName: 'Ada Admin',
    },
  },
}))

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({ replace: navigationState.replace }),
  useSearchParams: () => new URLSearchParams(navigationState.search),
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
    profile: {
      displayName: 'Ada Admin',
    },
  }
})

afterEach(cleanup)

describe('ProfileAppFrame root invite redirects', () => {
  it('redirects signed-in root invite links before rendering the home shell', async () => {
    navigationState.search = 'inviteToken=abc'

    renderRootPage()

    await waitFor(() => {
      expect(navigationState.replace).toHaveBeenCalledWith('/invitations/abc')
    })
    expect(screen.queryByText(/Welcome, Ada Admin/i)).not.toBeInTheDocument()
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

  it('keeps ordinary signed-in root rendering inside a single profile shell', () => {
    const view = renderRootPage()

    expect(screen.getByRole('heading', { name: /Welcome, Ada Admin/i })).toBeInTheDocument()
    expect(view.container.querySelectorAll('.cu-sidebar')).toHaveLength(1)
    expect(navigationState.replace).not.toHaveBeenCalled()
  })

  it('keeps unrelated root query strings protected', () => {
    navigationState.search = 'next=%2Fmembers'

    renderRootPage()

    expect(screen.getByRole('heading', { name: /Welcome, Ada Admin/i })).toBeInTheDocument()
    expect(navigationState.replace).not.toHaveBeenCalled()
  })

  it('keeps empty invite tokens protected', () => {
    navigationState.search = 'inviteToken='

    renderRootPage()

    expect(screen.getByRole('heading', { name: /Welcome, Ada Admin/i })).toBeInTheDocument()
    expect(navigationState.replace).not.toHaveBeenCalled()
  })
})
