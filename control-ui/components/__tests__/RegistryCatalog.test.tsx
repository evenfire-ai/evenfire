import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import * as api from '../../lib/api'
import type { RegistryEntry, RegistryInstalledState } from '../../lib/api'
import RegistryCatalog from '../RegistryCatalog'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getRegistryCatalog: vi.fn(),
  getRegistryConnection: vi.fn(),
  deleteRegistryEntry: vi.fn(),
  installRecipeFromRegistry: vi.fn(),
}))

const navigation = vi.hoisted(() => ({
  pathname: '/marketplace/connectors',
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}))

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

const MOCK_MCP_ENTRY: RegistryEntry = {
  id: '1',
  name: 'brave-search',
  version: '1.0.0',
  entry_type: 'mcp-server',
  description: 'Brave web search',
  author: 'test',
  origin: 'human-authored',
  category: 'search',
  tags: ['search', 'web'],
  trust_level: 'high',
  quality_tier: 'verified',
  visibility: 'public',
  status: 'published',
  server_mode: 'local',
  transport: 'streamableHttp',
  recipe_type: null,
  mcp_server_meta: { imageRef: 'brave-search:1.0' },
  recipe_meta: null,
  artifact_refs: null,
  downloads: 42,
  installs: 10,
  created_at: '2026-01-01T00:00:00Z',
}

const MOCK_RECIPE_ENTRY: RegistryEntry = {
  id: '2',
  name: 'market-report',
  version: '2.1.0',
  entry_type: 'recipe',
  description: 'Market analysis workflow',
  author: 'test',
  origin: 'human-authored',
  category: 'analytics',
  tags: ['analytics', 'reporting'],
  trust_level: 'mid',
  quality_tier: 'unverified',
  visibility: 'private',
  status: 'published',
  server_mode: null,
  transport: null,
  recipe_type: 'workflow',
  mcp_server_meta: null,
  recipe_meta: {
    recipeYaml: JSON.stringify({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'market-report' },
      spec: { workloads: [{ id: 'w1', type: 'deployment', image: 'test:1' }] },
    }),
  },
  artifact_refs: null,
  downloads: 5,
  installs: 2,
  created_at: '2026-01-01T00:00:00Z',
}

function mockApiSuccess(
  entries: RegistryEntry[] = [MOCK_MCP_ENTRY, MOCK_RECIPE_ENTRY],
  options: { installed?: Partial<RegistryInstalledState> } = {}
) {
  vi.mocked(api.getRegistryCatalog).mockResolvedValue({
    data: entries,
    meta: { total: entries.length },
    categories: ['search', 'analytics'],
    installed: {
      catalogKeys: options.installed?.catalogKeys ?? [],
      serverNames: options.installed?.serverNames ?? [],
      recipeKeys: options.installed?.recipeKeys ?? [],
    },
  })
}

beforeEach(() => {
  // Default: managed deployment (not_self_hosted) so the large pre-existing
  // catalog suite is undisturbed. Connect-discoverability tests override per case.
  vi.mocked(api.getRegistryConnection).mockRejectedValue(
    Object.assign(new Error('409 not_self_hosted'), { code: 'not_self_hosted' })
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  navigation.pathname = '/marketplace/connectors'
})

describe('RegistryCatalog tabs and columns', () => {
  it('shows only connector entries on the connectors route', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    expect(await screen.findByText('brave-search')).toBeInTheDocument()
    expect(screen.queryByText('market-report')).not.toBeInTheDocument()
    expect(screen.getByText('Brave web search')).toBeInTheDocument()
    expect(screen.getByText('1 of 1 entries')).toBeInTheDocument()
  })

  it('shows only plugin entries on the plugins route', async () => {
    navigation.pathname = '/marketplace/plugins'
    mockApiSuccess()
    render(<RegistryCatalog />)

    expect(await screen.findByText('market-report')).toBeInTheDocument()
    expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search plugins...')).toBeInTheDocument()
  })

  it('uses the same compact columns for both tabs', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    for (const heading of ['Name', 'Version', 'Visibility', 'Downloads']) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument()
    }
    for (const actionHeading of ['View details', 'Installation', 'Edit or remove']) {
      expect(screen.getByRole('columnheader', { name: actionHeading })).toBeInTheDocument()
    }
    for (const removed of ['Type', 'Category', 'Trust', 'Quality']) {
      expect(screen.queryByRole('columnheader', { name: removed })).not.toBeInTheDocument()
    }
  })

  it('provides canonical tabs for connectors and plugins', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    expect(screen.getByRole('tab', { name: 'Connectors' })).toHaveAttribute(
      'href',
      '/marketplace/connectors'
    )
    expect(screen.getByRole('tab', { name: 'Plugins' })).toHaveAttribute(
      'href',
      '/marketplace/plugins'
    )
  })
})

