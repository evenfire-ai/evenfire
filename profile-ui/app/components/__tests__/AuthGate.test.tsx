import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { useAuth } from '../AuthContext'
import { AuthGate } from '../AuthGate'

vi.mock('../AuthContext', () => ({ useAuth: vi.fn() }))
vi.mock('../LoginPanel', () => ({
  LoginPanel: ({ returnTo }: { returnTo?: string }) => (
    <div data-return-to={returnTo}>login-panel</div>
  ),
}))

afterEach(cleanup)

describe('AuthGate', () => {
  it('renders a skeleton while profile auth resolves', () => {
    vi.mocked(useAuth).mockReturnValue({
      authState: { isLoggedIn: false, isLoading: true, me: null },
      checkAuth: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      signOutIncomplete: false,
      signOutPending: false,
      retrySignOut: vi.fn(),
    })
    const view = render(
      <AuthGate>
        <div>protected profile content</div>
      </AuthGate>
    )

    expect(screen.getByRole('status', { name: /loading profile session/i })).toBeInTheDocument()
    expect(screen.queryByText(/^Loading/i)).toBeNull()
    expect(view.container.querySelectorAll('.profile-skeleton__line').length).toBeGreaterThan(0)
  })

  it.each([false, true])(
    'hydrates the server loading shell when auth already resolved (logged in: %s)',
    async isLoggedIn => {
      const value = {
        authState: { isLoggedIn: false, isLoading: true, me: null },
        checkAuth: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
        signOutIncomplete: false,
        signOutPending: false,
        retrySignOut: vi.fn(),
      }
      vi.mocked(useAuth).mockReturnValue(value)
      const content = (
        <AuthGate>
          <div>protected profile content</div>
        </AuthGate>
      )
      const container = document.createElement('div')
      container.innerHTML = renderToString(content)
      document.body.append(container)
      vi.mocked(useAuth).mockReturnValue({
        ...value,
        authState: { ...value.authState, isLoading: false, isLoggedIn },
      })
      const recover = vi.fn()
      let root: ReturnType<typeof hydrateRoot> | undefined
      try {
        await act(async () => {
          root = hydrateRoot(container, content, { onRecoverableError: recover })
        })
        expect(container.textContent).toContain(
          isLoggedIn ? 'protected profile content' : 'login-panel'
        )
        expect(recover).not.toHaveBeenCalled()
      } finally {
        await act(async () => root?.unmount())
        container.remove()
      }
    }
  )

  it('passes returnTo to the sign-in panel when signed out', () => {
    vi.mocked(useAuth).mockReturnValue({
      authState: { isLoggedIn: false, isLoading: false, me: null },
      checkAuth: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      signOutIncomplete: false,
      signOutPending: false,
      retrySignOut: vi.fn(),
    })

    render(
      <AuthGate returnTo="desktop-setup">
        <div>protected profile content</div>
      </AuthGate>
    )
    expect(screen.getByText('login-panel')).toHaveAttribute('data-return-to', 'desktop-setup')
    expect(screen.queryByText('protected profile content')).toBeNull()

    cleanup()
    render(
      <AuthGate>
        <div>protected profile content</div>
      </AuthGate>
    )
    expect(screen.getByText('login-panel')).not.toHaveAttribute('data-return-to')
  })
})
