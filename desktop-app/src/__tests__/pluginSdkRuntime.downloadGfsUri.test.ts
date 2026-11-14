import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppService } from '../appService.js'
import { getActiveEnvKey } from '../config.js'
import type { ResolvedGfsResource } from '../gfs/uriHandler.js'
import { PluginSdkRuntime } from '../pluginSdkRuntime.js'
import { _resetPluginSurfacesForTests, pinPluginSurface } from '../pluginSurfaceRegistry.js'

vi.mock('electron', () => ({
  app: { isReady: vi.fn(() => false), getPath: vi.fn(() => '/unused') },
  BrowserWindow: class {},
  Notification: class {},
}))

const USER_ID = 'user-1'
const SENDER_ID = 42
const PLUGIN_ID = 'sandbox-recipes/leadforge'
const RID = '0123456789abcdef0123456789abcdef'
const URI = `gfs://main/${RID}`

const RESOURCE: ResolvedGfsResource = {
  drive: 'main',
  resourceId: RID,
  parentResourceId: null,
  rid: RID,
  gfsUri: URI,
  name: 'README.md',
  kind: 'file',
  pathCache: '/README.md',
  version: 1,
  bytes: 5,
}

const tempDirs: string[] = []

describe('PluginSdkRuntime GFS reads', () => {
  afterEach(async () => {
    _resetPluginSurfacesForTests()
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
    vi.restoreAllMocks()
  })

  it('reads plugin content without recording an open', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'evenfire-plugin-gfs-read-'))
    tempDirs.push(userDataDir)
    const downloadGfsUri = vi.fn(async () => ({
      resource: RESOURCE,
      bytes: new TextEncoder().encode('hello').buffer,
    }))
    const service = {
      downloadGfsUri,
      getTokenMetadata: () => ({ hasSession: true }),
      getCachedUserId: () => USER_ID,
      setSandboxUiVisible: vi.fn(),
    } as unknown as AppService
    const runtime = new PluginSdkRuntime({
      service,
      getMainWindow: () =>
        ({
          isDestroyed: () => false,
          isVisible: () => true,
          isMinimized: () => false,
          isFocused: () => true,
          webContents: { send: vi.fn() },
        }) as never,
      userDataDir,
    })
    // Consent is the user's earlier decision, not what this test asserts: seed
    // the grant so the call reaches the provider.
    await runtime.store.put({
      envKey: getActiveEnvKey(),
      userId: USER_ID,
      pluginId: PLUGIN_ID,
      capability: 'gfs.read',
      grantedAt: new Date(0).toISOString(),
      lastUsedAt: null,
      descriptorVersion: 1,
      revision: 1,
    })
    pinPluginSurface({
      pluginId: PLUGIN_ID,
      pluginTitle: 'LeadForge',
      surface: 'sandbox-ui-embed',
      webContentsId: SENDER_ID,
      generation: 1,
    })

    const response = await runtime.broker.request(SENDER_ID, {
      v: 1,
      capability: 'gfs.read',
      params: { uri: URI, as: 'text' },
    })

    // Witness: the provider ran and its bytes came back, so the assertion below
    // is about the intent flag of the call that produced them.
    expect(response).toMatchObject({ ok: true, data: { text: 'hello' } })
    expect(downloadGfsUri).toHaveBeenCalledWith(URI, { recordOpen: false })
  })
})
