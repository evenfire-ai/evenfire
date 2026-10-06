/**
 * File-backed ZIP assembly for the folder-zip export (R1-H2, spec: round-2
 * extensions). The renderer streams one downloaded file at a time to
 * `gfs:zipStream:append`; entries (local header + payload) are appended to a
 * temp file, only central-directory metadata stays in memory, and `finish`
 * appends the directory + EOCD in place, then moves the temp file to the
 * user-chosen save location. Renderer peak memory is independent of folder
 * size; main keeps ~76 + name bytes per entry plus one chunk.
 *
 * Format reference: APPNOTE.TXT — local file header (4.3.7), central directory
 * (4.3.12), EOCD (4.3.19). Entries are STORED (see the renderer-era decision:
 * already-encoded payloads, exact byte-budget reasoning); names are UTF-8 with
 * general-purpose flag bit 11 set; DOS timestamps are zero (deterministic).
 */
import { dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, open, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { entryNameFitsZipFields, finalizeEntryName, foldEntryName } from './zipEntryName.js'

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const VERSION_NEEDED = 20
const UTF8_FLAG = 0x0800
const STORED_METHOD = 0

const CRC32_POLYNOMIAL = 0xedb88320

let crc32Table: Uint32Array | null = null

function crc32TableFor(): Uint32Array {
  if (crc32Table) return crc32Table
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ CRC32_POLYNOMIAL : value >>> 1
    }
    table[index] = value >>> 0
  }
  crc32Table = table
  return table
}

export function crc32(bytes: Uint8Array): number {
  const table = crc32TableFor()
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[index]!) & 0xff]!
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface DirectoryEntry {
  nameBytes: Uint8Array
  crc: number
  size: number
  localHeaderOffset: number
}

interface ZipStreamJob {
  tempPath: string
  handle: Awaited<ReturnType<typeof open>>
  /** Serializes temp-file writes across append calls. */
  writeChain: Promise<void>
  entries: DirectoryEntry[]
  usedFoldedNames: Set<string>
  byteCount: number
}

export interface ZipStreamDeps {
  openFile?: typeof open
  unlinkFile?: typeof unlink
  renameFile?: typeof rename
  showSaveDialog?: typeof dialog.showSaveDialog
  tempDir?: string
}

const jobs = new Map<string, ZipStreamJob>()

export class ZipStreamNameError extends Error {
  constructor(name: string) {
    super(
      `Entry name is not representable in a ZIP header (encoded length must stay under 65535 bytes): ${name.slice(0, 64)}…`
    )
    this.name = 'ZipStreamNameError'
  }
}

export async function startZipJob(deps: ZipStreamDeps = {}): Promise<string> {
  const jobId = randomUUID()
  const tempPath = join(deps.tempDir ?? tmpdir(), `evenfire-zip-${jobId}.part`)
  const handle = await (deps.openFile ?? open)(tempPath, 'w', 0o600)
  jobs.set(jobId, {
    tempPath,
    handle,
    writeChain: Promise.resolve(),
    entries: [],
    usedFoldedNames: new Set(),
    byteCount: 0,
  })
  return jobId
}

function localHeader(nameBytes: Uint8Array, crc: number, size: number): Uint8Array {
  const header = new Uint8Array(30 + nameBytes.length)
  const view = new DataView(header.buffer)
  view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true)
  view.setUint16(4, VERSION_NEEDED, true)
  view.setUint16(6, UTF8_FLAG, true)
  view.setUint16(8, STORED_METHOD, true)
  view.setUint16(10, 0, true) // mod time
  view.setUint16(12, 0, true) // mod date
  view.setUint32(14, crc, true)
  view.setUint32(18, size, true) // compressed size (stored)
  view.setUint32(22, size, true) // uncompressed size
  view.setUint16(26, nameBytes.length, true)
  view.setUint16(28, 0, true) // extra length
  header.set(nameBytes, 30)
  return header
}

/**
 * Appends one STORED entry. The name is finalized case-insensitively against
 * the job's used set and validated against the 16-bit name fields BEFORE any
 * header is written (R1-M2): an unrepresentable name is an error, never a
 * truncated corrupt header.
 */
