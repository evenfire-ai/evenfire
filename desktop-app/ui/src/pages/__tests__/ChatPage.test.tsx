// @vitest-environment jsdom
import { createRef, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentActivityContext } from '@contexts/AgentActivityContext'
import type { AgentActivityContextValue } from '@contexts/AgentActivityContext'
import { NavigationContext } from '@contexts/NavigationContext'
import type { NavigationContextValue } from '@contexts/NavigationContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type { AccessCatalog } from '../../../../src/types'
import { ChatPage } from '../ChatPage'

const workspaceMounts = vi.hoisted(() => ({ count: 0 }))

vi.mock('@components/agents/AgentWorkspace', () => ({
  AgentWorkspace: function AgentWorkspaceStub() {
    useEffect(() => {
      workspaceMounts.count += 1
    }, [])
    return <div data-testid="agent-workspace-stub" />
  },
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

function deferredCatalog() {
  let resolve!: (catalog: AccessCatalog) => void
  const promise = new Promise<AccessCatalog>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function renderChatPage(queryClient: QueryClient, selectedAgent: string | null) {
  const navigation = {
    selectedAgent,
    handleSelectChatAgent: vi.fn(),
  } as unknown as NavigationContextValue
  const activity = { agentLastActiveByAgent: {} } as unknown as AgentActivityContextValue
  return render(
    <QueryClientProvider client={queryClient}>
      <NavigationContext.Provider value={navigation}>
        <AgentActivityContext.Provider value={activity}>
          <ChatPage scrollContainerRef={createRef<HTMLElement>()} />
        </AgentActivityContext.Provider>
      </NavigationContext.Provider>
    </QueryClientProvider>
  )
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function startCatalogFetch(queryClient: QueryClient) {
  const catalog = deferredCatalog()
  const fetching = queryClient.fetchQuery({
    queryKey: desktopQueryKeys.accessCatalog,
    queryFn: () => catalog.promise,
    staleTime: 0,
  })
  return { catalog, fetching }
}

afterEach(() => {
  cleanup()
  workspaceMounts.count = 0
})

describe('ChatPage with an empty or loading catalog', () => {
  it('C1: shows the workspace for a selected agent when the catalog is empty', () => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(desktopQueryKeys.accessCatalog, emptyCatalog())

    renderChatPage(queryClient, 'agent-x')

    expect(screen.getByTestId('agent-workspace-stub')).toBeTruthy()
  })

  it('C2: shows the empty state when the catalog is empty and nothing is selected', () => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(desktopQueryKeys.accessCatalog, emptyCatalog())

    renderChatPage(queryClient, null)

    expect(screen.getByText('No agents available')).toBeTruthy()
    expect(
      screen.getByText('You do not currently have authorized agents in this team.')
    ).toBeTruthy()
  })

  it('C3: shows the workspace for a selected agent while the first catalog is fetching', async () => {
    const queryClient = newQueryClient()
    const { catalog, fetching } = startCatalogFetch(queryClient)

    const { container } = renderChatPage(queryClient, 'agent-x')

    expect(queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.fetchStatus).toBe('fetching')
    expect(screen.getByTestId('agent-workspace-stub')).toBeTruthy()
    expect(container.querySelector('.chat-page-skeleton')).toBeNull()
    catalog.resolve(emptyCatalog())
    await act(async () => {
      await fetching
    })
  })

  it('C4: shows the skeleton while the first catalog is fetching and nothing is selected', async () => {
    const queryClient = newQueryClient()
    const { catalog, fetching } = startCatalogFetch(queryClient)

    const { container } = renderChatPage(queryClient, null)

    expect(container.querySelector('.chat-page-skeleton')).not.toBeNull()
    catalog.resolve(emptyCatalog())
    await act(async () => {
      await fetching
    })
  })

  it('C5: does not remount the workspace while an empty catalog refreshes', async () => {
    const queryClient = newQueryClient()
    queryClient.setQueryData(desktopQueryKeys.accessCatalog, emptyCatalog())
    renderChatPage(queryClient, 'agent-x')
    expect(workspaceMounts.count).toBe(1)

    const catalog = deferredCatalog()
    let fetching!: Promise<AccessCatalog>
    act(() => {
      fetching = queryClient.fetchQuery({
        queryKey: desktopQueryKeys.accessCatalog,
        queryFn: () => catalog.promise,
        staleTime: 0,
      })
    })
    await waitFor(() =>
      expect(queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.fetchStatus).toBe(
        'fetching'
      )
    )
    expect(screen.getByTestId('agent-workspace-stub')).toBeTruthy()
    expect(workspaceMounts.count).toBe(1)

    await act(async () => {
      catalog.resolve(emptyCatalog())
      await fetching
    })
    expect(queryClient.getQueryState(desktopQueryKeys.accessCatalog)?.fetchStatus).toBe('idle')
    expect(screen.getByTestId('agent-workspace-stub')).toBeTruthy()
    expect(workspaceMounts.count).toBe(1)
  })
})
