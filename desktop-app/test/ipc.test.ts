import { beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { registerIpcHandlers, sanitizeChatLoadWindow } from '../src/ipc.js'
import type { HostStatusStreamEvent } from '../src/types.js'

const testState = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const downloadsDir = '/tmp/clerum-test'
  const ipcMainMock = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }),
  }
  return { handlers, ipcMainMock, downloadsDir }
})

vi.mock('electron', () => ({
  ipcMain: testState.ipcMainMock,
  app: { getPath: () => testState.downloadsDir },
}))

function makeTrustedEvent(senderId = 77) {
  const destroyedCallbacks: Array<() => void> = []
  const sender = {
    id: senderId,
    send: vi.fn(),
    once: vi.fn((eventName: string, callback: () => void) => {
      if (eventName === 'destroyed') destroyedCallbacks.push(callback)
    }),
  }
  return {
    event: {
      senderFrame: { url: 'file:///index.html' },
      sender,
    },
    sender,
    destroy: () => destroyedCallbacks.forEach(callback => callback()),
  }
}

describe('chat IPC pagination validation', () => {
  it('accepts bounded safe-integer windows', () => {
    expect(sanitizeChatLoadWindow(100, 200)).toEqual({ limit: 100, offset: 200 })
    expect(sanitizeChatLoadWindow(undefined, undefined)).toEqual({})
  })

  it.each([
    ['10', 0],
    [NaN, 0],
    [Infinity, 0],
    [1.5, 0],
    [0, 0],
    [1001, 0],
    [10, NaN],
    [10, Infinity],
    [10, 1.5],
    [10, -1],
    [10, Number.MAX_SAFE_INTEGER + 1],
    [Number.MAX_SAFE_INTEGER + 1, 0],
  ])('rejects an invalid limit/offset pair: %s, %s', (limit, offset) => {
    expect(() => sanitizeChatLoadWindow(limit, offset)).toThrow()
  })
})

