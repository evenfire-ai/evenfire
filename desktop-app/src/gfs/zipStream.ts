/**
 * File-backed ZIP assembly for the folder-zip export (R1-H2, spec: round-2
 * extensions). The renderer walks the folder and hands each entry to the main
 * process; entries (local header + payload) are appended to a temp file, only
 * central-directory metadata stays in memory, and `finish` appends the
 * directory + EOCD in place, then moves the temp file to the user-chosen save
 * location. Peak renderer memory is independent of folder size; main keeps
 * ~76 + name bytes per entry plus one chunk.
 *
 * The main process is the TRUST BOUNDARY, not a helper. A renderer is a web
 * page: it must not be able to write outside the directory the user chose, to
 * grow the temp file without bound, or to leave a handle and a `.part` file
 * behind. So the writer owns four guarantees of its own, independent of the
 * renderer's:
 *
 * - PATH SAFETY (R3-M1): every entry name is validated as a canonical
 *   relative path BEFORE a byte of entry data is written.
 * - RESOURCE LIMITS (R3-M2): aggregate payload bytes, entry count, the ZIP32
 *   format bounds, job ownership and concurrency are all enforced here.
 * - CLEANUP OWNERSHIP (R3-M3): the job owns its handle and its temp file until
 *   the save has completed; every unsuccessful path closes the handle and
 *   removes the file.
 * - STREAMED PAYLOAD (R1-H2): the payload is written chunk by chunk, so a
 *   large file never materializes as one contiguous buffer.
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
import { type PlannedEntryName, ZipEntryNameAllocator } from './zipEntryName.js'
import { validateZipEntryPath } from './zipEntryPath.js'
import {
  ZIP32_MAX_BYTES,
  ZIP32_MAX_ENTRIES,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_BYTES,
} from './zipLimits.js'

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const VERSION_NEEDED = 20
const UTF8_FLAG = 0x0800
const STORED_METHOD = 0

const CRC32_POLYNOMIAL = 0xedb88320
const CRC32_INIT = 0xffffffff

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

/** Folds one chunk into a running CRC-32 (the pre/post inversion is applied
 *  by the caller, so a streamed payload and a whole-buffer payload agree). */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  const table = crc32TableFor()
  let value = crc
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value >>> 8) ^ table[(value ^ bytes[index]!) & 0xff]!
  }
  return value
}

/** The CRC-32 of a complete buffer. */
export function crc32(bytes: Uint8Array): number {
  return (crc32Update(CRC32_INIT, bytes) ^ CRC32_INIT) >>> 0
}

interface DirectoryEntry {
  nameBytes: Uint8Array
  crc: number
  size: number
  localHeaderOffset: number
}

interface ZipStreamJob {
  jobId: string
  /** The window that opened the job. Only that window may drive it. */
  ownerId: string
  tempPath: string
  handle: Awaited<ReturnType<typeof open>>
  /** Serializes temp-file writes across append calls. Never rejects. */
  writeChain: Promise<void>
  entries: DirectoryEntry[]
  allocator: ZipEntryNameAllocator
  /** Payload bytes committed to the archive (the archive's data size). */
  payloadBytes: number
  /** Bytes written to the temp file: payload + local headers. */
  byteCount: number
  /** The archive's ceilings, resolved when the job was opened. */
  limits: ZipStreamLimits
  /** Appends currently in flight for this job. */
  inFlight: number
  closed: boolean
  destroyed: boolean
}

/** An entry whose local header has been written and whose payload follows. */
interface PreparedEntry {
  plan: PlannedEntryName
  nameBytes: Uint8Array
  header: Uint8Array
  localHeaderOffset: number
}

export interface ZipStreamLimits {
  /** The aggregate payload ceiling for one archive. */
  maxTotalBytes: number
  /** The entry ceiling for one archive. */
  maxEntries: number
}

export interface ZipStreamDeps {
  openFile?: typeof open
  unlinkFile?: typeof unlink
  renameFile?: typeof rename
  copyFile?: typeof copyFile
  showSaveDialog?: typeof dialog.showSaveDialog
  tempDir?: string
  /**
   * Overrides for the archive's ceilings. The DEFAULTS are the product
   * ceilings; the override exists so the limits can be exercised at a size a
   * test can actually write (R3-M2).
   */
  limits?: Partial<ZipStreamLimits>
}

/** Concurrent archives this process holds open. */
export const MAX_ACTIVE_ZIP_JOBS = 8
/** Concurrent archives ONE window may hold open. */
export const MAX_ACTIVE_ZIP_JOBS_PER_OWNER = 2
/** Appends in flight for one job. Each in-flight append holds its payload. */
export const MAX_CONCURRENT_APPENDS_PER_JOB = 4

