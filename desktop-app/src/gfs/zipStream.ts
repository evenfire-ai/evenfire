/**
 * File-backed ZIP assembly for the folder-zip export (R1-H2, R3-M1, R3-M2,
 * R3-M3, R3-M5, R4-M1). The renderer walks the folder and hands each entry to
 * the main process; entries (local header + payload) are appended to a
 * temp file, only central-directory metadata stays in memory, and `finish`
 * appends the directory + EOCD in place, then moves the temp file to the
 * user-chosen save location. Peak renderer memory is independent of folder
 * size; main keeps ~76 + name bytes per entry plus one chunk.
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
 *   format bounds, job ownership and concurrency are all enforced here, and
 *   every one of them is RESERVED ATOMICALLY before the asynchronous work
 *   that consumes it.
 * - CLEANUP OWNERSHIP (R3-M3): the job owns its handle and its temp file until
 *   the save has completed; every unsuccessful path closes the handle and
 *   removes the file.
 * - STREAMED PAYLOAD (R1-H2): the payload is written chunk by chunk, so a
 *   large file never materializes as one contiguous buffer.
 *
 * ## Concurrency (R4-M1)
 *
 * The writer serializes COMPLETE ENTRY LIFECYCLES, not individual WRITES.
 * An entry's local header, payload and CRC patch are written by ONE task, so
 * two concurrent appends can never interleave: the second entry's header
 * cannot land inside the first entry's payload. Finalization waits for every
 * accepted append to settle before the central directory is written, so an
 * in-flight entry can never land after the directory.
 *
 * ## Reservations (R3-M2)
 *
 * A ceiling that is CHECKED but not RESERVED is a ceiling two concurrent
 * operations can both slip past. Every limit below is therefore taken as a
 * reservation in ONE synchronous step, before the first `await`:
 *
 * - a job slot, held from before the temp file is opened until the job is
 *   registered;
 * - an entry slot, held from admission until the entry commits or fails;
 * - payload bytes, held per chunk until the entry commits or fails.
 *
 * The reservations are taken against the COMMITTED state plus everything
 * other accepted appends already reserved, so the aggregate ceilings include
 * in-flight work. A rejected append releases everything it reserved and
 * changes nothing: not the file size, not the entry list, not the counters.
 *
 * Format reference: APPNOTE.TXT — local file header (4.3.7), central directory
 * (4.3.12), EOCD (4.3.19). Entries are STORED (see the renderer-era decision:
 * the payload is streamed, not compressed, so the CRC is computed over the
 * bytes as they are written).
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
  /**
   * Serializes COMPLETE ENTRY LIFECYCLES: one at a time, in acceptance
   * order. Never rejects.
   */
  lifecycleChain: Promise<void>
  /** The entries committed to the central directory. */
  entries: DirectoryEntry[]
  /**
   * Entry slots held by accepted appends that have not committed yet. Counted
   * against the entry ceiling together with the committed entries (R3-M2).
   */
  reservedEntries: number
  allocator: ZipEntryNameAllocator
  /** Payload bytes committed to the archive (the archive's data size). */
  payloadBytes: number
  /**
   * Payload bytes reserved by accepted appends that have not committed yet.
   * Counted against the payload ceiling together with the committed bytes
   * (R3-M2).
   */
  reservedPayloadBytes: number
  /** Bytes written to the temp file: payload + local headers. */
  byteCount: number
  /** The archive's ceilings, resolved when the job was opened. */
  limits: ZipStreamLimits
  /** Appends accepted and not yet finished (queued or running). */
  inFlight: number
  /** The archive is being finalized: no further append is accepted. */
  finishing: boolean
  /** The job is dead: no further lifecycle may start. */
  destroyed: boolean
  /** The handle and the temp file have been released. */
  cleaned: boolean
  closed: boolean
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
/**
 * Jobs being opened RIGHT NOW. Their slot is held from before the temp file
 * is opened until the job is registered, so two concurrent starts cannot
 * both observe the same free capacity (R3-M2).
 */
let pendingJobStarts = 0
/** The same, per window, so one window cannot bypass its own ceiling. */
const pendingJobStartsByOwner = new Map<string, number>()

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
 * Runs one complete entry lifecycle, strictly in acceptance order.
 *
 * The WHOLE lifecycle — local header, payload, CRC patch — runs inside ONE
 * task, so an entry's bytes are always contiguous and never interleaved with
 * another entry's (R4-M1). A failed lifecycle belongs to the append that
 * caused it: the chain stays usable so a later append is not silently
 * skipped.
 */
