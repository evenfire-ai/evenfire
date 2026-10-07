import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { downloadGfsContent } from './gfsContentDownload'
import { readGfsMetadata } from './gfsContentRead'
import { GfsDownloadStore } from './gfsDownloadStore'

const args = { drive: 'main', resourceId: 'a'.repeat(32) }
const uri = `gfs://main/${args.resourceId}`
let hostRoot: string
let callerRoot: string
let store: GfsDownloadStore

function metadata(size: number, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        ...args,
        rid: args.resourceId,
        gfsUri: uri,
        kind: 'file',
        name: 'input.csv',
        version: 4,
        bytes: size,
        ...overrides,
      },
    }),
    { headers: { 'content-type': 'application/json' } }
  )
}

function contentHeaders(size: number, overrides: Record<string, string | undefined> = {}) {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  ) as Record<string, string>
  const headers = {
    'content-length': String(size),
    'x-gfs-uri': uri,
    'x-gfs-version': '4',
    ...defined,
  }
  if ('content-length' in overrides && overrides['content-length'] === undefined)
    delete (headers as { 'content-length'?: string })['content-length']
  return headers
}

function harness(
  bytes: Uint8Array,
  changes: {
    metadata?: Record<string, unknown>
    headers?: Record<string, string | undefined>
    body?: ReadableStream<Uint8Array>
  } = {}
) {
  return vi.fn(async (url: string) =>
    url.includes('/content?')
      ? new Response(changes.body ?? new Uint8Array(bytes), {
          headers: contentHeaders(bytes.byteLength, changes.headers),
        })
      : metadata(bytes.byteLength, changes.metadata)
  )
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    store,
    callerIdentity: 'caller-a',
    callerWorkspacePath: callerRoot,
    ...overrides,
  }
}

async function retainedDirectories(): Promise<string[]> {
  return fs.readdir(path.join(callerRoot, '.gfs-downloads')).catch(() => [])
}

beforeEach(async () => {
  hostRoot = await fs.mkdtemp(path.join(tmpdir(), 'gfs-download-test-'))
  callerRoot = path.join(hostRoot, 'users', 'caller-a')
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
  store = new GfsDownloadStore(hostRoot)
  await store.initialize()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await fs.rm(hostRoot, { recursive: true, force: true })
})