const jobs = new Map<string, ZipStreamJob>()

/** The entry name is unsafe: it could escape the extraction directory. */
export class ZipStreamNameError extends Error {
  constructor(name: string, reason: string) {
    super(`Refusing an unsafe ZIP entry name (${reason}): ${name.slice(0, 64)}`)
    this.name = 'ZipStreamNameError'
  }
}

/** The entry does not fit the ZIP32 name fields. */
export class ZipStreamNameTooLongError extends Error {
  constructor(name: string) {
    super(
      `Entry name is not representable in a ZIP header (encoded length must stay under 65535 bytes): ${name.slice(0, 64)}…`
    )
    this.name = 'ZipStreamNameTooLongError'
  }
}

/** The job would exceed a format or product limit. */
export class ZipStreamLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipStreamLimitError'
  }
}

function requireJob(jobId: string, ownerId: string): ZipStreamJob {
  const job = jobs.get(jobId)
  if (!job) throw new Error(`Unknown zip job ${jobId}`)
  if (job.ownerId !== ownerId) {
    throw new Error(`ZIP job ${jobId} belongs to another window`)
  }
  return job
}

/**
 * Serializes one write onto the job's chain. A failed write belongs to the
 * append that caused it: the chain stays usable so a later append is not
 * silently skipped, and the job's cleanup path owns the broken handle.
 */
