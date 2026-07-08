import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import RegistryInstallPage from '../../app/registry/install/page'
import { getRegistryEntryVersion, installRecipeFromRegistry } from '../../lib/api'
import type { RegistryEntry } from '../../lib/api'
import { ToastProvider } from '../Toast'

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams('entry=market-report&version=1.0.0'),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getRegistryEntryVersion: vi.fn(),
    installRecipeFromRegistry: vi.fn(),
  }
})

const RECIPE_ENTRY: RegistryEntry = {
  id: 'recipe-1',
  name: 'market-report',
  version: '1.0.0',
  entry_type: 'recipe',
  description: 'Market report workflow',
  author: 'clerum',
  origin: 'official',
  category: 'workflow',
  tags: ['research'],
  trust_level: 'high',
  quality_tier: 'verified',
  status: 'published',
  server_mode: null,
  transport: null,
  recipe_type: 'workflow',
  mcp_server_meta: null,
  recipe_meta: {
    recipeYaml: JSON.stringify(
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'WorkflowRecipe',
        metadata: { name: 'market-report' },
        spec: {
          triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
          workloads: [
            {
              id: 'web-search',
              type: 'deployment',
              image: 'clerum/web-search:test',
              port: 3000,
              transport: { type: 'streamableHttp', path: '/mcp' },
            },
          ],
          steps: [
            {
              id: 'research',
              run: { type: 'snippet', language: 'typescript', code: 'return { ok: true }' },
            },
          ],
        },
      },
      null,
      2
    ),
  },
  artifact_refs: null,
  downloads: 0,
  installs: 0,
  created_at: '2026-05-19T00:00:00Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

describe('RegistryInstallPage — WorkflowRecipe preview egress editor', () => {
  it('edits recipe workload egress before installing from registry', async () => {
    vi.mocked(getRegistryEntryVersion).mockResolvedValueOnce(RECIPE_ENTRY)
    vi.mocked(installRecipeFromRegistry).mockResolvedValueOnce({
      recipeName: 'recipe-market-report',
      registryEntry: 'market-report',
      registryVersion: '1.0.0',
      correlationId: 'corr-1',
    })

    render(<RegistryInstallPage />)

    expect(await screen.findByRole('heading', { name: 'Marketplace recipe' })).toBeInTheDocument()
    expect(
      screen.getByText('Review the recipe package and manifest before installation.')
    ).toBeInTheDocument()
    expect(screen.queryByText('Install Plugin from Marketplace')).not.toBeInTheDocument()
    expect(screen.queryByText('Step 1 of 3')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('External Egress Editor')).toBeInTheDocument()
    expect(screen.getAllByText('Transport workload "web-search"').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByDisplayValue('No external egress (closed by default)'), {
      target: { value: 'exact-host' },
    })
    fireEvent.change(screen.getByPlaceholderText('api.example.com, auth.example.com'), {
      target: { value: 'duckduckgo.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('443'), { target: { value: '443' } })
    await waitFor(() =>
      expect(screen.getByText(/1 domain\(s\) x 1 port\(s\) = 1 binding/)).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install plugin' }))

    await waitFor(() => expect(installRecipeFromRegistry).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(installRecipeFromRegistry).mock.calls[0][0]
    expect(payload.registryEntryName).toBe('market-report')
    expect(payload.registryEntryVersion).toBe('1.0.0')
    expect(payload.recipeManifest).toContain('"egressBindings"')
    expect(payload.recipeManifest).toContain('"duckduckgo.com"')
    expect(mockPush).toHaveBeenCalledWith('/workflow-recipes/sandbox-recipes/recipe-market-report')
  })

  it('blocks registry recipe install when edited egress exceeds CRD cardinality', async () => {
    vi.mocked(getRegistryEntryVersion).mockResolvedValueOnce(RECIPE_ENTRY)
    render(<RegistryInstallPage />)

    expect(await screen.findByRole('heading', { name: 'Marketplace recipe' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('External Egress Editor')).toBeInTheDocument()
    fireEvent.change(screen.getByDisplayValue('No external egress (closed by default)'), {
      target: { value: 'exact-host' },
    })
    fireEvent.change(screen.getByPlaceholderText('api.example.com, auth.example.com'), {
      target: {
        value: Array.from({ length: 21 }, (_, i) => `host-${i}.example.com`).join(', '),
      },
    })
    fireEvent.change(screen.getByPlaceholderText('443'), { target: { value: '443' } })

    await waitFor(() => expect(screen.getAllByText(/CRD maximum is 20/).length).toBeGreaterThan(0))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    expect(installRecipeFromRegistry).not.toHaveBeenCalled()
  })
})
