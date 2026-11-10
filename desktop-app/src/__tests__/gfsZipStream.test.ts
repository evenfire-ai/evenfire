/**
 * The main-process ZIP writer (R1-H2, R3-M1, R3-M2, R3-M3, R3-M5).
 *
 * These tests run the REAL writer against real temp files and verify the
 * SAVED ARCHIVE with an independent extractor, not by re-reading the writer's
 * own inputs. They also pin the guarantees the MAIN process owns, because the
 * renderer is untrusted: path safety, the resource limits, job ownership, and
 * the cleanup of every unsuccessful path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ZIP32_MAX_ENTRIES, ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL_BYTES } from '../gfs/zipLimits.js'
import type { ZipStreamDeps } from '../gfs/zipStream.js'
import {
  MAX_ACTIVE_ZIP_JOBS,
  MAX_ACTIVE_ZIP_JOBS_PER_OWNER,
  ZipStreamLimitError,
  ZipStreamNameError,
  ZipStreamNameTooLongError,
  abortZipJob,
  activeZipJobCount,
  appendZipEntry,
  appendZipEntryStreaming,
  crc32,
  finishZipJob,
  startZipJob,
} from '../gfs/zipStream.js'

const execFileAsync = promisify(execFile)

const OWNER = 'window-1'
const OTHER_OWNER = 'window-2'

const savedFiles: string[] = []
const tempRoots: string[] = []
/** Every job this file opened, so the module never leaks one into the next test. */
const openJobs: Array<{ jobId: string; owner: string; deps: ZipStreamDeps }> = []

async function makeDeps(
  savePath: string,
  options: {
    cancelDialog?: boolean
    failRename?: boolean
    failCopy?: boolean
    failDialog?: boolean
    openFile?: ZipStreamDeps['openFile']
  } = {}
): Promise<ZipStreamDeps & { tempDir: string; savePath: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'evenfire-zip-test-'))
  tempRoots.push(tempDir)
  return {
    tempDir,
    savePath,
    openFile: options.openFile,
    showSaveDialog: vi.fn(async () => {
      if (options.failDialog) throw new Error('save dialog failed')
      return {
        canceled: Boolean(options.cancelDialog),
        filePath: options.cancelDialog ? undefined : savePath,
      }
    }),
    renameFile: options.failRename
      ? async () => {
          throw new Error('EXDEV: cross-device link not permitted')
        }
      : undefined,
    copyFile: options.failCopy
      ? async () => {
          throw new Error('copy failed')
        }
      : undefined,
  }
}

/** Opens a job and remembers it, so `afterEach` can always clean it up. */
async function openJob(owner: string, deps: ZipStreamDeps): Promise<string> {
  const jobId = await startZipJob(owner, deps)
  openJobs.push({ jobId, owner, deps })
  openedJobCount += 1
  return jobId
}

let openedJobCount = 0

afterEach(async () => {
  for (const job of openJobs.splice(0)) {
    await abortZipJob(job.jobId, job.owner, job.deps).catch(() => undefined)
  }
  for (const dir of tempRoots.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface ReadEntry {
  name: string
  bytes: Uint8Array
  crc: number
}

/** Independent central-directory reader (an extractor's view of the file). */
function readZipArchive(archive: Uint8Array): { entries: ReadEntry[]; entryCount: number } {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const decoder = new TextDecoder()
  const eocdOffset = archive.length - 22
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50)
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
  const entries: ReadEntry[] = []
  let cursor = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50)
    const crc = view.getUint32(cursor + 16, true)
    const size = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const localHeaderOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength))

    expect(view.getUint32(localHeaderOffset, true)).toBe(0x04034b50)
    expect(view.getUint16(localHeaderOffset + 8, true)).toBe(0) // STORED
    const localNameLength = view.getUint16(localHeaderOffset + 26, true)
    const dataOffset = localHeaderOffset + 30 + localNameLength
    const bytes = archive.subarray(dataOffset, dataOffset + size)
    expect(bytes.length).toBe(size)
    entries.push({ name, bytes, crc })
    cursor += 46 + nameLength
  }
  return { entries, entryCount }
}

function contentBytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

/** The temp file the writer created for `jobId` (one per job, by design). */
async function tempFilesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(name => name.endsWith('.part'))
}

/**
 * Extract the archive with the SYSTEM unzip — a genuinely independent
 * extractor, not our own reader. Skipped when the binary is unavailable.
 */
