import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import { __setChatStoreBaseDirForTests } from '../chatStoreBinding.js'
import { ApiError } from '../httpClient.js'

describe('AppService.invokeHostMessage', () => {
  let chatStoreBaseDir: string

  beforeEach(async () => {
    chatStoreBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-app-service-rpc-'))
    __setChatStoreBaseDirForTests(chatStoreBaseDir)
  })

  afterEach(async () => {
    __setChatStoreBaseDirForTests(null)
    await fs.rm(chatStoreBaseDir, { recursive: true, force: true })
  })

  it('forces desktop host messages onto the authenticated rpc envelope', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    service.me = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: '00000000-0000-4000-8000-0000000000aa',
      teamName: 'Test Team',
      role: 'member',
    }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-token' }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      invokeHostMessage: vi.fn().mockResolvedValue({ success: true, response: 'ok' }),
    }

    await service.invokeHostMessage(
      'chatllm',
      {
        content: 'What workflow recipes can I trigger and what inputs do they require?',
        channelType: 'slack',
        channelId: 'attacker-channel',
        hostRef: 'attacker-host',
        sender: 'attacker-controlled-user',
        metadata: {
          teamId: 'attacker-controlled-team',
          targetUserId: '00000000-0000-4000-8000-000000000999',
          outputOverrides: { path: '/tmp/untrusted' },
        },
        targetUserId: '00000000-0000-4000-8000-000000000999',
        outputOverrides: { path: '/tmp/untrusted' },
      },
      ['chatllm'],
      { async: true }
    )

    expect(service.rpcClient.invokeHostMessage).toHaveBeenCalledTimes(1)
    const forwarded = service.rpcClient.invokeHostMessage.mock.calls[0][2]
    expect(forwarded).toEqual({
      content: 'What workflow recipes can I trigger and what inputs do they require?',
      channelType: 'rpc',
      channelId: 'chatllm',
      hostRef: 'chatllm',
      sender: '00000000-0000-4000-8000-000000000001',
      metadata: { teamId: '00000000-0000-4000-8000-0000000000aa' },
      threadId: undefined,
      attachments: undefined,
    })
    expect(service.rpcClient.invokeHostMessage.mock.calls[0][3]).toEqual({ async: true })
  })

  it('switches to a matching directory team before issuing RPC tokens for teamless sessions', async () => {
    const service = new AppService() as any
    service.desktopGfsUploadStatePath = vi
      .fn()
      .mockResolvedValue(path.join(chatStoreBaseDir, 'gfs-upload-state.json'))
    service.sessionToken = 'teamless-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: null,
      teamName: null,
      role: 'member',
    }
    const teamMe = {
      ...service.me,
      teamId: 'team-1',
      teamName: 'Team One',
    }
    service.accessCatalog = {
      userId: 'user-1',
      teamId: null,
      userContextIds: [],
      userAgentNames: ['pro-agent'],
      teamContextIds: [],
      teamAgentNames: [],
      contextIds: [],
      agentNames: ['pro-agent'],
      mcpServersByAgent: { 'pro-agent': [] },
      agentContextByName: { 'pro-agent': null },
    }
    service.teamDirectoryCache = {
      currentTeamId: 'team-1',
      items: [
        {
          team: { id: 'team-1', name: 'Team One', role: 'member' },
          members: [],
          contextIds: [],
          agentNames: ['pro-agent'],
        },
      ],
    }
    service.authClient = {
      getMe: vi.fn().mockResolvedValueOnce(service.me).mockResolvedValueOnce(teamMe),
      switchTeam: vi.fn().mockResolvedValue({
        token: 'team-token',
        team: { id: 'team-1', name: 'Team One', role: 'member' },
      }),
    }
    service.tokenStore = {
      setSessionToken: vi.fn(),
    }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-token' }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      invokeHostMessage: vi.fn().mockResolvedValue({ success: true, response: 'ok' }),
    }

    await expect(
      service.invokeHostMessage('pro-agent', { content: 'hello' }, ['pro-agent'])
    ).resolves.toEqual({ success: true, response: 'ok' })

    expect(service.authClient.switchTeam).toHaveBeenCalledWith('teamless-token', 'team-1')
    expect(service.rpcTokenManager.getOrIssue).toHaveBeenCalledWith(
      'team-token',
      ['host:message:invoke', 'host:task:read', 'host:wake:write'],
      ['pro-agent']
    )
  })

  it('uses the teamless session when a directly granted agent needs an RPC token', async () => {
    const service = new AppService() as any
    service.sessionToken = 'teamless-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: null,
      teamName: null,
      role: 'member',
    }
    service.accessCatalog = {
      userId: 'user-1',
      teamId: null,
      userContextIds: [],
      userAgentNames: ['pro-agent'],
      teamContextIds: [],
      teamAgentNames: [],
      contextIds: [],
      agentNames: ['pro-agent'],
      mcpServersByAgent: { 'pro-agent': [] },
      agentContextByName: { 'pro-agent': null },
    }
    service.authClient = {
      getMe: vi.fn().mockResolvedValue(service.me),
    }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({
        token: 'user-rpc-token',
        accessScope: 'user',
        teamId: null,
      }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      invokeHostMessage: vi.fn().mockResolvedValue({ success: true, response: 'ok' }),
    }

    await expect(
      service.invokeHostMessage('pro-agent', { content: 'hello' }, ['pro-agent'])
    ).resolves.toEqual({ success: true, response: 'ok' })
    expect(service.rpcTokenManager.getOrIssue).toHaveBeenCalledWith(
      'teamless-token',
      ['host:message:invoke', 'host:task:read', 'host:wake:write'],
      ['pro-agent']
    )
    expect(service.rpcClient.invokeHostMessage).toHaveBeenCalled()
  })

  it('uses the access catalog response without probing host status', async () => {
    const service = new AppService() as any
    service.sessionToken = 'session-token'
    service.me = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: '00000000-0000-4000-8000-0000000000aa',
      teamName: 'Test Team',
      role: 'member',
    }
    service.authClient = {
      getMe: vi.fn().mockResolvedValue(service.me),
      getMyContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
      getMyAgents: vi.fn().mockResolvedValue({
        agentNames: ['allowed-agent', 'denied-agent'],
        agents: [
          { name: 'allowed-agent', mcpServers: [] },
          { name: 'denied-agent', mcpServers: [] },
        ],
      }),
      getTeamContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
      getTeamAgents: vi.fn().mockResolvedValue({ agentNames: [], agents: [] }),
    }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-token' }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      getHostStatus: vi.fn((_token: string, hostRef: string) => {
        if (hostRef === 'denied-agent') {
          throw new ApiError(
            '403 Forbidden: Forbidden: user cannot access this host',
            403,
            '{"error":"Forbidden: user cannot access this host"}'
          )
        }
        return Promise.resolve({ queue: { pending: 0, processing: 0 } })
      }),
    }

    const catalog = await service.refreshAccessCatalog()

    expect(catalog.agentNames).toEqual(['allowed-agent', 'denied-agent'])
    expect(catalog.userAgentNames).toEqual(['allowed-agent', 'denied-agent'])
    expect(catalog.mcpServersByAgent).toEqual({ 'allowed-agent': [], 'denied-agent': [] })
    expect(service.rpcTokenManager.clear).toHaveBeenCalledTimes(1)
    expect(service.rpcClient.getHostStatus).not.toHaveBeenCalled()
  })
})
