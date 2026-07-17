import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import type { RegistryEntry, RegistryInstalledState } from '../../lib/api'
import RegistryCatalog from '../RegistryCatalog'
import { ToastProvider } from '../Toast'

// vi.mock is hoisted before imports, factory runs lazily
vi.mock('../../lib/api', () => ({
  getRegistryCatalog: vi.fn(),
  getRegistryConnection: vi.fn(),
  deleteRegistryEntry: vi.fn(),
  installRecipeFromRegistry: vi.fn(),
}))

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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
  version: '1.0.0',
  entry_type: 'recipe',
  description: 'Market analysis workflow',
  author: 'test',
  origin: 'human-authored',
  category: 'analytics',
  tags: ['analytics'],
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
  categories: string[] = ['search', 'analytics'],
  options: {
    installed?: Partial<RegistryInstalledState>
  } = {}
) {
  vi.mocked(api.getRegistryCatalog).mockResolvedValue({
    data: entries,
    meta: { total: entries.length },
    categories,
    installed: {
      catalogKeys: options.installed?.catalogKeys ?? [],
      serverNames: options.installed?.serverNames ?? [],
      recipeKeys: options.installed?.recipeKeys ?? [],
    },
  })
}

beforeEach(() => {
  // Default: managed deployment (no self-hosted connect surface) so the large
  // pre-existing catalog suite is undisturbed. Connect-discoverability tests
  // below override this per case.
  vi.mocked(api.getRegistryConnection).mockRejectedValue(
    Object.assign(new Error('409 not_self_hosted'), { code: 'not_self_hosted' })
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RegistryCatalog - render', () => {
  it('test_registryCatalog_renderEntries_showsTableWithNames', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })
    expect(screen.getByText('market-report')).toBeInTheDocument()
    expect(screen.getByText('Brave web search')).toBeInTheDocument()
    expect(screen.getByText('Market analysis workflow')).toBeInTheDocument()
  })

  it('test_registryCatalog_mcpServerEntry_showsInstallButton', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const installButtons = screen.getAllByText('Install')
    expect(installButtons.length).toBeGreaterThanOrEqual(1)

    // The Install button should be in the same row as brave-search
    const braveRow = screen.getByText('brave-search').closest('tr')
    expect(braveRow).toBeTruthy()
    const installButton = braveRow!.querySelector('button')
    expect(installButton).toBeTruthy()
    expect(installButton!.textContent).toBe('Install')
    expect(installButton).toHaveAttribute('type', 'button')
  })

  it('test_registryCatalog_recipeEntry_showsInstallButton', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })

    const recipeRow = screen.getByText('market-report').closest('tr')
    expect(recipeRow).toBeTruthy()

    const installButton = recipeRow!.querySelector('button')
    expect(installButton).toBeTruthy()
    expect(installButton!.textContent).toBe('Install')
    expect(installButton).toHaveAttribute('type', 'button')
  })

  it('test_registryCatalog_recipeWithoutYaml_showsNoRecipeData', async () => {
    const recipeNoYaml: RegistryEntry = {
      ...MOCK_RECIPE_ENTRY,
      id: '3',
      name: 'empty-recipe',
      recipe_meta: null,
    }
    mockApiSuccess([MOCK_MCP_ENTRY, recipeNoYaml], ['search', 'analytics'])
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('empty-recipe')).toBeInTheDocument()
    })

    const recipeRow = screen.getByText('empty-recipe').closest('tr')
    expect(recipeRow).toBeTruthy()

    const noDataElements = Array.from(recipeRow!.querySelectorAll('span')).filter(
      el => el.textContent === 'No plugin data'
    )
    expect(noDataElements.length).toBe(1)

    // No Install button (the row uses the "No plugin data" span instead) but
    // the developer Edit/Remove actions are always rendered as icon-only buttons.
    const buttons = Array.from(recipeRow!.querySelectorAll('button'))
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toHaveAccessibleName('Edit Marketplace metadata for empty-recipe v1.0.0')
    expect(buttons[0]).toHaveTextContent('')
    expect(buttons[0].querySelector('svg')).not.toBeNull()
    expect(buttons[1]).toHaveAccessibleName('Remove empty-recipe v1.0.0 from Marketplace')
    expect(buttons[1]).toHaveTextContent('')
    expect(buttons[1].querySelector('svg')).not.toBeNull()
  })

  it('test_registryCatalog_publishButton_usesButtonType', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const publishButton = screen.getByRole('button', { name: '+ Publish to Marketplace' })
    expect(publishButton).toHaveAttribute('type', 'button')
  })

  it('routes to /registry/keys from the Manage API keys button', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    fireEvent.click(await screen.findByRole('button', { name: /manage api keys/i }))
    expect(mockPush).toHaveBeenCalledWith('/registry/keys')
  })
})