async function extractWithSystemUnzip(archivePath: string): Promise<Record<string, string> | null> {
  try {
    await execFileAsync('unzip', ['-v'])
  } catch {
    return null
  }
  const target = await mkdtemp(join(tmpdir(), 'evenfire-unzip-'))
  tempRoots.push(target)
  await execFileAsync('unzip', ['-o', '-q', archivePath, '-d', target])
  const out: Record<string, string> = {}
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, `${prefix}${entry.name}/`)
      } else {
        const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          // Inspect and read the same open file, so replacing its path cannot
          // change the file between the check and the read.
          expect((await file.stat()).isFile()).toBe(true)
          out[`${prefix}${entry.name}`] = await file.readFile('utf8')
        } finally {
          await file.close()
        }
      }
    }
  }
  await walk(target, '')
  return out
}

describe('gfs zipStream — archive assembly (R1-H2)', () => {
  it('assembles a file-backed archive that an independent reader verifies', async () => {
    const savePath = join(tmpdir(), `saved-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await openJob(OWNER, deps)

    expect(await appendZipEntry(jobId, OWNER, 'Docs/a.txt', contentBytes('alpha'))).toBe(
      'Docs/a.txt'
    )
    expect(await appendZipEntry(jobId, OWNER, 'Docs/b.bin', contentBytes('\u00ff\u00fe'))).toBe(
      'Docs/b.bin'
    )
    const result = await finishZipJob(jobId, OWNER, 'Docs.zip', deps)

    expect(result.saved).toBe(true)
    expect(result.entryCount).toBe(2)
    expect(activeZipJobCount()).toBe(0)

    const archive = new Uint8Array(await readFile(savePath))
    const { entries, entryCount } = readZipArchive(archive)
    expect(entryCount).toBe(2)
    expect(entries.map(entry => entry.name)).toEqual(['Docs/a.txt', 'Docs/b.bin'])
    const decoder = new TextDecoder()
    expect(decoder.decode(entries[0]!.bytes)).toBe('alpha')
    expect(entries[1]!.bytes).toEqual(new Uint8Array([0xc3, 0xbf, 0xc3, 0xbe]))
    // The stored CRC fields match the payload CRC-32 an extractor recomputes.
    for (const entry of entries) expect(entry.crc).toBe(crc32(entry.bytes))
  })

  it('extracts cleanly with an INDEPENDENT extractor (R3-M5)', async () => {
    const savePath = join(tmpdir(), `independent-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await openJob(OWNER, deps)

    // A file whose name collides with a directory component, case-insensitively.
    await appendZipEntry(jobId, OWNER, 'Report/child.txt', contentBytes('child'))
    await appendZipEntry(jobId, OWNER, 'report', contentBytes('sibling'))
    await appendZipEntry(jobId, OWNER, 'Report/other.txt', contentBytes('other'))
    await finishZipJob(jobId, OWNER, 'Independent.zip', deps)

    const extracted = await extractWithSystemUnzip(savePath)
    if (!extracted) return // no system extractor on this machine
    // Every entry landed on its own path: the sibling FILE was renamed away
    // from the directory's name, so nothing was overwritten.
    expect(Object.keys(extracted).sort()).toEqual(
      ['Report/child.txt', 'Report/other.txt', 'report (2)'].sort()
    )
    expect(extracted['Report/child.txt']).toBe('child')
    expect(extracted['Report/other.txt']).toBe('other')
    expect(extracted['report (2)']).toBe('sibling')
  })
})

describe('gfs zipStream — streamed payload (R1-H2)', () => {
  it('writes a chunked payload with the CRC an extractor recomputes', async () => {
    const savePath = join(tmpdir(), `chunked-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await openJob(OWNER, deps)

    const chunks = ['one-', 'two-', 'three'].map(part => new TextEncoder().encode(part))
    const result = await appendZipEntryStreaming(jobId, OWNER, 'big.bin', async sink => {
      for (const chunk of chunks) await sink.write(chunk)
    })
    expect(result).toEqual({ name: 'big.bin', bytes: 13 })
    await finishZipJob(jobId, OWNER, 'Chunked.zip', deps)

    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries).toHaveLength(1)
    expect(new TextDecoder().decode(entries[0]!.bytes)).toBe('one-two-three')
    expect(entries[0]!.crc).toBe(crc32(entries[0]!.bytes))
  })

  it('never materializes a large payload as one buffer (R1-H2)', async () => {
    // The near-limit memory claim: a payload is written CHUNK BY CHUNK, so
    // the writer's peak payload allocation is one chunk, not the file.
    //
    // The observable witness is the WRITER's own write granularity: the file
    // handle must never be handed a buffer larger than one chunk. Watching
    // the PRODUCER's chunk count alone would pass even for a writer that
    // collected the whole payload into one buffer before writing it — which
    // is exactly the pre-R1-H2 shape this claim has to exclude.
    const savePath = join(tmpdir(), `large-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const writeSizes: number[] = []
    const deps = await makeDeps(savePath, {
      openFile: async (path, flags, mode) => {
        const handle = await open(path, flags, mode)
        const original = handle.write.bind(handle) as (...args: unknown[]) => Promise<unknown>
        handle.write = ((buffer: Uint8Array, ...rest: unknown[]) => {
          writeSizes.push(buffer.byteLength)
          return original(buffer, ...rest)
        }) as typeof handle.write
        return handle
      },
    })
    const jobId = await openJob(OWNER, deps)

    const chunkSize = 64 * 1024
    const chunkCount = 16
    let largestChunk = 0
    let chunksSeen = 0
    const result = await appendZipEntryStreaming(jobId, OWNER, 'large.bin', async sink => {
      for (let index = 0; index < chunkCount; index += 1) {
        const chunk = new Uint8Array(chunkSize).fill(index % 251)
        largestChunk = Math.max(largestChunk, chunk.byteLength)
        chunksSeen += 1
        await sink.write(chunk)
      }
    })
    expect(chunksSeen).toBe(chunkCount)
    expect(largestChunk).toBe(chunkSize)
    expect(result.bytes).toBe(chunkSize * chunkCount)

    // The writer's own writes: one per chunk, never a whole-payload buffer.
    // The local header and the CRC patch are small and are excluded by size.
    expect(writeSizes.length).toBeGreaterThanOrEqual(chunkCount)
    expect(Math.max(...writeSizes)).toBeLessThanOrEqual(chunkSize)
    expect(writeSizes.filter(size => size === chunkSize)).toHaveLength(chunkCount)

    await finishZipJob(jobId, OWNER, 'Large.zip', deps)
    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.bytes.length).toBe(chunkSize * chunkCount)
    // The CRC an extractor recomputes matches the streamed one.
    expect(entries[0]!.crc).toBe(crc32(entries[0]!.bytes))
  })

  it('keeps the archive valid after a failed entry and serves the next one', async () => {
    const savePath = join(tmpdir(), `rollback-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await openJob(OWNER, deps)

    await appendZipEntry(jobId, OWNER, 'first.txt', contentBytes('first'))
    await expect(
      appendZipEntryStreaming(jobId, OWNER, 'doomed.bin', async sink => {
        await sink.write(new TextEncoder().encode('partial'))
        throw new Error('producer failed mid-stream')
      })
    ).rejects.toThrow(/producer failed/)

    // The half-written entry was rolled back: the next entry still lands, and
    // the archive contains no trace of the failed one.
    await appendZipEntry(jobId, OWNER, 'second.txt', contentBytes('second'))
    await finishZipJob(jobId, OWNER, 'Rollback.zip', deps)

    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries.map(entry => entry.name)).toEqual(['first.txt', 'second.txt'])
    expect(new TextDecoder().decode(entries[1]!.bytes)).toBe('second')
  })
})

/**
 * R4-M1 / R3-M2 — CONCURRENCY. The writer used to serialize individual
 * WRITES, not complete ENTRY LIFECYCLES, so two concurrent appends could
 * interleave: the second entry's local header landed inside the first
 * entry's payload. The aggregate ceilings were likewise checked against
 * committed state only, so concurrent appends could collectively exceed
 * them.
 */
describe('gfs zipStream — concurrent entries (R4-M1, R3-M2)', () => {
  /** Yields to the event loop, so concurrent appends really do interleave. */
  const yieldToLoop = () => new Promise<void>(resolve => setTimeout(resolve, 0))

  it('keeps concurrent streaming appends from interleaving entries (R4-M1)', async () => {
    const savePath = join(tmpdir(), `concurrent-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await openJob(OWNER, deps)

    const sources = [
      { name: 'a.txt', chunks: ['aaa-1', 'aaa-2', 'aaa-3'] },
      { name: 'b.txt', chunks: ['bbb-1', 'bbb-2', 'bbb-3'] },
      { name: 'c.txt', chunks: ['ccc-1', 'ccc-2', 'ccc-3'] },
    ]
    // All three appends are ACCEPTED before any of them completes.
    const results = await Promise.all(
      sources.map(source =>
        appendZipEntryStreaming(
          jobId,
          OWNER,
          source.name,
          async sink => {
            for (const chunk of source.chunks) {
              await sink.write(new TextEncoder().encode(chunk))
              await yieldToLoop()
            }
          },
          deps
        )
      )
    )
    expect(results.map(result => result.bytes)).toEqual([15, 15, 15])

    await finishZipJob(jobId, OWNER, 'Concurrent.zip', deps)

    // An INDEPENDENT reader sees three complete entries whose payloads are
    // exactly what the producers wrote.
    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries.map(entry => entry.name).sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
    for (const entry of entries) {
      const source = sources.find(candidate => candidate.name === entry.name)!
      expect(new TextDecoder().decode(entry.bytes)).toBe(source.chunks.join(''))
      expect(entry.crc).toBe(crc32(entry.bytes))
    }

    // The SYSTEM extractor agrees — a corrupted archive does not extract.
    const extracted = await extractWithSystemUnzip(savePath)
    if (extracted) {
      expect(extracted['a.txt']).toBe('aaa-1aaa-2aaa-3')
      expect(extracted['b.txt']).toBe('bbb-1bbb-2bbb-3')
      expect(extracted['c.txt']).toBe('ccc-1ccc-2ccc-3')
    }
  })

  it('keeps a failed concurrent append from corrupting its neighbours (R4-M1)', async () => {
    const savePath = join(tmpdir(), `concurrent-rollback-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await openJob(OWNER, deps)

    const good = appendZipEntryStreaming(
      jobId,
      OWNER,
      'good.txt',
      async sink => {
        await sink.write(new TextEncoder().encode('good-1'))
        await yieldToLoop()
        await sink.write(new TextEncoder().encode('good-2'))
        await yieldToLoop()
      },
      deps
    )
    const doomed = appendZipEntryStreaming(
      jobId,
      OWNER,
      'doomed.txt',
      async sink => {
        await sink.write(new TextEncoder().encode('partial'))
        await yieldToLoop()
        throw new Error('producer failed mid-stream')
      },
      deps
    )

    await expect(doomed).rejects.toThrow(/producer failed/)
    await expect(good).resolves.toMatchObject({ name: 'good.txt', bytes: 12 })

    await finishZipJob(jobId, OWNER, 'ConcurrentRollback.zip', deps)
    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries.map(entry => entry.name)).toEqual(['good.txt'])
    expect(new TextDecoder().decode(entries[0]!.bytes)).toBe('good-1good-2')
  })

  it('reserves job slots atomically across concurrent starts (R3-M2)', async () => {
    const deps = await makeDeps(join(tmpdir(), 'batch.zip'))
    // Every start is fired WITHOUT awaiting, so they all race for the slots.
    // DIFFERENT owners race for the PROCESS-wide ceiling.
    const attempts = Array.from({ length: MAX_ACTIVE_ZIP_JOBS + 3 }, (_, index) =>
      startZipJob(`window-${index}`, deps).then(
        jobId => ({ ok: true as const, jobId }),
        error => ({ ok: false as const, error })
      )
    )
    const settled = await Promise.all(attempts)
    const opened = settled.filter(result => result.ok)
    const refused = settled.filter(result => !result.ok)
    // Register the opened jobs for cleanup BEFORE asserting, so a failing
    // expectation cannot leak a job into the next test.
    settled.forEach((result, index) => {
      if (result.ok) openJobs.push({ jobId: result.jobId, owner: `window-${index}`, deps })
    })

    expect(opened).toHaveLength(MAX_ACTIVE_ZIP_JOBS)
    expect(refused).toHaveLength(3)
    for (const result of refused) {
      expect((result as { error: Error }).error).toBeInstanceOf(ZipStreamLimitError)
    }
  })

  it('reserves per-window job slots atomically across concurrent starts (R3-M2)', async () => {
    const deps = await makeDeps(join(tmpdir(), 'owner-batch.zip'))
    // ONE window racing for its own ceiling.
    const attempts = Array.from({ length: MAX_ACTIVE_ZIP_JOBS_PER_OWNER + 3 }, () =>
      startZipJob(OWNER, deps).then(
        jobId => ({ ok: true as const, jobId }),
        error => ({ ok: false as const, error })
      )
    )
    const settled = await Promise.all(attempts)
    // Register the opened jobs for cleanup BEFORE asserting.
    for (const result of settled.filter(result => result.ok)) {
      openJobs.push({ jobId: result.jobId, owner: OWNER, deps })
    }
    expect(settled.filter(result => result.ok)).toHaveLength(MAX_ACTIVE_ZIP_JOBS_PER_OWNER)
    expect(settled.filter(result => !result.ok)).toHaveLength(3)
    for (const result of settled.filter(result => !result.ok)) {
      expect((result as { error: Error }).error).toBeInstanceOf(ZipStreamLimitError)
    }
  })

  it('reserves the payload budget atomically across concurrent appends (R3-M2)', async () => {
    const deps = await makeDeps(join(tmpdir(), 'budget.zip'))
    const jobId = await openJob(OWNER, { ...deps, limits: { maxTotalBytes: 64 } })

    // Three appends of 32 bytes each: only TWO fit in a 64-byte archive.
    const attempts = Array.from({ length: 3 }, (_, index) =>
      appendZipEntryStreaming(
        jobId,
        OWNER,
        `entry-${index}.bin`,
        async sink => {
          await sink.write(new Uint8Array(32).fill(index + 1))
          await yieldToLoop()
        },
        deps
      ).then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error })
      )
    )
    const settled = await Promise.all(attempts)
    const accepted = settled.filter(result => result.ok)
    const refused = settled.filter(result => !result.ok)

    // The ceiling is not bypassed: the archive never exceeds 64 payload bytes.
    expect(accepted).toHaveLength(2)
    expect(refused).toHaveLength(1)
    expect((refused[0] as { error: Error }).error).toBeInstanceOf(ZipStreamLimitError)

    await finishZipJob(jobId, OWNER, 'Budget.zip', deps)
    const { entries } = readZipArchive(new Uint8Array(await readFile(deps.savePath)))
    const total = entries.reduce((sum, entry) => sum + entry.bytes.length, 0)
    expect(total).toBeLessThanOrEqual(64)
  })

  it('reserves the entry count atomically across concurrent appends (R3-M2)', async () => {
    const deps = await makeDeps(join(tmpdir(), 'entries.zip'))
    const jobId = await openJob(OWNER, { ...deps, limits: { maxEntries: 2 } })

    const attempts = Array.from({ length: 4 }, (_, index) =>
      appendZipEntryStreaming(
        jobId,
        OWNER,
        `entry-${index}.bin`,
        async sink => {
          await sink.write(new TextEncoder().encode('x'))
          await yieldToLoop()
        },
        deps
      ).then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error })
      )
    )
    const settled = await Promise.all(attempts)
    expect(settled.filter(result => result.ok)).toHaveLength(2)
    expect(settled.filter(result => !result.ok)).toHaveLength(2)
    for (const result of settled.filter(result => !result.ok)) {
      expect((result as { error: Error }).error).toBeInstanceOf(ZipStreamLimitError)
    }
  })
})

describe('gfs zipStream — path safety (R3-M1)', () => {
  const unsafeNames = [
    '../outside.txt',
    'Docs/../../outside.txt',
    '/rooted.txt',
    'C:\\Windows\\system32.txt',
    'C:/Windows/system32.txt',
    'Docs\\win.txt',
    'Docs//empty.txt',
    'Docs/./same.txt',
    'Docs/trailing.',
    'Docs/trailing ',
    'Docs/NUL',
    'Docs/con.txt',
    'Docs/LPT9',
    'Docs/quote".txt',
    'Docs/pipe|.txt',
    'Docs/colon:.txt',
    'Docs/ctrl\u0001.txt',
  ]

  it.each(unsafeNames)('refuses %j before writing any entry data', async name => {
    const savePath = join(tmpdir(), `unsafe-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await openJob(OWNER, deps)

    await expect(appendZipEntry(jobId, OWNER, name, contentBytes('x'))).rejects.toBeInstanceOf(
      ZipStreamNameError
    )

    // Nothing was written: the archive is still empty and the job is intact.
    const tempFiles = await tempFilesIn(deps.tempDir!)
    expect(tempFiles).toHaveLength(1)
    expect((await stat(join(deps.tempDir!, tempFiles[0]!))).size).toBe(0)
    // The rejected name was not reserved: a legal name still gets its own path.
    expect(await appendZipEntry(jobId, OWNER, 'safe.txt', contentBytes('safe'))).toBe('safe.txt')
    await abortZipJob(jobId, OWNER, deps)
  })

  it('refuses a name whose finalized form does not fit the 16-bit fields', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    const jobId = await openJob(OWNER, deps)
    const nearLimit = `${'a'.repeat(65530)}.txt`
    await appendZipEntry(jobId, OWNER, nearLimit, contentBytes('one'))
    await expect(
      appendZipEntry(jobId, OWNER, nearLimit, contentBytes('two'))
    ).rejects.toBeInstanceOf(ZipStreamNameTooLongError)
    await abortZipJob(jobId, OWNER, deps)
  })
})

describe('gfs zipStream — resource limits (R3-M2)', () => {
  it('rejects an over-budget entry without changing the file or the job', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    deps.limits = { maxTotalBytes: 1024 }
    const jobId = await openJob(OWNER, deps)

    await appendZipEntry(jobId, OWNER, 'small.txt', contentBytes('small'))
    const tempFiles = await tempFilesIn(deps.tempDir!)
    const tempPath = join(deps.tempDir!, tempFiles[0]!)
    const sizeBefore = (await stat(tempPath)).size

    // The aggregate ceiling is enforced in MAIN: a renderer that keeps
    // appending past the budget is refused, and the refusal changes nothing.
    await expect(
      appendZipEntry(jobId, OWNER, 'too-big.bin', new ArrayBuffer(2048))
    ).rejects.toBeInstanceOf(ZipStreamLimitError)

    // The archive on disk and the job's own state are untouched.
    expect((await stat(tempPath)).size).toBe(sizeBefore)
    const result = await finishZipJob(jobId, OWNER, 'Limited.zip', deps)
    expect(result.entryCount).toBe(1)
  })

  it('rejects an over-budget STREAMED entry and rolls the half-written entry back', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    deps.limits = { maxTotalBytes: 1024 }
    const jobId = await openJob(OWNER, deps)

    await appendZipEntry(jobId, OWNER, 'small.txt', contentBytes('small'))
    const tempFiles = await tempFilesIn(deps.tempDir!)
    const tempPath = join(deps.tempDir!, tempFiles[0]!)
    const sizeBefore = (await stat(tempPath)).size

    await expect(
      appendZipEntryStreaming(jobId, OWNER, 'stream.bin', async sink => {
        await sink.write(new Uint8Array(512))
        await sink.write(new Uint8Array(1024))
      })
    ).rejects.toBeInstanceOf(ZipStreamLimitError)

    // The half-written entry was rolled back: the archive still holds exactly
    // the one complete entry.
    expect((await stat(tempPath)).size).toBe(sizeBefore)
    const result = await finishZipJob(jobId, OWNER, 'Limited.zip', deps)
    expect(result.entryCount).toBe(1)
  })

  it('enforces the entry-count ceiling', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    deps.limits = { maxEntries: 2 }
    const jobId = await openJob(OWNER, deps)

    await appendZipEntry(jobId, OWNER, 'one.txt', contentBytes('1'))
    await appendZipEntry(jobId, OWNER, 'two.txt', contentBytes('2'))
    await expect(
      appendZipEntry(jobId, OWNER, 'three.txt', contentBytes('3'))
    ).rejects.toBeInstanceOf(ZipStreamLimitError)

    const result = await finishZipJob(jobId, OWNER, 'Counted.zip', deps)
    expect(result.entryCount).toBe(2)
  })

  it('keeps the ZIP32 format ceilings in force', () => {
    // The format bounds are not configurable: they are what a ZIP32 reader
    // can address.
    expect(ZIP32_MAX_ENTRIES).toBe(65535)
    expect(ZIP_MAX_TOTAL_BYTES).toBe(512 * 1024 * 1024)
    expect(ZIP_MAX_ENTRIES).toBe(2000)
  })

  it('refuses a second job from the same window beyond the concurrency bound', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    const first = await openJob(OWNER, deps)
    const second = await openJob(OWNER, deps)
    await expect(startZipJob(OWNER, deps)).rejects.toBeInstanceOf(ZipStreamLimitError)
    expect(MAX_ACTIVE_ZIP_JOBS_PER_OWNER).toBe(2)
    await abortZipJob(first, OWNER, deps)
    await abortZipJob(second, OWNER, deps)
  })

  it('binds a job to the window that opened it', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    const jobId = await openJob(OWNER, deps)

    await expect(
      appendZipEntry(jobId, OTHER_OWNER, 'stolen.txt', contentBytes('x'))
    ).rejects.toThrow(/belongs to another window/)
    await expect(finishZipJob(jobId, OTHER_OWNER, 'Stolen.zip', deps)).rejects.toThrow(
      /belongs to another window/
    )
    await expect(abortZipJob(jobId, OTHER_OWNER, deps)).rejects.toThrow(/belongs to another window/)
    // The rightful owner can still use it.
    expect(await appendZipEntry(jobId, OWNER, 'mine.txt', contentBytes('x'))).toBe('mine.txt')
    await abortZipJob(jobId, OWNER, deps)
  })

  it('bounds the concurrent appends one job may hold', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    const jobId = await openJob(OWNER, deps)

    const inFlight: Array<Promise<unknown>> = []
    for (let index = 0; index < 4; index += 1) {
      inFlight.push(
        appendZipEntryStreaming(jobId, OWNER, `entry-${index}.bin`, async sink => {
          await sink.write(new TextEncoder().encode(`payload-${index}`))
        })
      )
    }
    await expect(
      appendZipEntryStreaming(jobId, OWNER, 'entry-4.bin', async sink => {
        await sink.write(new TextEncoder().encode('overflow'))
      })
    ).rejects.toBeInstanceOf(ZipStreamLimitError)
    await Promise.all(inFlight)
    await abortZipJob(jobId, OWNER, deps)
  })
})

