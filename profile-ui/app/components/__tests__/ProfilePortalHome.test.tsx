import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Page from '../../page'

const api = vi.hoisted(() => ({
  getDesktopEnvironment: vi.fn(),
}))

vi.mock('@lib/api', () => ({
  getDesktopEnvironment: api.getDesktopEnvironment,
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      isLoading: false,
      isLoggedIn: true,
      me: {
        email: 'josue@example.com',
        name: 'Josue',
        profile: { displayName: 'Josue' },
      },
    },
  }),
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

beforeEach(() => {
  api.getDesktopEnvironment.mockReset()
  api.getDesktopEnvironment.mockResolvedValue({
    appName: 'Evenfire Test',
    externalRestApiBaseUrl: 'https://api.example.com',
    rpcProxyBaseUrl: 'https://rpc.example.com',
  })
})

afterEach(cleanup)

describe('Profile Portal home desktop setup link', () => {
  it('shows a loading status while desktop setup availability is checked', () => {
    api.getDesktopEnvironment.mockReturnValue(new Promise(() => {}))

    render(<Page />)

    expect(screen.getByRole('status')).toHaveTextContent('Checking desktop app setup…')
    expect(screen.queryByRole('link', { name: 'Set up Desktop App' })).not.toBeInTheDocument()
  })

  it('explains unavailable setup and links to Settings when discovery fails', async () => {
    api.getDesktopEnvironment.mockRejectedValue(new Error('Service unavailable'))

    render(<Page />)

    const unavailableStatus = await screen.findByRole('status')

    expect(unavailableStatus).toHaveTextContent('Desktop app setup is unavailable right now.')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings/profile'
    )
    expect(screen.queryByRole('link', { name: 'Set up Desktop App' })).not.toBeInTheDocument()
  })

  it('labels the environment setup handoff accurately', async () => {
    render(<Page />)

    const setupLink = await screen.findByRole('link', { name: 'Set up Desktop App' })
    const setupCopy = setupLink.closest('p')

    expect(setupCopy).toHaveTextContent('Prefer the desktop app?')
    expect(setupCopy).not.toHaveTextContent('instead')
    expect(setupLink).toHaveAttribute(
      'href',
      'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.com&tenantName=Evenfire+Test'
    )
  })
})
