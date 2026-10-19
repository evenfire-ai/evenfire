import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
  vi.stubEnv('NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED', 'true')
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('Profile Portal home desktop app link', () => {
  it('keeps the welcome, portal prompt, and account summary in three cards', () => {
    api.getDesktopEnvironment.mockReturnValue(new Promise(() => {}))

    const view = render(<Page />)

    expect(view.container.querySelectorAll('.profile-page > .cu-card')).toHaveLength(3)
    expect(
      screen.getByRole('heading', { name: 'Welcome, Josue' }).closest('.cu-home-welcome-card')
    ).not.toBeNull()
    expect(screen.getByText('Profile Portal', { selector: 'strong' })).toBeInTheDocument()
  })

  it('does not discover or link a Desktop environment while handoffs are disabled', () => {
    vi.stubEnv('NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED', 'false')

    render(<Page />)

    expect(api.getDesktopEnvironment).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Automatic Desktop setup is not enabled yet.'
    )
    expect(screen.queryByRole('link', { name: 'Open Desktop App' })).not.toBeInTheDocument()
  })

  it('shows a loading status while desktop setup availability is checked', () => {
    api.getDesktopEnvironment.mockReturnValue(new Promise(() => {}))

    render(<Page />)

    expect(screen.getByRole('status')).toHaveTextContent('Checking desktop app setup…')
    expect(screen.queryByRole('link', { name: 'Open Desktop App' })).not.toBeInTheDocument()
  })

  it('keeps one polite live region as desktop setup changes from loading to ready', async () => {
    let resolveEnvironment!: (environment: DesktopEnvironmentResponse) => void
    api.getDesktopEnvironment.mockReturnValue(
      new Promise<DesktopEnvironmentResponse>(resolve => {
        resolveEnvironment = resolve
      })
    )

    render(<Page />)

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Checking desktop app setup…')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')

    resolveEnvironment(desktopEnvironment)

    await screen.findByRole('link', { name: 'Open Desktop App' })
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Open Desktop App instead.')
  })

  it('explains unavailable setup and links to Settings when discovery fails', async () => {
    api.getDesktopEnvironment.mockRejectedValue(new Error('Service unavailable'))

    render(<Page />)

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Desktop app setup is unavailable right now.'
      )
    )
    const unavailableStatus = screen.getByRole('status')

    expect(unavailableStatus).toHaveTextContent('Desktop app setup is unavailable right now.')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings/profile'
    )
    expect(screen.queryByRole('link', { name: 'Open Desktop App' })).not.toBeInTheDocument()
  })

  it('explains unavailable setup when discovery has no External REST API URL', async () => {
    api.getDesktopEnvironment.mockResolvedValue({
      ...desktopEnvironment,
      externalRestApiBaseUrl: '',
    })

    render(<Page />)

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Desktop app setup is unavailable right now.'
      )
    )
    const unavailableStatus = screen.getByRole('status')

    expect(unavailableStatus).toHaveTextContent('Desktop app setup is unavailable right now.')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings/profile'
    )
    expect(screen.queryByRole('link', { name: 'Open Desktop App' })).not.toBeInTheDocument()
  })

  it('labels the environment handoff as opening the desktop app instead', async () => {
    const environment = desktopEnvironment

    render(<Page />)

    const openLink = await screen.findByRole('link', { name: 'Open Desktop App' })
    const handoffCopy = openLink.closest('p')
    const href = new URL(openLink.getAttribute('href') ?? '')

    expect(handoffCopy).toHaveTextContent('Open Desktop App instead.')
    expect(href.searchParams.get('externalRestApiBaseUrl')).toBe(environment.externalRestApiBaseUrl)
    expect(href.searchParams.get('tenantName')).toBe(environment.appName)
    expect(href.searchParams.get('rpcProxyBaseUrl')).toBeNull()
  })

  it('builds the desktop app link from the production discovery response', () => {
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
    expect(parsedLink.searchParams.get('rpcProxyBaseUrl')).toBeNull()
  })
})
