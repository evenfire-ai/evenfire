import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { LoginPanel } from '@components/LoginPanel'
import { edgeRecord, edgeResponse } from '@/test/edgeFixtures'

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    login: vi.fn(),
    signOutIncomplete: false,
    signOutPending: false,
    retrySignOut: vi.fn(),
  }),
}))

vi.mock('next/image', () => ({
  default: ({ alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
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

const CONFIGURATION_PATH = '/external-rest-api/api/v1/oidc/profile-flow/configuration'
const fetchMock = vi.fn()

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

function enabledConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    redirectUri: 'https://profile.example.test/api/oidc/callback',
    memberAuthenticationActivated: true,
    displayLabel: 'Acme SSO',
    ...overrides,
  }
}

// Asserts the configuration request went out, then lets the answer and the resulting state
// update settle so a negative assertion afterwards runs against the final render.
async function expectConfigurationFetched() {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(fetchMock.mock.calls[0]?.[0]).toBe(CONFIGURATION_PATH)
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('LoginPanel OIDC sign-in button', () => {
  it('shows Continue with <label> when member sign-in is on', async () => {
    fetchMock.mockResolvedValue(answer(200, enabledConfiguration()))

    render(<LoginPanel />)

    const button = await screen.findByRole('button', { name: 'Continue with Acme SSO' })
    await expectConfigurationFetched()
    const form = button.closest('form')
    expect(form).not.toBeNull()
    expect(form?.getAttribute('action')).toBe('/api/oidc/start')
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  // The error statuses carry an enabled configuration with a label, so the status check
  // alone has to hide the button.
  it('shows only the password form when configuration answers 404', async () => {
    fetchMock.mockResolvedValue(answer(404, enabledConfiguration()))

    render(<LoginPanel />)

    await expectConfigurationFetched()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull()
  })

  it.each([
    ['a 503 answer', () => answer(503, enabledConfiguration())],
    ['a 429 answer', () => answer(429, enabledConfiguration())],
    ['a malformed body', () => answer(200, 'not json')],
    ['an empty display label', () => answer(200, enabledConfiguration({ displayLabel: '' }))],
    [
      'a missing display label',
      () => answer(200, enabledConfiguration({ displayLabel: undefined })),
    ],
  ])('shows only the password form when configuration answers %s', async (_name, respond) => {
    fetchMock.mockResolvedValue(respond())

    render(<LoginPanel />)

    await expectConfigurationFetched()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull()
  })

  it('shows only the password form when the configuration request fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))

    render(<LoginPanel />)

    await expectConfigurationFetched()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull()
  })

  it('shows only the password form when member sign-in is off', async () => {
    fetchMock.mockResolvedValue(
      answer(200, enabledConfiguration({ memberAuthenticationActivated: false }))
    )

    render(<LoginPanel />)

    await expectConfigurationFetched()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull()
  })

  it('adds the hidden returnTo field only when given', async () => {
    const configurationKey = 'GET /api/v1/oidc/profile-flow/configuration activated'
    const label = (edgeRecord(configurationKey).body as { displayLabel: string }).displayLabel
    fetchMock.mockImplementation(async () => edgeResponse(configurationKey))

    render(<LoginPanel returnTo="desktop-setup" />)
    const withReturn = (
      await screen.findByRole('button', { name: `Continue with ${label}` })
    ).closest('form')
    await expectConfigurationFetched()
    const fields = withReturn?.querySelectorAll<HTMLInputElement>('input[name="returnTo"]')
    expect(fields).toHaveLength(1)
    expect(fields?.[0]?.type).toBe('hidden')
    expect(fields?.[0]?.value).toBe('desktop-setup')

    cleanup()
    fetchMock.mockClear()
    render(<LoginPanel />)
    const withoutReturn = (
      await screen.findByRole('button', { name: `Continue with ${label}` })
    ).closest('form')
    await expectConfigurationFetched()
    expect(withoutReturn?.getAttribute('action')).toBe('/api/oidc/start')
    expect(withoutReturn?.querySelector('input[name="returnTo"]')).toBeNull()
  })
})
