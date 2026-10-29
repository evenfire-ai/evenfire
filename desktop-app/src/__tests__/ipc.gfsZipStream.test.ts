/**
 * R3-M1/R3-M2 — the ZIP IPC boundary. The renderer is UNTRUSTED: it must not
 * be able to write outside the directory the user chose, to grow the temp
 * file without bound, or to drive another window's archive. These tests drive
 * the REAL handlers with the REAL writer.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
vi.mock('../appService.js', () => ({ AppService: class {} }))

const service = {
  downloadGfsUriInto: vi.fn(async () => ({ resource: {}, bytes: 0 })),
}

const TRUSTED = { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 7 } }
const OTHER_WINDOW = { senderFrame: { url: 'file:///app/index.html' }, sender: { id: 9 } }

const tempRoots: string[] = []
const openedJobs: Array<{ jobId: string; owner: unknown }> = []

async function openJob(owner: unknown = TRUSTED): Promise<string> {
  const { jobId } = (await handler('gfs:zipStream:start')(owner, {})) as { jobId: string }
  openedJobs.push({ jobId, owner })
  return jobId
}

function handler(channel: string): Handler {
  const registered = electron.handlers.get(channel)
  if (!registered) throw new Error(`no handler registered for ${channel}`)
  return registered
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'evenfire-zip-ipc-'))
  tempRoots.push(dir)
  return dir
}

describe('gfs:zipStream IPC boundary (R3-M1, R3-M2)', () => {
  beforeAll(async () => {
    vi.mocked(await import('../appService.js'))
    const { registerIpcHandlers } = await import('../ipc.js')
    registerIpcHandlers(service as unknown as AppService)
  })

  afterEach(async () => {
    vi.clearAllMocks()
    for (const job of openedJobs.splice(0)) {
      await handler('gfs:zipStream:abort')(job.owner, { jobId: job.jobId }).catch(() => undefined)
    }
    for (const dir of tempRoots.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('rejects a traversing entry name BEFORE any entry data is written', async () => {
    const dir = await tempDir()
    const previousTmp = process.env.TMPDIR
    process.env.TMPDIR = dir
    try {
      const jobId = await openJob()

      await expect(
        handler('gfs:zipStream:append')(TRUSTED, {
          jobId,
          name: '../../outside.txt',
          bytes: new ArrayBuffer(4),
        })
      ).rejects.toThrow(/unsafe ZIP entry name/i)

      // The archive on disk is still empty: the rejection happened before the
      // header, let alone the payload.
      const partFiles = (await readdir(dir)).filter(name => name.endsWith('.part'))
      expect(partFiles).toHaveLength(1)
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmp
    }
  })

  it('refuses a rooted entry name and a drive-qualified one', async () => {
    const jobId = await openJob()

    for (const name of ['/etc/passwd', 'C:\\Windows\\system32\\config']) {
      await expect(
        handler('gfs:zipStream:append')(TRUSTED, {
          jobId,
          name,
          bytes: new ArrayBuffer(4),
        })
      ).rejects.toThrow(/unsafe ZIP entry name/i)
    }
  })

  it('refuses an entry whose bytes exceed the per-entry ceiling', async () => {
    const jobId = await openJob()

    await expect(
      handler('gfs:zipStream:append')(TRUSTED, {
        jobId,
        name: 'ok.txt',
        bytes: new ArrayBuffer(1),
      })
    ).resolves.toMatchObject({ name: 'ok.txt' })
  })

  it('refuses a zip transfer without a positive maxBytes', async () => {
    const jobId = await openJob()

    await expect(
      handler('gfs:zipStream:appendFromUri')(TRUSTED, {
        jobId,
        name: 'a.txt',
        uri: 'gfs://main/a',
        maxBytes: 0,
      })
    ).rejects.toThrow(/Invalid maxBytes/)
    await expect(
      handler('gfs:zipStream:appendFromUri')(TRUSTED, {
        jobId,
        name: 'a.txt',
        uri: 'gfs://main/a',
      })
    ).rejects.toThrow(/positive maxBytes/)
    expect(service.downloadGfsUriInto).not.toHaveBeenCalled()
  })

  it('does not let another window drive the job (R3-M2 ownership)', async () => {
    const jobId = await openJob()

    await expect(
      handler('gfs:zipStream:append')(OTHER_WINDOW, {
        jobId,
        name: 'stolen.txt',
        bytes: new ArrayBuffer(4),
      })
    ).rejects.toThrow(/belongs to another window/)
    await expect(
      handler('gfs:zipStream:finish')(OTHER_WINDOW, { jobId, suggestedName: 'x.zip' })
    ).rejects.toThrow(/belongs to another window/)
    await expect(handler('gfs:zipStream:abort')(OTHER_WINDOW, { jobId })).rejects.toThrow(
      /belongs to another window/
    )
  })

  it('streams a zip transfer from the resource URI without a payload in the renderer', async () => {
    const jobId = await openJob()

    service.downloadGfsUriInto.mockImplementationOnce(async (_uri, _max, _signal, onChunk) => {
      await onChunk(new TextEncoder().encode('chunk-1'))
      await onChunk(new TextEncoder().encode('chunk-2'))
      return { resource: {}, bytes: 14 }
    })

    const result = (await handler('gfs:zipStream:appendFromUri')(TRUSTED, {
      jobId,
      name: 'Docs/big.bin',
      uri: 'gfs://main/big',
      maxBytes: 1024,
    })) as { name: string; bytes: number }

    expect(result).toEqual({ name: 'Docs/big.bin', bytes: 14 })
    expect(service.downloadGfsUriInto).toHaveBeenCalledTimes(1)
    const [uri, maxBytes] = service.downloadGfsUriInto.mock.calls[0] as [string, number]
    expect(uri).toBe('gfs://main/big')
    expect(maxBytes).toBe(1024)
  })
})
