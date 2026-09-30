// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  GFS_ZIP_MAX_ENTRIES,
  type GfsFolderZipDeps,
  GfsFolderZipLimitError,
  type GfsFolderZipProgress,
  type GfsZipChildItem,
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

function depsFor(
  pages: Record<string, Array<{ items: GfsZipChildItem[]; nextCursor: string | null }>>,
  downloads: Record<string, () => Promise<{ bytes: ArrayBuffer }>> = {}
): GfsFolderZipDeps {
  return {
    listChildren: vi.fn(async (resourceId: string, _drive: string, cursor?: string) => {
      const pageList = pages[resourceId]
      if (!pageList) throw new Error(`unexpected listChildren for ${resourceId}`)
      const index = cursor ? Number(cursor) : 0
      const page = pageList[index]
      if (!page) throw new Error(`no page ${index} for ${resourceId}`)
      return { items: page.items, nextCursor: page.nextCursor }
    }),
    download: vi.fn(async (uri: string) => {
      const produce = downloads[uri]
      if (produce) return produce()
      return { bytes: bytesOf(uri) }
    }),
    // Spacing itself has a dedicated manual-clock test below the walk; here it
    // is a no-op so the orchestration tests run instantly.
    throttle: { acquire: async () => undefined },
    sleep: async () => undefined,
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
    expect(deps.listChildren).toHaveBeenCalledWith('folder-root', 'main', undefined)
    expect(deps.listChildren).toHaveBeenCalledWith('folder-root', 'main', '1')
    expect(deps.listChildren).toHaveBeenCalledWith('sub', 'main', undefined)

    const names = zipEntryNames(result.bytes)
    expect(names.sort()).toEqual(['Docs/a.txt', 'Docs/b.png', 'Docs/sub/c.md'].sort())
    expect(progress.map(value => value.phase)).toContain('downloading')
    expect(progress.at(-1)?.phase).toBe('assembling')
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
    expect(zipEntryNames(result.bytes)).toEqual(['Mixed/ok.txt'])
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
    }

    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Root' },
      { deps }
    )

    expect(result.fileCount).toBe(0)
    expect(result.skipped).toEqual([{ path: 'Root/locked', reason: 'Permission denied' }])
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
    ).rejects.toThrow(/more than 2 files/)
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
    }

    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Throttled' },
      { deps }
    )
    expect(attempts).toBe(2)
    expect(result.fileCount).toBe(0)
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
            folder({ resourceId: 'n1', name: '../escape.txt' }),
            folder({ resourceId: 'n2', name: 'a/b.txt' }),
            folder({ resourceId: 'n3', name: '' }),
          ],
          nextCursor: null,
        },
      ],
    })
    const result = await createGfsFolderZip(
      { resourceId: 'root', drive: 'main', name: 'Weird/Name' },
      { deps }
    )
    expect(zipEntryNames(result.bytes).sort()).toEqual(
      ['Weird_Name/_escape.txt', 'Weird_Name/a_b.txt', 'Weird_Name/unnamed'].sort()
    )
  })
})

/** Minimal central-directory name reader for assertions. */
function zipEntryNames(archive: Uint8Array): string[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const decoder = new TextDecoder()
  const eocdOffset = archive.length - 22
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
  const names: string[] = []
  let cursor = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = view.getUint16(cursor + 28, true)
    names.push(decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength)))
    cursor += 46 + nameLength
  }
  return names
}