describe('governed GFS content download', () => {
  it('streams the exact incident-sized CSV and returns only a bounded receipt', async () => {
    const bytes = Buffer.alloc(3_836_961, 65)
    const result = await downloadGfsContent(harness(bytes), args, options())

    expect(await fs.readFile(path.join(callerRoot, result.path))).toEqual(bytes)
    expect(result).toMatchObject({
      sizeBytes: 3_836_961,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(result.source.version).toBe(4)
    expect(JSON.stringify(result)).not.toContain('AAAAAAA')
    expect(JSON.stringify(result).length).toBeLessThan(4096)
    expect((await fs.stat(path.join(callerRoot, result.path))).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.dirname(path.join(callerRoot, result.path)))).mode & 0o777).toBe(
      0o700
    )
    // The durable 3.8 MB publication measured 7.7 s on a loaded host.
  }, 30_000)

  it('waits for each partial write before pulling more content', async () => {
    let finish!: () => void
    const finalChunk = new Promise<void>(resolve => {
      finish = resolve
    })
    let firstWritten!: () => void
    const started = new Promise<void>(resolve => {
      firstWritten = resolve
    })
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            return
          }
          await finalChunk
          controller.enqueue(new Uint8Array([4, 5, 6]))
          controller.close()
        },
      },
      { highWaterMark: 0 }
    )
    const probe = await fs.open(path.join(callerRoot, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    const original = prototype.write
    vi.spyOn(prototype, 'write').mockImplementation(async function (
      this: fs.FileHandle,
      ...values: unknown[]
    ) {
      const written = await original.apply(this, values)
      firstWritten()
      return written
    })

    const pending = downloadGfsContent(harness(new Uint8Array(6), { body }), args, options())
    await started
    const [directory] = await retainedDirectories()
    expect(
      await fs.readFile(path.join(callerRoot, '.gfs-downloads', directory, 'source.partial'))
    ).toEqual(Buffer.from([1, 2, 3]))
    finish()
    const result = await pending
    expect(await fs.readFile(path.join(callerRoot, result.path))).toEqual(
      Buffer.from([1, 2, 3, 4, 5, 6])
    )
  })

  it('rejects a source over the configured general limit before content', async () => {
    const request = harness(new Uint8Array(0), {
      metadata: { bytes: 16 * 1024 * 1024 + 1 },
    })
    await expect(downloadGfsContent(request, args, options())).rejects.toMatchObject({
      code: 'limit_exceeded',
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ 'x-gfs-version': '5' }, 'version_conflict'],
    [{ 'x-gfs-uri': 'gfs://main/other' }, 'identity_mismatch'],
    [{ 'content-length': '4' }, 'incomplete_response'],
    [{ 'content-encoding': 'gzip' }, 'invalid_response'],
    [{ 'content-length': undefined }, 'incomplete_response'],
  ])('does not publish inconsistent content headers: %j', async (changed, code) => {
    await expect(
      downloadGfsContent(
        harness(new Uint8Array(3), {
          headers: changed,
        }),
        args,
        options()
      )
    ).rejects.toMatchObject({ code })
    expect(await retainedDirectories()).toEqual([])
  })

  it.each([
    [2, 'incomplete_response'],
    [4, 'limit_exceeded'],
  ])('removes truncated or oversized content (%i bytes)', async (length, code) => {
    const request = vi.fn(async (url: string) =>
      url.includes('/content?')
        ? new Response(new Uint8Array(length), { headers: contentHeaders(3) })
        : metadata(3)
    )
    await expect(downloadGfsContent(request, args, options())).rejects.toMatchObject({ code })
    expect(await retainedDirectories()).toEqual([])
  })

  it('cancels an in-progress stream, removes the partial, and frees the slot', async () => {
    const controller = new AbortController()
    let pulled!: () => void
    const started = new Promise<void>(resolve => {
      pulled = resolve
    })
    let count = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          if (count++ === 0) stream.enqueue(new Uint8Array([1]))
          else pulled()
        },
      },
      { highWaterMark: 0 }
    )
    const pending = downloadGfsContent(
      harness(new Uint8Array(2), { body }),
      args,
      options({ signal: controller.signal })
    )
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await started
    controller.abort()
    await rejected
    expect(await retainedDirectories()).toEqual([])
    await downloadGfsContent(harness(new Uint8Array([1])), args, options())
  })

  it('enforces an absolute deadline when the request callback ignores abort', async () => {
    vi.useFakeTimers()
    const request = vi.fn(() => new Promise<Response>(() => undefined))
    const rejected = expect(
      downloadGfsContent(request, args, options({ timeoutMs: 10 }))
    ).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(11)
    await rejected
  })

  it('applies its own metadata deadline even without an external signal', async () => {
    vi.useFakeTimers()
    const request = vi.fn(() => new Promise<Response>(() => undefined))
    const rejected = expect(
      readGfsMetadata(request, args, { timeoutMs: 10 })
    ).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(11)
    await rejected
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects redirects and preserves authoritative GFSC denials', async () => {
    const redirected = metadata(0)
    Object.defineProperty(redirected, 'redirected', { value: true })
    await expect(
      downloadGfsContent(
        vi.fn(async () => redirected),
        args,
        options()
      )
    ).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(
      downloadGfsContent(
        vi.fn(async () => new Response('forbidden', { status: 403 })),
        args,
        options()
      )
    ).rejects.toThrow('gfsc 403')
    expect(await retainedDirectories()).toEqual([])
  })

  it('does not publish when file sync is released after abort', async () => {
    const controller = new AbortController()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const probe = await fs.open(path.join(callerRoot, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle
    await probe.close()
    let releaseSync!: () => void
    const syncBlocked = new Promise<void>(resolve => {
      releaseSync = resolve
    })
    let syncEntered!: () => void
    const syncStarted = new Promise<void>(resolve => {
      syncEntered = resolve
    })
    let heldSync = false
    const originalSync = prototype.sync
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: fs.FileHandle) {
      const info = await this.stat()
      if (!heldSync && info.isFile() && info.size === bytes.byteLength) {
        heldSync = true
        syncEntered()
        await syncBlocked
      }
      return originalSync.call(this)
    })

    const pending = downloadGfsContent(harness(bytes), args, options({ signal: controller.signal }))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await syncStarted
    controller.abort()
    releaseSync()
    await rejected
    expect(await retainedDirectories()).toEqual([])
    expect(store.debugUsage()).toMatchObject({ bytes: 0, files: 0 })
    await downloadGfsContent(harness(new Uint8Array([1])), args, options())
  })

  it('does not commit a publication released after abort', async () => {
    const controller = new AbortController()
    const bytes = new Uint8Array([9, 8, 7])
    const probe = await fs.open(path.join(callerRoot, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle
    await probe.close()
    let releaseRead!: () => void
    const readBlocked = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    let readEntered!: () => void
    const readStarted = new Promise<void>(resolve => {
      readEntered = resolve
    })
    let heldRead = false
    const originalRead = prototype.read
    vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: fs.FileHandle,
      ...values: unknown[]
    ) {
      const info = await this.stat()
      if (!heldRead && info.isFile() && info.size === bytes.byteLength) {
        heldRead = true
        readEntered()
        await readBlocked
      }
      return originalRead.apply(this, values as never)
    })

    const pending = downloadGfsContent(harness(bytes), args, options({ signal: controller.signal }))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await readStarted
    controller.abort()
    releaseRead()
    await rejected
    expect(await retainedDirectories()).toEqual([])
    expect(store.debugUsage()).toMatchObject({ bytes: 0, files: 0 })
    await downloadGfsContent(harness(new Uint8Array([1])), args, options())
  })

  it('keeps quota reserved when cancellation cleanup fails', async () => {
    const controller = new AbortController()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const probe = await fs.open(path.join(callerRoot, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as fs.FileHandle
    await probe.close()
    let releaseSync!: () => void
    const syncBlocked = new Promise<void>(resolve => {
      releaseSync = resolve
    })
    let syncEntered!: () => void
    const syncStarted = new Promise<void>(resolve => {
      syncEntered = resolve
    })
    let heldSync = false
    const originalSync = prototype.sync
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: fs.FileHandle) {
      const info = await this.stat()
      if (!heldSync && info.isFile() && info.size === bytes.byteLength) {
        heldSync = true
        syncEntered()
        await syncBlocked
      }
      return originalSync.call(this)
    })

    const pending = downloadGfsContent(harness(bytes), args, options({ signal: controller.signal }))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await syncStarted
    const [name] = await retainedDirectories()
    const directory = path.join(callerRoot, '.gfs-downloads', name)
    await fs.rename(directory, `${directory}.parked`)
    await fs.writeFile(directory, 'not-a-directory')
    controller.abort()
    releaseSync()
    await rejected
    expect(store.debugUsage()).toMatchObject({ bytes: bytes.byteLength, files: 1 })
    const ledger = JSON.parse(
      await fs.readFile(path.join(hostRoot, '.gfs-download-store', 'ledger-v1.json'), 'utf8')
    ) as { records: Record<string, { state: string; sha256?: string }> }
    const [record] = Object.values(ledger.records)
    expect(record?.state).toBe('cleanup_failed')
    expect(record?.sha256).toBeUndefined()
    await expect(
      downloadGfsContent(harness(new Uint8Array([1])), args, options())
    ).resolves.toMatchObject({
      sizeBytes: 1,
    })
  })

  it('reuses a verified copy only after fresh authorization without renewing its TTL', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const request = vi.fn(harness(bytes))
    const first = await downloadGfsContent(request, args, options())
    const usage = store.debugUsage()
    const second = await downloadGfsContent(request, args, options())

    expect(second).toEqual(first)
    expect(second.expiresAt).toBe(first.expiresAt)
    expect(store.debugUsage()).toEqual(usage)
    expect(request.mock.calls).toHaveLength(3)
    expect(request.mock.calls.filter(([url]) => url.includes('/content?'))).toHaveLength(1)
  })

  it('does not reuse retained bytes after upstream permission is revoked', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    await downloadGfsContent(harness(bytes), args, options())
    const request = vi.fn(async () => new Response('denied', { status: 403 }))

    await expect(downloadGfsContent(request, args, options())).rejects.toThrow('gfsc 403')
    expect(request).toHaveBeenCalledOnce()
    expect(store.debugUsage()).toMatchObject({ bytes: bytes.byteLength, files: 1 })
  })

  it('does not substitute a retained version for a newly stale reference', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    await downloadGfsContent(harness(bytes), args, options({ expectedVersion: 4 }))
    const request = vi.fn(harness(bytes, { metadata: { version: 5 } }))

    await expect(
      downloadGfsContent(request, args, options({ expectedVersion: 4 }))
    ).rejects.toMatchObject({
      code: 'version_conflict',
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it('replaces an invalid cached copy through the authorized source and keeps old bytes accounted', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const first = await downloadGfsContent(harness(bytes), args, options())
    await fs.writeFile(path.join(callerRoot, first.path), new Uint8Array([3, 2, 1]))
    const request = vi.fn(harness(bytes))
    const second = await downloadGfsContent(request, args, options())

    expect(second.id).not.toBe(first.id)
    expect(second.sha256).toBe(first.sha256)
    expect(request).toHaveBeenCalledTimes(2)
    expect(store.debugRecord(first.id)?.state).toBe('missing')
    expect(store.debugUsage()).toMatchObject({ bytes: bytes.byteLength * 2, files: 2 })
    await expect(store.readManagedFile(second.path, 'caller-a')).resolves.toEqual(
      Buffer.from(bytes)
    )
  })
})