export async function appendZipEntry(
  jobId: string,
  rawName: string,
  bytes: ArrayBuffer
): Promise<string> {
  const job = jobs.get(jobId)
  if (!job) throw new Error(`Unknown zip job ${jobId}`)
  const { name } = finalizeEntryName(rawName, job.usedFoldedNames)
  if (!entryNameFitsZipFields(name)) throw new ZipStreamNameError(name)
  job.usedFoldedNames.add(foldEntryName(name))
  const nameBytes = new TextEncoder().encode(name)
  const data = new Uint8Array(bytes)
  const crc = crc32(data)
  const header = localHeader(nameBytes, crc, data.length)
  const localHeaderOffset = job.byteCount
  job.byteCount += header.length + data.length
  job.entries.push({ nameBytes, crc, size: data.length, localHeaderOffset })
  job.writeChain = job.writeChain.then(async () => {
    await job.handle.write(header)
    await job.handle.write(data, 0, data.length)
  })
  await job.writeChain
  return name
}

export interface FinishZipJobResult {
  saved: boolean
  filePath: string | null
  entryCount: number
}

/** Finalizes the archive and saves it through a native dialog. */
export async function finishZipJob(
  jobId: string,
  suggestedName: string,
  deps: ZipStreamDeps = {}
): Promise<FinishZipJobResult> {
  const job = jobs.get(jobId)
  if (!job) throw new Error(`Unknown zip job ${jobId}`)
  const centralDirectoryOffset = job.byteCount
  const parts: Uint8Array[] = []
  for (const entry of job.entries) {
    const record = new Uint8Array(46 + entry.nameBytes.length)
    const view = new DataView(record.buffer)
    view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true)
    view.setUint16(4, VERSION_NEEDED, true) // made by
    view.setUint16(6, VERSION_NEEDED, true) // needed
    view.setUint16(8, UTF8_FLAG, true)
    view.setUint16(10, STORED_METHOD, true)
    view.setUint16(12, 0, true) // mod time
    view.setUint16(14, 0, true) // mod date
    view.setUint32(16, entry.crc, true)
    view.setUint32(20, entry.size, true)
    view.setUint32(24, entry.size, true)
    view.setUint16(28, entry.nameBytes.length, true)
    view.setUint16(30, 0, true) // extra length
    view.setUint16(32, 0, true) // comment length
    view.setUint16(34, 0, true) // disk start
    view.setUint16(36, 0, true) // internal attributes
    view.setUint32(38, 0, true) // external attributes
    view.setUint32(42, entry.localHeaderOffset, true)
    record.set(entry.nameBytes, 46)
    parts.push(record)
  }
  const centralDirectorySize = parts.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const view = new DataView(eocd.buffer)
  view.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  view.setUint16(8, job.entries.length, true)
  view.setUint16(10, job.entries.length, true)
  view.setUint32(12, centralDirectorySize, true)
  view.setUint32(16, centralDirectoryOffset, true)
  view.setUint16(20, 0, true)
  parts.push(eocd)

  const entryCount = job.entries.length
  const tempPath = job.tempPath
  try {
    job.writeChain = job.writeChain.then(async () => {
      for (const part of parts) await job.handle.write(part)
      await job.handle.close()
    })
    await job.writeChain
  } finally {
    jobs.delete(jobId)
  }

  const saveDialog = deps.showSaveDialog ?? dialog.showSaveDialog
  const result = await saveDialog({
    defaultPath: suggestedName,
    title: 'Save folder zip',
  })
  if (result.canceled || !result.filePath) {
    await (deps.unlinkFile ?? unlink)(tempPath).catch(() => undefined)
    return { saved: false, filePath: null, entryCount }
  }
  // rename fails across filesystems (EXDEV: /tmp tmpfs vs home) — fall back
  // to copy+unlink so the save works wherever the OS keeps its temp dir.
  try {
    await (deps.renameFile ?? rename)(tempPath, result.filePath)
  } catch {
    await copyFile(tempPath, result.filePath)
    await (deps.unlinkFile ?? unlink)(tempPath).catch(() => undefined)
  }
  return { saved: true, filePath: result.filePath, entryCount }
}

/** Aborts a job: closes the temp file and deletes it. */
export async function abortZipJob(jobId: string, deps: ZipStreamDeps = {}): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return
  jobs.delete(jobId)
  job.writeChain = job.writeChain
    .then(async () => {
      await job.handle.close()
    })
    .catch(() => undefined)
  await job.writeChain
  await (deps.unlinkFile ?? unlink)(job.tempPath).catch(() => undefined)
}

export function activeZipJobCount(): number {
  return jobs.size
}
