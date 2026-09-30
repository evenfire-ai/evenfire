/**
 * BUG-175 — recursive "Download as zip" for a GFS folder, assembled fully in
 * the renderer from the existing `window.clerum.gfs` read plane.
 *
 * Budget contract: the server meters GFS reads per actor (~120 requests/min
 * shared with the browsing surface), so every listing and download below goes
 * through `createGfsReadThrottle`, which spaces requests to that budget, and a
 * 429 answer backs off once by the server-provided `retryAfterSeconds` before
 * failing. Byte and entry ceilings bound the walk before anything large is
 * buffered, and entries the caller cannot read (a listing row marked
 * unreadable, or a 403 on the download itself) are skipped and reported back
 * so the result can show a visible skip notice instead of a silently holey
 * archive.
 */
import { isRateLimited, parseHttpStatus, parseRetryAfterSeconds } from '@lib/gfsGrantErrors'
import { createZipWriter } from '@lib/zipWriter'

/** Server-side GFS read budget the walk must respect (requests per minute). */
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
  bytes: number
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
}

export interface GfsZipFolderSource {
  resourceId: string
  drive: string
  name: string
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A per-resource denial for THIS entry (403/forbidden), not a session failure. */
function isAccessDenied(message: string): boolean {
  return parseHttpStatus(message) === 403 || message.toLowerCase().includes('forbidden')
}

/** Zip-safe path segment: no separators, no NUL, no traversal prefix. */
function sanitizeZipSegment(name: string): string {
  const cleaned = name
    .replace(/[/\\\u0000]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || 'unnamed'
}

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\\u0000]/g, '_').trim() || 'folder'
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

  /** One 429 backs off by the server-provided hint and retries exactly once. */
  const withRateLimitRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      const message = toMessage(error)
      if (!isRateLimited(message)) throw error
      await sleep(Math.min((parseRetryAfterSeconds(message) ?? 15) * 1000, 120_000))
      return operation()
    }
  }

  const writer = createZipWriter()
  const skipped: GfsZipSkippedEntry[] = []
  const files: Array<{ uri: string; path: string }> = []
  const rootName = sanitizeZipSegment(folder.name)
  const queue: Array<{ resourceId: string; prefix: string }> = [
    { resourceId: folder.resourceId, prefix: rootName },
  ]
  const visitedFolders = new Set<string>()
  let plannedBytes = 0

  // ── Phase 1: recursive listing (breadth-first, cursor-paginated). ──
  report({ phase: 'listing', filesFound: 0, filesAdded: 0, currentPath: rootName })
  while (queue.length) {
    const next = queue.shift()!
    if (visitedFolders.has(next.resourceId)) continue
    visitedFolders.add(next.resourceId)
    let cursor: string | undefined
    do {
      await throttle.acquire()
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
        if (child.kind === 'directory') {
          if (child.readable === false) {
            skipped.push({ path, reason: 'No access' })
            continue
          }
          queue.push({ resourceId: child.resourceId, prefix: path })
          continue
        }
        if (child.readable === false) {
          skipped.push({ path, reason: 'No access' })
          continue
        }
        if (files.length + 1 > maxEntries) {
          throw new GfsFolderZipLimitError(
            `"${folder.name}" holds more than ${maxEntries} files, which exceeds the folder-zip limit. Download smaller subfolders individually.`
          )
        }
        plannedBytes += child.bytes
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

  // ── Phase 2: throttled downloads, skipping per-resource denials. ──
  let addedBytes = 0
  for (const [index, file] of files.entries()) {
    report({
      phase: 'downloading',
      filesFound: files.length,
      filesAdded: index,
      currentPath: file.path,
    })
    await throttle.acquire()
    let bytes: ArrayBuffer
    try {
      bytes = (await withRateLimitRetry(() => download(file.uri))).bytes
    } catch (error) {
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
