import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import { OwnedEntries } from '../PublisherView/OwnedEntries'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getOwnedRegistryEntries: vi.fn(),
  getRegistryCatalog: vi.fn(),
  deleteRegistryEntry: vi.fn(),
  // GrantAccessModal deps (mounted lazily when Share access is clicked):
  listOrgGrants: vi.fn().mockResolvedValue({ grants: [] }),
  createOrgGrant: vi.fn(),
  revokeOrgGrant: vi.fn(),
}))

const EMPTY_INSTALLED = {
  data: [],
  categories: [],
  installed: { catalogKeys: [], serverNames: [], recipeKeys: [] },
}

const confirmMock = vi.hoisted(() => vi.fn())
vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, confirmDialog: null }),
}))

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
}))

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  confirmMock.mockResolvedValue(false)
  // Default: nothing installed, so entries show the Install CTA.
  vi.mocked(api.getRegistryCatalog).mockResolvedValue(EMPTY_INSTALLED as never)
})

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

  it('offers Edit from the row actions menu, routing to the entry editor', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    render(<OwnedEntries orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for @acme/db v1.0.0' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // The scoped name is URL-encoded so its '/' stays inside one path segment.
    expect(navigation.push).toHaveBeenCalledWith('/marketplace/entries/%40acme%2Fdb/1.0.0/edit')
  })

  it('offers Install, routing to the install wizard for the entry', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    render(<OwnedEntries orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining('/marketplace/install'))
  })

  it('shows "Installed" (disabled) for an entry already installed in the cluster', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    vi.mocked(api.getRegistryCatalog).mockResolvedValue({
      data: [],
      categories: [],
      installed: { catalogKeys: [], serverNames: [], recipeKeys: ['@acme/db@1.0.0'] },
    } as never)
    render(<OwnedEntries orgScope="acme" />)
    expect(await screen.findByRole('button', { name: 'Installed' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('removes an entry from the row actions menu after confirmation', async () => {
    confirmMock.mockResolvedValue(true)
    vi.mocked(api.getOwnedRegistryEntries)
      .mockResolvedValueOnce({
        data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
      })
      .mockResolvedValueOnce({ data: [] })
    vi.mocked(api.deleteRegistryEntry).mockResolvedValue({ deleted: true })
    render(<OwnedEntries orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for @acme/db v1.0.0' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Marketplace' }))
    await waitFor(() => expect(api.deleteRegistryEntry).toHaveBeenCalledWith('@acme/db', '1.0.0'))
  })

  it('does not remove when the confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false)
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    render(<OwnedEntries orgScope="acme" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for @acme/db v1.0.0' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Marketplace' }))
    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(api.deleteRegistryEntry).not.toHaveBeenCalled()
  })

  it('collapses same-named versions into one row showing the latest, expandable to previous', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [
        { name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' },
        { name: '@acme/db', version: '1.2.0', visibility: 'private', status: 'published' },
        { name: '@acme/db', version: '1.1.0', visibility: 'private', status: 'published' },
      ],
    })
    render(<OwnedEntries orgScope="acme" />)
    await screen.findByText('@acme/db')
    // One collapsed row: latest version leads, previous count summarized.
    expect(screen.getByText('1.2.0')).toBeInTheDocument()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    // Previous versions are hidden until the row is expanded.
    expect(screen.queryByText('1.1.0')).toBeNull()
    expect(screen.queryByText('1.0.0')).toBeNull()

    fireEvent.click(screen.getByText('@acme/db'))
    expect(await screen.findByText('Previous versions')).toBeInTheDocument()
    expect(screen.getByText('1.1.0')).toBeInTheDocument()
    expect(screen.getByText('1.0.0')).toBeInTheDocument()
  })

  it('row Install targets the latest version; expanded rows install previous versions', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [
        { name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' },
        { name: '@acme/db', version: '2.0.0', visibility: 'private', status: 'published' },
      ],
    })
    render(<OwnedEntries orgScope="acme" />)
    await screen.findByText('@acme/db')
    // Collapsed row's Install goes to the latest version.
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining('version=2.0.0'))

    navigation.push.mockClear()
    fireEvent.click(screen.getByText('@acme/db'))
    await screen.findByText('Previous versions')
    // Now there are two Installs: the latest (main row) then the previous (detail).
    const installs = screen.getAllByRole('button', { name: 'Install' })
    expect(installs).toHaveLength(2)
    fireEvent.click(installs[1])
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining('version=1.0.0'))
  })

  it('states the sharing limit and hides Share when sharing is unavailable', async () => {
    vi.mocked(api.getOwnedRegistryEntries).mockResolvedValue({
      data: [{ name: '@acme/db', version: '1.0.0', visibility: 'private', status: 'published' }],
    })
    render(<OwnedEntries orgScope="acme" canShare={false} sharingUnavailable />)
    await screen.findByText('@acme/db')
    expect(screen.queryByRole('button', { name: /share access/i })).toBeNull()
    expect(screen.getByText(/Cross-org sharing/i)).toBeInTheDocument()
  })
})
