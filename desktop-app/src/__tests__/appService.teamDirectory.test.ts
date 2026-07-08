import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

describe('AppService team directory loading', () => {
  it('uses the readonly initial directory endpoint without switching teams', async () => {
    const payload = {
      currentTeamId: 'team-1',
      items: [
        {
          team: { id: 'team-1', name: 'Alpha', role: 'member' as const },
          members: [],
          contextIds: ['ctx-a'],
          agentNames: ['agent-a'],
        },
      ],
    }
    const service = new AppService() as unknown as {
      sessionToken: string | null
      authClient: {
        getInitialTeamDirectory: ReturnType<typeof vi.fn>
        switchTeam: ReturnType<typeof vi.fn>
      }
      getInitialTeamsDirectory: () => Promise<unknown>
    }
    service.sessionToken = 'session-token'
    service.authClient = {
      getInitialTeamDirectory: vi.fn().mockResolvedValue(payload),
      switchTeam: vi.fn(),
    } as never

    await expect(service.getInitialTeamsDirectory()).resolves.toEqual(payload)

    expect(service.authClient.getInitialTeamDirectory).toHaveBeenCalledWith('session-token')
    expect(service.authClient.switchTeam).not.toHaveBeenCalled()
  })

  it('clears workflow team mappings when workflow listing falls back without teams', async () => {
    const service = new AppService() as unknown as {
      sessionToken: string | null
      workflowTeamByKey: Map<string, string>
      authClient: {
        listTeams: ReturnType<typeof vi.fn>
        listWorkflows: ReturnType<typeof vi.fn>
      }
      listWorkflows: () => Promise<unknown>
    }
    service.sessionToken = 'session-token'
    service.workflowTeamByKey.set('sandbox-recipes/stale', 'team-old')
    service.authClient = {
      listTeams: vi.fn().mockResolvedValue({ currentTeamId: null, items: [] }),
      listWorkflows: vi.fn().mockResolvedValue({ items: [], count: 0 }),
    } as never

    await expect(service.listWorkflows()).resolves.toEqual({ items: [], count: 0 })

    expect(service.workflowTeamByKey.size).toBe(0)
    expect(service.authClient.listWorkflows).toHaveBeenCalledWith('session-token')
  })

  it('clears workflow team mappings when team-scoped workflow listing falls back on failure', async () => {
    const service = new AppService() as unknown as {
      sessionToken: string | null
      workflowTeamByKey: Map<string, string>
      authClient: {
        listTeams: ReturnType<typeof vi.fn>
        listWorkflows: ReturnType<typeof vi.fn>
      }
      listWorkflows: () => Promise<unknown>
    }
    service.sessionToken = 'session-token'
    service.workflowTeamByKey.set('sandbox-recipes/stale', 'team-old')
    service.authClient = {
      listTeams: vi.fn().mockRejectedValue(new Error('team directory unavailable')),
      listWorkflows: vi.fn().mockResolvedValue({ items: [], count: 0 }),
    } as never

    await expect(service.listWorkflows()).resolves.toEqual({ items: [], count: 0 })

    expect(service.workflowTeamByKey.size).toBe(0)
    expect(service.authClient.listWorkflows).toHaveBeenCalledWith('session-token')
  })

  it('refreshes the access catalog instead of returning the main-process cache', async () => {
    const service = new AppService() as unknown as {
      sessionToken: string | null
      me: { id: string; teamId: string | null } | null
      accessCatalog: unknown
      authClient: {
        getMyContexts: ReturnType<typeof vi.fn>
        getMyAgents: ReturnType<typeof vi.fn>
        getTeamContexts: ReturnType<typeof vi.fn>
        getTeamAgents: ReturnType<typeof vi.fn>
      }
      getAccessCatalog: () => Promise<{ agentNames: string[] }>
    }
    service.sessionToken = 'session-token'
    service.me = { id: 'user-1', teamId: 'team-1' }
    service.accessCatalog = { userId: 'user-1', teamId: 'team-1', agentNames: ['stale-agent'] }
    service.authClient = {
      getMyContexts: vi.fn().mockResolvedValue({ userId: 'user-1', contextIds: [] }),
      getMyAgents: vi
        .fn()
        .mockResolvedValueOnce({
          userId: 'user-1',
          agentNames: ['fresh-agent'],
          agents: [{ name: 'fresh-agent', contextRef: 'ctx-a', mcpServers: [] }],
        })
        .mockResolvedValueOnce({
          userId: 'user-1',
          agentNames: ['newer-agent'],
          agents: [{ name: 'newer-agent', contextRef: 'ctx-b', mcpServers: [] }],
        }),
      getTeamContexts: vi.fn().mockResolvedValue({ teamId: 'team-1', contextIds: [] }),
      getTeamAgents: vi.fn().mockResolvedValue({ teamId: 'team-1', agentNames: [], agents: [] }),
    } as never

    await expect(service.getAccessCatalog()).resolves.toMatchObject({
      agentNames: ['fresh-agent'],
    })
    await expect(service.getAccessCatalog()).resolves.toMatchObject({
      agentNames: ['newer-agent'],
    })

    expect(service.authClient.getMyAgents).toHaveBeenCalledTimes(2)
  })

  it('skips team-scoped catalog calls when the session has no current team', async () => {
    const service = new AppService() as unknown as {
      sessionToken: string | null
      me: { id: string; teamId: string | null } | null
      authClient: {
        getMyContexts: ReturnType<typeof vi.fn>
        getMyAgents: ReturnType<typeof vi.fn>
        getTeamContexts: ReturnType<typeof vi.fn>
        getTeamAgents: ReturnType<typeof vi.fn>
      }
      getAccessCatalog: () => Promise<{
        teamId: string | null
        contextIds: string[]
        agentNames: string[]
        teamContextIds: string[]
        teamAgentNames: string[]
      }>
    }
    service.sessionToken = 'session-token'
    service.me = { id: 'user-1', teamId: null }
    service.authClient = {
      getMyContexts: vi.fn().mockResolvedValue({ userId: 'user-1', contextIds: ['ctx-user'] }),
      getMyAgents: vi.fn().mockResolvedValue({
        userId: 'user-1',
        agentNames: ['user-agent'],
        agents: [{ name: 'user-agent', contextRef: 'ctx-user', mcpServers: [] }],
      }),
      getTeamContexts: vi.fn(),
      getTeamAgents: vi.fn(),
    } as never

    await expect(service.getAccessCatalog()).resolves.toMatchObject({
      teamId: null,
      contextIds: ['ctx-user'],
      agentNames: ['user-agent'],
      teamContextIds: [],
      teamAgentNames: [],
    })

    expect(service.authClient.getTeamContexts).not.toHaveBeenCalled()
    expect(service.authClient.getTeamAgents).not.toHaveBeenCalled()
  })

  it('loads refreshed team directory data from the readonly endpoint', async () => {
    const payload = {
      currentTeamId: 'team-1',
      items: [
        {
          team: { id: 'team-1', name: 'Alpha', role: 'member' as const },
          members: [],
          contextIds: ['ctx-a'],
          agentNames: ['agent-a'],
        },
      ],
    }
    const service = new AppService() as unknown as {
      sessionToken: string | null
      authClient: {
        getInitialTeamDirectory: ReturnType<typeof vi.fn>
        switchTeam: ReturnType<typeof vi.fn>
      }
      getTeamsDirectory: () => Promise<unknown>
    }
    service.sessionToken = 'session-token'
    service.authClient = {
      getInitialTeamDirectory: vi.fn().mockResolvedValue(payload),
      switchTeam: vi.fn(),
    } as never

    await expect(service.getTeamsDirectory()).resolves.toEqual(payload)

    expect(service.authClient.getInitialTeamDirectory).toHaveBeenCalledWith('session-token')
    expect(service.authClient.switchTeam).not.toHaveBeenCalled()
  })

  it('uses active agent names returned by the access catalog without enrichment filtering', async () => {
    const service = new AppService() as unknown as {
      sessionToken: string | null
      me: { id: string; teamId: string | null } | null
      authClient: {
        getMyContexts: ReturnType<typeof vi.fn>
        getMyAgents: ReturnType<typeof vi.fn>
        getTeamContexts: ReturnType<typeof vi.fn>
        getTeamAgents: ReturnType<typeof vi.fn>
      }
      getAccessCatalog: () => Promise<{
        agentNames: string[]
        userAgentNames: string[]
        agentContextByName: Record<string, string | null>
      }>
    }
    service.sessionToken = 'session-token'
    service.me = { id: 'user-1', teamId: 'team-1' }
    service.authClient = {
      getMyContexts: vi.fn().mockResolvedValue({ userId: 'user-1', contextIds: [] }),
      getMyAgents: vi.fn().mockResolvedValue({
        userId: 'user-1',
        agentNames: ['chatllm', 'agent-without-details'],
        agents: [{ name: 'chatllm', contextRef: 'business', mcpServers: [] }],
      }),
      getTeamContexts: vi.fn().mockResolvedValue({ teamId: 'team-1', contextIds: [] }),
      getTeamAgents: vi.fn().mockResolvedValue({ teamId: 'team-1', agentNames: [], agents: [] }),
    } as never

    await expect(service.getAccessCatalog()).resolves.toMatchObject({
      agentNames: ['chatllm', 'agent-without-details'],
      userAgentNames: ['chatllm', 'agent-without-details'],
      agentContextByName: { chatllm: 'business', 'agent-without-details': null },
    })
  })

  it('does not probe host status while building the access catalog', async () => {
    const service = new AppService() as unknown as {
      sessionToken: string | null
      me: { id: string; teamId: string | null } | null
      authClient: {
        getMyContexts: ReturnType<typeof vi.fn>
        getMyAgents: ReturnType<typeof vi.fn>
        getTeamContexts: ReturnType<typeof vi.fn>
        getTeamAgents: ReturnType<typeof vi.fn>
        issueRpcToken: ReturnType<typeof vi.fn>
      }
      getAccessCatalog: () => Promise<{
        agentNames: string[]
        userAgentNames: string[]
        teamAgentNames: string[]
      }>
    }
    service.sessionToken = 'session-token'
    service.me = { id: 'user-1', teamId: 'team-1' }
    service.authClient = {
      getMyContexts: vi.fn().mockResolvedValue({ userId: 'user-1', contextIds: [] }),
      getMyAgents: vi.fn().mockResolvedValue({
        userId: 'user-1',
        agentNames: ['chatllm', 'rpc-down-agent'],
        agents: [
          { name: 'chatllm', contextRef: null, mcpServers: [] },
          { name: 'rpc-down-agent', contextRef: null, mcpServers: [] },
        ],
      }),
      getTeamContexts: vi.fn().mockResolvedValue({ teamId: 'team-1', contextIds: [] }),
      getTeamAgents: vi.fn().mockResolvedValue({
        teamId: 'team-1',
        agentNames: ['trader'],
        agents: [{ name: 'trader', contextRef: null, mcpServers: [] }],
      }),
      issueRpcToken: vi.fn(),
    } as never

    await expect(service.getAccessCatalog()).resolves.toMatchObject({
      agentNames: ['chatllm', 'rpc-down-agent', 'trader'],
      userAgentNames: ['chatllm', 'rpc-down-agent'],
      teamAgentNames: ['trader'],
    })
    expect(service.authClient.issueRpcToken).not.toHaveBeenCalled()
  })
})
