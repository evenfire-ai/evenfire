import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import * as api from '../../lib/api'
import { OwnedEntries } from '../PublisherView/OwnedEntries'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getOwnedRegistryEntries: vi.fn(),
  // GrantAccessModal deps (mounted lazily when Share access is clicked):
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
  it('renders a skeleton while owned entries load', () => {
    vi.mocked(api.getOwnedRegistryEntries).mockReturnValue(
      new Promise(() => undefined) as ReturnType<typeof api.getOwnedRegistryEntries>
    )
    const view = render(<OwnedEntries orgScope="acme" />)
    expect(screen.getByRole('status', { name: /loading published entries/i })).toBeInTheDocument()
    expect(screen.queryByText(/Loading your published entries/i)).toBeNull()
    expect(view.container.querySelectorAll('.cu-skeleton').length).toBeGreaterThan(0)
  })

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

  it('Type column shows Connector for mcp-servers (serverMode) and Plugin for recipes', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [
        {
          name: '@acme/conn',
          version: '1.0.0',
          visibility: 'public',
          status: 'published',
          serverMode: 'local',
        },
        {
          name: '@acme/plug',
          version: '1.0.0',
          visibility: 'public',
          status: 'published',
          serverMode: null,
        },
      ],
    })
    render(<OwnedEntries orgScope="acme" />)
    await screen.findByText('@acme/conn')
    expect(screen.getByText('Connector')).toBeInTheDocument()
    expect(screen.getByText('Plugin')).toBeInTheDocument()
  })

  it('Type prefers explicit entry_type over the serverMode inference', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [
        {
          name: '@acme/x',
          version: '1.0.0',
          visibility: 'public',
          status: 'published',
          entry_type: 'recipe',
          serverMode: 'local',
        },
      ],
    })
    render(<OwnedEntries orgScope="acme" />)
    await screen.findByText('@acme/x')
    // entry_type 'recipe' wins even though serverMode is set → "Plugin".
    expect(screen.getByText('Plugin')).toBeInTheDocument()
    expect(screen.queryByText('Connector')).toBeNull()
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

  it('clicking Share access opens the Grant access modal', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    render(<OwnedEntries orgScope="acme" />)
    // Modal is not in the DOM until the button is clicked.
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /share access/i }))
    expect(await screen.findByRole('dialog', { name: /grant access/i })).toBeInTheDocument()
    expect(await screen.findByLabelText(/grantee org/i)).toBeInTheDocument()
    expect(api.listOrgGrants).toHaveBeenCalledWith('@acme/db')
  })

  it('renders a skeleton while grant access details load', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    vi.mocked(api.listOrgGrants).mockReturnValue(
      new Promise(() => undefined) as ReturnType<typeof api.listOrgGrants>
    )
    const view = render(<OwnedEntries orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: /share access/i }))
    expect(screen.getByRole('status', { name: /loading grants/i })).toBeInTheDocument()
    expect(screen.queryByText(/Loading grants/i)).toBeNull()
    expect(view.container.querySelectorAll('.cu-skeleton').length).toBeGreaterThan(0)
  })

  it('closing the modal unmounts it from the DOM', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    render(<OwnedEntries orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: /share access/i }))
    expect(await screen.findByRole('dialog', { name: /grant access/i })).toBeInTheDocument()
    // Disambiguate from the icon close button (aria-label="Close") using text.
    fireEvent.click(screen.getByText('Close', { selector: 'button' }))
    expect(screen.queryByRole('dialog', { name: /grant access/i })).toBeNull()
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
