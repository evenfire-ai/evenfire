// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  GFS_ZIP_MAX_ENTRIES,
  type GfsFolderZipDeps,
  GfsFolderZipEmptyError,
  GfsFolderZipLimitError,
  type GfsFolderZipProgress,
  type GfsZipChildItem,
  type GfsZipChildrenPage,
  createGfsFolderZip,
  createGfsReadThrottle,
} from '../gfsFolderZip'

interface ManualClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Resolves one pending sleep and advances the clock by its delay. */
  advanceOne: () => boolean
  pending: () => number
}

function manualClock(): ManualClock {
  let current = 1_000_000
  const wakeups: Array<{ delayMs: number; wake: () => void }> = []
  return {
    now: () => current,
    sleep: ms =>
      new Promise<void>(resolve => {
        wakeups.push({ delayMs: ms, wake: () => resolve() })
      }),
    advanceOne: () => {
      const next = wakeups.shift()
      if (!next) return false
      current += next.delayMs
      next.wake()
      return true
    },
    pending: () => wakeups.length,
  }
}

function folder(
  overrides: Partial<GfsZipChildItem> & { resourceId: string; name: string }
): GfsZipChildItem {
  return {
    gfsUri: `gfs://main/${overrides.resourceId}`,
    kind: 'file',
    bytes: 4,
    drive: 'main',
    ...overrides,
  }
}

export interface RecordedZipStream {
  appended: Array<{ name: string; bytes: ArrayBuffer }>
  finishedWith: Array<{ suggestedName: string }>
  abortedJobs: string[]
  deps: import('../gfsFolderZip').GfsZipStreamDeps
}

/** File-backed stream fake: records appends, finishes "saved" to a path. */
function recordedZipStream(options: { saved?: boolean } = {}): RecordedZipStream {
  const appended: Array<{ name: string; bytes: ArrayBuffer }> = []
  const finishedWith: Array<{ suggestedName: string }> = []
  const abortedJobs: string[] = []
  let jobCounter = 0
  return {
    appended,
    finishedWith,
    abortedJobs,
    deps: {
      start: vi.fn(async () => ({ jobId: `job-${++jobCounter}` })),
      append: vi.fn(async (jobId: string, name: string, bytes: ArrayBuffer) => {
        void jobId
        appended.push({ name, bytes })
      }),
      finish: vi.fn(async (jobId: string, suggestedName: string) => {
        void jobId
        finishedWith.push({ suggestedName })
        return {
          saved: options.saved ?? true,
          filePath: options.saved === false ? null : `/saved/${suggestedName}`,
          entryCount: appended.length,
        }
      }),
      abort: vi.fn(async (jobId: string) => {
        abortedJobs.push(jobId)
      }),
    },
  }
}

function streamEntryNames(stream: RecordedZipStream): string[] {
  return stream.appended.map(entry => entry.name)
}

function depsFor(
  pages: Record<string, Array<{ items: GfsZipChildItem[]; nextCursor: string | null }>>,
  downloads: Record<
    string,
    (uri: string, options?: { maxBytes?: number }) => Promise<{ bytes: ArrayBuffer }>
  > = {},
  streamOptions: { saved?: boolean } = {}
): GfsFolderZipDeps & { zipStreamRecord: RecordedZipStream } {
  const stream = recordedZipStream(streamOptions)
  return {
    listChildren: vi.fn(async (resourceId: string, _drive: string, cursor?: string) => {
      const pageList = pages[resourceId]
      if (!pageList) throw new Error(`unexpected listChildren for ${resourceId}`)
      const index = cursor ? Number(cursor) : 0
      const page = pageList[index]
      if (!page) throw new Error(`no page ${index} for ${resourceId}`)
      return { items: page.items, nextCursor: page.nextCursor }
    }),
    download: vi.fn(async (uri: string, options?: { maxBytes?: number }) => {
      const produce = downloads[uri]
      if (produce) return produce(uri, options)
      return { bytes: bytesOf(uri) }
    }),
    zipStream: stream.deps,
    // Spacing itself has a dedicated manual-clock test below the walk; here it
    // is a no-op so the orchestration tests run instantly.
    throttle: { acquire: async () => undefined },
    sleep: async () => undefined,
    zipStreamRecord: stream,
  }
}

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

