// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook } from '@testing-library/react'
import type { AccessCatalog } from '../../../../../src/types'
import { desktopQueryDefaults } from '../../../lib/queryClient'
import { desktopQueryKeys } from '../queryKeys'
import { useMcpServersDataController } from '../useMcpServersDataController'

// RP1004-P01a (#991): a present scoped key is authoritative even when empty;
// only an absent key (older wire) may fall back to the workspace-wide preview.

const AGENT_NAMES = ['agent-a', 'agent-b']

function catalogWith(overrides: Partial<AccessCatalog>): AccessCatalog {
  return {
    userId: 'user-1',
    teamId: null,
    userContextIds: ['ctx-a', 'ctx-b'],
    userAgentNames: AGENT_NAMES,
    teamContextIds: [],
    teamAgentNames: [],
    contextIds: ['ctx-a', 'ctx-b'],
    agentNames: AGENT_NAMES,
    mcpServersByAgent: { 'agent-a': [], 'agent-b': ['shared-x'] },
    agentContextByName: { 'agent-a': 'ctx-a', 'agent-b': 'ctx-b' },
    agentProviderByName: { 'agent-a': null, 'agent-b': null },
    agentDisplayByName: { 'agent-a': 'agent-a', 'agent-b': 'agent-b' },
    ...overrides,
  }
}

function renderController(
  catalog: AccessCatalog,
  params: { selectedAgent?: string; selectedContext?: string }
) {
  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  client.setQueryData(desktopQueryKeys.accessCatalog, catalog)
  // The workspace-wide preview still lists the server (agent-b keeps it).
  client.setQueryData(desktopQueryKeys.mcpServersPreview(AGENT_NAMES), [{ name: 'shared-x' }])
  return renderHook(() => useMcpServersDataController(params), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

describe('useMcpServersDataController — scoped connector mapping', () => {
  afterEach(() => cleanup())

  it('serves an explicit-empty agent mapping as zero connectors, not the preview', () => {
    const { result } = renderController(
      catalogWith({
        agentMcpServers: { 'agent-a': [], 'agent-b': [{ name: 'shared-x' }] },
        contextMcpServers: { 'ctx-a': [], 'ctx-b': [{ name: 'shared-x' }] },
      }),
      { selectedAgent: 'agent-a', selectedContext: 'ctx-a' }
    )

    expect(result.current.selectedAgentMcpServerMappingAvailable).toBe(true)
    expect(result.current.selectedAgentMcpServersUnscoped).toBe(false)
    expect(result.current.selectedAgentMcpServers).toEqual([])
    expect(result.current.agentMcpServerCountByAgent['agent-a']).toBe(0)
    expect(result.current.selectedContextMcpServerMappingAvailable).toBe(true)
    expect(result.current.selectedContextMcpServers).toEqual([])
  })

  it('falls back to the preview when the agent key is absent (older wire)', () => {
    const { result } = renderController(catalogWith({}), {
      selectedAgent: 'agent-a',
      selectedContext: 'ctx-a',
    })

    expect(result.current.selectedAgentMcpServerMappingAvailable).toBe(true)
    expect(result.current.selectedAgentMcpServersUnscoped).toBe(true)
    expect(result.current.selectedAgentMcpServers).toEqual([{ name: 'shared-x' }])
    expect(result.current.selectedContextMcpServersUnscoped).toBe(true)
    expect(result.current.selectedContextMcpServers).toEqual([{ name: 'shared-x' }])
  })
})
