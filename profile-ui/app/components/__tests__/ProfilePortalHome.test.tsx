import React from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { buildDesktopEnvironmentLink } from '@lib/desktopAppLinks'
import type { DesktopEnvironmentResponse } from '@/app/types/api'
import Page from '../../page'

type ExpressTestApp = { use: (path: string, router: unknown) => void }
type ExpressFactory = () => ExpressTestApp
type SupertestResponse = { body: unknown }
type SupertestRequest = { expect: (status: number) => Promise<SupertestResponse> }
type SupertestFactory = (app: ExpressTestApp) => { get: (path: string) => SupertestRequest }

const requireExternalRestApi = createRequire(
  join(resolve(process.cwd(), '../external-rest-api'), 'package.json')
)
const express = requireExternalRestApi('express') as ExpressFactory
const request = requireExternalRestApi('supertest') as SupertestFactory

const api = vi.hoisted(() => ({
  getDesktopEnvironment: vi.fn(),
}))

const originalDesktopEnvironmentConfig = {
  appName: process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME,
  externalRestApiBaseUrl: process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL,
  rpcProxyBaseUrl: process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL,
}

async function getDesktopEnvironmentFromProducer(): Promise<DesktopEnvironmentResponse> {
  const { createDesktopRouter } =
    await import('../../../../external-rest-api/src/routes/desktop.js')
  const app = express()
  app.use('/api/v1', createDesktopRouter())

  const response = await request(app).get('/api/v1/desktop/environment').expect(200)
  return response.body as DesktopEnvironmentResponse
}

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

beforeAll(() => {
  process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL = 'https://api.example.com/'
  process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL = 'https://rpc.example.com/'
  process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME = 'Example Tenant'
})

afterAll(() => {
  if (originalDesktopEnvironmentConfig.externalRestApiBaseUrl === undefined) {
    delete process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL
  } else {
    process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL =
      originalDesktopEnvironmentConfig.externalRestApiBaseUrl
  }
  if (originalDesktopEnvironmentConfig.rpcProxyBaseUrl === undefined) {
    delete process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL
  } else {
    process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL =
      originalDesktopEnvironmentConfig.rpcProxyBaseUrl
  }
  if (originalDesktopEnvironmentConfig.appName === undefined) {
    delete process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME
  } else {
    process.env.EXTERNAL_REST_API_DESKTOP_APP_NAME = originalDesktopEnvironmentConfig.appName
  }
})

beforeEach(() => {
  api.getDesktopEnvironment.mockReset()
  api.getDesktopEnvironment.mockImplementation(getDesktopEnvironmentFromProducer)
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
    const environment = await getDesktopEnvironmentFromProducer()
    api.getDesktopEnvironment.mockResolvedValue(environment)

    render(<Page />)

    const setupLink = await screen.findByRole('link', { name: 'Set up Desktop App' })
    const setupCopy = setupLink.closest('p')
    const href = new URL(setupLink.getAttribute('href') ?? '')

    expect(setupCopy).toHaveTextContent('Prefer the desktop app?')
    expect(setupCopy).not.toHaveTextContent('instead')
    expect(href.searchParams.get('externalRestApiBaseUrl')).toBe(environment.externalRestApiBaseUrl)
    expect(href.searchParams.get('tenantName')).toBe(environment.appName)
  })

  it('builds the setup link from the real public discovery response', async () => {
    const environment = await getDesktopEnvironmentFromProducer()
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
