// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { AccessCatalog } from '../../../../../src/types'
import { useAgentsDataController } from '../useAgentsDataController'

function catalog(agentNames: string[]): AccessCatalog {
  return {
    agentNames,
    userAgentNames: agentNames,
    teamAgentNames: [],
    mcpServerNames: [],
    contextNames: [],
    mcpServersByAgent: {},
    agentContextByName: {},
    agentProviderByName: {},
  }
}

describe('useAgentsDataController', () => {
  it('reports a failed initial catalog load so startup can retry the session identity', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useAgentsDataController(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })

    let firstResult = true
    await act(async () => {
      firstResult = await result.current.refreshWithCatalog(
        Promise.reject(new Error('catalog unavailable'))
      )
    })
    expect(firstResult).toBe(false)

    let retryResult = false
    await act(async () => {
      retryResult = await result.current.refreshWithCatalog(Promise.resolve(catalog(['agent-x'])))
    })
    expect(retryResult).toBe(true)
    expect(result.current.agentNames).toEqual(['agent-x'])
  })
})
