import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import EditConnectorSecretPage from '../../app/secrets/connector/[name]/edit/page'
import { getRegistryCredentialSchema, updateMcpSecret } from '../../lib/api'

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

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getRegistryCredentialSchema: vi.fn(),
    updateMcpSecret: vi.fn(),
  }
})

const getRegistryCredentialSchemaMock = vi.mocked(getRegistryCredentialSchema)
const updateMcpSecretMock = vi.mocked(updateMcpSecret)

function renderPage() {
  render(
    <ToastProvider>
      <EditConnectorSecretPage />
    </ToastProvider>
  )
}

async function confirmUpdate() {
  const dialog = await screen.findByRole('alertdialog', { name: 'Update connector secret' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
}

describe('EditConnectorSecretPage', () => {
  beforeEach(() => {
    getRegistryCredentialSchemaMock.mockReset()
    updateMcpSecretMock.mockReset()
    navigation.params = { name: 'linear-credentials' }
    navigation.searchParams = new URLSearchParams()
    navigation.push.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps Save disabled until a key and value are both filled', () => {
    renderPage()

    const save = screen.getByRole('button', { name: 'Save changes' })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('API_KEY'), { target: { value: 'API_KEY' } })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('secret value'), {
      target: { value: 'rotated' },
    })
    expect(save).toBeEnabled()
  })

  it('rotates only the filled keys and reports affected connectors', async () => {
    updateMcpSecretMock.mockResolvedValue({
      name: 'linear-credentials',
      namespace: 'mcp-server',
      keys: ['API_KEY'],
      affectedConnectors: ['linear-conn'],
    })
    renderPage()

    fireEvent.change(screen.getByPlaceholderText('API_KEY'), { target: { value: 'API_KEY' } })
    fireEvent.change(screen.getByPlaceholderText('secret value'), { target: { value: 'rotated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await confirmUpdate()

    await waitFor(() => {
      expect(updateMcpSecretMock).toHaveBeenCalledWith('linear-credentials', {
        API_KEY: 'rotated',
      })
    })
    expect(
      await screen.findByText(
        'Secret linear-credentials updated. Restarting connectors: linear-conn.'
      )
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith('/secrets/connector')
    })
  })

  it('writes nothing when the rotation confirmation is cancelled', async () => {
    renderPage()

    fireEvent.change(screen.getByPlaceholderText('API_KEY'), { target: { value: 'API_KEY' } })
    fireEvent.change(screen.getByPlaceholderText('secret value'), { target: { value: 'rotated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Update connector secret' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(updateMcpSecretMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
  })

  it('surfaces the API error inline instead of navigating away', async () => {
    updateMcpSecretMock.mockRejectedValue(new Error('Secret not found'))
    renderPage()

    fireEvent.change(screen.getByPlaceholderText('API_KEY'), { target: { value: 'API_KEY' } })
    fireEvent.change(screen.getByPlaceholderText('secret value'), { target: { value: 'rotated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await confirmUpdate()

    expect(await screen.findByText('Secret not found')).toBeInTheDocument()
    expect(navigation.push).not.toHaveBeenCalled()
  })

  it('uses the registry credential schema when the source is known', async () => {
    navigation.searchParams = new URLSearchParams('registryEntry=mcp-linear&registryVersion=1.4.0')
    getRegistryCredentialSchemaMock.mockResolvedValue({
      required: true,
      authType: 'api-key',
      keys: [
        { name: 'api-token', label: 'API token', kind: 'api-key' },
        { name: 'workspace-id', label: 'Workspace ID', kind: 'text' },
      ],
    })
    updateMcpSecretMock.mockResolvedValue({
      name: 'linear-credentials',
      namespace: 'mcp-server',
      keys: ['api-token', 'workspace-id'],
      affectedConnectors: [],
    })
    renderPage()

    fireEvent.change(await screen.findByLabelText('API token'), { target: { value: 'rotated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await confirmUpdate()

    await waitFor(() => {
      expect(updateMcpSecretMock).toHaveBeenCalledWith('linear-credentials', {
        'api-token': 'rotated',
      })
    })
    expect(await screen.findByText('Secret linear-credentials updated.')).toBeInTheDocument()
  })
})
