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
import { __resetRegistryCapabilityCacheForTests } from '../../lib/hooks/useRegistryCapability'
import RegistryCatalog from '../RegistryCatalog'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getRegistryCatalog: vi.fn(),
  getRegistryConnection: vi.fn(),
  getPublishScope: vi.fn(),
  deleteRegistryEntry: vi.fn(),
}))

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
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
  visibility: 'public',
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
  __resetRegistryCapabilityCacheForTests()
  // Default persona: curator (administers the shared catalog), which keeps
  // inline edit/remove + Publish visible so the large pre-existing suite is
  // undisturbed. canManageOrg stays false for a curator, so the API-key and
  // ownership-badge cases set an org-bound scope explicitly.
  vi.mocked(api.getPublishScope).mockResolvedValue({ scope: null, curator: true, orgName: null })
  // Default: managed deployment (not_self_hosted) so the connect surfaces stay
  // hidden. Connect-discoverability tests override per case.
  vi.mocked(api.getRegistryConnection).mockRejectedValue(
    Object.assign(new Error('409 not_self_hosted'), { code: 'not_self_hosted' })
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RegistryCatalog tabs and columns', () => {
  it('shows only connector entries on the connectors route', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    expect(await screen.findByText('brave-search')).toBeInTheDocument()
    expect(screen.queryByText('market-report')).not.toBeInTheDocument()
    expect(screen.getByText('Brave web search')).toBeInTheDocument()
    // Panel title is "Marketplace" (the "Connectors" tab selects its catalog); no count.
    expect(screen.getByText('Marketplace')).toBeInTheDocument()
    expect(screen.queryByText(/Marketplace \(/)).not.toBeInTheDocument()
  })

  it('keeps the catalog connector-only when recipe entries are returned', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    expect(await screen.findByText('brave-search')).toBeInTheDocument()
    expect(screen.queryByText('market-report')).not.toBeInTheDocument()
  })

  it('uses explicit record columns and one actions column', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    for (const heading of [
      'Name',
      'Description',
      'Type',
      'Tags',
      'Trust',
      'Verification',
      'Version',
    ]) {
      expect(screen.getByRole('columnheader', { name: heading })).toBeInTheDocument()
    }
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument()
  })

  it('excludes private entries from the Marketplace', async () => {
    mockApiSuccess([
      MOCK_MCP_ENTRY,
      { ...MOCK_MCP_ENTRY, id: '3', name: 'private-search', visibility: 'private' },
    ])
    render(<RegistryCatalog />)

    expect(await screen.findByText('brave-search')).toBeInTheDocument()
    expect(screen.queryByText('private-search')).not.toBeInTheDocument()
  })

  it('shows a single Connectors tab and hides the Plugins tab', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    expect(screen.getAllByRole('tab', { name: 'Connectors' })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Connectors' })).toHaveAttribute(
      'href',
      '/marketplace/connectors'
    )
    expect(screen.queryByRole('tab', { name: 'Plugins' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('tablist', { name: 'Marketplace entry types' })
    ).not.toBeInTheDocument()
  })

  it('places Marketplace navigation below the panel header', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    const header = screen.getByText('Marketplace')
    const connectorsTab = screen.getByRole('tab', { name: 'Connectors' })
    expect(header.compareDocumentPosition(connectorsTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('navigates a record row to its shareable detail route', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    fireEvent.click((await screen.findByText('brave-search')).closest('tr')!)
    expect(navigation.push).toHaveBeenCalledWith('/marketplace/entries/brave-search/1.0.0')
  })

  it('sorts connectors by name and version from their headers', async () => {
    mockApiSuccess([
      MOCK_MCP_ENTRY,
      { ...MOCK_MCP_ENTRY, id: '3', name: 'zebra-search', version: '1.2.0' },
      { ...MOCK_MCP_ENTRY, id: '4', name: 'alpha-search', version: '2.0.0' },
    ])
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    const listedNames = () =>
      Array.from(document.querySelectorAll('.cu-marketplace-table .cu-registry-name')).map(
        element => element.textContent
      )

    fireEvent.click(screen.getByRole('button', { name: 'Sort by name ascending' }))
    expect(listedNames()).toEqual(['alpha-search', 'brave-search', 'zebra-search'])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by version descending' }))
    expect(listedNames()).toEqual(['alpha-search', 'zebra-search', 'brave-search'])

    fireEvent.click(screen.getByRole('button', { name: 'Sort by version ascending' }))
    expect(listedNames()).toEqual(['brave-search', 'zebra-search', 'alpha-search'])
  })
})

describe('RegistryCatalog record navigation and actions', () => {
  it('keeps all record actions in one overflow menu', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!
    const trigger = within(row).getByRole('button', {
      name: 'Actions for brave-search v1.0.0',
    })
    expect(within(row).queryByRole('button', { name: 'Install' })).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Install' })).toBeInTheDocument()
  })

  it('shows former detail metadata in ordinary columns without expansion', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    expect(within(row).getByText('local / streamableHttp')).toBeInTheDocument()
    expect(within(row).getByText('HIGH')).toBeInTheDocument()
    expect(within(row).getByText('verified')).toBeInTheDocument()
    expect(within(row).getByText('search, web')).toBeInTheDocument()
    expect(row).not.toHaveAttribute('aria-expanded')
  })

  it('opens the connector install flow from the overflow menu', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for brave-search v1.0.0' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Install' }))

    expect(navigation.push).toHaveBeenCalledWith(
      '/marketplace/install?entry=brave-search&version=1.0.0'
    )
    expect(row).not.toHaveAttribute('aria-expanded')
  })

  it('marks installed connectors as unavailable for repeat installation', async () => {
    mockApiSuccess(undefined, { installed: { serverNames: ['brave-search'] } })
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for brave-search v1.0.0' }))
    expect(screen.getByRole('menuitem', { name: 'Installed' })).toBeDisabled()
    expect(screen.queryByRole('menuitem', { name: 'Install' })).toBeNull()
  })

  it('removes an entry after confirmation', async () => {
    mockApiSuccess()
    vi.mocked(api.deleteRegistryEntry).mockResolvedValue({ deleted: true })
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for brave-search v1.0.0' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Marketplace' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(api.deleteRegistryEntry).toHaveBeenCalledWith('brave-search', '1.0.0')
    })
  })
})

