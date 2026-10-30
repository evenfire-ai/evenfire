import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { buildGfsFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import { AppService } from '../appService.js'
import { __setChatStoreBaseDirForTests } from '../chatStoreBinding.js'
import { ApiError } from '../httpClient.js'
import { TokenStore } from '../tokenStore.js'
import type { HostMessageAttachment } from '../types.js'

const { declaredHeaderPngOfSize, jpegOfSize } = createRequire(import.meta.url)(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  declaredHeaderPngOfSize: (targetBytes: number) => Buffer
  jpegOfSize: (targetBytes: number, width?: number, height?: number) => Buffer
}

const MIB = 1024 * 1024
const MESSAGE_SCOPES = ['host:message:invoke', 'host:task:read', 'host:wake:write'] as const
const credentialFixture = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => credentialFixture.directory },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../windowsSessionAuthorityAcl.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityAcl.js')>()
  const { createWindowsSessionAuthorityAclUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityAclUnitFixture.js')
  return createWindowsSessionAuthorityAclUnitFixture(actual)
})
vi.mock('../windowsSessionAuthorityFileOps.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityFileOps.js')>()
  const { createWindowsSessionAuthorityFileOpsUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityFileOpsUnitFixture.js')
  return createWindowsSessionAuthorityFileOpsUnitFixture(actual)
})
vi.mock('../config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    getActiveRuntimeConfigOptionId: () => null,
    getActiveEnvKey: () => 'test_env-000000000000',
    getActiveLegacyEnvKeys: () => [],
    getActiveLegacyEnvKeyInventory: () => ({ keys: [], complete: true }),
    hydrateDesktopRuntimeConfig: vi.fn(),
    isDesktopRuntimeConfigured: () => true,
    config: {
      ...actual.config,
      externalRestApiBaseUrl: 'http://rest.rpc.test',
      rpcProxyBaseUrl: 'http://proxy.rpc.test',
    },
  }
})