describe('RegistryCatalog - filters', () => {
  it('test_registryCatalog_typeFilter_filtersToMcpServersOnly', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    // Both entries visible initially
    expect(screen.getByText('market-report')).toBeInTheDocument()

    // Find the type filter select (the one with "All Types" option)
    const selects = screen.getAllByRole('combobox')
    const typeSelect = selects.find(s => {
      const options = Array.from(s.querySelectorAll('option'))
      return options.some(o => o.textContent === 'All Types')
    })
    expect(typeSelect).toBeTruthy()

    // Filter to Connectors only
    fireEvent.change(typeSelect!, { target: { value: 'mcp-server' } })

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
      expect(screen.queryByText('market-report')).not.toBeInTheDocument()
    })
  })

  it('test_registryCatalog_typeFilter_filtersToRecipesOnly', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const selects = screen.getAllByRole('combobox')
    const typeSelect = selects.find(s => {
      const options = Array.from(s.querySelectorAll('option'))
      return options.some(o => o.textContent === 'All Types')
    })
    expect(typeSelect).toBeTruthy()

    fireEvent.change(typeSelect!, { target: { value: 'recipe' } })

    await waitFor(() => {
      expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })
  })

  it('test_registryCatalog_searchFilter_filtersEntriesByName', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText('Search entries...')
    fireEvent.change(searchInput, { target: { value: 'brave' } })

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
      expect(screen.queryByText('market-report')).not.toBeInTheDocument()
    })
  })

  it('test_registryCatalog_searchFilter_filtersEntriesByDescription', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText('Search entries...')
    fireEvent.change(searchInput, { target: { value: 'market analysis' } })

    await waitFor(() => {
      expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })
  })

  it('test_registryCatalog_searchFilter_filtersEntriesByTag', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText('Search entries...')
    fireEvent.change(searchInput, { target: { value: 'analytics' } })

    await waitFor(() => {
      expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })
  })

  it('test_registryCatalog_searchFilter_noResults_showsEmptyMessage', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText('Search entries...')
    fireEvent.change(searchInput, { target: { value: 'nonexistent-xyz' } })

    await waitFor(() => {
      expect(screen.getByText('No entries match your filters.')).toBeInTheDocument()
    })
  })
})

describe('RegistryCatalog - loading and error states', () => {
  it('test_registryCatalog_loading_showsSkeletonRows', () => {
    // Mock with never-resolving promises to keep loading state
    vi.mocked(api.getRegistryCatalog).mockReturnValue(new Promise(() => {}))

    const { container } = render(<RegistryCatalog />)
    expect(screen.getByText('Marketplace')).toBeInTheDocument()
    expect(screen.queryByText('Loading Marketplace...')).not.toBeInTheDocument()
    // 5 skeleton rows × 9 columns (Name, Type, Category, Version, Trust,
    // Quality, Visibility, Downloads, Actions).
    expect(container.querySelectorAll('.cu-skeleton')).toHaveLength(45)
    expect(screen.getByPlaceholderText('Search entries...')).toBeDisabled()
  })

  it('test_registryCatalog_apiFailure_showsErrorMessage', async () => {
    vi.mocked(api.getRegistryCatalog).mockRejectedValue(new Error('Network error'))

    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('Error: Network error')).toBeInTheDocument()
    })
  })

  it('test_registryCatalog_entriesApiFailure_showsError', async () => {
    vi.mocked(api.getRegistryCatalog).mockRejectedValue(new Error('500 Internal Server Error'))

    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('Error: 500 Internal Server Error')).toBeInTheDocument()
    })
  })

  it('test_registryCatalog_unavailable_showsFriendlyServerMessage', async () => {
    vi.mocked(api.getRegistryCatalog).mockRejectedValue(
      new Error('The registry is currently unavailable. Check the connection and try again.')
    )

    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(
        screen.getByText(
          'Error: The registry is currently unavailable. Check the connection and try again.'
        )
      ).toBeInTheDocument()
    })
    expect(screen.queryByText('Error: 500 Internal Server Error')).not.toBeInTheDocument()
  })
})