describe('RegistryCatalog controls', () => {
  it('filters the catalog by the search box', async () => {
    mockApiSuccess([MOCK_MCP_ENTRY, { ...MOCK_MCP_ENTRY, id: '3', name: 'private-search' }])
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    fireEvent.change(screen.getByPlaceholderText('Search connectors...'), {
      target: { value: 'private' },
    })
    expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
    expect(screen.getByText('private-search')).toBeInTheDocument()
  })

  it('applies the category filter to the current tab', async () => {
    mockApiSuccess([
      MOCK_MCP_ENTRY, // category 'search'
      { ...MOCK_MCP_ENTRY, id: '3', name: 'analytics-db', category: 'analytics' },
    ])
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    fireEvent.click(screen.getByRole('button', { name: 'Filter by category' }))
    fireEvent.click(screen.getByRole('option', { name: 'analytics' }))
    expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
    expect(screen.getByText('analytics-db')).toBeInTheDocument()
  })

  // Publish-to-Marketplace is commented out under the distribution strategy
  // narrowing (users don't publish to a public catalog), so the preselect-type
  // test was removed with it.

  // API-key management moved to the org tab's "API Keys" sub-tab; the single-item
  // catalog title kebab was removed, so its menu test was removed with it.
})

describe('RegistryCatalog state handling', () => {
  it('renders a skeleton across the compact columns while capability is resolving', () => {
    vi.mocked(api.getRegistryCatalog).mockReturnValue(new Promise(() => {}))
    // Role is unknown while capability resolves, so the curator-only actions
    // column is absent and the four visible columns render 20 skeleton cells
    // across five rows.
    vi.mocked(api.getPublishScope).mockReturnValue(new Promise(() => {}))
    const { container } = render(<RegistryCatalog />)

    expect(container.querySelectorAll('.cu-skeleton')).toHaveLength(40)
  })

  it('shows an API error', async () => {
    vi.mocked(api.getRegistryCatalog).mockRejectedValue(new Error('Network error'))
    render(<RegistryCatalog />)

    expect(await screen.findByText('Error: Network error')).toBeInTheDocument()
  })

  it('shows the empty state when no entries match', async () => {
    mockApiSuccess([MOCK_RECIPE_ENTRY])
    render(<RegistryCatalog />)
    expect(await screen.findByText('No connectors match your filters.')).toBeInTheDocument()
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

  it('self-hosted + connected → no banner and no header Connect button (nothing to connect)', async () => {
    mockApiSuccess()
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'connected' })
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    // A connected deployment has nothing to connect, so the "Connect" control is
    // removed rather than presented as a no-op (design spec §5.1).
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    )
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

describe('RegistryCatalog - capability-gated controls (§5.1)', () => {
  const ORG_OWNER = { scope: '@acme', curator: false, orgName: 'acme' }

  it('org owner: publish + API-key kebab hidden, inline edit/remove hidden', async () => {
    mockApiSuccess()
    vi.mocked(api.getPublishScope).mockResolvedValue(ORG_OWNER)
    render(<RegistryCatalog />)
    const row = (await screen.findByText('brave-search')).closest('tr')!

    // Publishing is commented out under the distribution strategy narrowing, and
    // API-key management moved to the org tab — the catalog title kebab is gone.
    expect(
      screen.queryByRole('button', { name: '+ Publish to Marketplace' })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Marketplace actions' })).not.toBeInTheDocument()
    // Editing/removing moves to the ownership area, so the discovery row no
    // longer offers them (design spec §5.4).
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for brave-search v1.0.0' }))
    expect(screen.getByRole('menuitem', { name: 'View details' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Remove from Marketplace' })).toBeNull()
  })

  it('org owner: owned entries are badged and lead to the ownership area', async () => {
    mockApiSuccess([{ ...MOCK_MCP_ENTRY, id: '9', name: '@acme/internal-tool' }, MOCK_MCP_ENTRY])
    vi.mocked(api.getPublishScope).mockResolvedValue(ORG_OWNER)
    render(<RegistryCatalog />)

    const ownedRow = (await screen.findByText('@acme/internal-tool')).closest('tr')!
    expect(within(ownedRow).getByText('Owned by your organization')).toBeInTheDocument()
    fireEvent.click(
      within(ownedRow).getByRole('button', {
        name: 'Actions for @acme/internal-tool v1.0.0',
      })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage published entry' }))
    expect(navigation.push).toHaveBeenCalledWith('/marketplace/org/entries')
    // A catalog entry the org does not own carries no ownership badge.
    const otherRow = screen.getByText('brave-search').closest('tr')!
    expect(within(otherRow).queryByRole('link', { name: 'You own this' })).not.toBeInTheDocument()
  })

  it('browse-only (unbound, non-curator): no Publish, no API-key menu, no inline actions', async () => {
    mockApiSuccess()
    vi.mocked(api.getPublishScope).mockResolvedValue({ scope: null, curator: false, orgName: null })
    render(<RegistryCatalog />)
    await screen.findByText('brave-search')

    expect(
      screen.queryByRole('button', { name: '+ Publish to Marketplace' })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Marketplace actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Edit or remove' })).not.toBeInTheDocument()
  })
})
