import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { buildDesktopEnvironmentLink } from '@lib/desktopAppLinks'
import type { DesktopEnvironmentResponse } from '@/app/types/api'
import desktopEnvironmentFixture from '@/test/fixtures/desktop-environment-response.json'
import Page from '../../page'

const api = vi.hoisted(() => ({
  getDesktopEnvironment: vi.fn(),
}))

const desktopEnvironment: DesktopEnvironmentResponse = desktopEnvironmentFixture

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
  api.getDesktopEnvironment.mockResolvedValue(desktopEnvironment)
})

afterEach(cleanup)

describe('Profile Portal home desktop setup link', () => {
  it('keeps the welcome, portal prompt, and account summary in three cards', () => {
    api.getDesktopEnvironment.mockReturnValue(new Promise(() => {}))

    const view = render(<Page />)

    expect(view.container.querySelectorAll('.cu-page-stack > .cu-card')).toHaveLength(3)
    expect(screen.getByText('Profile Portal', { selector: 'strong' })).toBeInTheDocument()
  })

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
    const environment = desktopEnvironment

    render(<Page />)

    const setupLink = await screen.findByRole('link', { name: 'Set up Desktop App' })
    const setupCopy = setupLink.closest('p')
    const href = new URL(setupLink.getAttribute('href') ?? '')

    expect(setupCopy).toHaveTextContent('Prefer the desktop app?')
    expect(setupCopy).not.toHaveTextContent('instead')
    expect(href.searchParams.get('externalRestApiBaseUrl')).toBe(environment.externalRestApiBaseUrl)
    expect(href.searchParams.get('tenantName')).toBe(environment.appName)
  })

  it('builds the setup link from the production discovery response', () => {
    const environment = desktopEnvironment
    const href = buildDesktopEnvironmentLink(environment)

    expect(href).not.toBeNull()
    const parsedLink = new URL(href ?? '')
    expect(parsedLink.protocol).toBe('evenfire:')
    expect(parsedLink.hostname).toBe('desktop-environment')
    expect(parsedLink.searchParams.get('externalRestApiBaseUrl')).toBe(
      environment.externalRestApiBaseUrl
    )
    expect(parsedLink.searchParams.get('tenantName')).toBe(environment.appName)
  })
})