describe('RegistryCatalog - entry details', () => {
  it('test_registryCatalog_trustLevel_rendersCorrectLabel', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('HIGH')).toBeInTheDocument()
    })
    expect(screen.getByText('MID')).toBeInTheDocument()
  })

  it('test_registryCatalog_typeLabels_rendersCorrectBadges', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('Connector')).toBeInTheDocument()
    })
    expect(screen.getByText('Plugin')).toBeInTheDocument()
  })

  it('test_registryCatalog_tags_rendersTagBadges', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })
    // "search" tag appears as both a tag badge AND as the category text in the category column.
    // We verify tags are present via their container rows.
    const braveRow = screen.getByText('brave-search').closest('tr')!
    expect(braveRow.textContent).toContain('web')

    const recipeRow = screen.getByText('market-report').closest('tr')!
    expect(recipeRow.textContent).toContain('analytics')
  })

  it('test_registryCatalog_downloads_showsCount', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument()
    })
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('test_registryCatalog_entryCount_showsFilteredOfTotal', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('2 of 2 entries')).toBeInTheDocument()
    })
  })

  it('test_registryCatalog_qualityTier_rendersBadges', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('verified')).toBeInTheDocument()
    })
    expect(screen.getByText('unverified')).toBeInTheDocument()
  })

  it('test_registryCatalog_serverMode_displaysTransportInfo', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('local / streamableHttp')).toBeInTheDocument()
    })
  })

  it('test_registryCatalog_recipeType_displaysWorkflowLabel', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('workflow')).toBeInTheDocument()
    })
  })
})

describe('RegistryCatalog - visibility badge', () => {
  it('test_registryCatalog_publicEntry_rendersPublicBadge', async () => {
    // MOCK_MCP_ENTRY (brave-search) is visibility: 'public'.
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const publicRow = screen.getByText('brave-search').closest('tr')!
    const badge = Array.from(publicRow.querySelectorAll('span.cu-registry-chip')).find(
      el => el.textContent === 'Public'
    )
    expect(badge).toBeTruthy()
    expect(badge).toHaveClass('cu-registry-chip--visibility-public')
    // A public row carries no "Private" badge.
    expect(publicRow.textContent).not.toContain('Private')
  })

  it('test_registryCatalog_privateEntry_rendersPrivateBadge', async () => {
    // MOCK_RECIPE_ENTRY (market-report) is visibility: 'private'.
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })

    const privateRow = screen.getByText('market-report').closest('tr')!
    const badge = Array.from(privateRow.querySelectorAll('span.cu-registry-chip')).find(
      el => el.textContent === 'Private'
    )
    expect(badge).toBeTruthy()
    expect(badge).toHaveClass('cu-registry-chip--visibility-private')
  })

  it('test_registryCatalog_entryWithoutVisibility_rendersNoBadge', async () => {
    // A row missing `visibility` (older/partial registry row) must not assume a
    // value — neither Public nor Private should appear for it.
    const noVisibility: RegistryEntry = { ...MOCK_MCP_ENTRY, id: '9', name: 'no-vis-entry' }
    delete (noVisibility as { visibility?: unknown }).visibility
    mockApiSuccess([noVisibility], ['search'])
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('no-vis-entry')).toBeInTheDocument()
    })

    const row = screen.getByText('no-vis-entry').closest('tr')!
    const visibilityBadge = Array.from(row.querySelectorAll('span.cu-registry-chip')).find(
      el => el.textContent === 'Public' || el.textContent === 'Private'
    )
    expect(visibilityBadge).toBeUndefined()
  })
})