function enqueue<T>(job: ZipStreamJob, task: () => Promise<T>): Promise<T> {
  const result = job.writeChain.then(task, task)
  job.writeChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/**
 * Closes the handle and removes the temp file, and drops the job. The job
 * OWNS both resources until the save completes, so this is the single place
 * that releases them (R3-M3).
 */
async function destroyJob(job: ZipStreamJob, deps: ZipStreamDeps): Promise<void> {
  jobs.delete(job.jobId)
  if (job.destroyed) return
  job.destroyed = true
  await job.writeChain.catch(() => undefined)
  if (!job.closed) {
    job.closed = true
    await job.handle.close().catch(() => undefined)
  }
  await (deps.unlinkFile ?? unlink)(job.tempPath).catch(() => undefined)
}

export async function startZipJob(ownerId: string, deps: ZipStreamDeps = {}): Promise<string> {
  if (jobs.size >= MAX_ACTIVE_ZIP_JOBS) {
    throw new ZipStreamLimitError('Too many ZIP jobs are already open')
  }
  let owned = 0
  for (const job of jobs.values()) if (job.ownerId === ownerId) owned += 1
  if (owned >= MAX_ACTIVE_ZIP_JOBS_PER_OWNER) {
    throw new ZipStreamLimitError('This window already has too many ZIP jobs open')
  }
  const jobId = randomUUID()
  const tempPath = join(deps.tempDir ?? tmpdir(), `evenfire-zip-${jobId}.part`)
  const handle = await (deps.openFile ?? open)(tempPath, 'w', 0o600)
  jobs.set(jobId, {
    jobId,
    ownerId,
    tempPath,
    handle,
    writeChain: Promise.resolve(),
    entries: [],
    allocator: new ZipEntryNameAllocator(),
    payloadBytes: 0,
    byteCount: 0,
    limits: {
      maxTotalBytes: deps.limits?.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES,
      maxEntries: deps.limits?.maxEntries ?? ZIP_MAX_ENTRIES,
    },
    inFlight: 0,
    closed: false,
    destroyed: false,
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
 * Validates the entry and reserves its name, WITHOUT touching the archive.
 *
 * Every check here runs before the caller writes a byte, so a rejected append
 * leaves the file size, the entry list and the byte counters exactly as they
 * were (R3-M2).
 */
function prepareEntry(job: ZipStreamJob, rawName: string): PlannedEntryName {
  const rejection = validateZipEntryPath(rawName)
  if (rejection) throw new ZipStreamNameError(rawName, rejection)
  const plan = job.allocator.plan(rawName)
  if (!plan.fits) throw new ZipStreamNameTooLongError(plan.name)
  if (job.entries.length >= Math.min(job.limits.maxEntries, ZIP32_MAX_ENTRIES)) {
    throw new ZipStreamLimitError(
      `A ZIP archive holds at most ${Math.min(job.limits.maxEntries, ZIP32_MAX_ENTRIES)} entries, which this archive would exceed`
    )
  }
  return plan
}

/**
 * Appends one STORED entry from a WHOLE buffer. The size is known up front,
 * so an over-budget entry is rejected before the archive changes at all.
 */
export async function appendZipEntry(
  jobId: string,
  ownerId: string,
  rawName: string,
  bytes: ArrayBuffer,
  deps: ZipStreamDeps = {}
): Promise<string> {
  const job = requireJob(jobId, ownerId)
  const data = new Uint8Array(bytes)
  const plan = prepareEntry(job, rawName)
  if (job.payloadBytes + data.byteLength > job.limits.maxTotalBytes) {
    throw new ZipStreamLimitError(
      `The archive would exceed the ${job.limits.maxTotalBytes}-byte folder-zip limit`
    )
  }
  const nameBytes = new TextEncoder().encode(plan.name)
  const header = localHeader(nameBytes, 0, 0)
  if (job.byteCount + header.length + data.byteLength > ZIP32_MAX_BYTES) {
    throw new ZipStreamLimitError('The archive would exceed the ZIP32 size limit')
  }
  const localHeaderOffset = job.byteCount
  try {
    await enqueue(job, async () => {
      await job.handle.write(header, 0, header.length, localHeaderOffset)
      await job.handle.write(data, 0, data.byteLength, localHeaderOffset + header.length)
      const crc = crc32(data)
      const patch = new Uint8Array(12)
      const view = new DataView(patch.buffer)
      view.setUint32(0, crc, true)
      view.setUint32(4, data.byteLength, true)
      view.setUint32(8, data.byteLength, true)
      await job.handle.write(patch, 0, patch.length, localHeaderOffset + 14)
      job.allocator.commit(plan)
      job.entries.push({ nameBytes, crc, size: data.byteLength, localHeaderOffset })
      job.payloadBytes += data.byteLength
      job.byteCount = localHeaderOffset + header.length + data.byteLength
    })
  } catch (error) {
    await rollBackEntry(job, localHeaderOffset, deps)
    throw error
  }
  return plan.name
}

/**
 * Undoes a half-written entry: the temp file is truncated back to the entry's
 * first byte, so the archive stays a valid sequence of COMPLETE entries and
 * the job can still serve the next one. A failed rollback means the handle is
 * no longer trustworthy, so the job is destroyed (its handle closed and its
 * temp file removed).
 */
async function rollBackEntry(
  job: ZipStreamJob,
  localHeaderOffset: number,
  deps: ZipStreamDeps
): Promise<void> {
  try {
    await enqueue(job, async () => {
      await job.handle.truncate(localHeaderOffset)
      job.byteCount = localHeaderOffset
    })
  } catch {
    await destroyJob(job, deps)
  }
}

/** The sink a producer writes one entry's payload through. */
export interface ZipEntrySink {
  /** Appends one payload chunk to the entry. */
  write(chunk: Uint8Array): Promise<void>
}

export interface ZipStreamEntryResult {
  /** The name actually written (after collision suffixing). */
  name: string
  /** The payload bytes written. */
  bytes: number
}

/**
 * Appends one STORED entry whose payload is produced chunk by chunk (R1-H2).
 *
 * The producer never materializes the payload as one buffer: it hands the
 * sink one chunk at a time and the writer folds each chunk into the running
 * CRC and writes it straight to the temp file. The local header is written
 * first with placeholder CRC/size fields and patched in place once the
 * payload is complete, so the entry stays a valid STORED entry.
 */
export async function appendZipEntryStreaming(
  jobId: string,
  ownerId: string,
  rawName: string,
  produce: (sink: ZipEntrySink) => Promise<void>,
  deps: ZipStreamDeps = {}
): Promise<ZipStreamEntryResult> {
  const job = requireJob(jobId, ownerId)
  if (job.inFlight + 1 > MAX_CONCURRENT_APPENDS_PER_JOB) {
    throw new ZipStreamLimitError('Too many ZIP appends are in flight for this job')
  }
  job.inFlight += 1
  let preparedEntryOffset: number | undefined
  try {
    const prepared: PreparedEntry = await enqueue(job, async () => {
      const plan = prepareEntry(job, rawName)
      const nameBytes = new TextEncoder().encode(plan.name)
      const header = localHeader(nameBytes, 0, 0)
      if (job.byteCount + header.length > ZIP32_MAX_BYTES) {
        throw new ZipStreamLimitError('The archive would exceed the ZIP32 size limit')
      }
      const localHeaderOffset = job.byteCount
      preparedEntryOffset = localHeaderOffset
      await job.handle.write(header, 0, header.length, localHeaderOffset)
      job.byteCount = localHeaderOffset + header.length
      return { plan, nameBytes, header, localHeaderOffset }
    })

    let crc = CRC32_INIT
    let size = 0
    const sink: ZipEntrySink = {
      write: async (chunk: Uint8Array) => {
        if (chunk.byteLength === 0) return
        if (job.payloadBytes + size + chunk.byteLength > job.limits.maxTotalBytes) {
          throw new ZipStreamLimitError(
            `The archive would exceed the ${job.limits.maxTotalBytes}-byte folder-zip limit`
          )
        }
        if (job.byteCount + chunk.byteLength > ZIP32_MAX_BYTES) {
          throw new ZipStreamLimitError('The archive would exceed the ZIP32 size limit')
        }
        size += chunk.byteLength
        crc = crc32Update(crc, chunk)
        await enqueue(job, async () => {
          await job.handle.write(chunk, 0, chunk.byteLength, job.byteCount)
          job.byteCount += chunk.byteLength
        })
      },
    }

    await produce(sink)

    const finalCrc = (crc ^ CRC32_INIT) >>> 0
    await enqueue(job, async () => {
      const patch = new Uint8Array(12)
      const view = new DataView(patch.buffer)
      view.setUint32(0, finalCrc, true)
      view.setUint32(4, size, true)
      view.setUint32(8, size, true)
      await job.handle.write(patch, 0, patch.length, prepared.localHeaderOffset + 14)
    })
    job.allocator.commit(prepared.plan)
    job.entries.push({
      nameBytes: prepared.nameBytes,
      crc: finalCrc,
      size,
      localHeaderOffset: prepared.localHeaderOffset,
    })
    job.payloadBytes += size
    return { name: prepared.plan.name, bytes: size }
  } catch (error) {
    // The entry is incomplete. Roll it back so the archive stays a valid
    // sequence of complete entries and the job can still serve the next one;
    // a failed rollback destroys the job (its handle closed, its temp file
    // removed) instead of leaving an unowned resource behind (R3-M3).
    if (preparedEntryOffset !== undefined) {
      await rollBackEntry(job, preparedEntryOffset, deps)
    }
    throw error
  } finally {
    job.inFlight -= 1
  }
}

export interface FinishZipJobResult {
  saved: boolean
  filePath: string | null
  entryCount: number
}

/**
 * Finalizes the archive and saves it through a native dialog.
 *
 * The job stays REGISTERED until the save has completed: the cleanup
 * ownership must not end while the temp file is still on disk, or a failure
 * here would leave an unowned `.part` file behind (R3-M3).
 */
export async function finishZipJob(
  jobId: string,
  ownerId: string,
  suggestedName: string,
  deps: ZipStreamDeps = {}
): Promise<FinishZipJobResult> {
  const job = requireJob(jobId, ownerId)
  const entryCount = job.entries.length
  try {
    await enqueue(job, async () => {
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
      // Every write carries an EXPLICIT position: the writer must survive a
      // rollback that truncates the file, and a truncated file leaves the
      // handle's own position pointing past the new end.
      let writeOffset = job.byteCount
      for (const part of parts) {
        await job.handle.write(part, 0, part.length, writeOffset)
        writeOffset += part.length
      }
      job.byteCount = writeOffset
      await job.handle.close()
      job.closed = true
    })
  } catch (error) {
    await destroyJob(job, deps)
    throw error
  }

  const saveDialog = deps.showSaveDialog ?? dialog.showSaveDialog
  try {
    const result = await saveDialog({
      defaultPath: suggestedName,
      title: 'Save folder zip',
    })
    if (result.canceled || !result.filePath) {
      await (deps.unlinkFile ?? unlink)(job.tempPath).catch(() => undefined)
      jobs.delete(jobId)
      return { saved: false, filePath: null, entryCount }
    }
    // rename fails across filesystems (EXDEV: /tmp tmpfs vs home) — fall back
    // to copy+unlink so the save works wherever the OS keeps its temp dir.
    try {
      await (deps.renameFile ?? rename)(job.tempPath, result.filePath)
    } catch {
      await (deps.copyFile ?? copyFile)(job.tempPath, result.filePath)
      await (deps.unlinkFile ?? unlink)(job.tempPath).catch(() => undefined)
    }
    jobs.delete(jobId)
    return { saved: true, filePath: result.filePath, entryCount }
  } catch (error) {
    await destroyJob(job, deps)
    throw error
  }
}

/** Aborts a job: closes the temp file and deletes it. */
export async function abortZipJob(
  jobId: string,
  ownerId: string,
  deps: ZipStreamDeps = {}
): Promise<void> {
  const job = jobs.get(jobId)
  if (!job) return
  if (job.ownerId !== ownerId) {
    throw new Error(`ZIP job ${jobId} belongs to another window`)
  }
  await destroyJob(job, deps)
}

export function activeZipJobCount(): number {
  return jobs.size
}
