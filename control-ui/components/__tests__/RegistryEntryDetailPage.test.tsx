import type React from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import RegistryEntryDetailPage from '../../app/registry/entries/[name]/[version]/page'
import { getRegistryCatalog, installRecipeFromRegistry } from '../../lib/api'
import type { RegistryEntry } from '../../lib/api'
import { ToastProvider } from '../Toast'

const navigationState = vi.hoisted(() => ({
  push: vi.fn(),
  params: { name: 'brave-search', version: '1.0.0' },
}))

vi.mock('next/navigation', () => ({
  useParams: () => navigationState.params,
  useRouter: () => ({ push: navigationState.push }),
}))

vi.mock('../../components/AuthContext', () => ({
  useAuth: () => ({
    authState: { isLoggedIn: true, isLoading: false },
    checkAuth: vi.fn(),
  }),
}))

vi.mock('../../components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../lib/api', () => ({
  deleteRegistryEntry: vi.fn(),
  getRegistryCatalog: vi.fn(),
  installRecipeFromRegistry: vi.fn(),
}))
// The detail page gates edit/remove on capability (§5.4). Default to a curator
// so the actions menu stays visible for the existing management assertions.
vi.mock('../../lib/hooks/useRegistryCapability', () => ({
  useRegistryCapability: () => ({
    capability: {
      orgName: 'acme',
      scope: '@acme',
      isCurator: true,
      mode: 'managed',
      authEnabled: true,
      connectionState: null,
      canManageOrg: true,
    },
    loading: false,
    error: false,
    reload: () => {},
  }),
}))

const mockGetRegistryCatalog = vi.mocked(getRegistryCatalog)
const mockInstallRecipeFromRegistry = vi.mocked(installRecipeFromRegistry)

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

const RECIPE_ENTRY: RegistryEntry = {
  id: 'recipe-1',
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

afterEach(() => {
  cleanup()
  navigationState.push.mockClear()
  navigationState.params = { name: 'brave-search', version: '1.0.0' }
  vi.clearAllMocks()
})

describe('RegistryEntryDetailPage', () => {
  it('shows the marketplace detail skeleton while loading an entry after navigation', () => {
    mockGetRegistryCatalog.mockReturnValue(new Promise<never>(() => {}))

    const { container } = render(<RegistryEntryDetailPage />)

    expect(screen.getByRole('status', { name: 'Loading Marketplace entry' })).toBeInTheDocument()
    expect(screen.queryByText('Loading entry...')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.cu-skeleton').length).toBeGreaterThan(0)
  })

  it('installs a plugin directly from the marketplace detail action', async () => {
    navigationState.params = { name: 'market-report', version: '1.0.0' }
    mockGetRegistryCatalog.mockResolvedValueOnce({
      data: [RECIPE_ENTRY],
      meta: { total: 1 },
      categories: ['analytics'],
      installed: { catalogKeys: [], serverNames: [], recipeKeys: [] },
    })
    mockInstallRecipeFromRegistry.mockResolvedValueOnce({
      recipeName: 'market-report',
      registryEntry: 'market-report',
      registryVersion: '1.0.0',
      correlationId: 'corr-1',
    })

    render(<RegistryEntryDetailPage />)

    const installButton = await screen.findByRole('button', { name: 'Install' })
    fireEvent.click(installButton)

    await waitFor(() => expect(mockInstallRecipeFromRegistry).toHaveBeenCalledTimes(1))
    expect(mockInstallRecipeFromRegistry).toHaveBeenCalledWith({
      registryEntryName: 'market-report',
      registryEntryVersion: '1.0.0',
      recipeManifest: RECIPE_ENTRY.recipe_meta?.recipeYaml,
    })
    expect(navigationState.push).toHaveBeenCalledWith(
      '/plugins/sandbox-recipes/market-report/workloads'
    )
  })
})
