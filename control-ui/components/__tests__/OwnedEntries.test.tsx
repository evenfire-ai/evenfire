import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import * as api from '../../lib/api'
import { OwnedEntries } from '../PublisherView/OwnedEntries'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getOwnedRegistryEntries: vi.fn(),
  // ShareAccessPanel deps (rendered lazily on expand):
  listOrgGrants: vi.fn().mockResolvedValue({ grants: [] }),
  createOrgGrant: vi.fn(),
  revokeOrgGrant: vi.fn(),
}))
vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn().mockResolvedValue(false), confirmDialog: null }),
}))

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('OwnedEntries', () => {
  it('renders owned entries with visibility + status', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [
        { name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' },
        { name: '@acme/pub', version: '2.0.0', visibility: 'public', status: 'published' },
      ],
    })
    render(<OwnedEntries orgScope="acme" />)
    expect(await screen.findByText('@acme/db')).toBeInTheDocument()
    expect(screen.getByText('@acme/pub')).toBeInTheDocument()
  })

  it('shows Share access only for private entries; public shows a no-grant note', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [
        { name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' },
        { name: '@acme/pub', version: '2.0.0', visibility: 'public', status: 'published' },
      ],
    })
    render(<OwnedEntries orgScope="acme" />)
    await screen.findByText('@acme/db')
    expect(screen.getAllByRole('button', { name: /share access/i })).toHaveLength(1)
    expect(screen.getByText(/no grant needed/i)).toBeInTheDocument()
  })

  it('expanding Share access mounts the grants panel', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    render(<OwnedEntries orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: /share access/i }))
    expect(await screen.findByLabelText(/grantee org/i)).toBeInTheDocument()
  })

  it('empty state when no owned entries', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({ data: [] })
    render(<OwnedEntries orgScope="acme" />)
    expect(await screen.findByText(/haven’t published/i)).toBeInTheDocument()
  })

  it('error + Retry re-fetches', async () => {
    vi.mocked(api.getOwnedRegistryEntries)
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValueOnce({ data: [] })
    render(<OwnedEntries orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    expect(await screen.findByText(/haven’t published/i)).toBeInTheDocument()
  })
})
