import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppService } from '../appService.js'

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