describe('RegistryCatalog - install flow', () => {
  it('test_registryCatalog_installClick_navigatesToInstallPage', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const braveRow = screen.getByText('brave-search').closest('tr')
    const installButton = braveRow!.querySelector('button')!
    fireEvent.click(installButton)

    expect(mockPush).toHaveBeenCalledWith('/registry/install?entry=brave-search&version=1.0.0')
  })

  it('test_registryCatalog_pluginInstallClick_installsRecipeDirectly', async () => {
    mockApiSuccess()
    vi.mocked(api.installRecipeFromRegistry).mockResolvedValueOnce({
      recipeName: 'market-report',
      registryEntry: 'market-report',
      registryVersion: '1.0.0',
      correlationId: 'corr-1',
    })
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })

    const recipeRow = screen.getByText('market-report').closest('tr')!
    const installButton = Array.from(recipeRow.querySelectorAll('button')).find(
      button => button.textContent === 'Install'
    )!
    fireEvent.click(installButton)

    await waitFor(() => expect(api.installRecipeFromRegistry).toHaveBeenCalledTimes(1))
    expect(api.installRecipeFromRegistry).toHaveBeenCalledWith({
      registryEntryName: 'market-report',
      registryEntryVersion: '1.0.0',
      recipeManifest: MOCK_RECIPE_ENTRY.recipe_meta?.recipeYaml,
    })
    expect(mockPush).not.toHaveBeenCalledWith('/registry/install?entry=market-report&version=1.0.0')
    await waitFor(() => {
      expect(recipeRow.querySelector('button')?.textContent).toBe('Installed')
    })
  })

  it('test_registryCatalog_pluginInstallError_canBeDismissed', async () => {
    mockApiSuccess()
    vi.mocked(api.installRecipeFromRegistry).mockRejectedValueOnce(new Error('Install failed'))
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })

    const recipeRow = screen.getByText('market-report').closest('tr')!
    const installButton = Array.from(recipeRow.querySelectorAll('button')).find(
      button => button.textContent === 'Install'
    )!
    fireEvent.click(installButton)

    expect(await screen.findByRole('alert')).toHaveTextContent('Install failed')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss install error' }))
    expect(screen.queryByText('Install failed')).not.toBeInTheDocument()
  })
})

describe('RegistryCatalog - installed state for recipes', () => {
  it('test_registryCatalog_recipeInstalledByCatalogLabels_showsInstalledDisabled', async () => {
    mockApiSuccess([MOCK_MCP_ENTRY, MOCK_RECIPE_ENTRY], ['search', 'analytics'], {
      installed: { recipeKeys: ['market-report@1.0.0'] },
    })
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })

    const recipeRow = screen.getByText('market-report').closest('tr')!
    const button = recipeRow.querySelector('button')!
    expect(button.textContent).toBe('Installed')
    expect(button).toBeDisabled()

    // Disabled button must not navigate even if click bubbles
    fireEvent.click(button)
    expect(mockPush).not.toHaveBeenCalledWith(
      expect.stringContaining('/workflow-recipes?registry=market-report')
    )
  })

  it('test_registryCatalog_recipeWithoutMatchingLabels_stillShowsInstall', async () => {
    mockApiSuccess([MOCK_MCP_ENTRY, MOCK_RECIPE_ENTRY], ['search', 'analytics'], {
      installed: { recipeKeys: ['some-other-entry@2.0.0'] },
    })
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })

    const recipeRow = screen.getByText('market-report').closest('tr')!
    const button = recipeRow.querySelector('button')!
    expect(button.textContent).toBe('Install')
    expect(button).not.toBeDisabled()
  })

  it('test_registryCatalog_recipeMatchingNameButDifferentVersion_showsInstall', async () => {
    mockApiSuccess([MOCK_MCP_ENTRY, MOCK_RECIPE_ENTRY], ['search', 'analytics'], {
      installed: { recipeKeys: ['market-report@0.9.0'] },
    })
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })

    const recipeRow = screen.getByText('market-report').closest('tr')!
    const button = recipeRow.querySelector('button')!
    // Catalog row is v1.0.0; cluster has v0.9.0 — must surface as installable
    expect(button.textContent).toBe('Install')
  })
})

// ── Remote entry rendering ──────────────────────────────────────────────────

const MOCK_REMOTE_ENTRY: RegistryEntry = {
  id: '3',
  name: 'sentry-mcp',
  version: '1.0.0',
  entry_type: 'mcp-server',
  description: 'Sentry remote monitoring',
  author: 'test',
  origin: 'human-authored',
  category: 'monitoring',
  tags: ['monitoring'],
  trust_level: 'high',
  quality_tier: 'verified',
  visibility: 'public',
  status: 'published',
  server_mode: 'remote',
  transport: 'sse',
  recipe_type: null,
  mcp_server_meta: {
    imageRef: 'clerum/nginx-egress-proxy:0.1.0',
    remoteEndpoints: [{ url: 'https://mcp.sentry.io/sse' }],
  },
  recipe_meta: null,
  artifact_refs: null,
  downloads: 15,
  installs: 3,
  created_at: '2026-01-01T00:00:00Z',
}

