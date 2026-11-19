import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { AuthState } from '@components/AuthContext/types'
import Page from '../../page'

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
}))

const authState = vi.hoisted(
  (): AuthState => ({
    isLoggedIn: true,
    isLoading: false,
    me: {
      id: 'user-1',
      email: 'ada@example.com',
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
  useRouter: () => ({ replace: navigation.replace }),
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

beforeEach(() => {
  navigation.replace.mockClear()
  authState.isLoggedIn = true
  authState.isLoading = false
})

afterEach(cleanup)

describe('Profile root landing', () => {
  it('redirects signed-in users to the Social channels section', async () => {
    render(<Page />)

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('/channels')
    })
    expect(screen.queryByTestId('profile-login-panel')).not.toBeInTheDocument()
  })

  it('keeps the root as the login landing for signed-out users', () => {
    authState.isLoggedIn = false
    authState.me = null

    render(<Page />)

    expect(screen.getByTestId('profile-login-panel')).toBeInTheDocument()
    expect(navigation.replace).not.toHaveBeenCalled()
  })
})
