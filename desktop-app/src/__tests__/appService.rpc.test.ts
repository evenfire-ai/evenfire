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

  it('does not fence GFS uploads during a transient cross-team operation hop', async () => {
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
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const uploadJob = { suspendForAuth: vi.fn() }
    service.gfsUploadJobs = new Map([
      [
        'upload-1',
        {
          job: uploadJob,
          promise: Promise.resolve(undefined),
          scope: {
            ownerId: 'user-1',
            teamId: 'team-a',
            environmentKey: 'test-env',
            baseUrl: 'https://external.example',
            drive: 'main',
            authEpoch: 1,
          },
        },
      ],
    ])
    service.gfsPendingUploadJobs = new Set()
    service.gfsPendingLegacyUploads = new Set()
    service.authClient = {
      getMe: vi
        .fn()
        .mockResolvedValueOnce({ ...service.me, teamId: 'team-b', teamName: 'Team B' })
        .mockResolvedValueOnce({ ...service.me }),
      switchTeam: vi.fn(async (_token: string, teamId: string) => ({
        token: `${teamId}-token`,
        team: { id: teamId, name: teamId === 'team-b' ? 'Team B' : 'Team A', role: 'member' },
      })),
    }
    service.tokenStore = { setSessionToken: vi.fn() }

    await expect(
      service.runWithTeamContext('team-b', async (token: string) => token)
    ).resolves.toBe('team-b-token')

    expect(uploadJob.suspendForAuth).not.toHaveBeenCalled()
    expect(service.gfsUploadJobs).toHaveProperty('size', 1)
    expect(service.me.teamId).toBe('team-a')
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(1, 'teamless-token', 'team-b')
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(2, 'team-b-token', 'team-a')
  })

  it('blocks new GFS dispatches while a transient team token is installed', async () => {
    const service = new AppService() as any
    service.sessionToken = 'team-a-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.gfsDispatchBlocked = false
    service.authClient = {
      getMe: vi
        .fn()
        .mockResolvedValueOnce({ ...service.me, teamId: 'team-b', teamName: 'Team B' })
        .mockResolvedValueOnce(service.me),
      switchTeam: vi.fn(async (_token: string, teamId: string) => ({
        token: `${teamId}-token`,
        team: { id: teamId, name: teamId, role: 'member' },
      })),
    }
    service.tokenStore = { setSessionToken: vi.fn() }

    await expect(
      service.runWithTeamContext('team-b', async () => {
        await expect(
          service.startGfsFileUpload('parent-a', 'upload.bin', '/tmp/upload.bin')
        ).rejects.toThrow('GFS upload dispatch is unavailable during a transient team hop')
        return 'team-b-operation'
      })
    ).resolves.toBe('team-b-operation')

    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(1, 'team-a-token', 'team-b')
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(2, 'team-b-token', 'team-a')
    expect(service.gfsTransientTeamHopDepth).toBe(0)
  })

  it('keeps existing GFS controls usable through the real team-hop lifecycle', async () => {
    const service = new AppService() as any
    const statePath = path.join(chatStoreBaseDir, 'gfs-upload-state.json')
    const uploadId = '92929292-9292-4292-8292-929292929292'
    const session = {
      uploadId,
      drive: 'main',
      operation: 'create',
      expectedBytes: 4,
      partBytes: 4,
      partCount: 1,
      state: 'uploading',
      contiguousBytes: 0,
      committedBytes: 0,
      committedPartCount: 0,
      activePartCount: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const scope = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
      drive: 'main',
      authEpoch: 1,
    }
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        records: [
          {
            version: 2,
            uploadId,
            filePath: '/tmp/payload.bin',
            fileName: 'payload.bin',
            fileSize: 4,
            target: { operation: 'create', parentRid: 'parent' },
            name: 'payload.bin',
            session,
            scope,
            status: 'active',
            updatedAt: new Date().toISOString(),
          },
        ],
        quarantined: [],
      })
    )
    service.desktopGfsUploadStatePath = vi.fn().mockResolvedValue(statePath)
    service.sessionToken = 'team-a-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.gfsAuthEpoch = 1
    service.gfsDispatchBlocked = false
    service.gfsScopeIdentity = { ...scope, authEpoch: undefined }
    const job = {
      snapshot: vi.fn(() => ({ state: 'uploading', session, uploadedBytes: 0, totalBytes: 4 })),
      pause: vi.fn(async () => ({ ...session, state: 'paused' })),
      resume: vi.fn(async () => ({ ...session, state: 'uploading' })),
      cancel: vi.fn(async () => undefined),
    }
    service.gfsUploadJobs = new Map([[uploadId, { job, promise: Promise.resolve(session), scope }]])
    service.authClient = {
      getMe: vi
        .fn()
        .mockResolvedValueOnce({ ...service.me, teamId: 'team-b', teamName: 'Team B' })
        .mockResolvedValueOnce(service.me),
      switchTeam: vi.fn(async (_token: string, teamId: string) => ({
        token: `${teamId}-token`,
        team: { id: teamId, name: teamId, role: 'member' },
      })),
    }
    service.tokenStore = { setSessionToken: vi.fn() }

    await service.runWithTeamContext('team-b', async () => {
      await expect(service.getGfsUploadSnapshot(uploadId, 'main')).resolves.toMatchObject({
        state: 'uploading',
      })
      await expect(service.listGfsUploadSessions('main')).resolves.toHaveLength(1)
      await expect(service.pauseGfsUpload(uploadId, 'main')).resolves.toMatchObject({
        state: 'paused',
      })
      await expect(service.resumeGfsUpload(uploadId, 'main')).resolves.toMatchObject({
        state: 'uploading',
      })
      await expect(service.cancelGfsUpload(uploadId, 'main')).resolves.toBeUndefined()
    })

    expect(job.snapshot).toHaveBeenCalledTimes(1)
    expect(job.pause).toHaveBeenCalledTimes(1)
    expect(job.resume).toHaveBeenCalledTimes(1)
    expect(job.cancel).toHaveBeenCalledTimes(1)
    expect(service.me.teamId).toBe('team-a')
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(1, 'team-a-token', 'team-b')
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(2, 'team-b-token', 'team-a')
  })

  it('fences the old GFS scope if a replacement team token cannot be refreshed', async () => {
    const service = new AppService() as any
    service.sessionToken = 'team-a-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: 'team-b-token',
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockRejectedValue(new Error('replacement session rejected')),
    }
    service.tokenStore = { setSessionToken: vi.fn(), clearSessionToken: vi.fn() }
    service.rpcTokenManager = { clear: vi.fn() }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    service.clearAuthenticatedSessionState = vi.fn()

    await expect(service.switchSessionToTeam('team-b', 'team-a-token')).rejects.toThrow(
      'replacement session rejected'
    )

    expect(service.suspendDesktopGfsUploadsForAuthBoundary).toHaveBeenCalledWith({
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    })
    expect(service.clearAuthenticatedSessionState).toHaveBeenCalledTimes(1)
  })

  it('clears and revokes a replacement token even when GFS fence persistence fails', async () => {
    const service = new AppService() as any
    service.sessionToken = 'team-a-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: 'team-b-token',
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockRejectedValue(new Error('replacement session rejected')),
    }
    service.tokenStore = {
      setSessionToken: vi.fn(),
      clearSessionToken: vi.fn(),
    }
    service.rpcTokenManager = { clear: vi.fn() }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi
      .fn()
      .mockRejectedValue(new Error('state file is read-only'))
    service.clearAuthenticatedSessionState = vi.fn()

    await expect(service.switchSessionToTeam('team-b', 'team-a-token')).rejects.toThrow(
      'replacement session rejected'
    )

    expect(service.clearAuthenticatedSessionState).toHaveBeenCalledTimes(1)
    expect(service.tokenStore.clearSessionToken).toHaveBeenCalledWith(expect.any(String), {
      legacyEnvKeys: expect.any(Array),
    })
  })

  it('fences GFS uploads only after an explicit switchTeam succeeds', async () => {
    const service = new AppService() as any
    service.sessionToken = 'team-a-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.gfsDispatchBlocked = false
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: 'team-b-token',
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockResolvedValue({ ...service.me, teamId: 'team-b', teamName: 'Team B' }),
    }
    service.tokenStore = { setSessionToken: vi.fn() }
    service.rpcTokenManager = { clear: vi.fn() }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {
      await expect(
        service.startGfsFileUpload('parent-a', 'upload.bin', '/tmp/upload.bin')
      ).rejects.toThrow('GFS upload dispatch is unavailable during a transient team hop')
    })
    service.activateGfsAuthScope = vi.fn()
    service.stopAllStreams = vi.fn()
    service.gfsUploadJobs = new Map([['upload-1', { job: { suspendForAuth: vi.fn() } }]])

    await expect(service.switchTeam('team-b')).resolves.toMatchObject({
      authenticated: true,
      me: { teamId: 'team-b' },
    })

    expect(service.suspendDesktopGfsUploadsForAuthBoundary).toHaveBeenCalledWith({
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    })
    expect(
      service.suspendDesktopGfsUploadsForAuthBoundary.mock.invocationCallOrder[0]
    ).toBeGreaterThan(service.authClient.switchTeam.mock.invocationCallOrder[0])
  })

  it('clears the replacement team session when explicit GFS fence persistence fails', async () => {
    const service = new AppService() as any
    service.sessionToken = 'team-a-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.gfsDispatchBlocked = false
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: 'team-b-token',
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockResolvedValue({ ...service.me, teamId: 'team-b', teamName: 'Team B' }),
    }
    service.tokenStore = {
      setSessionToken: vi.fn(),
      clearSessionToken: vi.fn(),
    }
    service.rpcTokenManager = { clear: vi.fn() }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi
      .fn()
      .mockRejectedValue(new Error('state file is read-only'))
    const clearAuthenticatedSessionState = service.clearAuthenticatedSessionState.bind(service)
    let depthDuringCleanup = 0
    service.clearAuthenticatedSessionState = vi.fn(() => {
      depthDuringCleanup = service.gfsTransientTeamHopDepth
      clearAuthenticatedSessionState()
    })

    await expect(service.switchTeam('team-b')).rejects.toThrow('state file is read-only')

    expect(service.clearAuthenticatedSessionState).toHaveBeenCalledTimes(1)
    expect(service.tokenStore.clearSessionToken).toHaveBeenCalledWith(expect.any(String), {
      legacyEnvKeys: expect.any(Array),
    })
    expect(depthDuringCleanup).toBeGreaterThan(0)
    expect(service.sessionToken).toBeNull()
    expect(service.me).toBeNull()
    expect(service.gfsScopeIdentity).toBeNull()
    expect(service.gfsDispatchBlocked).toBe(true)
    expect(service.gfsTransientTeamHopDepth).toBe(0)
  })

  it('does not fence GFS uploads when an explicit switchTeam is rejected', async () => {
    const service = new AppService() as any
    service.sessionToken = 'team-a-token'
    service.me = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.authClient = {
      switchTeam: vi.fn().mockRejectedValue(new Error('team switch rejected')),
    }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn()

    await expect(service.switchTeam('team-b')).rejects.toThrow('team switch rejected')
    expect(service.suspendDesktopGfsUploadsForAuthBoundary).not.toHaveBeenCalled()
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
