/**
 * R1-M6 (round 2) — cancellation proven through the REAL producer boundary.
 * The abort path is exercised end to end: the ipc handler's AbortController →
 * the real `GfsClient.listChildren` → the real transport `requestJson`
 * (signal-honoring stub that hangs until aborted), and separately the real
 * `fetchBoundedBytes` (its OWN controller funnels the external signal into the
 * fetch it starts). No service mock is abort-aware: the only fake is the
 * network leg, which OBSERVES the signal exactly like a real fetch.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppService } from '../appService.js'
import { fetchBoundedBytes } from '../gfs/boundedDownload.js'
import { GfsClient } from '../gfs/uriHandler.js'

type Handler = (event: unknown, payload: unknown) => Promise<unknown>
type Listener = (event: unknown, payload: unknown) => void

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Listener>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  Notification: vi.fn(),
  app: { on: vi.fn(), getPath: vi.fn(), getVersion: vi.fn(), isReady: vi.fn(() => false) },
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
// pull in the whole main-process graph. The service below is a thin adapter to
// the REAL GfsClient — nothing in the cancellation path is faked.
vi.mock('../appService.js', () => ({ AppService: class {} }))

const trusted = { senderFrame: { url: 'file:///app/index.html' } }

/** Network leg that hangs until its signal aborts — like a real fetch. */
function signalHangingRequestJson() {
  return vi.fn(
    (_method: unknown, _url: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        options?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true }
        )
      })
  )
}

describe('producer-side abort through the real GfsClient (R1-M6)', () => {
  const requestJson = signalHangingRequestJson()
  const client = new GfsClient({
    baseUrl: 'https://api.example',
    requestJson: requestJson as unknown as never,
    fetchBytes: (url, token, opts) => fetchBoundedBytes(url, token, opts),
  })
  const service = {
    listGfsChildren: (resourceId: string, drive?: string, cursor?: string, signal?: AbortSignal) =>
      client.listChildren(resourceId, 'session-token', { drive, cursor, signal }),
  }

  beforeAll(async () => {
    const { registerIpcHandlers } = await import('../ipc.js')
    registerIpcHandlers(service as unknown as AppService)
  })

  afterEach(() => {
    requestJson.mockClear()
  })

  it('gfs:abort ends the real client listing through its transport signal', async () => {
    const pending = electron.handlers.get('gfs:listChildren')!(trusted, {
      resourceId: 'folder-1',
      requestId: 'req-real-1',
    })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    for (let index = 0; index < 25 && requestJson.mock.calls.length === 0; index += 1) {
      await Promise.resolve()
    }
    // The REAL client reached the transport leg carrying the handler's signal.
    const transportOptions = requestJson.mock.calls[0]?.[2] as { signal?: AbortSignal }
    expect(transportOptions?.signal).toBeInstanceOf(AbortSignal)
    expect(transportOptions?.signal?.aborted).toBe(false)

    electron.listeners.get('gfs:abort')!(trusted, { requestId: 'req-real-1' })
    await rejection
    // The producer leg observed the abort — the fetch died, not just the IPC.
    expect(transportOptions?.signal?.aborted).toBe(true)
  })

  it('the real bounded fetch funnels an external signal into the fetch it starts', async () => {
    const controller = new AbortController()
    const seenSignals: Array<AbortSignal | undefined> = []
    const hangingFetch = (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        seenSignals.push(init?.signal)
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true }
        )
      })
    const pending = fetchBoundedBytes(
      'https://api.example/file',
      'session-token',
      { signal: controller.signal },
      { fetch: hangingFetch as unknown as typeof fetch }
    )
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    for (let index = 0; index < 25 && seenSignals.length === 0; index += 1) {
      await Promise.resolve()
    }
    // The fetch the bounded downloader started received a REAL signal.
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
    expect(seenSignals[0]!.aborted).toBe(false)
    controller.abort()
    await rejection
    expect(seenSignals[0]!.aborted).toBe(true)
  })
})
