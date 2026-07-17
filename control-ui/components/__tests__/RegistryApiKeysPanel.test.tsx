// control-ui/components/__tests__/RegistryApiKeysPanel.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import * as ConfirmDialogModule from '../ConfirmDialog'
import RegistryApiKeysPanel from '../RegistryApiKeysPanel'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  listRegistryApiKeys: vi.fn(),
  createRegistryApiKey: vi.fn(),
  revokeRegistryApiKey: vi.fn(),
}))

vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: vi.fn(),
}))

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  // Default: confirm auto-resolves false (no confirmation); confirmDialog is null node
  vi.mocked(ConfirmDialogModule.useConfirmDialog).mockReturnValue({
    confirm: vi.fn().mockResolvedValue(false),
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

describe('RegistryApiKeysPanel', () => {
  it('renders the org header and table on success', async () => {
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({ org: 'acme', keys: [key] })
    render(<RegistryApiKeysPanel />)
    expect(await screen.findByText(/@acme/)).toBeInTheDocument()
    expect(screen.getByText('efrk_abc')).toBeInTheDocument()
    expect(screen.getByText('Never used')).toBeInTheDocument()
    expect(screen.getByText('Never')).toBeInTheDocument()
  })

  it('shows the not-owner state on 403 with org name and hides Create', async () => {
    vi.mocked(api.listRegistryApiKeys).mockRejectedValue(
      Object.assign(new Error('x'), { status: 403, code: 'forbidden', org: 'acme' })
    )
    render(<RegistryApiKeysPanel />)
    expect(await screen.findByText(/must be an org owner/i)).toBeInTheDocument()
    expect(screen.getByText(/@acme/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create key/i })).toBeNull()
  })

  it('shows the not-bound state on 409 no_org', async () => {
    vi.mocked(api.listRegistryApiKeys).mockRejectedValue(
      Object.assign(new Error('x'), { status: 409, code: 'no_org' })
    )
    render(<RegistryApiKeysPanel />)
    expect(await screen.findByText(/not bound to a registry org/i)).toBeInTheDocument()
  })

  it('shows actionable guidance to enable registry auth on 409 registry_auth_disabled', async () => {
    vi.mocked(api.listRegistryApiKeys).mockRejectedValue(
      Object.assign(new Error('x'), { status: 409, code: 'registry_auth_disabled' })
    )
    render(<RegistryApiKeysPanel />)
    expect(await screen.findByText(/registry authentication is disabled/i)).toBeInTheDocument()
    expect(screen.getByText('CLERUM_REGISTRY_AUTH_ENABLED=true')).toBeInTheDocument()
    expect(screen.getByText(/restart/i)).toBeInTheDocument()
  })

  it('on create success, shows the reveal modal then refetches', async () => {
    vi.mocked(api.listRegistryApiKeys)
      .mockResolvedValueOnce({ org: 'acme', keys: [] })
      .mockResolvedValueOnce({ org: 'acme', keys: [key] })
    vi.mocked(api.createRegistryApiKey).mockResolvedValue({
      id: 'k1',
      key: 'efrk_secret',
      key_prefix: 'efrk_abc',
      scopes: [],
      expires_at: null,
    })
    render(<RegistryApiKeysPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /create key/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^create key$/i }))
    expect(await screen.findByText(/only time this key/i)).toBeInTheDocument()
  })

  it('revoke: confirm → DELETE → success toast names key prefix + refetches list', async () => {
    vi.mocked(ConfirmDialogModule.useConfirmDialog).mockReturnValue({
      confirm: vi.fn().mockResolvedValue(true),
      confirmDialog: null,
    })
    vi.mocked(api.listRegistryApiKeys)
      .mockResolvedValueOnce({ org: 'acme', keys: [key] })
      .mockResolvedValueOnce({ org: 'acme', keys: [] })
    vi.mocked(api.revokeRegistryApiKey).mockResolvedValue(undefined)
    render(<RegistryApiKeysPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }))
    await waitFor(() => {
      expect(api.revokeRegistryApiKey).toHaveBeenCalledWith('k1')
      expect(api.listRegistryApiKeys).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByText(/revoked efrk_abc/i)).toBeInTheDocument()
  })

  it('revoke: 404 → already-revoked toast + refetches list', async () => {
    vi.mocked(ConfirmDialogModule.useConfirmDialog).mockReturnValue({
      confirm: vi.fn().mockResolvedValue(true),
      confirmDialog: null,
    })
    vi.mocked(api.listRegistryApiKeys)
      .mockResolvedValueOnce({ org: 'acme', keys: [key] })
      .mockResolvedValueOnce({ org: 'acme', keys: [] })
    vi.mocked(api.revokeRegistryApiKey).mockRejectedValue(
      Object.assign(new Error('not found'), { status: 404 })
    )
    render(<RegistryApiKeysPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }))
    await waitFor(() => {
      expect(api.listRegistryApiKeys).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByText(/already revoked/i)).toBeInTheDocument()
  })

  it('generic error: list rejects with non-403/409 → error state with a Retry button that re-calls list', async () => {
    vi.mocked(api.listRegistryApiKeys)
      .mockRejectedValueOnce(Object.assign(new Error('Network failure'), { status: 500 }))
      .mockResolvedValueOnce({ org: 'acme', keys: [] })
    render(<RegistryApiKeysPanel />)
    expect(await screen.findByText(/could not load api keys/i)).toBeInTheDocument()
    const retryButton = screen.getByRole('button', { name: /retry/i })
    expect(retryButton).toBeInTheDocument()
    fireEvent.click(retryButton)
    await waitFor(() => expect(api.listRegistryApiKeys).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/no api keys yet/i)).toBeInTheDocument()
  })

  it('create failure with status 429 → rate-limit toast', async () => {
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({ org: 'acme', keys: [] })
    vi.mocked(api.createRegistryApiKey).mockRejectedValue(
      Object.assign(new Error('rate limited'), { status: 429 })
    )
    render(<RegistryApiKeysPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /create key/i }))
    // submit the create key form
    fireEvent.click(await screen.findByRole('button', { name: /^create key$/i }))
    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument()
  })

  it('create failure with 409 too_many_keys → inline error in modal', async () => {
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({ org: 'acme', keys: [] })
    vi.mocked(api.createRegistryApiKey).mockRejectedValue(
      Object.assign(new Error('too many keys'), { status: 409, code: 'too_many_keys' })
    )
    render(<RegistryApiKeysPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /create key/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^create key$/i }))
    expect(await screen.findByText(/100-key limit/i)).toBeInTheDocument()
  })

  it('default sort: two keys with different created_at render newest-first', async () => {
    const olderKey = {
      ...key,
      id: 'k-old',
      key_prefix: 'efrk_old',
      created_at: '2026-01-01T00:00:00Z',
    }
    const newerKey = {
      ...key,
      id: 'k-new',
      key_prefix: 'efrk_new',
      created_at: '2026-06-01T00:00:00Z',
    }
    vi.mocked(api.listRegistryApiKeys).mockResolvedValue({
      org: 'acme',
      keys: [olderKey, newerKey],
    })
    render(<RegistryApiKeysPanel />)
    await waitFor(() => expect(screen.getByText('efrk_new')).toBeInTheDocument())
    const cells = screen.getAllByText(/^efrk_/)
    expect(cells[0]).toHaveTextContent('efrk_new')
    expect(cells[1]).toHaveTextContent('efrk_old')
  })
})
