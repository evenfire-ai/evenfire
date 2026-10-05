/**
 * BUG-175 — recursive "Download as zip" for a GFS folder, assembled fully in
 * the renderer from the existing `window.clerum.gfs` read plane.
 *
 * Budget contract: the producer meters this walk's request classes per actor —
 * resource reads (children, affordances, resolve) and proxy reads (downloads)
 * — at 480/min each by default (control-api `externalGfsResourceReadRlPerMin`
 * / `externalGfsProxyReadRlPerMin`). Every listing and download below goes
 * through `createGfsReadThrottle`, deliberately spaced at a CONSERVATIVE
 * fraction of those ceilings (see `GFS_ZIP_READS_PER_MINUTE`) so one walk
 * leaves room for the browsing surfaces sharing the same classes, and a 429
 * answer backs off once by the server-provided `retryAfterSeconds` before
 * failing. Byte and entry ceilings bound the walk before anything large is
 * buffered, and entries the caller cannot read (a listing row marked
 * unreadable, or a 403 on the download itself) are skipped and reported back
 * so the result can show a visible skip notice instead of a silently holey
 * archive.
 */
import { isRateLimited, parseHttpStatus, parseRetryAfterSeconds } from '@lib/gfsGrantErrors'
import { createZipWriter } from '@lib/zipWriter'

/**
 * Client-side pacing for the walk, a deliberate conservative margin: the
 * producer's default ceilings for the classes used here are 480/min each
 * (resource reads, proxy reads); spacing at 120/min keeps one walk well under
 * them while the Files browsing surface shares the same classes.
 */
export const GFS_ZIP_READS_PER_MINUTE = 120
/** Refuse before buffering: total uncompressed bytes across the folder. */
export const GFS_ZIP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
/** Refuse before buffering: total file entries across the folder. */
export const GFS_ZIP_MAX_ENTRIES = 2000

export interface GfsZipSkippedEntry {
  path: string
  reason: string
}

export type GfsFolderZipPhase = 'listing' | 'downloading' | 'assembling'

export interface GfsFolderZipProgress {
  phase: GfsFolderZipPhase
  filesFound: number
  filesAdded: number
  currentPath: string | null
}

export interface GfsFolderZipResult {
  bytes: Uint8Array<ArrayBuffer>
  fileName: string
  fileCount: number
  skipped: GfsZipSkippedEntry[]
}

/** The walk exceeded a configured ceiling — a refusal, not a failure. */
export class GfsFolderZipLimitError extends Error {}

/** Nothing was archivable (an empty folder, or every entry was skipped). */
export class GfsFolderZipEmptyError extends Error {
  readonly skipped: GfsZipSkippedEntry[]
  constructor(folderName: string, skipped: GfsZipSkippedEntry[]) {
    super(`"${folderName}" has no downloadable files.`)
    this.name = 'GfsFolderZipEmptyError'
    this.skipped = skipped
  }
}

export interface GfsReadThrottle {
  acquire(): Promise<void>
}