function enqueueLifecycle<T>(job: ZipStreamJob, task: () => Promise<T>): Promise<T> {
  const result = job.lifecycleChain.then(task, task)
  job.lifecycleChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/**
 * Reserves an entry slot and its payload bytes, in ONE synchronous step,
 * BEFORE any asynchronous work (R3-M2).
 *
 * The check and the reservation are not separated by an `await`, so two
 * concurrent appends cannot both observe the same free capacity and
 * collectively exceed a ceiling. Everything reserved here is released again
 * when the append fails.
 */
function reserveAppend(job: ZipStreamJob, payloadBytes: number): void {
  const maxEntries = Math.min(job.limits.maxEntries, ZIP32_MAX_ENTRIES)
  if (job.entries.length + job.reservedEntries >= maxEntries) {
    throw new ZipStreamLimitError(
      `A ZIP archive holds at most ${maxEntries} entries, which this archive would exceed`
    )
  }
  if (job.payloadBytes + job.reservedPayloadBytes + payloadBytes > job.limits.maxTotalBytes) {
    throw new ZipStreamLimitError(
      `The archive would exceed the ${job.limits.maxTotalBytes}-byte folder-zip limit`
    )
  }
  job.reservedEntries += 1
  job.reservedPayloadBytes += payloadBytes
}

/**
 * Reserves one payload chunk against the archive's ceilings, in ONE
 * synchronous step (R3-M2).
 *
 * The aggregate ceiling includes the bytes other accepted appends already
 * reserved, so in-flight work counts against the budget.
 */
function reservePayload(job: ZipStreamJob, bytes: number): void {
  if (job.payloadBytes + job.reservedPayloadBytes + bytes > job.limits.maxTotalBytes) {
    throw new ZipStreamLimitError(
      `The archive would exceed the ${job.limits.maxTotalBytes}-byte folder-zip limit`
    )
  }
  if (job.byteCount + bytes > ZIP32_MAX_BYTES) {
    throw new ZipStreamLimitError('The archive would exceed the ZIP32 size limit')
  }
  job.reservedPayloadBytes += bytes
}

/**
 * Releases the handle and removes the temp file, and drops the job. The job
 * OWNS both resources until the save completes, so this is the single place
 * that releases them (R3-M3).
 *
 * This does NOT wait for the lifecycle chain: it is called from INSIDE a
 * lifecycle when a rollback fails, and awaiting the chain from within the
 * chain would deadlock.
 */
async function destroyJob(job: ZipStreamJob, deps: ZipStreamDeps): Promise<void> {
  jobs.delete(job.jobId)
  job.destroyed = true
  if (job.cleaned) return
  job.cleaned = true
  if (!job.closed) {
    job.closed = true
    await job.handle.close().catch(() => undefined)
  }
  await (deps.unlinkFile ?? unlink)(job.tempPath).catch(() => undefined)
}

export async function startZipJob(ownerId: string, deps: ZipStreamDeps = {}): Promise<string> {
  // ── ADMISSION (synchronous, atomic) ─────────────────────────────────────
  // The slot is taken BEFORE the first await, so two concurrent starts
  // cannot both observe the same free capacity and collectively exceed the
  // ceiling (R3-M2).
  const pendingOwned = pendingJobStartsByOwner.get(ownerId) ?? 0
  let owned = 0
  for (const job of jobs.values()) if (job.ownerId === ownerId) owned += 1
  if (jobs.size + pendingJobStarts >= MAX_ACTIVE_ZIP_JOBS) {
    throw new ZipStreamLimitError('Too many ZIP jobs are already open')
  }
  if (owned + pendingOwned >= MAX_ACTIVE_ZIP_JOBS_PER_OWNER) {
    throw new ZipStreamLimitError('This window already has too many ZIP jobs open')
  }
  pendingJobStarts += 1
  pendingJobStartsByOwner.set(ownerId, pendingOwned + 1)
  try {
    const jobId = randomUUID()
    const tempPath = join(deps.tempDir ?? tmpdir(), `evenfire-zip-${jobId}.part`)
    const handle = await (deps.openFile ?? open)(tempPath, 'w', 0o600)
    jobs.set(jobId, {
      jobId,
      ownerId,
      tempPath,
      handle,
      lifecycleChain: Promise.resolve(),
      entries: [],
      reservedEntries: 0,
      allocator: new ZipEntryNameAllocator(),
      payloadBytes: 0,
      reservedPayloadBytes: 0,
      byteCount: 0,
      limits: {
        maxTotalBytes: deps.limits?.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES,
        maxEntries: deps.limits?.maxEntries ?? ZIP_MAX_ENTRIES,
      },
      inFlight: 0,
      finishing: false,
      destroyed: false,
      cleaned: false,
      closed: false,
    })
    return jobId
  } finally {
    pendingJobStarts -= 1
    const current = pendingJobStartsByOwner.get(ownerId) ?? 1
    if (current <= 1) pendingJobStartsByOwner.delete(ownerId)
    else pendingJobStartsByOwner.set(ownerId, current - 1)
  }
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
 * Validates the entry and plans its name, WITHOUT touching the archive and
 * WITHOUT reserving anything.
 *
 * The name is planned INSIDE the entry lifecycle, so it is planned against
 * the names already committed: two concurrent appends of the same name get
 * two different names, never one duplicated entry.
 */
function prepareEntry(job: ZipStreamJob, rawName: string): PlannedEntryName {
  const rejection = validateZipEntryPath(rawName)
  if (rejection) throw new ZipStreamNameError(rawName, rejection)
  const plan = job.allocator.plan(rawName)
  if (!plan.fits) throw new ZipStreamNameTooLongError(plan.name)
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
  // ── ADMISSION (synchronous, atomic) ─────────────────────────────────────
  if (job.finishing) throw new Error('The ZIP archive is being finalized')
  if (job.inFlight + 1 > MAX_CONCURRENT_APPENDS_PER_JOB) {
    throw new ZipStreamLimitError('Too many ZIP appends are in flight for this job')
  }
  reserveAppend(job, data.byteLength)
  job.inFlight += 1
  try {
    return await enqueueLifecycle(job, async () => {
      let localHeaderOffset: number | undefined
      try {
        if (job.destroyed) throw new Error('The ZIP job was destroyed')
        const plan = prepareEntry(job, rawName)
        const nameBytes = new TextEncoder().encode(plan.name)
        const header = localHeader(nameBytes, 0, 0)
        if (job.byteCount + header.length + data.byteLength > ZIP32_MAX_BYTES) {
          throw new ZipStreamLimitError('The archive would exceed the ZIP32 size limit')
        }
        localHeaderOffset = job.byteCount
        await job.handle.write(header, 0, header.length, localHeaderOffset)
        await job.handle.write(data, 0, data.byteLength, localHeaderOffset + header.length)
        const crc = crc32(data)
        const patch = new Uint8Array(12)
        const view = new DataView(patch.buffer)
        view.setUint32(0, crc, true)
        view.setUint32(4, data.byteLength, true)
        view.setUint32(8, data.byteLength, true)
        await job.handle.write(patch, 0, patch.length, localHeaderOffset + 14)
        job.byteCount = localHeaderOffset + header.length + data.byteLength
        job.allocator.commit(plan)
        job.entries.push({ nameBytes, crc, size: data.byteLength, localHeaderOffset })
        job.payloadBytes += data.byteLength
        job.reservedPayloadBytes -= data.byteLength
        job.reservedEntries -= 1
        return plan.name
      } catch (error) {
        job.reservedPayloadBytes -= data.byteLength
        job.reservedEntries -= 1
        if (localHeaderOffset !== undefined) {
          await rollBackEntry(job, localHeaderOffset, deps)
        }
        throw error
      }
    })
  } finally {
    job.inFlight -= 1
  }
}

/**
 * Undoes a half-written entry: the temp file is truncated back to the entry's
 * first byte, so the archive stays a valid sequence of COMPLETE entries and
 * the job can still serve the next one. A failed rollback means the handle is
 * no longer trustworthy, so the job is destroyed (its handle closed and its
 * temp file removed).
 *
 * This runs INSIDE the failing entry's own lifecycle, so no other entry can
 * be written between the failure and the truncation (R4-M1).
 */
async function rollBackEntry(
  job: ZipStreamJob,
  localHeaderOffset: number,
  deps: ZipStreamDeps
): Promise<void> {
  try {
    await job.handle.truncate(localHeaderOffset)
    job.byteCount = localHeaderOffset
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
 *
 * The WHOLE entry — header, payload, patch — is one lifecycle, so a
 * concurrent append cannot interleave with it (R4-M1).
 */
export async function appendZipEntryStreaming(
  jobId: string,
  ownerId: string,
  rawName: string,
  produce: (sink: ZipEntrySink) => Promise<void>,
  deps: ZipStreamDeps = {}
): Promise<ZipStreamEntryResult> {
  const job = requireJob(jobId, ownerId)
  // ── ADMISSION (synchronous, atomic) ─────────────────────────────────────
  if (job.finishing) throw new Error('The ZIP archive is being finalized')
  if (job.inFlight + 1 > MAX_CONCURRENT_APPENDS_PER_JOB) {
    throw new ZipStreamLimitError('Too many ZIP appends are in flight for this job')
  }
  reserveAppend(job, 0)
  job.inFlight += 1
  try {
    return await enqueueLifecycle(job, async () => {
      let localHeaderOffset: number | undefined
      let reservedPayload = 0
      try {
        if (job.destroyed) throw new Error('The ZIP job was destroyed')
        const plan = prepareEntry(job, rawName)
        const nameBytes = new TextEncoder().encode(plan.name)
        const header = localHeader(nameBytes, 0, 0)
        if (job.byteCount + header.length > ZIP32_MAX_BYTES) {
          throw new ZipStreamLimitError('The archive would exceed the ZIP32 size limit')
        }
        localHeaderOffset = job.byteCount
        await job.handle.write(header, 0, header.length, localHeaderOffset)
        job.byteCount = localHeaderOffset + header.length

        let crc = CRC32_INIT
        let size = 0
        const sink: ZipEntrySink = {
          write: async (chunk: Uint8Array) => {
            if (chunk.byteLength === 0) return
            // ATOMIC reservation: the chunk's bytes are claimed before the
            // write, against the aggregate ceiling that includes every other
            // accepted append's reservation (R3-M2).
            reservePayload(job, chunk.byteLength)
            reservedPayload += chunk.byteLength
            size += chunk.byteLength
            crc = crc32Update(crc, chunk)
            await job.handle.write(chunk, 0, chunk.byteLength, job.byteCount)
            job.byteCount += chunk.byteLength
          },
        }

        await produce(sink)

        const finalCrc = (crc ^ CRC32_INIT) >>> 0
        const patch = new Uint8Array(12)
        const view = new DataView(patch.buffer)
        view.setUint32(0, finalCrc, true)
        view.setUint32(4, size, true)
        view.setUint32(8, size, true)
        await job.handle.write(patch, 0, patch.length, localHeaderOffset + 14)

        job.allocator.commit(plan)
        job.entries.push({
          nameBytes,
          crc: finalCrc,
          size,
          localHeaderOffset,
        })
        job.payloadBytes += size
        job.reservedPayloadBytes -= reservedPayload
        job.reservedEntries -= 1
        return { name: plan.name, bytes: size }
      } catch (error) {
        // The entry is incomplete. Release everything it reserved and roll it
        // back so the archive stays a valid sequence of complete entries and
        // the job can still serve the next one; a failed rollback destroys the
        // job instead of leaving an unowned resource behind (R3-M3).
        job.reservedPayloadBytes -= reservedPayload
        job.reservedEntries -= 1
        if (localHeaderOffset !== undefined) {
          await rollBackEntry(job, localHeaderOffset, deps)
        }
        throw error
      }
    })
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
 *
 * No further append is accepted once the archive is being finalized, and the
 * central directory is written only after every ACCEPTED append has settled
 * — otherwise an in-flight entry could land after the directory and produce
 * an invalid archive (R4-M1).
 */
export async function finishZipJob(
  jobId: string,
  ownerId: string,
  suggestedName: string,
  deps: ZipStreamDeps = {}
): Promise<FinishZipJobResult> {
  const job = requireJob(jobId, ownerId)
  // No further append is accepted from here on.
  job.finishing = true
  // Wait for every accepted append to settle before the directory is built.
  await job.lifecycleChain.catch(() => undefined)

  const entryCount = job.entries.length
  try {
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
  // A queued append must not start against a closing handle.
  job.destroyed = true
  // Wait for the in-flight entry to settle, so no write races the close.
  await job.lifecycleChain.catch(() => undefined)
  await destroyJob(job, deps)
}

export function activeZipJobCount(): number {
  return jobs.size
}