describe('RegistryCatalog - remote entries', () => {
  it('test_registryCatalog_remoteEntry_displaysRemoteModeAndTransport', async () => {
    mockApiSuccess([MOCK_REMOTE_ENTRY], ['monitoring'])
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('sentry-mcp')).toBeInTheDocument()
    })

    expect(screen.getByText('remote / sse')).toBeInTheDocument()
  })

  it('test_registryCatalog_remoteEntry_hasInstallButton', async () => {
    mockApiSuccess([MOCK_REMOTE_ENTRY], ['monitoring'])
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('sentry-mcp')).toBeInTheDocument()
    })

    const row = screen.getByText('sentry-mcp').closest('tr')!
    const installBtn = row.querySelector('button')
    expect(installBtn).toBeTruthy()
    // Remote entries use the same standard blue install button as local entries;
    // the remote routing/egress behavior surfaces in the install modal, not in
    // a visually-distinct catalog button.
    expect(installBtn!.textContent).toMatch(/^Install$/)
    expect(installBtn!.className).toMatch(/cu-btn--primary/)
  })
})

describe('RegistryCatalog - mode filter', () => {
  it('test_registryCatalog_modeFilter_filtersToRemoteOnly', async () => {
    mockApiSuccess(
      [MOCK_MCP_ENTRY, MOCK_REMOTE_ENTRY, MOCK_RECIPE_ENTRY],
      ['search', 'monitoring', 'analytics']
    )
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    // All three entries visible initially
    expect(screen.getByText('sentry-mcp')).toBeInTheDocument()
    expect(screen.getByText('market-report')).toBeInTheDocument()

    // Find the mode filter (All Modes)
    const selects = screen.getAllByRole('combobox')
    const modeSelect = selects.find(s => {
      const options = Array.from(s.querySelectorAll('option'))
      return options.some(o => o.textContent === 'All Modes')
    })
    expect(modeSelect).toBeTruthy()

    // Filter to Remote
    fireEvent.change(modeSelect!, { target: { value: 'remote' } })

    await waitFor(() => {
      expect(screen.getByText('sentry-mcp')).toBeInTheDocument()
      expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
      expect(screen.queryByText('market-report')).not.toBeInTheDocument()
    })
  })

  it('test_registryCatalog_modeFilter_filtersToLocalOnly', async () => {
    mockApiSuccess([MOCK_MCP_ENTRY, MOCK_REMOTE_ENTRY], ['search', 'monitoring'])
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const selects = screen.getAllByRole('combobox')
    const modeSelect = selects.find(s => {
      const options = Array.from(s.querySelectorAll('option'))
      return options.some(o => o.textContent === 'All Modes')
    })
    expect(modeSelect).toBeTruthy()

    fireEvent.change(modeSelect!, { target: { value: 'local' } })

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
      expect(screen.queryByText('sentry-mcp')).not.toBeInTheDocument()
    })
  })

  it('test_registryCatalog_modeFilter_filtersToWorkflowOnly', async () => {
    mockApiSuccess([MOCK_MCP_ENTRY, MOCK_RECIPE_ENTRY], ['search', 'analytics'])
    render(<RegistryCatalog />)

    await waitFor(() => {
      expect(screen.getByText('brave-search')).toBeInTheDocument()
    })

    const selects = screen.getAllByRole('combobox')
    const modeSelect = selects.find(s => {
      const options = Array.from(s.querySelectorAll('option'))
      return options.some(o => o.textContent === 'All Modes')
    })
    expect(modeSelect).toBeTruthy()

    fireEvent.change(modeSelect!, { target: { value: 'workflow' } })

    await waitFor(() => {
      expect(screen.queryByText('brave-search')).not.toBeInTheDocument()
      expect(screen.getByText('market-report')).toBeInTheDocument()
    })
  })
})

