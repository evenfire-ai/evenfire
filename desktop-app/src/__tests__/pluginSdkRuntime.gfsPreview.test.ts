import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import { GfsClient, type GfsTransport } from '../gfs/uriHandler.js'

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/unused') },
  BrowserWindow: class {},
  Notification: class {},
}))

const tempDirs: string[] = []

describe('PluginSdkRuntime GFS preview handoff', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
    vi.restoreAllMocks()
  })

  it('defers plugin GFS open until the committed team token is restored', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'evenfire-plugin-preview-hop-'))
    tempDirs.push(userDataDir)
    const service = new AppService() as any
    const meA = {
      id: 'user-1',
      email: 'test@clerum.io',
      name: 'Test User',
      picture: null,
      teamId: 'team-a',
      teamName: 'Team A',
      role: 'member',
    }
    service.sessionToken = 'team-a-token'
    service.me = meA
    service.gfsScopeIdentity = {
      ownerId: 'user-1',
      teamId: 'team-a',
      environmentKey: 'test-env',
      baseUrl: 'https://external.example',
    }
    service.authClient = {
      getMe: vi
        .fn()
        .mockResolvedValueOnce({ ...meA, teamId: 'team-b', teamName: 'Team B' })
        .mockResolvedValueOnce(meA),
      switchTeam: vi.fn(async (_token: string, teamId: string) => ({
        token: `${teamId}-test-token`,
        team: { id: teamId, name: teamId, role: 'member' },
      })),
    }
    service.tokenStore = { setSessionToken: vi.fn(), clearSessionToken: vi.fn() }
    service.bindCurrentChatStore = vi.fn().mockResolvedValue(undefined)
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    service.activateGfsAuthScope = vi.fn()
    service.stopAllStreams = vi.fn()

    const resource = {
      drive: 'main',
      resourceId: 'resource-1',
      parentResourceId: null,
      rid: 'rid-1',
      gfsUri: 'gfs://main/rid-1',
      name: 'README.md',
      kind: 'file',
      version: 8,
      bytes: 80,
    }
    const calls: Array<{ url: string; token?: string }> = []
    const transport: GfsTransport = {
      baseUrl: 'https://external.example',
      requestJson: vi.fn(async (_method, url, options) => {
        calls.push({ url, token: options?.token })
        return { ok: true, data: resource } as never
      }),
      fetchBytes: vi.fn(async () => new ArrayBuffer(0)),
    }
    service.gfsClient = new GfsClient(transport)
    const send = vi.fn()
    const runtimeModule = await import('../pluginSdkRuntime.js')
    const runtime = new runtimeModule.PluginSdkRuntime({
      service,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
      userDataDir,
    })

    const hopStarted = new Promise<void>(resolve => {
      service.signalHopStarted = resolve
    })
    let releaseHop!: () => void
    const holdHop = new Promise<void>(resolve => {
      releaseHop = resolve
    })
    const hop = service.runWithTeamContext('team-b', async () => {
      service.signalHopStarted()
      await holdHop
    })
    await hopStarted

    let pluginOpenCompleted = false
    const pluginOpen = runtime.openGfsResource(resource.gfsUri).finally(() => {
      pluginOpenCompleted = true
    })
    await Promise.resolve()
    expect(pluginOpenCompleted).toBe(false)
    expect(calls).toEqual([])
    expect(send).not.toHaveBeenCalled()

    releaseHop()
    await expect(hop).resolves.toBeUndefined()
    await expect(pluginOpen).resolves.toEqual({ opened: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ token: 'team-a-test-token' })
    expect(send).toHaveBeenCalledWith(
      'pluginSdk:openGfsResource',
      expect.objectContaining({ gfsUri: resource.gfsUri, version: 8 })
    )
  })

  it('includes the resolved resource version in the renderer IPC payload', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'evenfire-plugin-preview-'))
    tempDirs.push(userDataDir)
    const send = vi.fn()
    const resource = {
      drive: 'main',
      resourceId: 'resource-1',
      parentResourceId: null,
      rid: 'rid-1',
      gfsUri: 'gfs://main/rid-1',
      name: 'README.md',
      kind: 'file',
      version: 8,
      bytes: 80,
    }
    const service = {
      resolveGfsUri: vi.fn().mockResolvedValue(resource),
    } as unknown as AppService
    const runtimeModule = await import('../pluginSdkRuntime.js')
    const runtime = new runtimeModule.PluginSdkRuntime({
      service,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
      userDataDir,
    })

    await expect(runtime.openGfsResource(resource.gfsUri)).resolves.toEqual({ opened: true })
    expect(send).toHaveBeenCalledWith(
      'pluginSdk:openGfsResource',
      expect.objectContaining({ gfsUri: resource.gfsUri, version: 8 })
    )
  })
})
