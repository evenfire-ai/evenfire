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
  it('labels the environment setup handoff accurately', async () => {
    render(<Page />)

    const setupLink = await screen.findByRole('link', { name: 'Set up Desktop App' })

    expect(setupLink).toHaveAttribute(
      'href',
      'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.com&tenantName=Evenfire+Test'
    )
  })
})