describe('createGfsReadThrottle', () => {
  it('spaces requests to the 120/min budget with the injected clock', async () => {
    const clock = manualClock()
    const throttle = createGfsReadThrottle({ now: clock.now, sleep: clock.sleep })
    const timings: number[] = []

    const job = (async () => {
      for (let index = 0; index < 4; index += 1) {
        await throttle.acquire()
        timings.push(clock.now())
      }
    })()

    // Drive the clock until the job is done: resolve a pending sleep when one
    // exists, otherwise let microtasks run so the job can arm the next one.
    while (timings.length < 4) {
      if (!clock.advanceOne()) await Promise.resolve()
    }
    await job

    expect(timings).toEqual([1_000_000, 1_000_500, 1_001_000, 1_001_500])
  })
})

describe('createGfsFolderZip', () => {
  it('walks nested folders with pagination and archives every readable file', async () => {
    const deps = depsFor({
      'folder-root': [
        { items: [folder({ resourceId: 'a', name: 'a.txt' })], nextCursor: '1' },
        {
          items: [
            folder({ resourceId: 'sub', name: 'sub', kind: 'directory' }),
            folder({ resourceId: 'b', name: 'b.png' }),
          ],
          nextCursor: null,
        },
      ],
      sub: [{ items: [folder({ resourceId: 'c', name: 'c.md' })], nextCursor: null }],
    })
    const progress: GfsFolderZipProgress[] = []
    const result = await createGfsFolderZip(
      { resourceId: 'folder-root', drive: 'main', name: 'Docs' },
      {
        deps,
        onProgress: value => progress.push(value),
      }
    )

    expect(result.fileName).toBe('Docs.zip')
    expect(result.fileCount).toBe(3)
    expect(result.skipped).toEqual([])
    expect(deps.listChildren).toHaveBeenCalledWith('folder-root', 'main', undefined, {
      signal: undefined,
    })
    expect(deps.listChildren).toHaveBeenCalledWith('folder-root', 'main', '1', {
      signal: undefined,
    })
    expect(deps.listChildren).toHaveBeenCalledWith('sub', 'main', undefined, { signal: undefined })

    expect(result.saved).toBe(true)
    expect(result.savedPath).toBe('/saved/Docs.zip')
    expect(streamEntryNames(deps.zipStreamRecord).sort()).toEqual(
      ['Docs/a.txt', 'Docs/b.png', 'Docs/sub/c.md'].sort()
    )
    expect(progress.map(value => value.phase)).toContain('downloading')
    expect(progress.at(-1)?.phase).toBe('assembling')
    // The "downloading N of M" copy is 1-based: file 1 reports filesAdded 1.
    expect(
      progress.filter(value => value.phase === 'downloading').map(value => value.filesAdded)
    ).toEqual([1, 2, 3])
  })

  it('skips unreadable rows and 403 downloads with visible reasons', async () => {
    const deps = depsFor(
      {
        root: [
          {
            items: [
              folder({
                resourceId: 'hidden-dir',
                name: 'hidden-dir',
                kind: 'directory',
                readable: false,
              }),
              folder({ resourceId: 'hidden', name: 'hidden.txt', readable: false }),
              folder({ resourceId: 'denied', name: 'denied.txt' }),
              folder({ resourceId: 'ok', name: 'ok.txt' }),
            ],
            nextCursor: null,
          },
        ],
      },
      {
        'gfs://main/ok': async () => ({ bytes: bytesOf('fine') }),
        'gfs://main/denied': async () => {
          throw new Error('gfs download failed: 403 httpStatus=403 forbidden')
        },
      }
    )

    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Mixed' },
      { deps }
    )

    expect(result.fileCount).toBe(1)
    expect(result.skipped).toEqual([
      { path: 'Mixed/hidden-dir', reason: 'No access' },
      { path: 'Mixed/hidden.txt', reason: 'No access' },
      { path: 'Mixed/denied.txt', reason: 'Permission denied' },
    ])
    expect(streamEntryNames(deps.zipStreamRecord)).toEqual(['Mixed/ok.txt'])
  })

  it('skips a subfolder whose listing itself is denied and continues the walk', async () => {
    const deps: GfsFolderZipDeps = {
      listChildren: vi.fn(async (resourceId: string) => {
        if (resourceId === 'root')
          return {
            items: [folder({ resourceId: 'locked', name: 'locked', kind: 'directory' })],
            nextCursor: null,
          }
        throw new Error("Error invoking remote method 'gfs:listChildren': Error: httpStatus=403")
      }),
      download: async () => ({ bytes: bytesOf('x') }),
      throttle: { acquire: async () => undefined },
      sleep: async () => undefined,
      zipStream: recordedZipStream().deps,
    }

    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Root' },
      { deps }
    ).catch(error => error)

    // Nothing archivable: the walk short-circuits as empty (L8), carrying the
    // skip so the caller can still explain why.
    expect(result).toBeInstanceOf(GfsFolderZipEmptyError)
    expect((result as GfsFolderZipEmptyError).skipped).toEqual([
      { path: 'Root/locked', reason: 'Permission denied' },
    ])
  })

  it('refuses over the declared byte ceiling with a clear message', async () => {
    const deps = depsFor({
      root: [
        {
          items: [
            folder({ resourceId: 'big', name: 'big.bin', bytes: 600 }),
            folder({ resourceId: 'big2', name: 'big2.bin', bytes: 600 }),
          ],
          nextCursor: null,
        },
      ],
    })

    await expect(
      createGfsFolderZip(
        { resourceId: 'root', drive: 'main', name: 'Huge' },
        { deps, limits: { maxTotalBytes: 1024 } }
      )
    ).rejects.toBeInstanceOf(GfsFolderZipLimitError)
    await expect(
      createGfsFolderZip(
        { resourceId: 'root', drive: 'main', name: 'Huge' },
        { deps, limits: { maxTotalBytes: 1024 } }
      )
    ).rejects.toThrow(/exceeds the 1 KiB folder-zip limit/)
  })

  it('refuses over the declared entry ceiling', async () => {
    expect(GFS_ZIP_MAX_ENTRIES).toBeGreaterThan(0)
    const deps = depsFor({
      root: [
        {
          items: [
            folder({ resourceId: 'one', name: 'one.txt' }),
            folder({ resourceId: 'two', name: 'two.txt' }),
            folder({ resourceId: 'three', name: 'three.txt' }),
          ],
          nextCursor: null,
        },
      ],
    })

    await expect(
      createGfsFolderZip(
        { resourceId: 'root', drive: 'main', name: 'Many' },
        { deps, limits: { maxEntries: 2 } }
      )
    ).rejects.toThrow(/more than 2 entries/)
  })

  it('counts DIRECTORIES against the entry budget, bounding folder-only walks (R1-M3)', async () => {
    // 2001 empty folders used to pass the file-only budget: every one of them
    // would then cost a listing request against the shared read budget.
    const deps = depsFor({
      root: [
        {
          items: Array.from({ length: GFS_ZIP_MAX_ENTRIES + 1 }, (_, index) =>
            folder({ resourceId: `empty-${index}`, name: `empty-${index}`, kind: 'directory' })
          ),
          nextCursor: null,
        },
      ],
    })

    await expect(
      createGfsFolderZip({ resourceId: 'root', drive: 'main', name: 'Hive' }, { deps })
    ).rejects.toThrow(
      new RegExp(`more than ${GFS_ZIP_MAX_ENTRIES} entries \\(files and folders\\)`)
    )
    // Bounded work: the refusal fires inside the FIRST listing page.
    expect(deps.listChildren).toHaveBeenCalledTimes(1)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('forwards the stop signal to the producer bridge on both call kinds (R1-M1)', async () => {
    const controller = new AbortController()
    const listChildren = vi.fn(
      (
        _resourceId: string,
        _drive?: string,
        _cursor?: string,
        _options?: { signal?: AbortSignal }
      ) => new Promise<GfsZipChildrenPage>(() => undefined)
    )
    const download = vi.fn(async () => ({ bytes: new ArrayBuffer(4) }))
    const previousClerum = (window as { clerum?: unknown }).clerum
    ;(window as { clerum?: unknown }).clerum = { gfs: { listChildren, download } }

    try {
      const walk = createGfsFolderZip(
        { resourceId: 'root', drive: 'main', name: 'Bridge' },
        { signal: controller.signal }
      )
      const rejection = expect(walk).rejects.toMatchObject({ name: 'AbortError' })
      for (let index = 0; index < 200 && listChildren.mock.calls.length === 0; index += 1)
        await Promise.resolve()
      const bridgeOptions = listChildren.mock.calls[0]?.[3] as { signal?: AbortSignal } | undefined
      // The default wiring hands the walk's signal to the bridge, so the
      // producer fetch dies with the walk instead of outliving the Stop.
      expect(bridgeOptions?.signal).toBeInstanceOf(AbortSignal)
      expect(bridgeOptions?.signal?.aborted).toBe(false)
      controller.abort()
      await rejection
      expect(bridgeOptions?.signal?.aborted).toBe(true)
    } finally {
      ;(window as { clerum?: unknown }).clerum = previousClerum
    }
  })

  it('aborts the stream job on any failure path so no temp file survives (R1-H2)', async () => {
    const stream = recordedZipStream()
    const deps: GfsFolderZipDeps = {
      listChildren: vi.fn(async () => ({
        items: [folder({ resourceId: 'doomed', name: 'doomed.txt' })],
        nextCursor: null,
      })),
      download: async () => {
        throw new Error('gfs download failed: 500 httpStatus=500')
      },
      zipStream: stream.deps,
      throttle: { acquire: async () => undefined },
      sleep: async () => undefined,
    }
    await expect(
      createGfsFolderZip({ resourceId: 'root', drive: 'main', name: 'Broken' }, { deps })
    ).rejects.toThrow(/500/)
    // The job was started, nothing was appended, and the temp file was told
    // to clean up through the abort channel.
    expect(stream.deps.start).toHaveBeenCalledTimes(1)
    expect(stream.appended).toHaveLength(0)
    expect(stream.abortedJobs).toHaveLength(1)

    // Stop mid-walk takes the same cleanup path.
    const stopStream = recordedZipStream()
    const controller = new AbortController()
    const stopDeps: GfsFolderZipDeps = {
      listChildren: vi.fn(async () => ({
        items: [folder({ resourceId: 'first', name: 'first.txt' })],
        nextCursor: null,
      })),
      download: () => new Promise<{ bytes: ArrayBuffer }>(() => undefined),
      zipStream: stopStream.deps,
      throttle: { acquire: async () => undefined },
      sleep: async () => undefined,
    }
    const walk = createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Stopped' },
      { deps: stopDeps, signal: controller.signal }
    )
    const rejection = expect(walk).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(stopStream.abortedJobs).toHaveLength(1)
  })

  it('skips entries whose complete path would overflow the 16-bit ZIP name field (R1-M2)', async () => {
    // A 110-deep chain of 700-byte segment names crosses 65535 assembled
    // bytes around depth ~93: the overlong child is skipped (visible notice,
    // shortened path) and its subtree is pruned, so the walk stays bounded.
    const longName = 'a'.repeat(700)
    const depth = 110
    const pages: Record<string, Array<{ items: GfsZipChildItem[]; nextCursor: null }>> = {}
    const chainChild = (index: number) =>
      index === depth - 1
        ? folder({ resourceId: 'leaf', name: 'leaf.txt', kind: 'file' })
        : folder({ resourceId: `f${index}`, name: longName, kind: 'directory' })
    pages.root = [{ items: [chainChild(0)], nextCursor: null }]
    for (let index = 0; index < depth - 1; index += 1) {
      pages[`f${index}`] = [{ items: [chainChild(index + 1)], nextCursor: null }]
    }
    const deps = depsFor(pages)

    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Deep' },
      { deps }
    ).catch(error => error)

    // The only file lived under the pruned subtree: nothing archivable, and
    // the skip notice explains why with a path a human can read.
    expect(result).toBeInstanceOf(GfsFolderZipEmptyError)
    const skipped = (result as GfsFolderZipEmptyError).skipped
    expect(skipped[0]?.reason).toBe('Path too long')
    expect(skipped[0]?.path.length).toBeLessThan(120)
    // The walk terminated at the overflow depth instead of chasing all 110
    // levels: bounded listing work, no downloads.
    const listingCalls = vi.mocked(deps.listChildren).mock.calls.length
    expect(listingCalls).toBeLessThanOrEqual(110)
    expect(listingCalls).toBeGreaterThanOrEqual(90)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('refuses when the actual downloaded bytes exceed the ceiling', async () => {
    const deps = depsFor(
      {
        root: [
          {
            items: [folder({ resourceId: 'lied', name: 'lied.bin', bytes: 1 })],
            nextCursor: null,
          },
        ],
      },
      { 'gfs://main/lied': async () => ({ bytes: new ArrayBuffer(2048) }) }
    )

    await expect(
      createGfsFolderZip(
        { resourceId: 'root', drive: 'main', name: 'Sneaky' },
        { deps, limits: { maxTotalBytes: 1024 } }
      )
    ).rejects.toThrow(/exceeded the 1 KiB folder-zip limit while downloading/)
  })

  it('bounds each transfer producer-side by the remaining budget (R1-H2)', async () => {
    // Declared size missing (older server) + a dishonestly large body: the
    // bounded fetch must refuse BEFORE the body materializes — the walk's
    // only obligation after that is mapping the refusal to the limit error.
    const deps = depsFor(
      {
        root: [
          {
            items: [
              folder({
                resourceId: 'ghost',
                name: 'ghost.bin',
                bytes: undefined as unknown as number,
              }),
            ],
            nextCursor: null,
          },
        ],
      },
      {
        'gfs://main/ghost': async (uri: string, options?: { maxBytes?: number }) => {
          expect(options?.maxBytes).toBe(1024)
          throw new Error('gfs download exceeds the 1024-byte limit httpStatus=413')
        },
      }
    )

    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Ghost' },
      { deps, limits: { maxTotalBytes: 1024 } }
    ).catch(error => error)
    // R2-L2: a producer-refused body no longer kills the job — the file is
    // skipped with a visible reason and the walk terminates cleanly.
    expect(result).toBeInstanceOf(GfsFolderZipEmptyError)
    expect((result as GfsFolderZipEmptyError).skipped).toEqual([
      { path: 'Ghost/ghost.bin', reason: 'Zip byte limit reached' },
    ])
  })

  it('stops before the next transfer at exact budget exhaustion, never maxBytes 0 (R2-L2)', async () => {
    // Missing declared sizes: the first file honestly consumes the whole
    // budget; the two behind it must never be requested (a zero bound is an
    // invalid IPC), and the archive finishes with a visible notice per file.
    const seenBounds: Array<number | undefined> = []
    const deps = depsFor(
      {
        root: [
          {
            items: [
              folder({
                resourceId: 'fill',
                name: 'fill.bin',
                bytes: undefined as unknown as number,
              }),
              folder({
                resourceId: 'after-a',
                name: 'after-a.bin',
                bytes: undefined as unknown as number,
              }),
              folder({
                resourceId: 'after-b',
                name: 'after-b.bin',
                bytes: undefined as unknown as number,
              }),
            ],
            nextCursor: null,
          },
        ],
      },
      {
        'gfs://main/fill': async (_uri: string, options?: { maxBytes?: number }) => {
          seenBounds.push(options?.maxBytes)
          return { bytes: new ArrayBuffer(1024) }
        },
        'gfs://main/after-a': async (_uri: string, options?: { maxBytes?: number }) => {
          seenBounds.push(options?.maxBytes)
          return { bytes: new ArrayBuffer(1) }
        },
        'gfs://main/after-b': async (_uri: string, options?: { maxBytes?: number }) => {
          seenBounds.push(options?.maxBytes)
          return { bytes: new ArrayBuffer(1) }
        },
      }
    )

    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Exact' },
      { deps, limits: { maxTotalBytes: 1024 } }
    )

    expect(seenBounds).toEqual([1024])
    expect(result.fileCount).toBe(1)
    expect(result.skipped).toEqual([
      { path: 'Exact/after-a.bin', reason: 'Zip byte limit reached' },
      { path: 'Exact/after-b.bin', reason: 'Zip byte limit reached' },
    ])
    expect(streamEntryNames(deps.zipStreamRecord)).toEqual(['Exact/fill.bin'])
  })

  it('carries a near-limit folder through download, zip and save-sized output (R1-H2)', async () => {
    // Two honest files at half the ceiling each: the second transfer is
    // bounded by exactly the remaining budget and both land in the archive.
    const seenMaxBytes: Array<number | undefined> = []
    const deps = depsFor(
      {
        root: [
          {
            items: [
              folder({ resourceId: 'half-a', name: 'half-a.bin', bytes: 512 }),
              folder({ resourceId: 'half-b', name: 'half-b.bin', bytes: 512 }),
            ],
            nextCursor: null,
          },
        ],
      },
      {
        'gfs://main/half-a': async (_uri: string, options?: { maxBytes?: number }) => {
          seenMaxBytes.push(options?.maxBytes)
          return { bytes: new ArrayBuffer(512) }
        },
        'gfs://main/half-b': async (_uri: string, options?: { maxBytes?: number }) => {
          seenMaxBytes.push(options?.maxBytes)
          return { bytes: new ArrayBuffer(512) }
        },
      }
    )

    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Brink' },
      { deps, limits: { maxTotalBytes: 1024 } }
    )
    expect(result.fileCount).toBe(2)
    expect(seenMaxBytes).toEqual([1024, 512])
    expect(result.saved).toBe(true)
    expect(streamEntryNames(deps.zipStreamRecord)).toHaveLength(2)
  })

  it('backs off once on a 429 using the server-provided retry hint', async () => {
    let attempts = 0
    const deps: GfsFolderZipDeps = {
      listChildren: vi.fn(async () => {
        attempts += 1
        if (attempts === 1)
          throw new Error('gfs children failed: 429 httpStatus=429 retryAfterSeconds=2')
        return { items: [], nextCursor: null }
      }),
      download: async () => ({ bytes: new ArrayBuffer(0) }),
      throttle: { acquire: async () => undefined },
      sleep: async () => undefined,
      zipStream: recordedZipStream().deps,
    }

    // The retry succeeds but finds nothing archivable → empty short-circuit.
    await expect(
      createGfsFolderZip({ resourceId: 'root', drive: 'main', name: 'Throttled' }, { deps })
    ).rejects.toThrow(/no downloadable files/)
    expect(attempts).toBe(2)
  })

  it('stops before the first request when the signal is aborted mid-wait (M3)', async () => {
    const listChildren = vi.fn(async () => ({ items: [], nextCursor: null }))
    const controller = new AbortController()
    const deps: GfsFolderZipDeps = {
      listChildren,
      download: async () => ({ bytes: new ArrayBuffer(0) }),
      zipStream: recordedZipStream().deps,
      // The first slot never frees: the walk parks here until the stop lands.
      throttle: { acquire: () => new Promise<void>(() => undefined) },
      sleep: async () => undefined,
    }

    const walk = createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Stopped' },
      { deps, signal: controller.signal }
    )
    const expectation = expect(walk).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await expectation
    expect(listChildren).not.toHaveBeenCalled()
  })

  it('stops during a hung download instead of waiting out the request (M3)', async () => {
    const controller = new AbortController()
    const deps: GfsFolderZipDeps = {
      listChildren: vi.fn(async () => ({
        items: [folder({ resourceId: 'hung', name: 'hung.txt' })],
        nextCursor: null,
      })),
      download: () => new Promise<{ bytes: ArrayBuffer }>(() => undefined),
      throttle: { acquire: async () => undefined },
      sleep: async () => undefined,
      zipStream: recordedZipStream().deps,
    }

    const walk = createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Stopped' },
      { deps, signal: controller.signal }
    )
    const expectation = expect(walk).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await expectation
  })

  it('stops during the RETRIED listing, not only its first attempt (review L3)', async () => {
    const controller = new AbortController()
    let attempts = 0
    const deps: GfsFolderZipDeps = {
      listChildren: vi.fn(() => {
        attempts += 1
        if (attempts === 1)
          return Promise.reject(new Error('429 httpStatus=429 retryAfterSeconds=0'))
        // The retried listing hangs: without the abort race on the retry the
        // walk would park here forever and a Stop could never land.
        return new Promise<GfsZipChildrenPage>(() => undefined)
      }),
      download: async () => ({ bytes: new ArrayBuffer(0) }),
      throttle: { acquire: async () => undefined },
      sleep: async () => undefined,
      zipStream: recordedZipStream().deps,
    }

    const walk = createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Stopped' },
      { deps, signal: controller.signal }
    )
    const expectation = expect(walk).rejects.toMatchObject({ name: 'AbortError' })
    // Let the first attempt reject, the backoff elapse and the retry fire
    // (each await in the retry chain is its own microtask tick).
    for (let index = 0; index < 200 && attempts < 2; index += 1) await Promise.resolve()
    expect(attempts).toBe(2)
    controller.abort()
    await expectation
  })

  it('aborts on a non-permission download failure instead of a holey archive', async () => {
    const deps: GfsFolderZipDeps = {
      listChildren: vi.fn(async () => ({
        items: [folder({ resourceId: 'flaky', name: 'flaky.txt' })],
        nextCursor: null,
      })),
      download: async () => {
        throw new Error('gfs download failed: 500 httpStatus=500')
      },
      throttle: { acquire: async () => undefined },
      sleep: async () => undefined,
      zipStream: recordedZipStream().deps,
    }

    await expect(
      createGfsFolderZip({ resourceId: 'root', drive: 'main', name: 'Broken' }, { deps })
    ).rejects.toThrow(/500/)
  })

  it('sanitizes hostile names into safe in-archive paths', async () => {
    const deps = depsFor({
      root: [
        {
          items: [
            // Traversal needs separators — only exact `.`/`..` segments drop,
            // so a leading-dot filename keeps its name (L5).
            folder({ resourceId: 'n1', name: '../escape.txt' }),
            folder({ resourceId: 'n2', name: 'a/b.txt' }),
            folder({ resourceId: 'n3', name: '' }),
            folder({ resourceId: 'n4', name: '.env' }),
            // Windows-forbidden characters and trailing dots map away (L6).
            folder({ resourceId: 'n5', name: 're:port*?"<>|.txt' }),
            folder({ resourceId: 'n6', name: 'ends...' }),
            folder({ resourceId: 'n7', name: '.' }),
            folder({ resourceId: 'n8', name: '..' }),
          ],
          nextCursor: null,
        },
      ],
    })
    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Weird/Name:' },
      { deps }
    )
    expect(streamEntryNames(deps.zipStreamRecord).sort()).toEqual(
      [
        'Weird_Name_/.._escape.txt',
        'Weird_Name_/a_b.txt',
        'Weird_Name_/unnamed',
        'Weird_Name_/.env',
        'Weird_Name_/re_port______.txt',
        'Weird_Name_/ends',
        'Weird_Name_/unnamed (2)',
        'Weird_Name_/unnamed (3)',
      ].sort()
    )
    expect(result.fileName).toBe('Weird_Name_.zip')
  })

  it('caps entry-name length so the 16-bit ZIP name fields cannot truncate (L4)', async () => {
    // 70 000 ASCII bytes would overflow ZIP's uint16 name length and corrupt
    // the archive; the segment must be cut under the documented ceiling.
    const overlong = `${'a'.repeat(70_000)}.txt`
    const deps = depsFor({
      root: [
        {
          items: [folder({ resourceId: 'huge', name: overlong })],
          nextCursor: null,
        },
      ],
    })
    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Long' },
      { deps }
    )

    expect(result.fileCount).toBe(1)
    const names = streamEntryNames(deps.zipStreamRecord)
    expect(names).toHaveLength(1)
    const written = names[0]!
    // The name handed to the streaming writer is well inside the uint16 field
    // and the SEGMENT was cut under the documented ceiling.
    expect(written.startsWith('Long/')).toBe(true)
    expect(new TextEncoder().encode(written).length).toBeLessThan(65536)
    expect(new TextEncoder().encode(written.slice('Long/'.length)).length).toBeLessThanOrEqual(1024)
    // Truncation keeps whole code points: a multi-byte character near the cut
    // is never split.
    const emojiDeps = depsFor({
      root: [
        {
          items: [folder({ resourceId: 'emoji', name: `${'😀'.repeat(600)}x` })],
          nextCursor: null,
        },
      ],
    })
    const emojiResult = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Emoji' },
      { deps: emojiDeps }
    )
    const emojiName = streamEntryNames(emojiDeps.zipStreamRecord)[0]!
    expect(emojiName.endsWith('\uFFFD')).toBe(false)
    expect(new TextEncoder().encode(emojiName.slice('Emoji/'.length)).length).toBeLessThanOrEqual(
      1024
    )
  })

  it('treats a missing byte count as zero instead of NaN-poisoning the size guard (M1)', async () => {
    const deps = depsFor({
      root: [
        {
          items: [
            folder({
              resourceId: 'unknown',
              name: 'unknown.bin',
              bytes: undefined as unknown as number,
            }),
            folder({ resourceId: 'small', name: 'small.bin', bytes: 512 }),
          ],
          nextCursor: null,
        },
      ],
    })
    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Legacy' },
      // 1 KiB ceiling: NaN accumulation would disable the guard; 0 + 512 must
      // still leave room, and a real overage must still refuse.
      { deps, limits: { maxTotalBytes: 1024 } }
    )
    expect(result.fileCount).toBe(2)

    const overDeps = depsFor({
      root: [
        {
          items: [
            folder({
              resourceId: 'unknown',
              name: 'unknown.bin',
              bytes: undefined as unknown as number,
            }),
            folder({ resourceId: 'big', name: 'big.bin', bytes: 2048 }),
          ],
          nextCursor: null,
        },
      ],
    })
    await expect(
      createGfsFolderZip(
        { resourceId: 'root', drive: 'main', name: 'Legacy' },
        { deps: overDeps, limits: { maxTotalBytes: 1024 } }
      )
    ).rejects.toThrow(/exceeds the 1 KiB folder-zip limit/)
  })

  it('re-enters the throttle budget after a 429 backoff before retrying (L1)', async () => {
    let attempts = 0
    const acquire = vi.fn(async () => undefined)
    const deps: GfsFolderZipDeps = {
      listChildren: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('429 httpStatus=429 retryAfterSeconds=0')
        return { items: [], nextCursor: null }
      }),
      download: async () => ({ bytes: new ArrayBuffer(0) }),
      zipStream: recordedZipStream().deps,
      throttle: { acquire },
      sleep: async () => undefined,
    }

    // An empty retry answer short-circuits as "no downloadable files"; the
    // witness here is the budget: initial acquire + one post-backoff acquire.
    await expect(
      createGfsFolderZip({ resourceId: 'root', drive: 'main', name: 'Throttled' }, { deps })
    ).rejects.toThrow(/no downloadable files/)
    expect(attempts).toBe(2)
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('refuses to save an empty archive and reports skips (L8)', async () => {
    const emptyDeps = depsFor({ root: [{ items: [], nextCursor: null }] })
    await expect(
      createGfsFolderZip({ resourceId: 'root', drive: 'main', name: 'Empty' }, { deps: emptyDeps })
    ).rejects.toMatchObject({
      name: 'GfsFolderZipEmptyError',
      message: '"Empty" has no downloadable files.',
    })

    const allSkipped = depsFor({
      root: [
        {
          items: [folder({ resourceId: 'hidden', name: 'hidden.txt', readable: false })],
          nextCursor: null,
        },
      ],
    })
    const failure = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Mixed' },
      { deps: allSkipped }
    ).catch(error => error)
    expect(failure).toBeInstanceOf(GfsFolderZipEmptyError)
    expect((failure as GfsFolderZipEmptyError).skipped).toEqual([
      { path: 'Mixed/hidden.txt', reason: 'No access' },
    ])
  })
})
