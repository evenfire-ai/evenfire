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
  listMcpSecrets,
  updateMcpSecret,
  updateMcpServer,
} from '../../lib/api'
import { buildMcpServerReference } from '../../test/fixtures/mcpServer'

// Exercise the Secrets page against names-only Secret metadata. Stored keys
// and connector mappings have separate ownership; rotation verifies rollout
// only for a mapped key on the selected connector.

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
  listMcpSecrets: vi.fn(),
  updateMcpSecret: vi.fn(),
  updateMcpServer: vi.fn(),
}))

const mockCreateMcpSecret = vi.mocked(createMcpSecret)
const mockGetMcpServer = vi.mocked(getMcpServer)
const mockGetMcpServers = vi.mocked(getMcpServers)
const mockGetRegistryCredentialSchema = vi.mocked(getRegistryCredentialSchema)
const mockListMcpSecrets = vi.mocked(listMcpSecrets)
const mockUpdateMcpSecret = vi.mocked(updateMcpSecret)
const mockUpdateMcpServer = vi.mocked(updateMcpServer)

function server(options: {
  name: string
  secretName?: string
  secretKey?: string
  envVar?: string
}) {
  const resource = buildMcpServerReference({
    ...options,
    secretName: options.secretName ?? 'linear-credentials',
    annotations: {
      'clerum.io/catalog-id': 'mcp-linear',
      'clerum.io/catalog-version': '1.4.0',
    },
  })
  return {
    ...resource,
    metadata: {
      ...resource.metadata,
      uid: `uid-${options.name}`,
      resourceVersion: '10',
      generation: 1,
    },
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

async function submitRotation(key: string, value: string) {
  fireEvent.click(screen.getByRole('button', { name: `Rotate ${key}` }))
  const dialog = screen.getByRole('dialog', { name: `Rotate ${key}` })
  fireEvent.change(within(dialog).getByLabelText('New value', { exact: false }), {
    target: { value },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate', exact: true }))
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
  let currentServer = {
    ...server({ name: 'linear-conn' }),
    status: {
      conditions: [
        {
          type: 'DeploymentReady',
          status: 'True' as const,
          reason: 'RolloutComplete',
          message: 'ready',
          lastTransitionTime: '2026-01-01T00:00:05.000Z',
          observedGeneration: 1,
        },
      ],
    },
  }
  let storedKeys = ['api-key', 'refresh-token']
  mockGetMcpServer.mockImplementation(async () => currentServer)
  mockUpdateMcpServer.mockImplementation(async (_name, payload) => {
    currentServer = {
      ...currentServer,
      spec: payload.spec,
      metadata: { ...currentServer.metadata, resourceVersion: '11', generation: 2 },
      status: { conditions: [{ ...currentServer.status.conditions[0], observedGeneration: 2 }] },
    }
    return currentServer
  })
  mockUpdateMcpSecret.mockImplementation(async (_name, data) => {
    storedKeys = [...new Set([...storedKeys, ...Object.keys(data)])]
    return {
      name: 'linear-credentials',
      namespace: 'mcp-server',
      keys: storedKeys,
      affectedConnectors: ['linear-conn'],
    }
  })
  mockListMcpSecrets.mockImplementation(async () => ({
    items: [{ name: 'linear-credentials', keys: storedKeys }],
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('EditConnectorSecretPage', () => {
  it('lists every stored key in separate key and environment columns without idle inputs', async () => {
    await renderPage()

    expect(screen.getByRole('columnheader', { name: 'Secret key' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Environment variable/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rotate api-key' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rotate refresh-token' })).toBeInTheDocument()
    expect(screen.getByText('LINEAR_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('Not mapped')).toBeInTheDocument()
    expect(document.querySelector('input')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Connectors referencing this secret' })).toBeNull()
  })

  it('rotates only the chosen key and verifies the mapped connector rollout', async () => {
    await renderPage()
    await submitRotation('api-key', '  rotated  ')

    expect(mockUpdateMcpSecret).toHaveBeenCalledWith('linear-credentials', {
      'api-key': '  rotated  ',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(/Value saved. Waiting for linear-conn/)).toBeInTheDocument()
    expect(screen.queryByText(/restarted and is serving/)).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(
      screen.getByText(/linear-conn restarted and is serving the new credential/)
    ).toBeInTheDocument()
  })

  it('refuses a non-canonical stored Secret name without rotating its trimmed alias', async () => {
    mockGetMcpServers.mockResolvedValue({
      items: [server({ name: 'linear-conn', secretName: '  linear-credentials  ' })],
    })
    await renderPage()

    expect(screen.getByRole('alert').textContent).toContain(
      'Connector linear-conn stores a non-canonical Secret name: "  linear-credentials  "'
    )
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  it('refuses the raw non-canonical Secret identity linked from the table', async () => {
    navigation.params = { name: '  linear-credentials  ' }
    mockGetMcpServers.mockResolvedValue({
      items: [server({ name: 'linear-conn', secretName: '  linear-credentials  ' })],
    })
    await renderPage()

    expect(screen.getByRole('alert').textContent).toContain(
      'Secret name in the URL is non-canonical: "  linear-credentials  "'
    )
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  it('latches to recreate mode when the rotation PUT answers 404', async () => {
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error('404 Not Found'), { status: 404 })
    )
    await renderPage()

    await submitRotation('api-key', 'rotated')

    // The missing Secret returns to the existing recovery flow without creating it.
    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  it('offers a connector chooser when several connectors reference the secret', async () => {
    mockListMcpSecrets.mockResolvedValue({
      items: [{ name: 'linear-credentials', keys: ['api-key', 'refresh-token', 'alpha-key'] }],
    })
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
    expect(screen.getByRole('button', { name: 'Rotate api-key' })).toBeInTheDocument()
  })

  it.each([
    ['empty', '?server='],
    ['whitespace-only', '?server=%20%20'],
    ['duplicate', '?server=alpha-conn&server=linear-conn'],
    ['unknown', '?server=stale-conn'],
  ])('rejects an %s server query without a credential form', async (_, query) => {
    navigation.searchParams = new URLSearchParams(query)
    mockGetMcpServers.mockResolvedValue({
      items: [server({ name: 'alpha-conn' }), server({ name: 'linear-conn' })],
    })

    await renderPage()

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument()
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  it('rejects an unknown server even when no connectors reference the Secret', async () => {
    navigation.searchParams = new URLSearchParams('?server=stale-conn')
    mockGetMcpServers.mockResolvedValue({ items: [] })
    await renderPage()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Connector stale-conn does not reference this Secret.'
    )
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  it('rotates an unmapped key without waiting for an unrelated connector restart', async () => {
    await renderPage()
    await submitRotation('refresh-token', 'next-token')
    expect(mockUpdateMcpSecret).toHaveBeenCalledWith('linear-credentials', {
      'refresh-token': 'next-token',
    })
    expect(screen.queryByText(/Waiting for/)).toBeNull()
    expect(mockGetMcpServer).not.toHaveBeenCalled()
    expect(navigation.push).not.toHaveBeenCalled()
  })

  it('rotates stored keys when no connector references the Secret', async () => {
    mockGetMcpServers.mockResolvedValue({ items: [] })
    await renderPage()
    await submitRotation('api-key', 'next-value')
    expect(mockUpdateMcpSecret).toHaveBeenCalledWith('linear-credentials', {
      'api-key': 'next-value',
    })
    expect(screen.getByText('No connector currently uses this Secret.')).toBeInTheDocument()
    expect(mockGetMcpServer).not.toHaveBeenCalled()
  })

  it('adds a key, retains it in the list and reloads it from stored metadata', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    const dialog = screen.getByRole('dialog', { name: 'Add key' })
    fireEvent.change(within(dialog).getByLabelText('Key name', { exact: false }), {
      target: { value: 'webhook-secret' },
    })
    expect(within(dialog).getByLabelText('Environment variable', { exact: false })).toHaveValue(
      'WEBHOOK_SECRET'
    )
    fireEvent.change(within(dialog).getByLabelText('Value', { exact: false }), {
      target: { value: 'whv-1' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add key' }))
    await flush()
    expect(mockUpdateMcpSecret).toHaveBeenCalledWith('linear-credentials', {
      'webhook-secret': 'whv-1',
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rotate webhook-secret' })).toBeInTheDocument()
    expect(screen.getByText(/Waiting for linear-conn/)).toBeInTheDocument()
    expect(mockUpdateMcpServer).toHaveBeenCalledWith('linear-conn', {
      metadata: { uid: 'uid-linear-conn', resourceVersion: '10' },
      spec: {
        ...server({ name: 'linear-conn' }).spec,
        envSecret: {
          name: 'linear-credentials',
          keys: [
            { secretKey: 'api-key', envVar: 'LINEAR_API_KEY' },
            { secretKey: 'webhook-secret', envVar: 'WEBHOOK_SECRET' },
          ],
        },
      },
    })
    expect(screen.getByText('WEBHOOK_SECRET')).toBeInTheDocument()

    mockListMcpSecrets.mockResolvedValue({
      items: [{ name: 'linear-credentials', keys: ['api-key', 'refresh-token', 'webhook-secret'] }],
    })
    cleanup()
    await renderPage()
    expect(screen.getByRole('button', { name: 'Rotate webhook-secret' })).toBeInTheDocument()
  })

  it('rejects an existing unmapped key and disables empty add submissions', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    const dialog = screen.getByRole('dialog', { name: 'Add key' })
    const save = within(dialog).getByRole('button', { name: 'Add key' })
    expect(save).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Key name', { exact: false }), {
      target: { value: 'refresh-token' },
    })
    fireEvent.change(within(dialog).getByLabelText('Value', { exact: false }), {
      target: { value: 'dup' },
    })
    expect(screen.getByText('This key already exists.')).toBeInTheDocument()
    expect(save).toBeDisabled()
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
  })

  it('rechecks newly added keys before writing instead of replacing an unseen value', async () => {
    await renderPage()
    mockListMcpSecrets.mockResolvedValue({
      items: [{ name: 'linear-credentials', keys: ['api-key', 'refresh-token', 'new-key'] }],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    const dialog = screen.getByRole('dialog', { name: 'Add key' })
    fireEvent.change(within(dialog).getByLabelText('Key name', { exact: false }), {
      target: { value: 'new-key' },
    })
    fireEvent.change(within(dialog).getByLabelText('Value', { exact: false }), {
      target: { value: 'dup' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add key' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('already exists')
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
  })

  it('preserves a failed rotation draft and cancels without writing', async () => {
    mockUpdateMcpSecret.mockRejectedValueOnce(new Error('Save unavailable'))
    await renderPage()
    await submitRotation('api-key', 'retry-value')
    const dialog = screen.getByRole('dialog', { name: 'Rotate api-key' })
    expect(within(dialog).getByLabelText('New value', { exact: false })).toHaveValue('retry-value')
    expect(screen.getByRole('alert')).toHaveTextContent('Save unavailable')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rotate api-key' }))
    expect(screen.getByLabelText('New value', { exact: false })).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
  })

  it('explains when the secret itself no longer exists', async () => {
    mockGetMcpServers.mockResolvedValue({ items: [] })
    mockListMcpSecrets.mockResolvedValue({ items: [] })
    await renderPage()

    expect(screen.getByText(/No connector secret named/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('shows the connector load error without presenting an empty result as verified', async () => {
    mockGetMcpServers.mockRejectedValue(new Error('Connector list unavailable'))
    await renderPage()

    expect(screen.getByRole('alert')).toHaveTextContent('Connector list unavailable')
    expect(screen.queryByText(/No connector currently references Secret/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
  })
  it('retries only mapping after the key was stored and the mapping was rejected', async () => {
    mockUpdateMcpServer.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }))
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    const dialog = screen.getByRole('dialog', { name: 'Add key' })
    fireEvent.change(within(dialog).getByLabelText('Key name', { exact: false }), {
      target: { value: 'extra-key' },
    })
    fireEvent.change(within(dialog).getByLabelText('Environment variable', { exact: false }), {
      target: { value: 'CUSTOM_TOKEN' },
    })
    fireEvent.change(within(dialog).getByLabelText('Value', { exact: false }), {
      target: { value: 'value-once' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add key' }))
    await flush(12)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'is stored, but its environment mapping could not be confirmed'
    )
    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
    expect(within(dialog).getByLabelText('Value', { exact: false })).toHaveValue('')
    expect(within(dialog).getByLabelText('Value', { exact: false })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry mapping' }))
    await flush(12)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mockUpdateMcpSecret).toHaveBeenCalledTimes(1)
    expect(mockUpdateMcpServer).toHaveBeenCalledTimes(2)
    expect(screen.getByText('CUSTOM_TOKEN')).toBeInTheDocument()
  })

  it('rejects a colliding environment variable before writing the key', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    const dialog = screen.getByRole('dialog', { name: 'Add key' })
    fireEvent.change(within(dialog).getByLabelText('Key name', { exact: false }), {
      target: { value: 'fresh-key' },
    })
    fireEvent.change(within(dialog).getByLabelText('Environment variable', { exact: false }), {
      target: { value: 'LINEAR_API_KEY' },
    })
    fireEvent.change(within(dialog).getByLabelText('Value', { exact: false }), {
      target: { value: 'never-save' },
    })
    expect(within(dialog).getByRole('button', { name: 'Add key' })).toBeDisabled()
    expect(
      screen.getByText(/Environment variable "LINEAR_API_KEY" is already mapped/)
    ).toBeInTheDocument()
    expect(mockUpdateMcpSecret).not.toHaveBeenCalled()
    expect(mockUpdateMcpServer).not.toHaveBeenCalled()
  })
})