function imageAttachment(
  id: string,
  sizeBytes: number,
  mimeType: HostMessageAttachment['mimeType'] = 'image/png'
): HostMessageAttachment {
  const bytes =
    mimeType === 'image/jpeg' ? jpegOfSize(sizeBytes) : declaredHeaderPngOfSize(sizeBytes)
  return {
    id,
    kind: 'image',
    mimeType,
    encoding: 'base64',
    dataBase64: bytes.toString('base64'),
    filename: `${id}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
  }
}

describe('AppService.invokeHostMessage', () => {
  let chatStoreBaseDir: string

  beforeEach(async () => {
    chatStoreBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-app-service-rpc-'))
    credentialFixture.directory = chatStoreBaseDir
    __setChatStoreBaseDirForTests(chatStoreBaseDir)
  })

  afterEach(async () => {
    __setChatStoreBaseDirForTests(null)
    await fs.rm(chatStoreBaseDir, { recursive: true, force: true })
  })

  function createService(): AppService {
    return new AppService({
      tokenStore: new TokenStore({ isolatedUserDataPath: chatStoreBaseDir }),
      getUserDataDirectory: () => chatStoreBaseDir,
    })
  }

  function createTemporaryToken(userId: string, teamId: string | null): string {
    const payload = Buffer.from(
      JSON.stringify({
        sub: userId,
        teamId,
        exp: Math.floor(Date.now() / 1000) + 60 * 60,
        jti: `rpc-test-${userId}-${teamId ?? 'teamless'}`,
      })
    ).toString('base64url')
    return `header.${payload}.signature`
  }

  async function acceptTemporaryTestSession(service: any, me: any): Promise<string> {
    const token = createTemporaryToken(me.id, me.teamId ?? null)
    vi.spyOn(service as any, 'resolveRuntimeConfigIfNeeded').mockResolvedValue(undefined)
    vi.spyOn(service.authClient, 'passwordLogin').mockResolvedValue({ token, me })
    vi.spyOn(service.authClient, 'getMe').mockResolvedValue(me)
    await service.passwordLogin(me.email, 'fixture-password')
    return token
  }

  it('forces desktop host messages onto the authenticated rpc envelope', async () => {
    const service = createService() as any
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
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-test-token', expiresInSeconds: 300 }),
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
        model: 'vision-model',
        modelSelectionRevision: 7,
        imageModel: { provider: 'untrusted', model: 'untrusted' },
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
      model: 'vision-model',
      modelSelectionRevision: 7,
      channelId: 'chatllm',
      hostRef: 'chatllm',
      sender: '00000000-0000-4000-8000-000000000001',
      metadata: { teamId: '00000000-0000-4000-8000-0000000000aa' },
      threadId: undefined,
      attachments: undefined,
    })
    expect(service.rpcClient.invokeHostMessage.mock.calls[0][3]).toEqual({ async: true })
  })

  it('forwards a 5 MiB JPEG without letting the payload choose identity, host, or scopes', async () => {
    const service = createService() as any
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
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-test-token', expiresInSeconds: 300 }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      invokeHostMessage: vi.fn().mockResolvedValue({ success: true, response: 'ok' }),
    }
    const attachment = imageAttachment('photo', 5 * MIB, 'image/jpeg')

    await service.invokeHostMessage(
      'chatllm',
      {
        content: 'look',
        channelType: 'slack',
        channelId: 'attacker-channel',
        hostRef: 'attacker-host',
        sender: 'attacker-controlled-user',
        metadata: { teamId: 'attacker-controlled-team' },
        attachments: [attachment],
      },
      ['chatllm']
    )

    expect(service.rpcTokenManager.getOrIssue).toHaveBeenCalledWith(
      'session-token',
      [...MESSAGE_SCOPES],
      ['chatllm'],
      expect.any(String)
    )
    expect(service.rpcClient.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(service.rpcClient.invokeHostMessage.mock.calls[0][0]).toBe('rpc-test-token')
    expect(service.rpcClient.invokeHostMessage.mock.calls[0][1]).toBe('chatllm')
    const forwarded = service.rpcClient.invokeHostMessage.mock.calls[0][2]
    expect(forwarded).toEqual({
      content: 'look',
      channelType: 'rpc',
      channelId: 'chatllm',
      hostRef: 'chatllm',
      sender: '00000000-0000-4000-8000-000000000001',
      metadata: { teamId: '00000000-0000-4000-8000-0000000000aa' },
      threadId: undefined,
      attachments: [attachment],
    })
    expect(Buffer.from(forwarded.attachments[0].dataBase64, 'base64')).toHaveLength(5 * MIB)
  })

  it('forwards a 10 MiB PNG + 5 MiB JPEG on the same authenticated envelope', async () => {
    const service = createService() as any
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
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-test-token', expiresInSeconds: 300 }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      invokeHostMessage: vi.fn().mockResolvedValue({ success: true, response: 'ok' }),
    }
    const attachments = [
      imageAttachment('ten', 10 * MIB),
      imageAttachment('five', 5 * MIB, 'image/jpeg'),
    ]

    await service.invokeHostMessage(
      'chatllm',
      {
        content: 'look',
        channelType: 'slack',
        hostRef: 'attacker-host',
        sender: 'attacker-controlled-user',
        attachments,
      },
      ['chatllm']
    )

    expect(service.rpcTokenManager.getOrIssue).toHaveBeenCalledWith(
      'session-token',
      [...MESSAGE_SCOPES],
      ['chatllm'],
      expect.any(String)
    )
    const forwarded = service.rpcClient.invokeHostMessage.mock.calls[0][2]
    expect(forwarded.channelType).toBe('rpc')
    expect(forwarded.sender).toBe('00000000-0000-4000-8000-000000000001')
    expect(forwarded.hostRef).toBe('chatllm')
    expect(forwarded.channelId).toBe('chatllm')
    expect(forwarded.attachments).toEqual(attachments)
    expect(Buffer.from(forwarded.attachments[0].dataBase64, 'base64')).toHaveLength(10 * MIB)
    expect(Buffer.from(forwarded.attachments[1].dataBase64, 'base64')).toHaveLength(5 * MIB)
  })

  it('rejects malformed attachments before issuing an RPC token', async () => {
    const service = createService() as any
    service.sessionToken = 'test-token-session'
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
      getOrIssue: vi.fn().mockResolvedValue({ token: 'test-token-rpc', expiresInSeconds: 300 }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      invokeHostMessage: vi.fn().mockResolvedValue({ success: true, response: 'ok' }),
    }
    const issueToken = vi.spyOn(service, 'issueRpcTokenForHostRefs')

    await expect(
      service.invokeHostMessage('chatllm', { content: 'hello', attachments: {} }, ['chatllm'])
    ).rejects.toThrow('Attachments must be a list.')
    expect(issueToken).not.toHaveBeenCalled()
    expect(service.rpcTokenManager.getOrIssue).not.toHaveBeenCalled()
    expect(service.rpcClient.invokeHostMessage).not.toHaveBeenCalled()

    // Positive control: the same call with a well-formed list issues the token
    // and reaches the Host, so the checks above are not vacuous.
    await service.invokeHostMessage('chatllm', { content: 'hello', attachments: [] }, ['chatllm'])
    expect(issueToken).toHaveBeenCalledTimes(1)
    expect(service.rpcTokenManager.getOrIssue).toHaveBeenCalled()
    expect(service.rpcClient.invokeHostMessage).toHaveBeenCalledTimes(1)
  })

  describe('structured file references (#666)', () => {
    const RID = '1234567890abcdef1234567890abcdef'

    function fileReference() {
      const built = buildGfsFileReference({
        drive: 'main',
        resourceId: RID,
        gfsUri: `gfs://main/${RID}`,
        version: 3,
        name: 'plan.md',
        declaredMediaType: null,
        byteLength: 120,
        classification: classifyBytes({
          bytes: new Uint8Array(0),
          totalByteLength: 120,
          declaredMediaType: null,
          filename: 'plan.md',
        }),
      })
      if (!built.ok) throw new Error(`fixture reference invalid: ${built.code}`)
      return built.value
    }

    function serviceWithRpc() {
      const service = createService() as any
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
        getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-test-token', expiresInSeconds: 300 }),
        clear: vi.fn(),
      }
      service.rpcClient = {
        invokeHostMessage: vi.fn().mockResolvedValue({ success: true, status: 'pending' }),
      }
      return service
    }

    it('forwards the references on the authenticated envelope', async () => {
      const service = serviceWithRpc()
      const reference = fileReference()

      await service.invokeHostMessage(
        'chatllm',
        { content: 'Summarize the plan', sender: 'attacker', fileReferences: [reference] },
        ['chatllm']
      )

      expect(service.rpcClient.invokeHostMessage).toHaveBeenCalledTimes(1)
      expect(service.rpcClient.invokeHostMessage.mock.calls[0][2]).toEqual({
        content: 'Summarize the plan',
        channelType: 'rpc',
        channelId: 'chatllm',
        hostRef: 'chatllm',
        sender: '00000000-0000-4000-8000-000000000001',
        metadata: { teamId: '00000000-0000-4000-8000-0000000000aa' },
        threadId: undefined,
        attachments: undefined,
        fileReferences: [reference],
      })
    })

    it('rejects non-list references before issuing an RPC token', async () => {
      const service = serviceWithRpc()
      const issueToken = vi.spyOn(service, 'issueRpcTokenForHostRefs')

      await expect(
        service.invokeHostMessage('chatllm', { content: 'hello', fileReferences: {} }, ['chatllm'])
      ).rejects.toThrow('File references must be a list.')
      expect(issueToken).toHaveBeenCalledTimes(0)
      expect(service.rpcClient.invokeHostMessage).toHaveBeenCalledTimes(0)

      // Positive control: a list issues the token and reaches the Host.
      await service.invokeHostMessage('chatllm', { content: 'hello', fileReferences: [] }, [
        'chatllm',
      ])
      expect(issueToken).toHaveBeenCalledTimes(1)
      expect(service.rpcClient.invokeHostMessage).toHaveBeenCalledTimes(1)
    })
  })

  it('switches to a matching directory team before issuing RPC tokens for teamless sessions', async () => {
    const service = createService() as any
    service.desktopGfsUploadStatePath = vi
      .fn()
      .mockResolvedValue(path.join(chatStoreBaseDir, 'gfs-upload-state.json'))
    const teamlessMe = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: null,
      teamName: null,
      role: 'member',
    }
    const teamlessToken = await acceptTemporaryTestSession(service, teamlessMe)
    const teamMe = {
      ...teamlessMe,
      teamId: 'team-1',
      teamName: 'Team One',
    }
    const teamToken = createTemporaryToken('user-1', 'team-1')
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
        token: teamToken,
        team: { id: 'team-1', name: 'Team One', role: 'member' },
      }),
    }
    service.rpcTokenManager = {
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-test-token', expiresInSeconds: 300 }),
      clear: vi.fn(),
    }
    service.rpcClient = {
      invokeHostMessage: vi.fn().mockResolvedValue({ success: true, response: 'ok' }),
    }

    await expect(
      service.invokeHostMessage('pro-agent', { content: 'hello' }, ['pro-agent'])
    ).resolves.toEqual({ success: true, response: 'ok' })

    expect(service.authClient.switchTeam).toHaveBeenCalledWith(teamlessToken, 'team-1')
    expect(service.rpcTokenManager.getOrIssue).toHaveBeenCalledWith(
      teamToken,
      ['host:message:invoke', 'host:task:read', 'host:wake:write'],
      ['pro-agent'],
      expect.any(String)
    )
  })

  it('does not fence GFS uploads during a transient cross-team operation hop', async () => {
    const service = createService() as any
    service.desktopGfsUploadStatePath = vi
      .fn()
      .mockResolvedValue(path.join(chatStoreBaseDir, 'gfs-upload-state.json'))
    const homeMe = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const homeToken = await acceptTemporaryTestSession(service, homeMe)
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
    const teamBToken = createTemporaryToken('user-1', 'team-b')
    const teamAToken = createTemporaryToken('user-1', 'team-a')
    service.authClient = {
      getMe: vi
        .fn()
        .mockResolvedValueOnce({ ...homeMe, teamId: 'team-b', teamName: 'Team B' })
        .mockResolvedValueOnce(homeMe),
      switchTeam: vi
        .fn()
        .mockResolvedValueOnce({
          token: teamBToken,
          team: { id: 'team-b', name: 'Team B', role: 'member' },
        })
        .mockResolvedValueOnce({
          token: teamAToken,
          team: { id: 'team-a', name: 'Team A', role: 'member' },
        }),
    }

    await expect(
      service.runWithTeamContext('team-b', async (token: string) => token)
    ).resolves.toBe(teamBToken)

    expect(uploadJob.suspendForAuth).not.toHaveBeenCalled()
    expect(service.gfsUploadJobs).toHaveProperty('size', 1)
    expect(service.me.teamId).toBe('team-a')
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(1, homeToken, 'team-b')
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(2, teamBToken, 'team-a')
  })

  it('blocks new GFS dispatches while a transient team token is installed', async () => {
    const service = createService() as any
    const homeMe = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const homeToken = await acceptTemporaryTestSession(service, homeMe)
    const teamBToken = createTemporaryToken('user-1', 'team-b')
    const teamAToken = createTemporaryToken('user-1', 'team-a')
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
        .mockResolvedValueOnce({ ...homeMe, teamId: 'team-b', teamName: 'Team B' })
        .mockResolvedValueOnce(homeMe),
      switchTeam: vi
        .fn()
        .mockResolvedValueOnce({
          token: teamBToken,
          team: { id: 'team-b', name: 'Team B', role: 'member' },
        })
        .mockResolvedValueOnce({
          token: teamAToken,
          team: { id: 'team-a', name: 'Team A', role: 'member' },
        }),
    }

    await expect(
      service.runWithTeamContext('team-b', async () => {
        await expect(
          service.startGfsFileUpload('parent-a', 'upload.bin', 'upload.bin')
        ).rejects.toThrow('GFS upload dispatch is unavailable during a transient team hop')
        return 'team-b-operation'
      })
    ).resolves.toBe('team-b-operation')

    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(1, homeToken, 'team-b')
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(2, teamBToken, 'team-a')
    expect(service.gfsTransientTeamHopDepth).toBe(0)
  })

  it('keeps existing GFS controls usable through the real team-hop lifecycle', async () => {
    const service = createService() as any
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
    const homeMe = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const homeToken = await acceptTemporaryTestSession(service, homeMe)
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
    let acceptedTeamBToken: string | undefined
    service.authClient = {
      getMe: vi
        .fn()
        .mockResolvedValueOnce({ ...homeMe, teamId: 'team-b', teamName: 'Team B' })
        .mockResolvedValueOnce(homeMe),
      switchTeam: vi.fn(async (_token: string, teamId: string) => {
        const token = createTemporaryToken('user-1', teamId)
        if (teamId === 'team-b') acceptedTeamBToken = token
        return { token, team: { id: teamId, name: teamId, role: 'member' } }
      }),
    }

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
    expect(service.authClient.switchTeam).toHaveBeenNthCalledWith(1, homeToken, 'team-b')
    const returnHomeCall = vi.mocked(service.authClient.switchTeam).mock.calls[1]
    expect(returnHomeCall?.[1]).toBe('team-a')
    const returnHomeToken = returnHomeCall?.[0]
    if (typeof returnHomeToken !== 'string') throw new Error('Expected the team-B session token')
    expect(returnHomeToken).toBe(acceptedTeamBToken)
    const payload = returnHomeToken.split('.')[1]
    if (!payload) throw new Error('Expected a JWT payload for the team-B session token')
    const tokenClaims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string
      teamId?: string | null
      exp?: number
      jti?: string
    }
    expect(tokenClaims).toMatchObject({
      sub: 'user-1',
      teamId: 'team-b',
      jti: 'rpc-test-user-1-team-b',
    })
    expect(tokenClaims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('preserves accepted session A when team candidate identity validation fails', async () => {
    const service = createService() as any
    const homeMe = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const homeToken = await acceptTemporaryTestSession(service, homeMe)
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: createTemporaryToken('user-1', 'team-b'),
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockRejectedValue(new Error('replacement session rejected')),
    }
    service.rpcTokenManager = { clear: vi.fn() }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(service, 'clearAuthenticatedSessionState')

    await expect(service.switchSessionToTeam('team-b', homeToken)).rejects.toThrow(
      'replacement session rejected'
    )

    expect(service.suspendDesktopGfsUploadsForAuthBoundary).not.toHaveBeenCalled()
    expect(service.clearAuthenticatedSessionState).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe(homeToken)
    expect(service.me).toEqual(homeMe)
    expect(service.gfsScopeIdentity).toEqual({
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    })
    const restarted = createService() as any
    restarted.authClient.getMe = vi.fn()
    await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(restarted.authClient.getMe).not.toHaveBeenCalled()
  })

  it('preserves session A when its GFS fence cannot be persisted before team acceptance', async () => {
    const service = createService() as any
    const homeMe = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const homeToken = await acceptTemporaryTestSession(service, homeMe)
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: createTemporaryToken('user-1', 'team-b'),
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockResolvedValue({ ...homeMe, teamId: 'team-b', teamName: 'Team B' }),
    }
    service.rpcTokenManager = { clear: vi.fn() }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi
      .fn()
      .mockRejectedValue(new Error('state file is read-only'))
    vi.spyOn(service, 'clearAuthenticatedSessionState')

    await expect(service.switchTeam('team-b')).rejects.toThrow('state file is read-only')

    expect(service.suspendDesktopGfsUploadsForAuthBoundary).toHaveBeenCalledOnce()
    expect(service.clearAuthenticatedSessionState).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe(homeToken)
    expect(service.me).toEqual(homeMe)
    const restarted = createService() as any
    restarted.authClient.getMe = vi.fn()
    await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(restarted.authClient.getMe).not.toHaveBeenCalled()
  })

  it('fences GFS uploads only after an explicit switchTeam succeeds', async () => {
    const service = createService() as any
    const homeMe = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const homeToken = await acceptTemporaryTestSession(service, homeMe)
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.gfsDispatchBlocked = false
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: createTemporaryToken('user-1', 'team-b'),
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockResolvedValue({ ...homeMe, teamId: 'team-b', teamName: 'Team B' }),
    }
    service.rpcTokenManager = { clear: vi.fn() }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {
      await expect(
        service.startGfsFileUpload('parent-a', 'upload.bin', 'upload.bin')
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

  it('preserves session A when explicit team GFS fencing fails before acceptance', async () => {
    const service = createService() as any
    const homeMe = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    const homeToken = await acceptTemporaryTestSession(service, homeMe)
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.gfsDispatchBlocked = false
    service.authClient = {
      switchTeam: vi.fn().mockResolvedValue({
        token: createTemporaryToken('user-1', 'team-b'),
        team: { id: 'team-b', name: 'Team B', role: 'member' },
      }),
      getMe: vi.fn().mockResolvedValue({ ...homeMe, teamId: 'team-b', teamName: 'Team B' }),
    }
    service.rpcTokenManager = { clear: vi.fn() }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi
      .fn()
      .mockRejectedValue(new Error('state file is read-only'))
    let depthDuringFence = 0
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn(async () => {
      depthDuringFence = service.gfsTransientTeamHopDepth
      throw new Error('state file is read-only')
    })
    vi.spyOn(service, 'clearAuthenticatedSessionState')

    await expect(service.switchTeam('team-b')).rejects.toThrow('state file is read-only')

    expect(service.clearAuthenticatedSessionState).not.toHaveBeenCalled()
    expect(service.sessionToken).toBe(homeToken)
    expect(service.me).toEqual(homeMe)
    const restarted = createService() as any
    restarted.authClient.getMe = vi.fn()
    await expect(restarted.initialize()).resolves.toEqual({ authenticated: false, me: null })
    expect(restarted.authClient.getMe).not.toHaveBeenCalled()
    expect(depthDuringFence).toBeGreaterThan(0)
    expect(service.sessionToken).toBe(homeToken)
    expect(service.me).toEqual(homeMe)
    expect(service.gfsScopeIdentity).toEqual({
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    })
    expect(service.gfsTransientTeamHopDepth).toBe(0)
  })

  it('does not fence GFS uploads when an explicit switchTeam is rejected', async () => {
    const service = createService() as any
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
    const service = createService() as any
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
        token: 'user-rpc-test-token',
        accessScope: 'user',
        teamId: null,
        expiresInSeconds: 300,
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
      ['pro-agent'],
      expect.any(String)
    )
    expect(service.rpcClient.invokeHostMessage).toHaveBeenCalled()
  })

  it('uses the access catalog response without probing host status', async () => {
    const service = createService() as any
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
      getOrIssue: vi.fn().mockResolvedValue({ token: 'rpc-test-token', expiresInSeconds: 300 }),
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
