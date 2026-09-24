/**
 * Issue #666 — the IPC boundary parses structured file references with the
 * shared FileReference v1 contract and refuses a malformed one instead of
 * forwarding it to the host.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildGfsFileReference, classifyBytes } from '@clerum/gfs-interaction-policy'
import type { AppService } from '../appService.js'

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

const service = {
  invokeHostMessage: vi.fn(async (..._args: unknown[]) => ({ taskId: 'task-1' })),
}
const trusted = { senderFrame: { url: 'file:///app/index.html' } }

const RID = '1234567890abcdef1234567890abcdef'

function reference(name = 'plan.md') {
  const built = buildGfsFileReference({
    drive: 'main',
    resourceId: RID,
    gfsUri: `gfs://main/${RID}`,
    version: 3,
    name,
    declaredMediaType: null,
    byteLength: 120,
    classification: classifyBytes({
      bytes: new Uint8Array(0),
      totalByteLength: 120,
      declaredMediaType: null,
      filename: name,
    }),
  })
  if (!built.ok) throw new Error(`fixture reference invalid: ${built.code}`)
  return built.value
}

function send(payload: Record<string, unknown>) {
  const registered = electron.handlers.get('rpc:invokeHostMessage')
  if (!registered) throw new Error('no IPC handler registered for rpc:invokeHostMessage')
  return registered(trusted, { hostRef: 'agent-x', payload: { content: 'hi', ...payload } })
}

beforeAll(async () => {
  const { registerIpcHandlers } = await import('../ipc.js')
  registerIpcHandlers(service as unknown as AppService)
})

afterEach(() => {
  service.invokeHostMessage.mockClear()
})

describe('rpc:invokeHostMessage fileReferences', () => {
  it('forwards the parsed references', async () => {
    const references = [reference('plan.md'), reference('photo.png')]
    await send({ fileReferences: references })
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect(service.invokeHostMessage).toHaveBeenCalledWith(
      'agent-x',
      expect.objectContaining({ content: 'hi', fileReferences: references }),
      undefined,
      undefined
    )
  })

  it('leaves a request without references unchanged', async () => {
    await send({})
    // Witness: the request reached the service.
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
    const request = service.invokeHostMessage.mock.calls[0][1] as Record<string, unknown>
    expect(request.content).toBe('hi')
    expect(request).not.toHaveProperty('fileReferences')
  })

  it.each([
    ['a non-list value', { id: 'x' }],
    ['null', null],
    ['an entry with schemaVersion 2', [{ ...reference(), schemaVersion: 2 }]],
    ['an entry whose id does not match its source', [{ ...reference(), id: 'gfs:main:other@v3' }]],
    ['an entry with a path in its name', [{ ...reference(), name: '../plan.md' }]],
  ])('rejects %s', async (_label, fileReferences) => {
    await expect(send({ fileReferences })).rejects.toThrow(
      'Invalid host message request: fileReferences'
    )
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(0)
    // Control: the same request with a valid reference goes through.
    await send({ fileReferences: [reference()] })
    expect(service.invokeHostMessage).toHaveBeenCalledTimes(1)
  })
})
