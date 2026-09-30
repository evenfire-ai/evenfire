import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import EditConnectorSecretPage from '../../app/secrets/connector/[name]/edit/page'
import {
  getMcpServer,
  getMcpServers,
  getRegistryCredentialSchema,
  updateMcpSecret,
} from '../../lib/api'
import { buildRegistryMcpServerReference } from '../../test/fixtures/mcpServer'
import { ToastProvider } from '../Toast'

vi.mock('next/navigation', () => ({
  useParams: () => ({ name: 'linear-credentials' }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('server=linear'),
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

beforeEach(() => {
  const connector = buildRegistryMcpServerReference({
    name: 'linear',
    catalogId: 'mcp-linear',
    catalogVersion: '1.4.0',
    credentialKeyNames: ['api-key'],
  })
  vi.mocked(getMcpServers).mockResolvedValue({ items: [connector] })
  vi.mocked(getMcpServer).mockResolvedValue(connector)
  vi.mocked(getRegistryCredentialSchema).mockResolvedValue({
    required: true,
    authType: 'api-key',
    keys: [{ name: 'api-key', label: 'API token', kind: 'api-key' }],
  })
  vi.mocked(updateMcpSecret).mockResolvedValue({
    name: 'linear-credentials',
    namespace: 'mcp-server',
    keys: ['api-key'],
    affectedConnectors: ['linear'],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('shows and rotates the registry-produced credential mapping for the attached connector', async () => {
  render(
    <ToastProvider>
      <EditConnectorSecretPage />
    </ToastProvider>
  )

  expect(await screen.findByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()
  expect(screen.getByText('Edit connector secret: linear-credentials')).toBeInTheDocument()
  expect(screen.getByLabelText('API token')).toBeInTheDocument()
  expect(screen.getAllByText('api-key').length).toBeGreaterThan(0)

  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'rotated' } })
  fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }))
  const dialog = screen.getByRole('alertdialog')
  expect(dialog).toHaveTextContent('restarts: linear.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate & restart' }))
  await waitFor(() => {
    expect(updateMcpSecret).toHaveBeenCalledWith('linear-credentials', { 'api-key': 'rotated' })
  })
})
