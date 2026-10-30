import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import EditConnectorSecretPage from '../../app/secrets/connector/[name]/edit/page'
import {
  getMcpServer,
  getMcpServers,
  getRegistryCredentialSchema,
  listMcpSecrets,
  updateMcpSecret,
} from '../../lib/api'
import type { EnvSecret } from '../../lib/api'
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
  listMcpSecrets: vi.fn(),
  updateMcpSecret: vi.fn(),
}))

beforeEach(() => {
  const connector = buildRegistryMcpServerReference({
    name: 'linear',
    catalogId: 'mcp-linear',
    catalogVersion: '1.4.0',
    credentialKeyNames: ['api-key'],
  })
  // A registry ownership change must reach the credential page and fail this
  // contract rather than being hidden by a fixture-owned `managed: true`.
  expect(connector.spec?.managed).toBe(true)
  vi.mocked(getMcpServers).mockResolvedValue({ items: [connector] })
  const reference = connector.spec!.envSecret as EnvSecret
  vi.mocked(listMcpSecrets).mockResolvedValue({
    items: [{ name: reference.name, keys: reference.keys.map(mapping => mapping.secretKey) }],
  })
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

  const rotate = await screen.findByRole('button', { name: 'Rotate api-key' })
  expect(rotate).toBeInTheDocument()
  expect(screen.getByText('Edit connector secret: linear-credentials')).toBeInTheDocument()
  expect(
    screen.getByRole('columnheader', { name: /Environment variable.*linear/ })
  ).toBeInTheDocument()
  // Registry-produced Secret keys and their environment destinations occupy
  // separate cells. No stored value or idle value input is rendered.
  const row = rotate.closest('tr')!
  const cells = within(row).getAllByRole('cell')
  expect(cells[0]).toHaveTextContent('api-key')
  expect(cells[1]).toHaveTextContent('api-key')
  expect(row.querySelector('input')).toBeNull()

  fireEvent.click(rotate)
  const dialog = screen.getByRole('dialog', { name: 'Rotate api-key' })
  expect(dialog).toHaveTextContent('Connectors sharing this Secret may restart: linear.')
  fireEvent.change(within(dialog).getByLabelText('New value', { exact: false }), {
    target: { value: 'rotated' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate', exact: true }))
  await waitFor(() => {
    expect(updateMcpSecret).toHaveBeenCalledWith('linear-credentials', { 'api-key': 'rotated' })
  })
})
