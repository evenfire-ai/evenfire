// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QueryClient,
  QueryClientProvider,
  defaultScheduler,
  notifyManager,
} from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AUTO_REFRESH_POLL_INTERVAL_MS } from '@constants/autoRefresh'
import { desktopQueryDefaults } from '@lib/queryClient'
import { AppService } from '../../../../../src/appService'
import { __setChatStoreBaseDirForTests } from '../../../../../src/chatStoreBinding'
import type { AccessCatalog, RpcConnectorsResult } from '../../../../../src/types'
import { AgentWorkspace } from '../AgentWorkspace'

// RP1004-P01a (#991): detaching the LAST connector from agent A while agent B
// keeps it must drop A's row on the next automatic poll. The catalogs come from
// the real AppService.refreshAccessCatalog (auth-client fixtures), and the real
// data controllers, scheduler and AgentWorkspace consume them; only the
// window.clerum IPC bridge and the client-UI-state contexts are stubbed.

const navMock = vi.hoisted(() => ({
  selectedAgent: 'agent-a' as string | null,
}))

vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({ me: null }),
}))
vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    selectedAgent: navMock.selectedAgent,
    selectedAgentRoute: 'mcp-servers',
    handleBackToAgents: vi.fn(),
    handleOpenAgentWorkspace: vi.fn(),
    handleSelectChatAgent: vi.fn(),
  }),
}))
vi.mock('@contexts/ChatListContext', () => ({
  useChatListContext: () => ({ sessionStateByChatId: {}, activeChatId: null }),
}))
vi.mock('@contexts/McpRuntimeContext', () => ({
  useMcpRuntimeContext: () => ({ hostRuntimeStatus: null }),
}))
vi.mock('@contexts/AgentChatActionsContext', () => ({
  useAgentChatActionsContext: () => ({ scrollChatToBottom: vi.fn() }),
}))
vi.mock('@hooks/useClickOutside', () => ({ useClickOutside: vi.fn() }))
vi.mock('../ComposerPanel', () => ({ ComposerPanel: () => null }))
vi.mock('../ChatThread', () => ({ ChatThread: () => null }))

const ME = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'test@clerum.io',
  name: 'Test User',
  picture: null,
  teamId: '00000000-0000-4000-8000-0000000000aa',
  teamName: 'Test Team',
  role: 'member',
}

const SHARED_SERVER = 'shared-x'
const ROW_TEST_ID = `mcp-health-row-${SHARED_SERVER}`

type WireAgent = { name: string; contextRef: string; mcpServers: Array<{ name: string }> }

// One real producer run over the given /me/agents response.
async function produceCatalog(agents: WireAgent[]): Promise<AccessCatalog> {
  const service = new AppService() as any
  service.sessionToken = 'fake-session-token'
  service.me = ME
  service.rpcTokenManager = { clear: vi.fn() }
  service.authClient = {
    getMe: vi.fn().mockResolvedValue(ME),
    getMyContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
    getMyAgents: vi.fn().mockResolvedValue({
      agentNames: agents.map(agent => agent.name),
      agents,
    }),
    getTeamContexts: vi.fn().mockResolvedValue({ teamId: ME.teamId, contextIds: [] }),
    getTeamAgents: vi.fn().mockResolvedValue({ teamId: ME.teamId, agentNames: [], agents: [] }),
  }
  return service.refreshAccessCatalog()
}

function connectorsFor(agentsWithServer: string[]): RpcConnectorsResult {
  return {
    userId: ME.id,
    agents: ['agent-a', 'agent-b'].map(name => ({
      name,
      contextRef: name === 'agent-a' ? 'ctx-a' : 'ctx-b',
      connectors: agentsWithServer.includes(name)
        ? [
            {
              name: SHARED_SERVER,
              provider: 'shared',
              authKind: 'oauth-user' as const,
              grantScope: 'user' as const,
              status: 'requires_setup' as const,
            },
          ]
        : [],
    })),
  }
}

describe('AgentWorkspace — last connector detached from one agent (#991)', () => {
  let chatStoreBaseDir: string
  let bothAttached: AccessCatalog
  let detachedFromA: AccessCatalog

  beforeEach(async () => {
    chatStoreBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-last-detach-'))
    __setChatStoreBaseDirForTests(chatStoreBaseDir)
    bothAttached = await produceCatalog([
      { name: 'agent-a', contextRef: 'ctx-a', mcpServers: [{ name: SHARED_SERVER }] },
      { name: 'agent-b', contextRef: 'ctx-b', mcpServers: [{ name: SHARED_SERVER }] },
    ])
    detachedFromA = await produceCatalog([
      { name: 'agent-a', contextRef: 'ctx-a', mcpServers: [] },
      { name: 'agent-b', contextRef: 'ctx-b', mcpServers: [{ name: SHARED_SERVER }] },
    ])
    // Query observers are notified through a zero-delay timeout that the fake
    // clock below does not flush; deliver them as microtasks instead so the
    // poll's cache write reaches the panel inside `act`.
    notifyManager.setScheduler(queueMicrotask)
  })

  afterEach(async () => {
    cleanup()
    vi.useRealTimers()
    notifyManager.setScheduler(defaultScheduler)
    navMock.selectedAgent = 'agent-a'
    delete (window as { clerum?: unknown }).clerum
    __setChatStoreBaseDirForTests(null)
    await fs.rm(chatStoreBaseDir, { recursive: true, force: true })
  })

  it('drops the row from agent A on the next poll while agent B keeps it', async () => {
    let catalog = bothAttached
    let connectors = connectorsFor(['agent-a', 'agent-b'])
    const refreshCatalog = vi.fn(async () => catalog)
    ;(window as { clerum?: unknown }).clerum = {
      access: { refreshCatalog },
      rpc: {
        // The workspace-wide preview still lists the server (B keeps it).
        listServers: vi.fn(async () => ({
          userId: ME.id,
          contextIds: [],
          servers: [{ name: SHARED_SERVER }],
        })),
        listConnectors: vi.fn(async () => connectors),
      },
      team: {
        directory: vi.fn(async () => ({ items: [] })),
        initialDirectory: vi.fn(async () => ({ items: [] })),
      },
    }

    vi.useFakeTimers()
    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const ui = () => (
      <QueryClientProvider client={queryClient}>
        <AgentWorkspace scrollContainerRef={{ current: null }} />
      </QueryClientProvider>
    )
    const view = render(ui())

    // Opening the panel with an empty cache runs the first refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(refreshCatalog).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId(ROW_TEST_ID)).toBeTruthy()

    // An admin removes the server from A only; no click, just the poll.
    catalog = detachedFromA
    connectors = connectorsFor(['agent-b'])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_POLL_INTERVAL_MS)
    })
    expect(refreshCatalog).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId(ROW_TEST_ID)).toBeNull()

    // B keeps its legitimate row.
    navMock.selectedAgent = 'agent-b'
    view.rerender(ui())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByTestId(ROW_TEST_ID)).toBeTruthy()
  })
})