describe('ipc host status stream handlers', () => {
  const service = {
    getSessionState: vi.fn(),
    getDependenciesHealth: vi.fn(),
    saveRuntimeConfig: vi.fn(),
    deleteRuntimeConfig: vi.fn(),
    googleLogin: vi.fn(),
    openProfileSettings: vi.fn(),
    logout: vi.fn(),
    listTeams: vi.fn(),
    listTeamMembers: vi.fn(),
    listPendingWorkflowApprovals: vi.fn(),
    decideWorkflowApproval: vi.fn(),
    switchTeam: vi.fn(),
    getAccessCatalog: vi.fn(),
    refreshAccessCatalog: vi.fn(),
    listServers: vi.fn(),
    invoke: vi.fn(),
    invokeHostMessage: vi.fn(),
    getHostStatus: vi.fn(),
    getHostActivity: vi.fn(),
    getTokenMetadata: vi.fn(),
    startHostStatusStream: vi.fn(),
    stopHostStatusStream: vi.fn(),
    stopHostStatusStreamsForOwner: vi.fn(),
    startHostActivityStream: vi.fn(),
    stopHostActivityStream: vi.fn(),
    stopHostActivityStreamsForOwner: vi.fn(),
    getTaskResult: vi.fn(),
    startTaskProgressStream: vi.fn(),
    stopTaskProgressStream: vi.fn(),
    stopTaskProgressStreamsForOwner: vi.fn(),
    startWorkflowNotificationStream: vi.fn(),
    stopWorkflowNotificationStream: vi.fn(),
    stopWorkflowNotificationStreamsForOwner: vi.fn(),
    getWorkflowNotificationStreamStatus: vi.fn(),
    getExternalChannelsSummary: vi.fn(),
    listArtifacts: vi.fn(),
    downloadArtifact: vi.fn(),
    listSessions: vi.fn(),
    loadSessionMessages: vi.fn(),
    listWorkflowRuns: vi.fn(),
    listWorkflowRunArtifacts: vi.fn(),
    downloadWorkflowRunArtifact: vi.fn(),
    resolveGfsUri: vi.fn(),
    downloadGfsUri: vi.fn(),
    listAccessibleGfsResources: vi.fn(),
    listGfsChildren: vi.fn(),
    gfsAffordances: vi.fn(),
    grantGfs: vi.fn(),
    listGfsGrants: vi.fn(),
    revokeGfsGrant: vi.fn(),
    listMyAgents: vi.fn(),
    createGfsShare: vi.fn(),
    setSandboxUiVisible: vi.fn(),
  }

  beforeEach(async () => {
    testState.handlers.clear()
    vi.clearAllMocks()
    await fs.rm(testState.downloadsDir, { recursive: true, force: true })
    await fs.mkdir(testState.downloadsDir, { recursive: true })
    service.stopHostStatusStream.mockReturnValue(true)
    registerIpcHandlers(service as never)
  })

  it('rejects untrusted sender for stream start', async () => {
    const handler = testState.handlers.get('rpc:hostStatusStreamStart')
    expect(handler).toBeDefined()
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { hostRef: 'chatllm' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
  })

  it('forwards sandbox UI visibility changes from the trusted renderer', async () => {
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('sandboxUi:setVisible')

    await Promise.resolve(handler?.(event, { visible: false }))

    expect(service.setSandboxUiVisible).toHaveBeenCalledWith(false)
  })

  it.each([NaN, Infinity, 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid session catalog limit %s before calling the service',
    async limit => {
      const { event } = makeTrustedEvent()
      const handler = testState.handlers.get('rpc:listSessions')
      await expect(
        Promise.resolve(handler?.(event, { hostRef: 'agent-x', query: { limit } }))
      ).rejects.toThrow(/limit|integer/)
      expect(service.listSessions).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['limit', NaN],
    ['limit', Infinity],
    ['limit', 1.5],
    ['limit', 0],
    ['limit', Number.MAX_SAFE_INTEGER + 1],
    ['beforeTurn', 0],
    ['beforeTurn', -1],
    ['beforeTurn', 1.5],
    ['afterTurn', -1],
    ['afterTurn', 1.5],
  ])('rejects invalid message query %s=%s before calling the service', async (field, value) => {
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('rpc:loadSessionMessages')
    await expect(
      Promise.resolve(
        handler?.(event, {
          hostRef: 'agent-x',
          agent: 'agent-x',
          chatId: 'chat-a',
          query: { [field]: value },
        })
      )
    ).rejects.toThrow()
    expect(service.loadSessionMessages).not.toHaveBeenCalled()
  })

  it('rejects mutually exclusive message cursors before calling the service', async () => {
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('rpc:loadSessionMessages')
    await expect(
      Promise.resolve(
        handler?.(event, {
          hostRef: 'agent-x',
          agent: 'agent-x',
          chatId: 'chat-a',
          query: { beforeTurn: 2, afterTurn: 1 },
        })
      )
    ).rejects.toThrow(/mutually exclusive/)
    expect(service.loadSessionMessages).not.toHaveBeenCalled()
  })

  it('starts stream and forwards emitted events to sender', async () => {
    let callback: ((event: HostStatusStreamEvent) => void) | null = null
    service.startHostStatusStream.mockImplementation(
      (
        _streamId: string,
        _ownerId: number,
        _hostRef: string,
        _hostRefs: string[] | undefined,
        cb: (event: HostStatusStreamEvent) => void
      ) => {
        callback = cb
      }
    )
    const { event, sender } = makeTrustedEvent()
    const handler = testState.handlers.get('rpc:hostStatusStreamStart')
    const started = (await Promise.resolve(
      handler?.(event, { hostRef: 'chatllm', hostRefs: ['chatllm'] })
    )) as { streamId: string }

    expect(started.streamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(service.startHostStatusStream).toHaveBeenCalledWith(
      started.streamId,
      77,
      'chatllm',
      ['chatllm'],
      expect.any(Function)
    )

    const streamCallback = callback as ((event: HostStatusStreamEvent) => void) | null
    if (streamCallback) {
      streamCallback({ type: 'error', message: 'test' })
    }
    expect(sender.send).toHaveBeenCalledWith('rpc:hostStatusStreamEvent', {
      streamId: started.streamId,
      event: { type: 'error', message: 'test' },
    })
  })

  it('stops stream by id', async () => {
    const { event } = makeTrustedEvent()
    const stopHandler = testState.handlers.get('rpc:hostStatusStreamStop')
    const result = await Promise.resolve(stopHandler?.(event, { streamId: 'stream-1' }))
    expect(service.stopHostStatusStream).toHaveBeenCalledWith('stream-1', 77)
    expect(result).toEqual({ ok: true })
  })

  it('routes host message submit through invokeHostMessage handler', async () => {
    service.invokeHostMessage.mockResolvedValue({ success: true, response: 'hello' })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('rpc:invokeHostMessage')
    const result = await Promise.resolve(
      handler?.(event, {
        hostRef: 'chatllm',
        payload: {
          content: 'hello',
          channelType: 'rpc',
          sender: 'desktop-app',
        },
        hostRefs: ['chatllm'],
      })
    )
    expect(service.invokeHostMessage).toHaveBeenCalledWith(
      'chatllm',
      expect.objectContaining({ content: 'hello' }),
      ['chatllm'],
      undefined
    )
    expect(result).toEqual({ success: true, response: 'hello' })
  })

  it('routes runtime config save through the auth handler', async () => {
    service.saveRuntimeConfig.mockResolvedValue({
      configured: true,
      activeOptionId: 'prod-1',
      options: [],
    })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('auth:saveRuntimeConfig')
    const result = await Promise.resolve(
      handler?.(event, {
        externalRestApiBaseUrl: ' https://example.com ',
        rpcProxyBaseUrl: ' https://example.com ',
        appName: ' Production ',
      })
    )

    expect(service.saveRuntimeConfig).toHaveBeenCalledWith({
      externalRestApiBaseUrl: 'https://example.com',
      rpcProxyBaseUrl: 'https://example.com',
      appName: 'Production',
    })
    expect(result).toMatchObject({ configured: true, activeOptionId: 'prod-1' })
  })

  it('rejects untrusted sender for runtime config save', async () => {
    const handler = testState.handlers.get('auth:saveRuntimeConfig')
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          {
            externalRestApiBaseUrl: 'https://example.com',
            rpcProxyBaseUrl: 'https://example.com',
            appName: 'Production',
          }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.saveRuntimeConfig).not.toHaveBeenCalled()
  })

  it('routes runtime config delete through the auth handler', async () => {
    service.deleteRuntimeConfig.mockResolvedValue({
      configured: false,
      activeOptionId: '__runtime_setup_local__',
      options: [],
    })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('auth:deleteRuntimeConfig')
    const result = await Promise.resolve(handler?.(event, { optionId: ' prod-1 ' }))

    expect(service.deleteRuntimeConfig).toHaveBeenCalledWith('prod-1')
    expect(result).toMatchObject({ configured: false, activeOptionId: '__runtime_setup_local__' })
  })

  it('rejects untrusted sender for runtime config delete', async () => {
    const handler = testState.handlers.get('auth:deleteRuntimeConfig')
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { optionId: 'prod-1' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.deleteRuntimeConfig).not.toHaveBeenCalled()
  })

  it('opens the canonical Profile UI social route through the auth handler', async () => {
    service.openProfileSettings.mockResolvedValue({
      profileUiUrl: 'http://localhost:3001/settings/social/telegram',
    })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('auth:openProfileSettings')

    await Promise.resolve(
      handler?.(event, {
        email: ' User@Example.com ',
        section: 'social',
        network: ' Telegram ',
      })
    )

    expect(service.openProfileSettings).toHaveBeenCalledWith('user@example.com', {
      section: 'social',
      network: 'telegram',
      action: undefined,
    })
  })

  it('loads the external channel summary through trusted IPC', async () => {
    service.getExternalChannelsSummary.mockResolvedValue({ targets: [], accounts: [] })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('socialChannels:getSummary')

    const result = await Promise.resolve(handler?.(event))

    expect(service.getExternalChannelsSummary).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ targets: [], accounts: [] })
  })

  it('routes GFS grant requests through trusted IPC with sanitized input', async () => {
    service.grantGfs.mockResolvedValue(undefined)
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('gfs:grant')

    await Promise.resolve(
      handler?.(event, {
        resourceId: ' 11111111-1111-1111-1111-111111111111 ',
        subjectKeys: [' user:user-1 ', ' team:team-2 '],
        bits: [' read ', ' manage_acl '],
        drive: ' main ',
      })
    )

    // The bulk subjects[] array is sanitized element-wise. No inherit in the
    // payload → forwarded as undefined (the client's historical `false` default
    // applies downstream).
    expect(service.grantGfs).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      ['user:user-1', 'team:team-2'],
      ['read', 'manage_acl'],
      'main',
      undefined
    )
  })

  it('rejects an empty or non-array subjectKeys payload before calling AppService', async () => {
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('gfs:grant')

    await expect(
      Promise.resolve(
        handler?.(event, {
          resourceId: '11111111-1111-1111-1111-111111111111',
          subjectKeys: [],
          bits: ['read'],
          drive: 'main',
        })
      )
    ).rejects.toThrow('subjectKeys must be a non-empty array')
    expect(service.grantGfs).not.toHaveBeenCalled()
  })

  it('forwards a boolean inherit and rejects a non-boolean one', async () => {
    service.grantGfs.mockResolvedValue(undefined)
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('gfs:grant')

    await Promise.resolve(
      handler?.(event, {
        resourceId: '11111111-1111-1111-1111-111111111111',
        subjectKeys: ['host:1st:mcp-host/chatllm'],
        bits: ['read'],
        drive: 'main',
        inherit: true,
      })
    )
    expect(service.grantGfs).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      ['host:1st:mcp-host/chatllm'],
      ['read'],
      'main',
      true
    )

    await expect(
      Promise.resolve(
        handler?.(event, {
          resourceId: '11111111-1111-1111-1111-111111111111',
          subjectKeys: ['host:1st:mcp-host/chatllm'],
          bits: ['read'],
          drive: 'main',
          inherit: 'yes',
        })
      )
    ).rejects.toThrow('inherit must be a boolean')
  })

  it('routes GFS grant list and revoke through trusted IPC with sanitized input', async () => {
    service.listGfsGrants.mockResolvedValue([])
    service.revokeGfsGrant.mockResolvedValue(undefined)
    const { event } = makeTrustedEvent()

    const listHandler = testState.handlers.get('gfs:listGrants')
    await Promise.resolve(
      listHandler?.(event, {
        resourceId: ' 11111111-1111-1111-1111-111111111111 ',
        drive: ' main ',
      })
    )
    expect(service.listGfsGrants).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'main'
    )

    const revokeHandler = testState.handlers.get('gfs:revokeGrant')
    await Promise.resolve(
      revokeHandler?.(event, { grantId: ' 22222222-2222-2222-2222-222222222222 ' })
    )
    expect(service.revokeGfsGrant).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222')
  })

  it('lists my agents through the dedicated channel (not the cached catalog)', async () => {
    const agents = [
      {
        name: 'chatllm',
        contextRef: 'engineering',
        mcpServers: [{ name: 'mongodb' }],
        gfsSubject: { type: 'host', id: '1st:mcp-host/chatllm' },
      },
    ]
    service.listMyAgents.mockResolvedValue(agents)
    const { event } = makeTrustedEvent()

    const handler = testState.handlers.get('agents:listMine')
    const result = await Promise.resolve(handler?.(event))

    expect(service.listMyAgents).toHaveBeenCalledTimes(1)
    expect(result).toEqual(agents)
  })

  it('propagates reserved GFS subject rejection from AppService', async () => {
    service.grantGfs.mockRejectedValue(new Error('subject must be user:<id> or team:<id>'))
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('gfs:grant')

    await expect(
      Promise.resolve(
        handler?.(event, {
          resourceId: '11111111-1111-1111-1111-111111111111',
          subjectKeys: ['host:mcp-host/standalone'],
          bits: ['read'],
          drive: 'main',
        })
      )
    ).rejects.toThrow('subject must be user:<id> or team:<id>')
  })

  it('rejects untrusted sender for GFS grant listing', async () => {
    const handler = testState.handlers.get('gfs:listGrants')
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { resourceId: '11111111-1111-1111-1111-111111111111', drive: 'main' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.listGfsGrants).not.toHaveBeenCalled()
  })

  it('rejects untrusted sender for GFS grant revocation', async () => {
    const handler = testState.handlers.get('gfs:revokeGrant')
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { grantId: '22222222-2222-2222-2222-222222222222' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.revokeGfsGrant).not.toHaveBeenCalled()
  })

  it('rejects untrusted sender for my agents listing', async () => {
    const handler = testState.handlers.get('agents:listMine')
    await expect(
      Promise.resolve(
        handler?.({
          senderFrame: { url: 'https://evil.example.com' },
          sender: { id: 1, send: vi.fn(), once: vi.fn() },
        })
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.listMyAgents).not.toHaveBeenCalled()
  })

  it('routes host status read through getHostStatus handler', async () => {
    service.getHostStatus.mockResolvedValue({
      hostRef: 'chatllm',
      queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
    })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('rpc:getHostStatus')
    await Promise.resolve(handler?.(event, { hostRef: 'chatllm', hostRefs: ['chatllm'] }))
    expect(service.getHostStatus).toHaveBeenCalledWith('chatllm', ['chatllm'])
  })

  it('routes pending approval listing through the approvals IPC handler', async () => {
    service.listPendingWorkflowApprovals.mockResolvedValue([{ id: 'approval-1' }])
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('approvals:listPending')
    const result = await Promise.resolve(handler?.(event, { limit: 7 }))

    expect(service.listPendingWorkflowApprovals).toHaveBeenCalledWith(7)
    expect(result).toEqual([{ id: 'approval-1' }])
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects invalid pending approval limit %s at the IPC boundary',
    async limit => {
      const { event } = makeTrustedEvent()
      const handler = testState.handlers.get('approvals:listPending')

      await expect(Promise.resolve(handler?.(event, { limit }))).rejects.toThrow(
        'Invalid pending approvals limit'
      )
      expect(service.listPendingWorkflowApprovals).not.toHaveBeenCalled()
    }
  )

  it('routes artifact listing through the IPC handler for trusted senders', async () => {
    service.listArtifacts.mockResolvedValue({ artifacts: [] })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('rpc:listArtifacts')
    const result = await Promise.resolve(
      handler?.(event, { hostRef: 'chatllm', hostRefs: ['chatllm'] })
    )

    expect(service.listArtifacts).toHaveBeenCalledWith('chatllm', ['chatllm'])
    expect(result).toEqual({ artifacts: [] })
  })

  it('rejects untrusted sender for artifact listing', async () => {
    const handler = testState.handlers.get('rpc:listArtifacts')
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { hostRef: 'chatllm', hostRefs: ['chatllm'] }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.listArtifacts).not.toHaveBeenCalled()
  })

  it('routes artifact download through the IPC handler for trusted senders', async () => {
    const file = Buffer.from('artifact')
    service.downloadArtifact.mockResolvedValue(file)
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('rpc:downloadArtifact')
    const result = await Promise.resolve(
      handler?.(event, { hostRef: 'chatllm', filename: 'report.txt', hostRefs: ['chatllm'] })
    )

    expect(service.downloadArtifact).toHaveBeenCalledWith('chatllm', 'report.txt', ['chatllm'])
    expect(result).toEqual(file)
  })

  it('rejects untrusted sender for artifact download', async () => {
    const handler = testState.handlers.get('rpc:downloadArtifact')
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { hostRef: 'chatllm', filename: 'report.txt', hostRefs: ['chatllm'] }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.downloadArtifact).not.toHaveBeenCalled()
  })

  it('routes workflow run listing through a validated IPC limit', async () => {
    service.listWorkflowRuns.mockResolvedValue({ items: [] })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('workflows:runs')

    const result = await Promise.resolve(
      handler?.(event, { ns: 'sandbox-recipes', name: 'recipe', limit: 25 })
    )

    expect(service.listWorkflowRuns).toHaveBeenCalledWith('sandbox-recipes', 'recipe', 25)
    expect(result).toEqual({ items: [] })
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects invalid workflow run limit %s at the IPC boundary',
    async limit => {
      const { event } = makeTrustedEvent()
      const handler = testState.handlers.get('workflows:runs')

      await expect(
        Promise.resolve(
          handler?.(event, {
            ns: 'sandbox-recipes',
            name: 'recipe',
            limit,
          })
        )
      ).rejects.toThrow('Invalid workflow runs limit')
      expect(service.listWorkflowRuns).not.toHaveBeenCalled()
    }
  )

  it('saves run artifacts under Downloads with sanitized filenames', async () => {
    service.downloadWorkflowRunArtifact.mockResolvedValue(Buffer.from('run artifact'))
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('workflows:downloadRunArtifact')
    const result = (await Promise.resolve(
      handler?.(event, {
        ns: 'sandbox-recipes',
        name: 'recipe',
        runId: '../../run-123456',
        artifactName: '../../report?.md',
      })
    )) as { saved: boolean; filePath: string; filename: string }

    expect(result.saved).toBe(true)
    expect(result.filePath).toBe(path.join(testState.downloadsDir, result.filename))
    expect(result.filename).toBe('run-1234-report_.md')
    expect(await fs.readFile(result.filePath, 'utf8')).toBe('run artifact')
  })

  it('does not overwrite an existing run artifact download', async () => {
    const existingPath = path.join(testState.downloadsDir, '4771438b-report.md')
    await fs.writeFile(existingPath, 'existing')
    service.downloadWorkflowRunArtifact.mockResolvedValue(Buffer.from('new artifact'))

    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('workflows:downloadRunArtifact')
    const result = (await Promise.resolve(
      handler?.(event, {
        ns: 'sandbox-recipes',
        name: 'recipe',
        runId: '4771438b-b77e-447c-a15e-3b8e0112ca35',
        artifactName: 'report.md',
      })
    )) as { filePath: string; filename: string }

    expect(result.filename).toBe('4771438b-report (1).md')
    expect(await fs.readFile(existingPath, 'utf8')).toBe('existing')
    expect(await fs.readFile(result.filePath, 'utf8')).toBe('new artifact')
  })

  it('routes approval decisions through the approvals IPC handler', async () => {
    service.decideWorkflowApproval.mockResolvedValue({ ok: true })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('approvals:decide')
    const result = await Promise.resolve(
      handler?.(event, { approvalId: 'approval-1', decision: 'approve', note: 'ship it' })
    )

    expect(service.decideWorkflowApproval).toHaveBeenCalledWith(
      'approval-1',
      'approve',
      'ship it',
      { teamId: undefined }
    )
    expect(result).toEqual({ ok: true })
  })

  it('rejects invalid approval decisions at the IPC boundary', async () => {
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('approvals:decide')

    await expect(
      Promise.resolve(handler?.(event, { approvalId: 'approval-1', decision: 'maybe' }))
    ).rejects.toThrow('decision must be approve or deny')
    expect(service.decideWorkflowApproval).not.toHaveBeenCalled()
  })

  it('routes host activity snapshot through getHostActivity handler', async () => {
    service.getHostActivity.mockResolvedValue({
      hostRef: 'chatllm',
      version: '1.0',
      items: [],
      nextCursor: null,
    })
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('rpc:getHostActivity')
    await Promise.resolve(
      handler?.(event, {
        hostRef: 'chatllm',
        limit: 50,
        sinceEventId: 'evt_1',
        hostRefs: ['chatllm'],
      })
    )
    expect(service.getHostActivity).toHaveBeenCalledWith('chatllm', {
      limit: 50,
      sinceEventId: 'evt_1',
      hostRefs: ['chatllm'],
    })
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    'rejects invalid host activity limit %s at the IPC boundary',
    async limit => {
      const { event } = makeTrustedEvent()
      const handler = testState.handlers.get('rpc:getHostActivity')

      await expect(
        Promise.resolve(handler?.(event, { hostRef: 'chatllm', limit }))
      ).rejects.toThrow('Invalid host activity limit')
      expect(service.getHostActivity).not.toHaveBeenCalled()
    }
  )

  it('rejects untrusted sender for stream stop', async () => {
    const handler = testState.handlers.get('rpc:hostStatusStreamStop')
    expect(handler).toBeDefined()
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { streamId: 'stream-1' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
  })

  it('denies stopping stream owned by another renderer', async () => {
    service.stopHostStatusStream.mockReturnValue(false)
    const { event: ownerAEvent } = makeTrustedEvent(100)
    const { event: ownerBEvent } = makeTrustedEvent(200)
    const startHandler = testState.handlers.get('rpc:hostStatusStreamStart')
    const stopHandler = testState.handlers.get('rpc:hostStatusStreamStop')
    const started = (await Promise.resolve(
      startHandler?.(ownerAEvent, { hostRef: 'chatllm', hostRefs: ['chatllm'] })
    )) as { streamId: string }

    await expect(
      Promise.resolve(stopHandler?.(ownerBEvent, { streamId: started.streamId }))
    ).rejects.toThrow('Forbidden: cannot stop stream owned by another renderer')
  })

  it('cleans up streams when sender is destroyed', async () => {
    const { event, destroy } = makeTrustedEvent()
    const startHandler = testState.handlers.get('rpc:hostStatusStreamStart')
    await Promise.resolve(startHandler?.(event, { hostRef: 'chatllm', hostRefs: ['chatllm'] }))
    destroy()
    expect(service.stopHostStatusStreamsForOwner).toHaveBeenCalledWith(77)
    expect(service.stopHostActivityStreamsForOwner).toHaveBeenCalledWith(77)
    expect(service.stopWorkflowNotificationStreamsForOwner).toHaveBeenCalledWith(77)
  })

  it('starts and stops host activity stream with owner checks', async () => {
    let callback: ((event: unknown) => void) | null = null
    service.startHostActivityStream.mockImplementation(
      (
        _streamId: string,
        _ownerId: number,
        _hostRef: string,
        _hostRefs: string[] | undefined,
        cb: (event: unknown) => void
      ) => {
        callback = cb
      }
    )
    service.stopHostActivityStream.mockReturnValue(true)
    const { event, sender } = makeTrustedEvent(300)
    const startHandler = testState.handlers.get('rpc:hostActivityStreamStart')
    const stopHandler = testState.handlers.get('rpc:hostActivityStreamStop')
    const started = (await Promise.resolve(
      startHandler?.(event, { hostRef: 'chatllm', hostRefs: ['chatllm'] })
    )) as {
      streamId: string
    }
    expect(started.streamId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(service.startHostActivityStream).toHaveBeenCalledWith(
      started.streamId,
      300,
      'chatllm',
      ['chatllm'],
      expect.any(Function)
    )
    if (callback) {
      callback({ type: 'error', message: 'test-activity' })
    }
    expect(sender.send).toHaveBeenCalledWith('rpc:hostActivityStreamEvent', {
      streamId: started.streamId,
      event: { type: 'error', message: 'test-activity' },
    })
    const stopped = await Promise.resolve(stopHandler?.(event, { streamId: started.streamId }))
    expect(stopped).toEqual({ ok: true })
    expect(service.stopHostActivityStream).toHaveBeenCalledWith(started.streamId, 300)
  })
})

describe('ipc desktop window handlers', () => {
  const desktopService = {
    getSessionState: vi.fn(),
    getDependenciesHealth: vi.fn(),
    googleLogin: vi.fn(),
    logout: vi.fn(),
    listTeams: vi.fn(),
    switchTeam: vi.fn(),
    getAccessCatalog: vi.fn(),
    refreshAccessCatalog: vi.fn(),
    listServers: vi.fn(),
    invoke: vi.fn(),
    invokeHostMessage: vi.fn(),
    getHostStatus: vi.fn(),
    getHostActivity: vi.fn(),
    getTokenMetadata: vi.fn(),
    startHostStatusStream: vi.fn(),
    stopHostStatusStream: vi.fn(),
    stopHostStatusStreamsForOwner: vi.fn(),
    startHostActivityStream: vi.fn(),
    stopHostActivityStream: vi.fn(),
    stopHostActivityStreamsForOwner: vi.fn(),
    getTaskResult: vi.fn(),
    startTaskProgressStream: vi.fn(),
    stopTaskProgressStream: vi.fn(),
    stopTaskProgressStreamsForOwner: vi.fn(),
    openDesktop: vi.fn(),
    closeDesktop: vi.fn(),
    getDesktopStatus: vi.fn(),
  }

  beforeEach(() => {
    testState.handlers.clear()
    vi.clearAllMocks()
    desktopService.stopHostStatusStream.mockReturnValue(true)
    registerIpcHandlers(desktopService as never)
  })

  it('desktop:openWindow rejects untrusted sender', async () => {
    const handler = testState.handlers.get('desktop:openWindow')
    expect(handler).toBeDefined()
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { hostRef: 'chatllm' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
  })

  it('desktop:openWindow rejects empty hostRef', async () => {
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('desktop:openWindow')
    await expect(Promise.resolve(handler?.(event, { hostRef: '' }))).rejects.toThrow(
      'hostRef is required'
    )
  })

  it('desktop:openWindow calls service.openDesktop with hostRef', async () => {
    desktopService.openDesktop.mockResolvedValue(undefined)
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('desktop:openWindow')
    await Promise.resolve(handler?.(event, { hostRef: 'chatllm' }))
    expect(desktopService.openDesktop).toHaveBeenCalledWith('chatllm', expect.any(Function))
  })

  it('desktop:closeWindow rejects untrusted sender', async () => {
    const handler = testState.handlers.get('desktop:closeWindow')
    expect(handler).toBeDefined()
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { hostRef: 'chatllm' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
  })

  it('desktop:closeWindow rejects empty hostRef', async () => {
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('desktop:closeWindow')
    await expect(Promise.resolve(handler?.(event, { hostRef: '' }))).rejects.toThrow(
      'hostRef is required'
    )
  })

  it('desktop:closeWindow calls service.closeDesktop with hostRef', async () => {
    desktopService.closeDesktop.mockResolvedValue(undefined)
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('desktop:closeWindow')
    await Promise.resolve(handler?.(event, { hostRef: 'chatllm' }))
    expect(desktopService.closeDesktop).toHaveBeenCalledWith('chatllm')
  })

  it('desktop:getStatus rejects untrusted sender', async () => {
    const handler = testState.handlers.get('desktop:getStatus')
    expect(handler).toBeDefined()
    await expect(
      Promise.resolve(
        handler?.(
          {
            senderFrame: { url: 'https://evil.example.com' },
            sender: { id: 1, send: vi.fn(), once: vi.fn() },
          },
          { hostRef: 'chatllm' }
        )
      )
    ).rejects.toThrow('Untrusted IPC sender')
  })

  it('desktop:getStatus rejects empty hostRef', async () => {
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('desktop:getStatus')
    await expect(Promise.resolve(handler?.(event, { hostRef: '' }))).rejects.toThrow(
      'hostRef is required'
    )
  })

  it('desktop:getStatus returns service.getDesktopStatus result', async () => {
    const statusResult = { hostRef: 'chatllm', status: 'running' }
    desktopService.getDesktopStatus.mockResolvedValue(statusResult)
    const { event } = makeTrustedEvent()
    const handler = testState.handlers.get('desktop:getStatus')
    const result = await Promise.resolve(handler?.(event, { hostRef: 'chatllm' }))
    expect(desktopService.getDesktopStatus).toHaveBeenCalledWith('chatllm')
    expect(result).toEqual(statusResult)
  })
})
