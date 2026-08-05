import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useAuth } from '../AuthContext'
import { AuthGate } from '../AuthGate'

vi.mock('../AuthContext', () => ({ useAuth: vi.fn() }))
vi.mock('../LoginPanel', () => ({ LoginPanel: () => <div>login-panel</div> }))

afterEach(cleanup)

describe('AuthGate', () => {
  it('renders a skeleton while profile auth resolves', () => {
    vi.mocked(useAuth).mockReturnValue({
      authState: { isLoggedIn: false, isLoading: true, me: null },
      checkAuth: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
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
})