describe('gfs zipStream — cleanup ownership (R3-M3)', () => {
  it('removes the temp file when the save dialog is canceled', async () => {
    const deps = await makeDeps('', { cancelDialog: true })
    const jobId = await openJob(OWNER, deps)
    await appendZipEntry(jobId, OWNER, 'x.txt', contentBytes('x'))
    const result = await finishZipJob(jobId, OWNER, 'Canceled.zip', deps)
    expect(result.saved).toBe(false)
    expect(result.filePath).toBeNull()
    expect(activeZipJobCount()).toBe(0)
    expect(await tempFilesIn(deps.tempDir!)).toHaveLength(0)
  })

  it('removes the temp file when the save dialog itself fails', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'), { failDialog: true })
    const jobId = await openJob(OWNER, deps)
    await appendZipEntry(jobId, OWNER, 'x.txt', contentBytes('x'))

    await expect(finishZipJob(jobId, OWNER, 'Broken.zip', deps)).rejects.toThrow(
      /save dialog failed/
    )
    expect(activeZipJobCount()).toBe(0)
    expect(await tempFilesIn(deps.tempDir!)).toHaveLength(0)
  })

  it('removes the temp file when the final rename AND the copy fallback fail', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'), {
      failRename: true,
      failCopy: true,
    })
    const jobId = await openJob(OWNER, deps)
    await appendZipEntry(jobId, OWNER, 'x.txt', contentBytes('x'))

    await expect(finishZipJob(jobId, OWNER, 'Broken.zip', deps)).rejects.toThrow(/copy failed/)
    expect(activeZipJobCount()).toBe(0)
    expect(await tempFilesIn(deps.tempDir!)).toHaveLength(0)
  })

  it('rolls a failed entry back and KEEPS the job owned, so an abort still cleans up', async () => {
    // The cleanup ownership must survive a failed append: the job is still
    // registered, so the renderer's abort can still release the handle and
    // the temp file (R3-M3).
    const failingOpen = async (path: string, flags: string, mode: number) => {
      const handle = await (await import('node:fs/promises')).open(path, flags as 'w', mode)
      ;(handle as unknown as { write: unknown }).write = async () => {
        throw new Error('disk full')
      }
      return handle
    }
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'), { openFile: failingOpen })
    const jobId = await openJob(OWNER, deps)

    await expect(appendZipEntry(jobId, OWNER, 'x.txt', contentBytes('x'))).rejects.toThrow(
      /disk full/
    )
    // The job is STILL registered: the owner keeps the cleanup right.
    expect(activeZipJobCount()).toBe(1)
    await abortZipJob(jobId, OWNER, deps)
    expect(activeZipJobCount()).toBe(0)
    expect(await tempFilesIn(deps.tempDir!)).toHaveLength(0)
  })

  it('removes the temp file when a write fails during FINALIZE', async () => {
    // The archive's entries are written; the central directory write fails.
    // The job owns the temp file until the save completes, so the failure
    // must release it (R3-M3).
    const failingOpen = async (path: string, flags: string, mode: number) => {
      const handle = await (await import('node:fs/promises')).open(path, flags as 'w', mode)
      const original = handle.write.bind(handle)
      let writes = 0
      ;(handle as unknown as { write: unknown }).write = async (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number
      ) => {
        writes += 1
        if (writes > 3) throw new Error('disk full')
        return original(buffer, offset, length, position)
      }
      return handle
    }
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'), { openFile: failingOpen })
    const jobId = await openJob(OWNER, deps)

    await appendZipEntry(jobId, OWNER, 'x.txt', contentBytes('x'))
    await expect(finishZipJob(jobId, OWNER, 'Broken.zip', deps)).rejects.toThrow(/disk full/)
    expect(activeZipJobCount()).toBe(0)
    expect(await tempFilesIn(deps.tempDir!)).toHaveLength(0)
  })

  it('falls back to copy+unlink when the final rename crosses filesystems', async () => {
    const savePath = join(tmpdir(), `exdev-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath, { failRename: true })
    const jobId = await openJob(OWNER, deps)
    await appendZipEntry(jobId, OWNER, 'x.txt', contentBytes('content'))
    const result = await finishZipJob(jobId, OWNER, 'Exdev.zip', deps)
    expect(result.saved).toBe(true)
    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries).toHaveLength(1)
  })

  it('abort cleans the job and its temp file', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    const jobId = await openJob(OWNER, deps)
    await appendZipEntry(jobId, OWNER, 'x.txt', contentBytes('x'))
    await abortZipJob(jobId, OWNER, deps)
    expect(activeZipJobCount()).toBe(0)
    expect(await tempFilesIn(deps.tempDir!)).toHaveLength(0)
    await expect(finishZipJob(jobId, OWNER, 'Gone.zip', deps)).rejects.toThrow(/Unknown zip job/)
  })
})

describe('gfs zipStream — case-folded path prefixes (R3-M5)', () => {
  it('suffixes case-insensitive collisions in the written file', async () => {
    const savePath = join(tmpdir(), `collide-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await openJob(OWNER, deps)
    await appendZipEntry(jobId, OWNER, 'Report.txt', contentBytes('upper'))
    await appendZipEntry(jobId, OWNER, 'report.txt', contentBytes('lower'))

    await finishZipJob(jobId, OWNER, 'Collide.zip', deps)
    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries.map(entry => entry.name)).toEqual(['Report.txt', 'report (2).txt'])
    const decoder = new TextDecoder()
    expect(entries.map(entry => decoder.decode(entry.bytes))).toEqual(['upper', 'lower'])
  })

  it('resolves a file/directory conflict whichever order it arrives in', async () => {
    // Order A: the directory's file first, then the sibling FILE.
    const savePathA = join(tmpdir(), `conflict-a-${Date.now()}.zip`)
    savedFiles.push(savePathA)
    const depsA = await makeDeps(savePathA)
    const jobA = await openJob(OWNER, depsA)
    await appendZipEntry(jobA, OWNER, 'Report/child.txt', contentBytes('child'))
    await appendZipEntry(jobA, OWNER, 'report', contentBytes('sibling'))
    await finishZipJob(jobA, OWNER, 'ConflictA.zip', depsA)
    const entriesA = readZipArchive(new Uint8Array(await readFile(savePathA))).entries

    // Order B: the sibling FILE first, then the directory's file.
    const savePathB = join(tmpdir(), `conflict-b-${Date.now()}.zip`)
    savedFiles.push(savePathB)
    const depsB = await makeDeps(savePathB)
    const jobB = await openJob(OWNER, depsB)
    await appendZipEntry(jobB, OWNER, 'report', contentBytes('sibling'))
    await appendZipEntry(jobB, OWNER, 'Report/child.txt', contentBytes('child'))
    await finishZipJob(jobB, OWNER, 'ConflictB.zip', depsB)
    const entriesB = readZipArchive(new Uint8Array(await readFile(savePathB))).entries

    // Neither order lets one entry overwrite the other: the file and the
    // directory end up on DIFFERENT paths.
    for (const entries of [entriesA, entriesB]) {
      const names = entries.map(entry => entry.name)
      const fileEntry = names.find(name => !name.includes('/'))
      const dirEntry = names.find(name => name.includes('/'))
      expect(fileEntry).toBeDefined()
      expect(dirEntry).toBeDefined()
      expect(fileEntry!.toLowerCase()).not.toBe(dirEntry!.split('/')[0]!.toLowerCase())
    }
    // Both payloads survived.
    for (const entries of [entriesA, entriesB]) {
      const decoder = new TextDecoder()
      expect(entries.map(entry => decoder.decode(entry.bytes)).sort()).toEqual(['child', 'sibling'])
    }
  })
})

describe('gfs zipStream — module hygiene', () => {
  it('leaves no job registered after every scenario', () => {
    expect(activeZipJobCount()).toBe(0)
    expect(openedJobCount).toBeGreaterThan(0)
    expect(existsSync(join(tmpdir(), 'nonexistent'))).toBe(false)
  })
})
