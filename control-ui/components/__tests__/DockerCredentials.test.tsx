import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import * as ConfirmDialogModule from '../ConfirmDialog'
import { DockerCredentialsPanel } from '../PublisherView/DockerCredentials'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  listRegistryApiKeys: vi.fn(),
  createRegistryApiKey: vi.fn(),
  revokeRegistryApiKey: vi.fn(),
}))
vi.mock('../ConfirmDialog', () => ({ useConfirmDialog: vi.fn() }))

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
  vi.mocked(ConfirmDialogModule.useConfirmDialog).mockReturnValue({
    confirm: vi.fn().mockResolvedValue(true),
    confirmDialog: null,
  })
})

const key = {
  id: 'k1',
  key_prefix: 'efrk_abc',
  description: 'CI',
  scopes: ['registry:publish'],
  created_by_username: 'alice',
  created_at: '2026-06-01T00:00:00Z',
  expires_at: null,
  last_used_at: null,
}

describe('DockerCredentialsPanel', () => {
  it('lists existing keys', async () => {
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({ org: 'acme', keys: [key] })
    render(<DockerCredentialsPanel orgScope="acme" />)
    expect(await screen.findByText('efrk_abc')).toBeInTheDocument()
  })

  it('generate → shows the reveal modal (docker login snippet) → refetches', async () => {
    vi.mocked(api.listRegistryApiKeys)
      .mockResolvedValueOnce({ org: 'acme', keys: [] })
      .mockResolvedValueOnce({ org: 'acme', keys: [key] })
    vi.mocked(api.createRegistryApiKey).mockResolvedValue({
      id: 'k1',
      key: 'efrk_secret',
      key_prefix: 'efrk_abc',
      scopes: ['registry:publish'],
      expires_at: null,
    })
    render(<DockerCredentialsPanel orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: /generate push credential/i }))
    expect(
      await screen.findByText(/docker login registry\.evenfire\.ai -u _ -p efrk_secret/)
    ).toBeInTheDocument()
    await waitFor(() => expect(api.listRegistryApiKeys).toHaveBeenCalledTimes(2))
  })

  it('too_many_keys → inline error', async () => {
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({ org: 'acme', keys: [] })
    vi.mocked(api.createRegistryApiKey).mockRejectedValue(
      Object.assign(new Error('x'), { status: 409, code: 'too_many_keys' })
    )
    render(<DockerCredentialsPanel orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: /generate push credential/i }))
    expect(await screen.findByText(/key limit/i)).toBeInTheDocument()
  })

  it('registry_self_service_unavailable → inline error', async () => {
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({ org: 'acme', keys: [] })
    vi.mocked(api.createRegistryApiKey).mockRejectedValue(
      Object.assign(new Error('x'), { status: 400, code: 'registry_self_service_unavailable' })
    )
    render(<DockerCredentialsPanel orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: /generate push credential/i }))
    expect(await screen.findByText(/not available on this deployment/i)).toBeInTheDocument()
  })

  it('revoke: confirm → DELETE → toast + refetch', async () => {
    vi.mocked(api.listRegistryApiKeys)
      .mockResolvedValueOnce({ org: 'acme', keys: [key] })
      .mockResolvedValueOnce({ org: 'acme', keys: [] })
    vi.mocked(api.revokeRegistryApiKey).mockResolvedValue(undefined)
    render(<DockerCredentialsPanel orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }))
    await waitFor(() => {
      expect(api.revokeRegistryApiKey).toHaveBeenCalledWith('k1')
      expect(api.listRegistryApiKeys).toHaveBeenCalledTimes(2)
    })
  })

  it('403 not-owner → owner-required banner, no generate form, no infinite Retry', async () => {
    vi.mocked(api.listRegistryApiKeys).mockRejectedValue(
      Object.assign(new Error('x'), { status: 403, code: 'forbidden', org: 'acme' })
    )
    render(<DockerCredentialsPanel orgScope="acme" />)
    expect(await screen.findByText(/must be an org owner/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /generate push credential/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('409 registry_auth_disabled → dev-mode notice', async () => {
    vi.mocked(api.listRegistryApiKeys).mockRejectedValue(
      Object.assign(new Error('x'), { status: 409, code: 'registry_auth_disabled' })
    )
    render(<DockerCredentialsPanel orgScope="acme" />)
    expect(await screen.findByText(/registry authentication is disabled/i)).toBeInTheDocument()
  })
})