export interface CreateGfsReadThrottleOptions {
  requestsPerMinute?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Sequential read spacing for the server's per-actor GFS budget: one acquired
 * slot per request, `60_000 / requestsPerMinute` apart. Injectable clock and
 * sleep keep the spacing testable without real time.
 */
export function createGfsReadThrottle(options: CreateGfsReadThrottleOptions = {}): GfsReadThrottle {
  const requestsPerMinute = options.requestsPerMinute ?? GFS_ZIP_READS_PER_MINUTE
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const intervalMs = 60_000 / requestsPerMinute
  let nextAllowedAt = 0
  return {
    async acquire() {
      const current = now()
      if (current < nextAllowedAt) {
        await sleep(nextAllowedAt - current)
      }
      nextAllowedAt = Math.max(nextAllowedAt, now()) + intervalMs
    },
  }
}

export interface GfsZipChildItem {
  resourceId: string
  gfsUri: string
  name: string
  kind: 'file' | 'directory'
  /** Absent on older servers — treated as 0 by the size guard, never as NaN. */
  bytes?: number
  drive?: string
  readable?: boolean
}

export interface GfsZipChildrenPage {
  items: GfsZipChildItem[]
  nextCursor: string | null
}

export interface GfsFolderZipDeps {
  listChildren(resourceId: string, drive: string, cursor?: string): Promise<GfsZipChildrenPage>
  download(uri: string): Promise<{ bytes: ArrayBuffer }>
  throttle: GfsReadThrottle
  sleep: (ms: number) => Promise<void>
}

export interface CreateGfsFolderZipOptions {
  onProgress?: (progress: GfsFolderZipProgress) => void
  limits?: { maxTotalBytes?: number; maxEntries?: number }
  deps?: Partial<GfsFolderZipDeps>
  /**
   * Cooperative stop for a walk that can legally run for many minutes: every
   * wait (throttle slot, 429 backoff, in-flight request) races the signal, and
   * each loop turn re-checks it. Aborting rejects with a DOMException named
   * `AbortError` (`isFolderZipAbortError`).
   */
  signal?: AbortSignal
}

export interface GfsZipFolderSource {
  resourceId: string
  drive: string
  name: string
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The user stopped the walk — not a failure, and never a save. */
export function isFolderZipAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function folderZipAbortedError(): DOMException {
  return new DOMException('Folder-zip walk was stopped.', 'AbortError')
}

/** A per-resource denial for THIS entry (403/forbidden), not a session failure. */
function isAccessDenied(message: string): boolean {
  return parseHttpStatus(message) === 403 || message.toLowerCase().includes('forbidden')
}

/**
 * Zip entry-name length ceiling per segment. ZIP name fields are 16-bit byte
 * counts; a name whose UTF-8 encoding reaches 65 536 bytes would silently
 * truncate there and corrupt the archive, so segments are cut well under it.
 */
export const GFS_ZIP_MAX_SEGMENT_NAME_BYTES = 1024

const segmentNameEncoder = new TextEncoder()

/** Truncates by code point so the UTF-8 encoding stays `maxBytes` or less. */
function truncateToUtf8Bytes(name: string, maxBytes: number): string {
  if (segmentNameEncoder.encode(name).length <= maxBytes) return name
  let kept = ''
  let used = 0
  for (const character of name) {
    const size = segmentNameEncoder.encode(character).length
    if (used + size > maxBytes) break
    kept += character
    used += size
  }
  return kept
}

/**
 * Zip-safe path segment. Separators, NUL and the characters Windows forbids
 * (`: * ? " < > |`) map to `_`; trailing dots/spaces (also invalid on Windows)
 * are stripped; only the EXACT `.`/`..` segments are dropped, so dotfiles like
 * `.env` keep their name; and the UTF-8 encoding is capped at
 * `GFS_ZIP_MAX_SEGMENT_NAME_BYTES` so the 16-bit ZIP name fields can never
 * truncate. Traversal is impossible regardless: separators are gone before the
 * segment is used.
 */
function sanitizeZipSegment(name: string): string {
  const cleaned = truncateToUtf8Bytes(
    name
      .replace(/[/\\:*?"<>|\u0000]/g, '_')
      .replace(/[\s.]+$/, '')
      .trim(),
    GFS_ZIP_MAX_SEGMENT_NAME_BYTES
  )
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'unnamed'
  return cleaned
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000]/g, '_')
    .replace(/[\s.]+$/, '')
    .trim()
  return cleaned || 'folder'
}

export async function createGfsFolderZip(
  folder: GfsZipFolderSource,
  options: CreateGfsFolderZipOptions = {}
): Promise<GfsFolderZipResult> {
  const maxTotalBytes = options.limits?.maxTotalBytes ?? GFS_ZIP_MAX_TOTAL_BYTES
  const maxEntries = options.limits?.maxEntries ?? GFS_ZIP_MAX_ENTRIES
  const listChildren: GfsFolderZipDeps['listChildren'] =
    options.deps?.listChildren ??
    ((resourceId, drive, cursor) => window.clerum.gfs.listChildren(resourceId, drive, cursor))
  const download: GfsFolderZipDeps['download'] =
    options.deps?.download ?? (uri => window.clerum.gfs.download(uri))
  const sleep =
    options.deps?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const throttle = options.deps?.throttle ?? createGfsReadThrottle()

  const report = (progress: GfsFolderZipProgress) => options.onProgress?.(progress)

  const signal = options.signal
  const throwIfAborted = () => {
    if (signal?.aborted) throw folderZipAbortedError()
  }
  // Rejects when the caller aborts; raced against every wait so a stop lands
  // immediately instead of after the current throttle slot or backoff. The
  // no-op catch keeps a late abort from becoming an unhandled rejection after
  // the walk already finished.
  const abortRejection = signal
    ? new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(folderZipAbortedError())
          },
          { once: true }
        )
      })
    : null
  if (abortRejection) abortRejection.catch(() => undefined)
  const withAbort = <T>(promise: Promise<T>): Promise<T> =>
    abortRejection ? Promise.race([promise, abortRejection]) : promise

  /**
   * One 429 backs off by the server-provided hint and retries exactly once.
   * The backoff window is NOT a throttle slot: after it elapses the retry
   * re-enters the budget through `throttle.acquire()`, so a
   * `retryAfterSeconds=0` answer cannot fire the retry with zero spacing
   * against the same per-minute budget that just refused the first attempt.
   * Both attempts race the abort signal, so a Stop during the retried request
   * preempts immediately instead of waiting out the in-flight call.
   */
  const withRateLimitRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await withAbort(operation())
    } catch (error) {
      if (isFolderZipAbortError(error)) throw error
      const message = toMessage(error)
      if (!isRateLimited(message)) throw error
      await withAbort(sleep(Math.min((parseRetryAfterSeconds(message) ?? 15) * 1000, 120_000)))
      await withAbort(throttle.acquire())
      return withAbort(operation())
    }
  }

  const skipped: GfsZipSkippedEntry[] = []
  const files: Array<{ uri: string; path: string }> = []
  const rootName = sanitizeZipSegment(folder.name)
  const queue: Array<{ resourceId: string; prefix: string }> = [
    { resourceId: folder.resourceId, prefix: rootName },
  ]
  const visitedFolders = new Set<string>()
  let plannedBytes = 0
  // Every accepted child, files AND folders, against `maxEntries` (R1-M3).
  let entriesSeen = 0
  // ── Phase 1: recursive listing (breadth-first, cursor-paginated). ──
  report({ phase: 'listing', filesFound: 0, filesAdded: 0, currentPath: rootName })
  while (queue.length) {
    throwIfAborted()
    const next = queue.shift()!
    if (visitedFolders.has(next.resourceId)) continue
    visitedFolders.add(next.resourceId)
    let cursor: string | undefined
    do {
      throwIfAborted()
      await withAbort(throttle.acquire())
      let page: GfsZipChildrenPage
      try {
        page = await withRateLimitRetry(() => listChildren(next.resourceId, folder.drive, cursor))
      } catch (error) {
        const message = toMessage(error)
        if (isAccessDenied(message)) {
          skipped.push({ path: next.prefix, reason: 'Permission denied' })
          break
        }
        throw error
      }
      for (const child of page.items) {
        const path = `${next.prefix}/${sanitizeZipSegment(child.name)}`
        if (child.readable === false) {
          skipped.push({ path, reason: 'No access' })
          continue
        }
        // Directories cost the same walk work as files (one listing request
        // each), so the entry budget counts BOTH kinds (R1-M3) — 2000 empty
        // folders is 2000 requests, not zero work.
        if (entriesSeen + 1 > maxEntries) {
          throw new GfsFolderZipLimitError(
            `"${folder.name}" holds more than ${maxEntries} entries (files and folders), which exceeds the folder-zip limit. Download smaller subfolders individually.`
          )
        }
        entriesSeen += 1
        if (child.kind === 'directory') {
          queue.push({ resourceId: child.resourceId, prefix: path })
          continue
        }
        // Older servers omit `bytes`; a missing value must read as 0, not
        // NaN — NaN would poison `plannedBytes` and silently disable the
        // size guard for the rest of the walk (M1).
        const childBytes =
          typeof child.bytes === 'number' && Number.isFinite(child.bytes) ? child.bytes : 0
        plannedBytes += childBytes
        if (plannedBytes > maxTotalBytes) {
          throw new GfsFolderZipLimitError(
            `"${folder.name}" exceeds the ${formatZipBytes(maxTotalBytes)} folder-zip limit. Download smaller subfolders individually.`
          )
        }
        files.push({ uri: child.gfsUri, path })
        report({
          phase: 'listing',
          filesFound: files.length,
          filesAdded: 0,
          currentPath: path,
        })
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }

  // An archive with zero entries is never useful: short-circuit instead of
  // saving an empty zip (L8). Any skips are carried on the error so the caller
  // can still explain why nothing was archivable.
  if (files.length === 0) throw new GfsFolderZipEmptyError(folder.name, skipped)

  // Pre-size the single archive buffer (M2): local header (30) + payload +
  // central record (46), each carrying the UTF-8 name, plus the 22-byte EOCD.
  // With server-provided sizes this allocates once; without them the writer
  // falls back to doubling.
  const nameEncoder = new TextEncoder()
  const estimatedArchiveBytes =
    plannedBytes +
    files.reduce((sum, file) => sum + 76 + 2 * nameEncoder.encode(file.path).length, 22)
  const writer = createZipWriter({ initialCapacityBytes: estimatedArchiveBytes })

  // ── Phase 2: throttled downloads, skipping per-resource denials. ──
  let addedBytes = 0
  for (const [index, file] of files.entries()) {
    throwIfAborted()
    // 1-based: the copy says "downloading N of M" while file N is fetched.
    report({
      phase: 'downloading',
      filesFound: files.length,
      filesAdded: index + 1,
      currentPath: file.path,
    })
    await withAbort(throttle.acquire())
    let bytes: ArrayBuffer
    try {
      bytes = (await withRateLimitRetry(() => download(file.uri))).bytes
    } catch (error) {
      if (isFolderZipAbortError(error)) throw error
      const message = toMessage(error)
      if (isAccessDenied(message)) {
        skipped.push({ path: file.path, reason: 'Permission denied' })
        continue
      }
      throw error
    }
    const data = new Uint8Array(bytes)
    addedBytes += data.length
    if (addedBytes > maxTotalBytes) {
      throw new GfsFolderZipLimitError(
        `"${folder.name}" exceeded the ${formatZipBytes(maxTotalBytes)} folder-zip limit while downloading. Download smaller subfolders individually.`
      )
    }
    writer.addFile(file.path, data)
  }

  // ── Phase 3: assemble the archive. ──
  report({
    phase: 'assembling',
    filesFound: files.length,
    filesAdded: writer.entryCount(),
    currentPath: null,
  })
  const archive = writer.build()
  return {
    bytes: archive,
    fileName: `${sanitizeFileName(folder.name)}.zip`,
    fileCount: writer.entryCount(),
    skipped,
  }
}

function formatZipBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024 * 1024))} GiB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`
  return `${Math.round(bytes / 1024)} KiB`
}

/** Visible skip notice for the result toast: names the first few skips. */
export function describeZipSkips(skipped: GfsZipSkippedEntry[]): string {
  const visible = skipped.slice(0, 3).map(entry => `${entry.path} (${entry.reason})`)
  const more = skipped.length - visible.length
  const names = more > 0 ? `${visible.join(', ')} and ${more} more` : visible.join(', ')
  return `Skipped ${skipped.length} ${skipped.length === 1 ? 'entry' : 'entries'}: ${names}`
}