describe('RegistryCatalog expansion and actions', () => {
  it('keeps details, installation, and metadata actions in separate columns', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!
    const detailsCell = within(row).getByRole('button', { name: 'View details' }).closest('td')
    const installCell = within(row).getByRole('button', { name: 'Install' }).closest('td')
    const editCell = within(row)
      .getByRole('button', { name: 'Edit Marketplace metadata for brave-search v1.0.0' })
      .closest('td')

    expect(detailsCell).not.toBe(installCell)
    expect(installCell).not.toBe(editCell)
    expect(detailsCell).not.toBe(editCell)
  })

  it('reveals metadata only after the full row is expanded', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    expect(screen.queryByText('local / streamableHttp')).not.toBeInTheDocument()
    fireEvent.click(row)

    expect(screen.getByText('Type')).toBeInTheDocument()
    const detailRow = screen.getByText('Type').closest('tr')!
    expect(within(detailRow).getAllByText('search')).toHaveLength(2)
    expect(screen.getByText('HIGH')).toBeInTheDocument()
    expect(screen.getByText('verified')).toBeInTheDocument()
    expect(screen.getByText('web')).toBeInTheDocument()
    expect(screen.getByText('local / streamableHttp')).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens details explicitly without expanding the row', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    fireEvent.click(within(row).getByRole('button', { name: 'View details' }))

    expect(navigation.push).toHaveBeenCalledWith('/marketplace/entries/brave-search/1.0.0')
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the connector install flow without expanding the row', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    fireEvent.click(within(row).getByRole('button', { name: 'Install' }))

    expect(navigation.push).toHaveBeenCalledWith(
      '/marketplace/install?entry=brave-search&version=1.0.0'
    )
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })

  it('installs a plugin from the plugins tab', async () => {
    navigation.pathname = '/marketplace/plugins'
    mockApiSuccess()
    vi.mocked(api.installRecipeFromRegistry).mockResolvedValue({ installed: true })
    render(<RegistryCatalog />)
    const row = (await screen.findByText('market-report')).closest('tr')!

    fireEvent.click(within(row).getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(api.installRecipeFromRegistry).toHaveBeenCalledOnce())
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks installed connectors as unavailable for repeat installation', async () => {
    mockApiSuccess(undefined, { installed: { serverNames: ['brave-search'] } })
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    expect(within(row).getByRole('button', { name: 'Installed' })).toBeDisabled()
  })

  it('removes an entry after confirmation', async () => {
    mockApiSuccess()
    vi.mocked(api.deleteRegistryEntry).mockResolvedValue({ deleted: true })
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    fireEvent.click(
      within(row).getByRole('button', { name: 'Remove brave-search v1.0.0 from Marketplace' })
    )
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(api.deleteRegistryEntry).toHaveBeenCalledWith('brave-search', '1.0.0')
    })
  })
})

