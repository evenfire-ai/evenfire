import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import { POLL_INTERVAL_MS } from '@components/UpdateConnectorCredentials'
import EditConnectorSecretPage from '../../app/secrets/connector/[name]/edit/page'
import {
  createMcpSecret,
  getMcpServer,
  getMcpServers,
  getRegistryCredentialSchema,
  updateMcpSecret,
} from '../../lib/api'
import type { McpServerResource } from '../../lib/api'

// These tests prove the PAGE wiring: the rotation form, its rollout
// verification, and the 404→recreate latch all belong to the shared
// UpdateConnectorCredentials component (covered by its own suite). Here we
// assert that the secrets-page route lands the operator on that exact
// component, bound to a connector that actually references the Secret.

const navigation = vi.hoisted(() => ({
  params: { name: 'linear-credentials' },
  push: vi.fn(),
  searchParams: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => navigation.params,
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => navigation.searchParams,
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../lib/api', () => ({
  createMcpSecret: vi.fn(),
  getMcpServer: vi.fn(),
  getMcpServers: vi.fn(),
  getRegistryCredentialSchema: vi.fn(),
  updateMcpSecret: vi.fn(),
}))

const mockCreateMcpSecret = vi.mocked(createMcpSecret)
const mockGetMcpServer = vi.mocked(getMcpServer)
const mockGetMcpServers = vi.mocked(getMcpServers)
const mockGetRegistryCredentialSchema = vi.mocked(getRegistryCredentialSchema)
const mockUpdateMcpSecret = vi.mocked(updateMcpSecret)

function server(options: { name: string; secretKey?: string; envVar?: string }): McpServerResource {
  return {
    metadata: {
      name: options.name,
      annotations: {
        'clerum.io/catalog-id': 'mcp-linear',
        'clerum.io/catalog-version': '1.4.0',
      },
    },
    spec: {
      envSecret: {
        name: 'linear-credentials',
        keys: [
          {
            secretKey: options.secretKey ?? 'api-key',
            envVar: options.envVar ?? 'LINEAR_API_KEY',
          },
        ],
      },
    },
    status: { conditions: [] },
  }
}

/** Drains chained microtasks without real timers — same contract as the
 * UpdateConnectorCredentials suite, safe under vi.useFakeTimers(). */
async function flush(ticks = 4) {
  for (let i = 0; i < ticks; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function renderPage() {
  render(
    <ToastProvider>
      <EditConnectorSecretPage />
    </ToastProvider>
  )
  // Settle the page's own getMcpServers() load plus the component's mount
  // effects (affected-preview fetch + registry label fetch).
  await flush(6)
}

async function submitRotation(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }))
  const dialog = screen.getByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate & restart' }))
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  navigation.params = { name: 'linear-credentials' }
  navigation.searchParams = new URLSearchParams()
  navigation.push.mockClear()
  mockGetMcpServers.mockResolvedValue({ items: [server({ name: 'linear-conn' })] })
  mockGetRegistryCredentialSchema.mockResolvedValue({
    required: true,
    authType: 'api-key',
    keys: [{ name: 'api-key', label: 'API token', kind: 'api-key' }],
  })
  mockGetMcpServer.mockResolvedValue({
    metadata: { name: 'linear-conn' },
    status: {
      conditions: [
        {
          type: 'DeploymentReady',
          status: 'True',
          reason: 'RolloutComplete',
          message: 'ready',
          lastTransitionTime: '2026-01-01T00:00:05.000Z',
        },
      ],
    },
  })
  mockUpdateMcpSecret.mockResolvedValue({
    name: 'linear-credentials',
    namespace: 'mcp-server',
    keys: ['api-key'],
    affectedConnectors: ['linear-conn'],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('EditConnectorSecretPage', () => {
  it('renders the shared rotation form for the single connector referencing the secret', async () => {
    await renderPage()

    expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()
    // registryCredentialSource is derived from the connector's catalog
    // annotations — the schema label proves it reached the shared component.
    expect(screen.getByLabelText('API token')).toBeInTheDocument()
    expect(screen.getByText('LINEAR_API_KEY')).toBeInTheDocument()
    // Single connector: no chooser.
    expect(screen.queryByRole('tablist', { name: 'Connectors referencing this secret' })).toBeNull()
  })

  it('rotates through the shared flow and waits for the connector rollout before declaring success', async () => {
    await renderPage()

    await submitRotation('API token', 'rotated')

    expect(mockUpdateMcpSecret).toHaveBeenCalledWith('linear-credentials', {
      'api-key': 'rotated',
    })
    // Success is derived from the connector's own fresh DeploymentReady, not
    // the PUT's 200 — the banner only appears after the poll observes it.
    expect(screen.getByText(/Rotating credentials/i)).toBeInTheDocument()
    expect(screen.queryByText(/Credentials rotated/i)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(
      screen.getByText(
        /Credentials rotated\. linear-conn restarted and is serving the new credential\./i
      )
    ).toBeInTheDocument()
  })

  it('latches to recreate mode when the rotation PUT answers 404', async () => {
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('404 Not Found'), { status: 404 })
    )
    await renderPage()

    await submitRotation('API token', 'rotated')

    expect(screen.getByText(/This Secret no longer exists\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  it('offers a connector chooser when several connectors reference the secret', async () => {
    mockGetMcpServers.mockResolvedValue({
      items: [
        server({ name: 'linear-conn' }),
        server({ name: 'alpha-conn', secretKey: 'alpha-key', envVar: 'ALPHA_KEY' }),
      ],
    })
    await renderPage()

    const chooser = screen.getByRole('tablist', { name: 'Connectors referencing this secret' })
    expect(within(chooser).getByRole('tab', { name: 'alpha-conn' })).toHaveAttribute(
      'href',
      '/secrets/connector/linear-credentials/edit?server=alpha-conn'
    )
    expect(within(chooser).getByRole('tab', { name: 'linear-conn' })).toHaveAttribute(
      'href',
      '/secrets/connector/linear-credentials/edit?server=linear-conn'
    )
    // Default selection is the first connector by name.
    expect(within(chooser).getByRole('tab', { name: 'alpha-conn' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByText('ALPHA_KEY')).toBeInTheDocument()

    // The ?server= filter selects the other connector's declaration.
    navigation.searchParams = new URLSearchParams('?server=linear-conn')
    cleanup()
    await renderPage()
    expect(screen.getByText('LINEAR_API_KEY')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()
  })

  it('explains when no connector currently references the secret', async () => {
    mockGetMcpServers.mockResolvedValue({ items: [] })
    await renderPage()

    expect(screen.getByText(/No connector currently references Secret/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
  })
})