describe('RegistryCatalog - developer row actions (Edit, Remove)', () => {
  it('test_registryCatalog_editButton_navigatesToEditRoute', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    const row = screen.getByText('brave-search').closest('tr')!
    const editButton = row.querySelector(
      'button[aria-label^="Edit Marketplace metadata for brave-search"]'
    ) as HTMLButtonElement
    expect(editButton).toBeTruthy()

    fireEvent.click(editButton)
    expect(mockPush).toHaveBeenCalledWith('/registry/entries/brave-search/1.0.0/edit')
  })

  it('test_registryCatalog_removeButton_opensConfirmModal', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    const row = screen.getByText('brave-search').closest('tr')!
    const removeButton = row.querySelector(
      'button[aria-label^="Remove brave-search v1.0.0"]'
    ) as HTMLButtonElement
    fireEvent.click(removeButton)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName(/Remove from Marketplace/i)
    expect(dialog.textContent).toContain('brave-search')
    expect(dialog.textContent).toContain('1.0.0')
  })

  it('test_registryCatalog_confirmRemove_callsDeleteAndShowsToast', async () => {
    mockApiSuccess()
    vi.mocked(api.deleteRegistryEntry).mockResolvedValue({ deleted: true })
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    const row = screen.getByText('brave-search').closest('tr')!
    fireEvent.click(
      row.querySelector('button[aria-label^="Remove brave-search v1.0.0"]') as HTMLButtonElement
    )

    const dialog = await screen.findByRole('dialog')
    const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(
      b => b.textContent?.trim() === 'Remove'
    ) as HTMLButtonElement
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(api.deleteRegistryEntry).toHaveBeenCalledWith('brave-search', '1.0.0')
    })
    // Reload triggers a fresh getRegistryCatalog call
    expect(api.getRegistryCatalog).toHaveBeenCalledTimes(2)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(
      screen.getByText(/Removed brave-search v1\.0\.0 from the Marketplace\./)
    ).toBeInTheDocument()
  })

  it('test_registryCatalog_cancelRemove_closesModalWithoutCallingDelete', async () => {
    mockApiSuccess()
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    const row = screen.getByText('brave-search').closest('tr')!
    fireEvent.click(
      row.querySelector('button[aria-label^="Remove brave-search v1.0.0"]') as HTMLButtonElement
    )

    const dialog = await screen.findByRole('dialog')
    const cancelBtn = Array.from(dialog.querySelectorAll('button')).find(
      b => b.textContent?.trim() === 'Cancel'
    ) as HTMLButtonElement
    fireEvent.click(cancelBtn)

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(api.deleteRegistryEntry).not.toHaveBeenCalled()
  })

  it('test_registryCatalog_removeApiError_showsErrorBannerInModal', async () => {
    mockApiSuccess()
    vi.mocked(api.deleteRegistryEntry).mockRejectedValue(
      new Error('500 - registry deleteVersion failed')
    )
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    const row = screen.getByText('brave-search').closest('tr')!
    fireEvent.click(
      row.querySelector('button[aria-label^="Remove brave-search v1.0.0"]') as HTMLButtonElement
    )
    const dialog = await screen.findByRole('dialog')
    const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(
      b => b.textContent?.trim() === 'Remove'
    ) as HTMLButtonElement
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(dialog.querySelector('[role="alert"]')?.textContent).toMatch(/registry deleteVersion/i)
    })
    // Modal stays open on error so the user can retry or cancel.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('RegistryCatalog - connect discoverability (Fix 1)', () => {
  it('self-hosted + disconnected → shows connect banner and header Connect button; both route to connect', async () => {
    mockApiSuccess()
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'disconnected' })
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    expect(
      screen.getByText(/This deployment isn't connected to a registry/i)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Connect to registry' }))
    expect(mockPush).toHaveBeenCalledWith('/registry/connect')

    mockPush.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(mockPush).toHaveBeenCalledWith('/registry/connect')
  })

  it('self-hosted + rejected → shows connect banner and header Connect button', async () => {
    mockApiSuccess()
    vi.mocked(api.getRegistryConnection).mockResolvedValue({ state: 'rejected' })
    render(<RegistryCatalog />)
    await waitFor(() => expect(screen.getByText('brave-search')).toBeInTheDocument())

    expect(
      screen.getByText(/This deployment isn't connected to a registry/i)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
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

    // The connection fetch resolves mode → managed, hiding the button.
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
    expect(mockPush).toHaveBeenCalledWith('/registry/connect')
  })
})