describe('RegistryCatalog controls', () => {
  it('searches and filters only the current tab', async () => {
    mockApiSuccess([
      MOCK_MCP_ENTRY,
      { ...MOCK_MCP_ENTRY, id: '3', name: 'private-search', visibility: 'private' },
      MOCK_RECIPE_ENTRY,
    ])
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    fireEvent.change(screen.getByPlaceholderText('Search connectors...'), {
      target: { value: 'private' },
    })

    expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
    expect(screen.getByText('private-search')).toBeInTheDocument()
    expect(screen.queryByText('market-report')).not.toBeInTheDocument()
  })

  it('applies category and mode filters to the current tab', async () => {
    mockApiSuccess([
      MOCK_MCP_ENTRY,
      {
        ...MOCK_MCP_ENTRY,
        id: '3',
        name: 'remote-db',
        category: 'database',
        server_mode: 'remote',
      },
    ])
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by mode' }), {
      target: { value: 'remote' },
    })
    expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
    expect(screen.getByText('remote-db')).toBeInTheDocument()
  })

  it('preselects the publish type from the active tab', async () => {
    navigation.pathname = '/marketplace/plugins'
    mockApiSuccess()
    render(<RegistryCatalog />)
    await screen.findByText('market-report')

    fireEvent.click(screen.getByRole('button', { name: '+ Publish to Marketplace' }))
    expect(navigation.push).toHaveBeenCalledWith('/marketplace/publish?type=recipe')
  })

  it('routes to canonical API-key management', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    fireEvent.click(await screen.findByRole('button', { name: /manage api keys/i }))
    expect(navigation.push).toHaveBeenCalledWith('/marketplace/keys')
  })
})

describe('RegistryCatalog state handling', () => {
  it('renders forty skeleton cells for the eight-column table', () => {
    vi.mocked(api.getRegistryCatalog).mockReturnValue(new Promise(() => {}))
    const { container } = render(<RegistryCatalog />)

    expect(container.querySelectorAll('.cu-skeleton')).toHaveLength(40)
    expect(screen.getByPlaceholderText('Search connectors...')).toBeDisabled()
  })

  it('shows an API error', async () => {
    vi.mocked(api.getRegistryCatalog).mockRejectedValue(new Error('Network error'))
    render(<RegistryCatalog />)

    expect(await screen.findByText('Error: Network error')).toBeInTheDocument()
  })

  it('shows the empty filter state', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    fireEvent.change(screen.getByPlaceholderText('Search connectors...'), {
      target: { value: 'not-present' },
    })
    expect(screen.getByText('No entries match your filters.')).toBeInTheDocument()
  })
})

describe('RegistryCatalog - connect discoverability', () => {
  it('self-hosted + disconnected → shows connect banner and header Connect button; both route to connect', async () => {
    mockApiSuccess()
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    expect(screen.getByText(/This deployment isn't connected to a registry/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Connect to registry' }))
    expect(navigation.push).toHaveBeenCalledWith('/marketplace/connect')

    navigation.push.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(navigation.push).toHaveBeenCalledWith('/marketplace/connect')
  })

  it('self-hosted + connected → no banner, header Connect button present', async () => {
    mockApiSuccess()
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'connected' })
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.queryByText(/This deployment isn't connected/i)).not.toBeInTheDocument()
  })

  it('managed deployment (not_self_hosted) → no banner and no header Connect button', async () => {
    mockApiSuccess()
    vi.mocked(api.getRegistryConnection).mockRejectedValue(
      Object.assign(new Error('409 not_self_hosted'), { code: 'not_self_hosted' })
    )
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    // The connection fetch resolves mode → managed, hiding both surfaces.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    )
    expect(screen.queryByText(/This deployment isn't connected/i)).not.toBeInTheDocument()
  })

  it('unknown connection error → header Connect button present (fail-open), no banner', async () => {
    mockApiSuccess()
    vi.mocked(api.getRegistryConnection).mockRejectedValue(new Error('500 Internal Server Error'))
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.queryByText(/This deployment isn't connected/i)).not.toBeInTheDocument()
  })

  it('catalog load error + self-hosted disconnected → connect banner rendered alongside the error banner', async () => {
    vi.mocked(api.getRegistryCatalog).mockRejectedValue(
      new Error('The registry is currently unavailable. Check the connection and try again.')
    )
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    render(<RegistryCatalog />)

    await waitFor(() =>
      expect(screen.getByText(/This deployment isn't connected to a registry/i)).toBeInTheDocument()
    )
    expect(
      screen.getByText(
        'Error: The registry is currently unavailable. Check the connection and try again.'
      )
    ).toBeInTheDocument()

    // The banner CTA still routes to the connect flow even inside the error branch.
    fireEvent.click(screen.getByRole('button', { name: 'Connect to registry' }))
    expect(navigation.push).toHaveBeenCalledWith('/marketplace/connect')
  })
})
