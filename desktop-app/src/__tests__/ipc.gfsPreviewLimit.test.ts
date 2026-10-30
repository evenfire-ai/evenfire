/**
 * R1-H4 — the preview download ceiling is authoritative in main. The renderer
 * is untrusted: it may request a smaller per-type limit, but a request above
 * GFS_PREVIEW_MAX_BYTES is rejected at the IPC boundary before it reaches the
 * service, instead of being obeyed unbounded.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'
import { GFS_PREVIEW_MAX_BYTES } from '../gfs/previewLimits.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler)
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))
// ipc.ts only uses AppService as a type at registration; the real module would
// pull in the whole main-process graph.
vi.mock('../appService.js', () => ({ AppService: class {} }))

let sessionGeneration = 4
const service = {
  getSessionGeneration: vi.fn(() => sessionGeneration),
  downloadGfsUri: vi.fn(async () => new ArrayBuffer(0)),
  listGfsChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
  createGfsFolder: vi.fn(async () => ({ resourceId: 'created-folder' })),
  getGfsResourceProfileOrigin: vi.fn(async () => ({
    origin: 'https://profile.example.test',
    sessionGeneration: 4,
    envKey: 'fixture-env',
  })),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }
const uri = 'gfs://drive/resource'
const staleAuthorityMarker = '__CLERUM_GFS_STALE_AUTHORITY_V1__:'

function encodedIpcMessage(message: string): string {
  return encodeURIComponent(JSON.stringify(message))
}

function handler(channel: string): Handler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`no IPC handler registered for ${channel}`)
  return registered
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService, async () => 0)
})

afterEach(() => {
  sessionGeneration = 4
  service.downloadGfsUri.mockClear()
  service.listGfsChildren.mockClear()
  service.createGfsFolder.mockClear()
  service.getGfsResourceProfileOrigin.mockClear()
})

describe('gfs:getResourceProfileOrigin trusted boundary', () => {
  it('forwards the main-owned effective origin for the trusted renderer', async () => {
    await expect(handler('gfs:getResourceProfileOrigin')(trusted, undefined)).resolves.toEqual({
      origin: 'https://profile.example.test',
      sessionGeneration: 4,
      envKey: 'fixture-env',
    })
    expect(service.getGfsResourceProfileOrigin).toHaveBeenCalledTimes(1)
  })

  it('rejects an untrusted renderer before consulting the service', async () => {
    await expect(
      handler('gfs:getResourceProfileOrigin')(
        { senderFrame: { url: 'https://attacker.example' } },
        undefined
      )
    ).rejects.toThrow('Untrusted IPC sender')
    expect(service.getGfsResourceProfileOrigin).not.toHaveBeenCalled()
  })
})

describe('gfs:downloadPreview maxBytes ceiling', () => {
  it.each([GFS_PREVIEW_MAX_BYTES + 1, Number.MAX_SAFE_INTEGER])(
    'rejects an over-cap maxBytes (%i) without calling the service',
    async maxBytes => {
      await expect(handler('gfs:downloadPreview')(trusted, { uri, maxBytes })).rejects.toThrow(
        'preview download limit exceeds the allowed maximum'
      )
      expect(service.downloadGfsUri).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['at the ceiling', GFS_PREVIEW_MAX_BYTES],
    ['a smaller per-type limit (image, 10 MiB)', 10 * 1024 * 1024],
  ])('forwards %s to the service', async (_label, maxBytes) => {
    await handler('gfs:downloadPreview')(trusted, { uri, maxBytes })
    expect(service.downloadGfsUri).toHaveBeenCalledWith(uri, maxBytes)
  })
})

describe('GFS IPC session-generation authority fencing', () => {
  it('marks an old-generation read failure without revoking a newer session', async () => {
    let rejectRead!: (error: unknown) => void
    service.listGfsChildren.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectRead = reject))
    )

    const pending = handler('gfs:listChildren')(trusted, { resourceId: 'folder' })
    expect(service.listGfsChildren).toHaveBeenCalledOnce()
    sessionGeneration += 1
    rejectRead(Object.assign(new Error('401 Unauthorized'), { status: 401 }))

    await expect(pending).rejects.toThrow(
      `${staleAuthorityMarker}stale:${encodedIpcMessage('401 Unauthorized')}`
    )
    expect(service.listGfsChildren).toHaveBeenCalledOnce()
  })

  it('keeps a current-generation 401 as a normal fail-closed authority failure', async () => {
    service.listGfsChildren.mockRejectedValueOnce(
      Object.assign(new Error('401 Unauthorized'), { status: 401 })
    )

    const pending = handler('gfs:listChildren')(trusted, { resourceId: 'folder' })
    await expect(pending).rejects.toThrow('401 Unauthorized')
    expect(service.listGfsChildren).toHaveBeenCalledOnce()
  })

  it('does not retry a mutation when its authority failure is stale', async () => {
    let rejectMutation!: (error: unknown) => void
    service.createGfsFolder.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectMutation = reject))
    )

    const pending = handler('gfs:createFolder')(trusted, {
      parentResourceId: 'parent',
      name: 'new-folder',
    })
    sessionGeneration += 1
    rejectMutation(Object.assign(new Error('401 Unauthorized'), { status: 401 }))

    await expect(pending).rejects.toThrow(`${staleAuthorityMarker}stale:`)
    expect(service.createGfsFolder).toHaveBeenCalledOnce()
  })

  it('does not mark a resource-scoped 403 stale', async () => {
    service.listGfsChildren.mockImplementationOnce(async () => {
      sessionGeneration += 1
      throw Object.assign(new Error('403 manage_acl_required'), { status: 403 })
    })

    await expect(handler('gfs:listChildren')(trusted, { resourceId: 'folder' })).rejects.toThrow(
      '403 manage_acl_required'
    )
  })

  it('marks an old-generation typed lifecycle failure', async () => {
    service.listGfsChildren.mockImplementationOnce(async () => {
      sessionGeneration += 1
      throw new Error('desktop_user_retired: account disabled')
    })

    await expect(handler('gfs:listChildren')(trusted, { resourceId: 'folder' })).rejects.toThrow(
      `${staleAuthorityMarker}stale:${encodedIpcMessage('desktop_user_retired: account disabled')}`
    )
  })

  it('escapes a current operation error that begins with the reserved marker', async () => {
    const originalMessage = `${staleAuthorityMarker}401 Unauthorized`
    service.listGfsChildren.mockRejectedValueOnce(new Error(originalMessage))

    await expect(handler('gfs:listChildren')(trusted, { resourceId: 'folder' })).rejects.toThrow(
      `${staleAuthorityMarker}message:${encodedIpcMessage(originalMessage)}`
    )
  })
})
