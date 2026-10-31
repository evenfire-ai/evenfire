/**
 * R2-L3/R1-M6 — the REAL preload's cancellable GFS bridge, exercised through
 * a mocked Electron boundary. The preload is the sandboxed security surface,
 * so its behavior is tested directly (no extracted helper): an already-aborted
 * signal starts no producer work; a mid-flight abort fires gfs:abort exactly
 * once with the invoke's requestId; a signal-less call is a plain invoke.
 *
 * R1-M6 — every expectation here BOUNDS its wait. A regression that made the
 * bridge hang (the pre-R2-L3 behaviour) must fail as an ASSERTION, not as a
 * test timeout: a timeout says "the test broke", an assertion says "the
 * behaviour broke".
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const exposed = new Map<string, unknown>()
  return {
    exposed,
    ipcRenderer: {
      invoke: vi.fn(() => new Promise(() => undefined)),
      send: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      electron.exposed.set(name, value)
    }),
  },
  ipcRenderer: electron.ipcRenderer,
  webUtils: { getPathForFile: vi.fn() },
}))

type ClerumBridge = {
  gfs: {
    listChildren: (
      resourceId: string,
      drive?: string,
      cursor?: string,
      options?: { signal?: AbortSignal }
    ) => Promise<unknown>
    download: (
      uri: string,
      options?: { maxBytes?: number; signal?: AbortSignal }
    ) => Promise<unknown>
    zipStream: {
      start: () => Promise<{ jobId: string }>
      appendFromUri: (
        jobId: string,
        name: string,
        uri: string,
        options?: { maxBytes?: number; signal?: AbortSignal }
      ) => Promise<unknown>
    }
  }
}

let bridge: ClerumBridge

/**
 * Settles a promise within `ms`, reporting a TIMEOUT instead of hanging. The
 * sentinel is a plain object so the assertion below can name the failure.
 */
const TIMEOUT = Symbol('timeout')
async function settleWithin<T>(promise: Promise<T>, ms = 250): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<typeof TIMEOUT>(resolve => {
    timer = setTimeout(() => resolve(TIMEOUT), ms)
  })
  try {
    return await Promise.race([promise.then(value => value), expiry])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

beforeAll(async () => {
  await import('../preload.js')
  bridge = electron.exposed.get('clerum') as ClerumBridge
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('preload cancellable GFS bridge (R2-L3)', () => {
  it('starts no IPC or producer work for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()

    // The rejection is awaited WITH A BOUND: against the pre-R2-L3 bridge
    // this call never settles, and the test must fail with an assertion
    // ("the bridge did not reject") rather than hang until the runner's
    // timeout.
    const listing = await settleWithin(
      bridge.gfs.listChildren('folder-1', 'main', undefined, { signal: controller.signal }).then(
        () => ({ settled: 'resolved' as const }),
        error => ({ settled: 'rejected' as const, error })
      )
    )
    expect(listing).not.toBe(TIMEOUT)
    expect(listing).toMatchObject({
      settled: 'rejected',
      error: { name: 'AbortError' },
    })

    const download = await settleWithin(
      bridge.gfs.download('gfs://main/x', { signal: controller.signal }).then(
        () => ({ settled: 'resolved' as const }),
        error => ({ settled: 'rejected' as const, error })
      )
    )
    expect(download).not.toBe(TIMEOUT)
    expect(download).toMatchObject({
      settled: 'rejected',
      error: { name: 'AbortError' },
    })

    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled()
  })

  it('carries a requestId, fires gfs:abort once on abort, and detaches on settle', async () => {
    const controller = new AbortController()
    const pending = bridge.gfs.listChildren('folder-1', 'main', undefined, {
      signal: controller.signal,
    })
    pending.catch(() => undefined)

    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1)
    const [channel, payload] = electron.ipcRenderer.invoke.mock.calls[0] as [
      string,
      { requestId?: string },
    ]
    expect(channel).toBe('gfs:listChildren')
    expect(typeof payload.requestId).toBe('string')

    controller.abort()
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('gfs:abort', {
      requestId: payload.requestId,
    })
    // A late synthetic abort event must not re-send after cleanup.
    controller.signal.dispatchEvent(new Event('abort'))
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1)
  })

  it('forwards the download bound and passes a signal-less call through untouched', async () => {
    electron.ipcRenderer.invoke.mockReturnValueOnce(Promise.resolve({ ok: true }))
    bridge.gfs.download('gfs://main/x', { maxBytes: 512, recordOpen: true })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('gfs:download', {
      uri: 'gfs://main/x',
      maxBytes: 512,
      recordOpen: true,
      requestId: undefined,
    })
  })

  it('cancels the folder-zip transfer through the same requestId channel (R1-H2)', async () => {
    // The zip transfer runs in the MAIN process, so the walk's stop has to
    // reach it: the preload attaches the requestId and fires gfs:abort.
    const controller = new AbortController()
    const pending = bridge.gfs.zipStream.appendFromUri('job-1', 'a/b.txt', 'gfs://main/b', {
      maxBytes: 1024,
      signal: controller.signal,
    })
    pending.catch(() => undefined)

    expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1)
    const [channel, payload] = electron.ipcRenderer.invoke.mock.calls[0] as [
      string,
      { jobId: string; name: string; uri: string; maxBytes?: number; requestId?: string },
    ]
    expect(channel).toBe('gfs:zipStream:appendFromUri')
    expect(payload.jobId).toBe('job-1')
    expect(payload.name).toBe('a/b.txt')
    expect(payload.uri).toBe('gfs://main/b')
    expect(payload.maxBytes).toBe(1024)
    expect(typeof payload.requestId).toBe('string')

    controller.abort()
    expect(electron.ipcRenderer.send).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith('gfs:abort', {
      requestId: payload.requestId,
    })
  })

  it('starts no IPC work for an already-aborted zip transfer (R2-L3)', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await settleWithin(
      bridge.gfs.zipStream
        .appendFromUri('job-1', 'a/b.txt', 'gfs://main/b', { signal: controller.signal })
        .then(
          () => ({ settled: 'resolved' as const }),
          error => ({ settled: 'rejected' as const, error })
        )
    )
    expect(outcome).not.toBe(TIMEOUT)
    expect(outcome).toMatchObject({
      settled: 'rejected',
      error: { name: 'AbortError' },
    })
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled()
  })
})
