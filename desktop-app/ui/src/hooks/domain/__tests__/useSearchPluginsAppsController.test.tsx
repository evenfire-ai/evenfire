// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { SandboxUiApp, WorkflowRecipeResource } from '../../../../../src/types'
import { useSearchPluginsAppsController } from '../useSearchPluginsAppsController'

const WORKFLOW_RESOURCE: WorkflowRecipeResource = {
  metadata: {
    namespace: 'sandbox-recipes',
    name: 'inbox-triage',
    creationTimestamp: '2026-08-01T00:00:00Z',
  },
  spec: { triggers: { onDemand: { allowedActors: ['user'] } } },
  status: { phase: 'Active' },
}

const APP: SandboxUiApp = {
  appRef: 'sandbox-recipes/review-board',
  title: 'Review Board',
  description: 'Approve requests fast',
  defaultPath: '/',
  ready: true,
  phase: 'active',
  updatedAt: '2026-08-01T00:00:00Z',
}

function installClerumHarness(
  options: { workflows?: Promise<unknown>; apps?: Promise<unknown> } = {}
) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      workflows: {
        list: vi.fn(
          () => options.workflows ?? Promise.resolve({ items: [WORKFLOW_RESOURCE], count: 1 })
        ),
      },
      sandboxUi: {
        listApps: vi.fn(() => options.apps ?? Promise.resolve({ apps: [APP] })),
      },
    },
  })
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

describe('useSearchPluginsAppsController', () => {
  afterEach(() => {
    delete (window as { clerum?: unknown }).clerum
  })

  it('loads summarized plugins and raw apps through ensureLoaded', async () => {
    installClerumHarness()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useSearchPluginsAppsController(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.ensureLoaded()
    })

    await waitFor(() => expect(result.current.plugins).toHaveLength(1))
    expect(result.current.plugins).toEqual([
      {
        namespace: 'sandbox-recipes',
        name: 'inbox-triage',
        status: 'Active',
        createdAt: '2026-08-01T00:00:00Z',
        triggerableByUser: true,
      },
    ])
    expect(result.current.apps).toEqual([APP])
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('keeps apps available when the workflow list fails and surfaces the error', async () => {
    installClerumHarness({
      workflows: Promise.reject(new Error('workflows unavailable')),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useSearchPluginsAppsController(), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.ensureLoaded()
    })

    await waitFor(() => expect(result.current.error).toBe('workflows unavailable'))
    expect(result.current.plugins).toEqual([])
    expect(result.current.apps).toEqual([APP])
  })
})
