import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CONTROL_ROUTES } from '../../app/constants/routes'
import RegistryInstallPage from '../../app/registry/install/page'
import { getRegistryEntryVersion } from '../../lib/api'
import type { RegistryEntry } from '../../lib/api'
import {
  CURATOR_CIMD_ENTRY,
  CURATOR_CIMD_USER_ONLY_ENTRY,
  CURATOR_INVALID_ENTRY,
  ORG_PRE_REGISTERED_ENTRY,
} from '../../test/fixtures/catalogRemoteOAuthWire'
import { ToastProvider } from '../Toast'

/**
 * A remote-OAuth catalog entry never reaches the registry or OAuth install forms: the
 * install page forwards it to the remote wizard in catalog mode. Entries are
 * control-api's own responses (catalogRemoteOAuthWire goldens).
 */

const mockPush = vi.fn()
const mockReplace = vi.fn()
let mockQuery = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockQuery),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Sentinels: if either form ever renders for a remote-OAuth entry, the test sees it.
vi.mock('@components/OAuthInstallForm', () => ({
  OAuthInstallForm: () => <div data-testid="oauth-install-form" />,
}))
vi.mock('@components/RegistryInstallForm', () => ({
  RegistryInstallForm: () => <div data-testid="registry-install-form" />,
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return { ...actual, getRegistryEntryVersion: vi.fn() }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderFor(entry: RegistryEntry) {
  mockQuery = `entry=${encodeURIComponent(entry.name)}&version=${entry.version}`
  vi.mocked(getRegistryEntryVersion).mockResolvedValue(entry)
  return render(
    <ToastProvider>
      <RegistryInstallPage />
    </ToastProvider>
  )
}

function expectNoInstallForm() {
  expect(screen.queryByTestId('oauth-install-form')).not.toBeInTheDocument()
  expect(screen.queryByTestId('registry-install-form')).not.toBeInTheDocument()
}

describe('RegistryInstallPage — remote-OAuth entries', () => {
  it('a single-slot entry forwards to the wizard in catalog mode, with the entry the registry returned', async () => {
    renderFor(CURATOR_CIMD_USER_ONLY_ENTRY)

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        CONTROL_ROUTES.connectors.remoteNew({
          entry: '@evenfire/linear-user',
          version: '1.0.0',
          scope: 'user',
        })
      )
    )
    const target = new URL(mockReplace.mock.calls[0][0] as string, 'https://ui.example.com')
    expect(target.pathname).toBe('/connectors/remote/new')
    // The URL is never handed to the wizard through the query.
    expect([...target.searchParams.keys()].sort()).toEqual(['entry', 'scope', 'version'])
    expectNoInstallForm()
  })

  it('a link naming the entry by an alias forwards with the name the registry returned', async () => {
    renderFor(CURATOR_CIMD_USER_ONLY_ENTRY)
    // Re-render with the alias in the query; the registry answers with the scoped name.
    cleanup()
    mockReplace.mockClear()
    mockQuery = 'entry=linear-user&version=1.0.0'
    render(
      <ToastProvider>
        <RegistryInstallPage />
      </ToastProvider>
    )
    await waitFor(() => expect(mockReplace).toHaveBeenCalled())
    expect(getRegistryEntryVersion).toHaveBeenLastCalledWith('linear-user', '1.0.0')
    expect(mockReplace).toHaveBeenCalledWith(
      CONTROL_ROUTES.connectors.remoteNew({
        entry: '@evenfire/linear-user',
        version: '1.0.0',
        scope: 'user',
      })
    )
  })

  it('a two-slot entry asks which slot to install and opens the wizard for that one', async () => {
    renderFor(CURATOR_CIMD_ENTRY)

    fireEvent.click(await screen.findByRole('button', { name: 'Install per context' }))
    expect(mockPush).toHaveBeenCalledWith(
      CONTROL_ROUTES.connectors.remoteNew({
        entry: '@evenfire/linear-remote',
        version: '1.0.0',
        scope: 'context',
      })
    )
    expect(screen.getByRole('button', { name: 'Install per user' })).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
    expectNoInstallForm()
  })

  it('an org entry with both slots gets the same choice and no install form', async () => {
    renderFor(ORG_PRE_REGISTERED_ENTRY)

    expect(await screen.findByRole('button', { name: 'Install per user' })).toBeInTheDocument()
    expectNoInstallForm()
  })

  it('an entry control-api marked invalid shows the reason and no form', async () => {
    renderFor(CURATOR_INVALID_ENTRY)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '@evenfire/broken-remote v1.0.0 cannot be installed (setup_guide_required)'
    )
    expect(mockReplace).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Install per/ })).not.toBeInTheDocument()
    expectNoInstallForm()
  })

  it('a remote-OAuth entry with no verdict (older control-api) is refused, never sent to a form', async () => {
    const { remoteOAuth: _verdict, ...unresolved } = CURATOR_CIMD_USER_ONLY_ENTRY
    renderFor(unresolved as RegistryEntry)

    expect(await screen.findByRole('alert')).toHaveTextContent('cannot be installed (unresolved)')
    expect(mockReplace).not.toHaveBeenCalled()
    expectNoInstallForm()
  })
})
