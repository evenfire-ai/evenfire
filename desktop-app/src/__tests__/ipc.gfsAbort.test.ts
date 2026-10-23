/**
 * R1-M1 — producer-side cancellation. A cancellable GFS read ('gfs:listChildren'
 * or 'gfs:download') carries a requestId; 'gfs:abort' must abort the in-flight
 * request's AbortController so the producer fetch ends instead of burning the
 * per-actor read budget after the user pressed Stop.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>
type Listener = (event: unknown, payload: unknown) => void

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Listener>(),
}))

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
    on: vi.fn((channel: string, listener: Listener) => {
      electron.listeners.set(channel, listener)
    }),
    removeHandler: vi.fn(),
  },
}))
// ipc.ts only uses AppService as a type at registration; the real module would
// pull in the whole main-process graph.
vi.mock('../appService.js', () => ({ AppService: class {} }))

/** A service read that settles ONLY when its signal aborts, like a real fetch. */
function hangingRead() {
  return vi.fn(
    (_resourceId: string, _drive?: string, _cursor?: string, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('producer aborted')), {
          once: true,
        })
      })
  )
}

const trusted = { senderFrame: { url: 'file:///app/index.html' } }

function handler(channel: string): Handler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`no handler registered for ${channel}`)
  return registered
}

function abortListener(): Listener {
  const registered = electron.listeners.get('gfs:abort')
  if (!registered) throw new Error('no gfs:abort listener registered')
  return registered
}

async function flushMicrotasks() {
  for (let index = 0; index < 25; index += 1) await Promise.resolve()
}

describe('gfs producer-side abort (R1-M1)', () => {
  const service = {
    listGfsChildren: hangingRead(),
    downloadGfsUri: vi.fn(async () => new ArrayBuffer(0)),
  }

  beforeAll(async () => {
    const { registerIpcHandlers } = await import('../ipc.js')
    registerIpcHandlers(service as unknown as AppService)
  })

  afterEach(() => {
    service.listGfsChildren.mockClear()
  })

  it('aborts the in-flight producer listing when the renderer stops the walk', async () => {
    const pending = handler('gfs:listChildren')(trusted, {
      resourceId: 'folder-1',
      requestId: 'req-1',
    })
    const rejection = expect(pending).rejects.toThrow('producer aborted')
    await flushMicrotasks()
    const signal = service.listGfsChildren.mock.calls[0]?.[3] as AbortSignal | undefined
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)

    abortListener()(trusted, { requestId: 'req-1' })
    await rejection
    expect(signal?.aborted).toBe(true)
  })

  it('leaves unrelated in-flight requests alone', async () => {
    const pending = handler('gfs:listChildren')(trusted, {
      resourceId: 'folder-1',
      requestId: 'req-a',
    })
    await flushMicrotasks()
    const signal = service.listGfsChildren.mock.calls[0]?.[3] as AbortSignal | undefined

    abortListener()(trusted, { requestId: 'req-other' })
    await flushMicrotasks()
    expect(signal?.aborted).toBe(false)
    expect(pending).toEqual(expect.any(Promise)) // still pending, not rejected

    abortListener()(trusted, { requestId: 'req-a' })
    await expect(pending).rejects.toThrow('producer aborted')
  })

  it('runs uncancellable reads without a signal when no requestId is sent', async () => {
    const immediate = vi.fn(async () => ({ items: [], nextCursor: null }))
    service.listGfsChildren.mockImplementationOnce(immediate)
    await handler('gfs:listChildren')(trusted, { resourceId: 'folder-1' })
    expect(immediate).toHaveBeenCalledWith('folder-1', undefined, undefined, undefined)
  })
})
