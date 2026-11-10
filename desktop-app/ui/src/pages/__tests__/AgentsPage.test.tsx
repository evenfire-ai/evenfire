// @vitest-environment jsdom
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext } from '@contexts/NavigationContext'
import type { NavigationContextValue } from '@contexts/NavigationContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { AccessCatalog } from '../../../../src/types'
import { AgentsPage } from '../AgentsPage'

vi.mock('../../components/agents/AgentWorkspace', () => ({
  AgentWorkspace: () => <div data-testid="agent-workspace-stub" />,
}))
vi.mock('../../components/agents/FleetBoard', () => ({
  FleetBoard: () => <div data-testid="fleet-board-stub" />,
}))

function emptyCatalog(): AccessCatalog {
  return {
    userId: 'user-1',
    teamId: 'team-1',
    userContextIds: [],
    userAgentNames: [],
    teamContextIds: [],
    teamAgentNames: [],
    contextIds: [],
    agentNames: [],
    mcpServersByAgent: {},
    agentContextByName: {},
    agentProviderByName: {},
    agentDisplayByName: {},
  }
}

function renderAgentsPage(queryClient: QueryClient, selectedAgent: string | null) {
  const navigation = { selectedAgent } as unknown as NavigationContextValue
  return render(
    <QueryClientProvider client={queryClient}>
      <NavigationContext.Provider value={navigation}>
        <AgentsPage scrollContainerRef={createRef<HTMLElement>()} />
      </NavigationContext.Provider>
    </QueryClientProvider>
  )
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function startCatalogFetch(queryClient: QueryClient) {
  let resolve!: (catalog: AccessCatalog) => void
  const promise = new Promise<AccessCatalog>(res => {
    resolve = res
  })
  const fetching = queryClient.fetchQuery({
    queryKey: desktopQueryKeys.accessCatalog,
    queryFn: () => promise,
    staleTime: 0,
  })
  return {
    finish: async () => {
      resolve(emptyCatalog())
      await act(async () => {
        await fetching
      })
    },
  }
}

afterEach(() => {
  cleanup()
})

describe('AgentsPage with an empty or loading catalog', () => {
  it('C1: shows the workspace for a selected agent when the catalog is empty', () => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(desktopQueryKeys.accessCatalog, emptyCatalog())

    renderAgentsPage(queryClient, 'agent-x')

    expect(screen.getByTestId('agent-workspace-stub')).toBeTruthy()
  })

  it('C2: shows the empty state when the catalog is empty and nothing is selected', () => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(desktopQueryKeys.accessCatalog, emptyCatalog())

    renderAgentsPage(queryClient, null)

    expect(screen.getByText('No agents available')).toBeTruthy()
    expect(screen.getByText('You do not currently have authorized agents.')).toBeTruthy()
  })

  it('C3: shows the workspace for a selected agent while the first catalog is fetching', async () => {
    const queryClient = newQueryClient()
    const { finish } = startCatalogFetch(queryClient)

    renderAgentsPage(queryClient, 'agent-x')

    expect(queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.fetchStatus).toBe('fetching')
    expect(screen.getByTestId('agent-workspace-stub')).toBeTruthy()
    await finish()
  })

  it('C4: shows the loading state while the first catalog is fetching and nothing is selected', async () => {
    const queryClient = newQueryClient()
    const { finish } = startCatalogFetch(queryClient)

    renderAgentsPage(queryClient, null)

    expect(screen.getByText('Fetching authorized agents...')).toBeTruthy()
    await finish()
  })
})
