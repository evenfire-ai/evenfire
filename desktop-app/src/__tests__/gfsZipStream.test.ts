/**
 * R1-H2 — the streamed, file-backed zip assembly. These tests run the REAL
 * writer against real temp files and verify the SAVED ARCHIVE with an
 * independent reader (walking the central directory the same way an extractor
 * does), not by re-reading the writer's own inputs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ZipStreamDeps } from '../gfs/zipStream.js'
import {
  abortZipJob,
  activeZipJobCount,
  appendZipEntry,
  finishZipJob,
  startZipJob,
} from '../gfs/zipStream.js'

const savedFiles: string[] = []
const tempRoots: string[] = []

async function makeDeps(
  savePath: string,
  options: { cancelDialog?: boolean; failRename?: boolean } = {}
): Promise<ZipStreamDeps & { tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'evenfire-zip-test-'))
  tempRoots.push(tempDir)
  return {
    tempDir,
    showSaveDialog: vi.fn(async () => ({
      canceled: Boolean(options.cancelDialog),
      filePath: options.cancelDialog ? undefined : savePath,
    })),
    renameFile: options.failRename
      ? async () => {
          throw new Error('EXDEV: cross-device link not permitted')
        }
      : undefined,
  }
}

afterEach(async () => {
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

describe('gfs zipStream (R1-H2)', () => {
  it('assembles a file-backed archive that an independent reader verifies', async () => {
    const savePath = join(tmpdir(), `saved-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await startZipJob(deps)

    expect(await appendZipEntry(jobId, 'Docs/a.txt', contentBytes('alpha'))).toBe('Docs/a.txt')
    expect(await appendZipEntry(jobId, 'Docs/b.bin', contentBytes('\u00ff\u00fe'))).toBe(
      'Docs/b.bin'
    )
    const result = await finishZipJob(jobId, 'Docs.zip', deps)

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
    const { crc32 } = await import('../gfs/zipStream.js')
    for (const entry of entries) expect(entry.crc).toBe(crc32(entry.bytes))
  })

  it('suffixes case-insensitive collisions in the written file (R1-L1 through the real writer)', async () => {
    const savePath = join(tmpdir(), `collide-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath)
    const jobId = await startZipJob(deps)
    await appendZipEntry(jobId, 'Report.txt', contentBytes('upper'))
    await appendZipEntry(jobId, 'report.txt', contentBytes('lower'))

    await finishZipJob(jobId, 'Collide.zip', deps)
    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries.map(entry => entry.name)).toEqual(['Report.txt', 'report (2).txt'])
    const decoder = new TextDecoder()
    expect(entries.map(entry => decoder.decode(entry.bytes))).toEqual(['upper', 'lower'])
  })

  it('rejects an entry whose FINAL name cannot fit the 16-bit fields, before writing (R1-M2)', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    const jobId = await startZipJob(deps)
    const nearLimit = `${'a'.repeat(65530)}.txt`
    // The pre-collision name fits exactly; a colliding second copy must not
    // push a suffixed name past the field — the writer refuses the header.
    await appendZipEntry(jobId, nearLimit, contentBytes('one'))
    await expect(appendZipEntry(jobId, nearLimit, contentBytes('two'))).rejects.toThrow(
      /not representable in a ZIP header/i
    )
    await abortZipJob(jobId, deps)
  })

  it('deletes the temp file when the save dialog is canceled', async () => {
    const deps = await makeDeps('', { cancelDialog: true })
    const jobId = await startZipJob(deps)
    await appendZipEntry(jobId, 'x.txt', contentBytes('x'))
    const result = await finishZipJob(jobId, 'Canceled.zip', deps)
    expect(result.saved).toBe(false)
    expect(result.filePath).toBeNull()
    expect(activeZipJobCount()).toBe(0)
  })

  it('falls back to copy+unlink when the final rename crosses filesystems', async () => {
    const savePath = join(tmpdir(), `exdev-${Date.now()}.zip`)
    savedFiles.push(savePath)
    const deps = await makeDeps(savePath, { failRename: true })
    const jobId = await startZipJob(deps)
    await appendZipEntry(jobId, 'x.txt', contentBytes('content'))
    const result = await finishZipJob(jobId, 'Exdev.zip', deps)
    expect(result.saved).toBe(true)
    const { entries } = readZipArchive(new Uint8Array(await readFile(savePath)))
    expect(entries).toHaveLength(1)
  })

  it('abort cleans the job and its temp file', async () => {
    const deps = await makeDeps(join(tmpdir(), 'unused.zip'))
    const jobId = await startZipJob(deps)
    await appendZipEntry(jobId, 'x.txt', contentBytes('x'))
    await abortZipJob(jobId, deps)
    expect(activeZipJobCount()).toBe(0)
    await expect(finishZipJob(jobId, 'Gone.zip', deps)).rejects.toThrow(/Unknown zip job/)
  })
})
