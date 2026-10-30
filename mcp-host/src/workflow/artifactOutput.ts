/**
 * Naming, placing and reporting the files the document generators write.
 */
import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { FREE_SPACE_FLOOR_MIN_BYTES, freeSpaceFloor } from '../internalTools/gfsDownloadStore'
import { logger } from '../logger'
import { CALLER_OUTPUTS_DIR } from '../workspace/callerOutputs'
import type { ArtifactMetadata, InternalToolResult } from './types'

const MAX_STEM_LENGTH = 120

/**
 * A filesystem error as `what` and its code, without the path Node puts in
 * the message: the error reaches the model, and in chat the path is the
 * Host's layout and the caller's key. Other errors pass through.
 */
function storageError(err: unknown, what: string): unknown {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return err instanceof Error && typeof code === 'string' ? new Error(`${what} (${code}).`) : err
}

/**
 * Extensions a requested name may already carry. Anything else after a dot is
 * part of the name, so "report.v2" keeps its "v2".
 */
const KNOWN_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'csv',
  'ppt',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'htm',
  'html',
  'json',
])

/**
 * A safe filename for a generated artifact.
 *
 * Only ASCII letters, digits, '.', '_' and '-' are kept, because the download
 * paths do not all encode other characters. Dropping characters must not make
 * two requested names equal ("報告.md" and "資料.md" would both be "__.md"), so
 * when anything other than a space is replaced or dropped a short hash of the
 * requested name is appended. The stem is shortened before the extension is
 * added, so a long name keeps its extension.
 */
export function outputFilename(requested: unknown, ext: string, fallbackStem: string): string {
  const extension = ext.replace(/^\./, '').toLowerCase()
  const base = path.basename(String(requested ?? '').normalize('NFC')).trim()
  const dot = base.lastIndexOf('.')
  const stem =
    dot > 0 && KNOWN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase()) ? base.slice(0, dot) : base

  if (!stem) return `${fallbackStem}.${extension}`
  const safe = stem
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
  if (safe === stem.replace(/\s+/g, '_') && safe && safe.length <= MAX_STEM_LENGTH) {
    return `${safe}.${extension}`
  }
  const hash = createHash('sha256').update(stem).digest('hex').slice(0, 8)
  return `${(safe || fallbackStem).slice(0, MAX_STEM_LENGTH - hash.length - 1)}-${hash}.${extension}`
}

export interface OutputTarget {
  filename: string
  filePath: string
  /** A file already at `filePath` will be overwritten. */
  replacesExisting: boolean
  /** The SHA-256 of the bytes writeArtifact published here. */
  writtenSha256?: string
}

/** Where to write `filename`; a file already there is replaced. */
export function claimOutputFile(outputDir: string, filename: string): OutputTarget {
  const filePath = path.join(outputDir, filename)
  const entry = lstat(filePath)
  // A write follows a symbolic link, so a link in the name's place is removed
  // and a regular file is written there instead of wherever it points.
  if (entry?.isSymbolicLink()) {
    try {
      fs.unlinkSync(filePath)
    } catch (err) {
      throw storageError(err, `Could not replace ${filename}`)
    }
  }
  return { filename, filePath, replacesExisting: !!entry && !entry.isSymbolicLink() }
}

function lstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file)
  } catch {
    return undefined
  }
}

/**
 * Size of the file a write is about to replace, so a quota check does not count
 * it twice. Only a regular file counts: a link planted in its place since
 * claimOutputFile must not lend the size of whatever it points to.
 */
export function replacedBytes(target: OutputTarget): number {
  if (!target.replacesExisting) return 0
  const entry = lstat(target.filePath)
  return entry?.isFile() ? entry.size : 0
}

/** Prefix of a file still being written: never listed, served, embedded or counted. */
export const PARTIAL_PREFIX = '.clerum-partial-'

export function isPartialArtifactName(name: string): boolean {
  return path.basename(name).startsWith(PARTIAL_PREFIX)
}

/** A partial file this old was left by a write that never finished. */
const ABANDONED_PARTIAL_MS = 60 * 60 * 1000

function removeAbandonedPartials(dir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - ABANDONED_PARTIAL_MS
  for (const name of names) {
    if (!isPartialArtifactName(name)) continue
    const file = path.join(dir, name)
    const entry = lstat(file)
    if (entry?.isFile() && entry.mtimeMs < cutoff) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Another write removed it, or it cannot be removed; the next write retries.
      }
    }
  }
}

/**
 * Writes `data` under `target` whole: into a new file beside it, created
 * without following links, flushed, then renamed over the name. A reader sees
 * the previous file or this one, never part of it; a link in the name's place
 * is replaced, not followed; a write that fails leaves the previous file and
 * no partial one.
 */
export function writeArtifact(target: OutputTarget, data: string | Uint8Array): void {
  try {
    publish(target, data)
  } catch (err) {
    throw storageError(err, `Could not save ${target.filename}`)
  }
}

function publish(target: OutputTarget, data: string | Uint8Array): void {
  const dir = path.dirname(target.filePath)
  removeAbandonedPartials(dir)
  const partial = path.join(dir, `${PARTIAL_PREFIX}${randomUUID()}`)
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(partial, O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0), 0o666)
  let published = false
  try {
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(partial, target.filePath)
    published = true
    target.writtenSha256 = createHash('sha256').update(data).digest('hex')
  } finally {
    if (!published) {
      try {
        fs.unlinkSync(partial)
      } catch {
        // Already gone; the error being thrown is the one that matters.
      }
    }
  }
  // The file is published; flushing the folder only makes the new name
  // survive a crash, so a folder that cannot be opened for it is not an error.
  try {
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY)
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    // Some filesystems refuse to fsync a directory.
  }
}

/** Lines of notes a result carries; the rest are counted. */
const MAX_NOTES = 12

/** Notes of one kind shown before the rest of the kind is counted. */
const NOTES_PER_KIND = 3

/** A note about content the file does not hold, which comes first. */
const LOSS_NOTE =
  /\b(dropped|left out|could not|cannot|missing|not drawn|was cut|were cut|skipped)\b/i

/**
 * `warnings` in a length the agent can relay: past a few, notes that differ
 * only in their numbers (a row, a cell, a count) are counted, and notes about
 * lost content come first.
 */
export function capNotes(warnings: string[]): string[] {
  const groups = new Map<string, { notes: string[]; loss: boolean }>()
  for (const warning of new Set(warnings)) {
    const key = warning.replace(/\d+(?:\.\d+)?/g, '#')
    const group = groups.get(key)
    if (group) group.notes.push(warning)
    else groups.set(key, { notes: [warning], loss: LOSS_NOTE.test(warning) })
  }
  const lines = [...groups.values()]
    .sort((a, b) => Number(b.loss) - Number(a.loss))
    .flatMap(({ notes }) => {
      const shown = notes.slice(0, NOTES_PER_KIND)
      const more = notes.length - shown.length
      if (more > 0) shown[shown.length - 1] += ` (${more} more like it.)`
      return shown
    })
  if (lines.length <= MAX_NOTES) return lines
  return [...lines.slice(0, MAX_NOTES), `(${lines.length - MAX_NOTES} more notes of other kinds.)`]
}

/**
 * The result of a generator that wrote `target`. The message leads with the
 * name the file was actually saved under, which is what another generator must
 * be given to embed it, and carries any warnings so the agent can relay them.
 */
export function artifactResult(
  target: OutputTarget,
  format: ArtifactMetadata['format'],
  opts: { summary?: string; warnings?: string[] } = {}
): InternalToolResult {
  let stats: fs.Stats
  try {
    stats = fs.statSync(target.filePath)
  } catch (err) {
    throw storageError(err, `Could not read ${target.filename} back`)
  }
  const parts = [opts.summary ?? `File generated: ${target.filename} (${format}).`]
  const warnings = capNotes(opts.warnings ?? [])
  if (warnings.length > 0) parts.push(`Notes: ${warnings.join(' ')}`)
  return {
    success: true,
    artifact: {
      name: target.filename,
      format,
      path: target.filePath,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    },
    content: parts.join('\n'),
    ...(target.writtenSha256 ? { writtenSha256: target.writtenSha256 } : {}),
  }
}

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw storageError(err, 'Could not open the output folder')
  }
}

// A dashboard with charts inlines the Chart.js UMD bundle (~210 KB) so the
// HTML works offline: about 250 of them fit in the default quota.
const DEFAULT_QUOTA_MB = 50

/**
 * Recursively sum the size of all regular files under `dir`.
 * Returns 0 if the directory does not exist.
 */
export function getDirectorySize(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += getDirectorySize(full)
    } else if (entry.isFile() && !isPartialArtifactName(entry.name)) {
      try {
        total += fs.statSync(full).size
      } catch {
        // file may have been removed between readdir and stat — ignore
      }
    }
  }
  return total
}

/** The last invalid quota setting logged, so each is logged once. */
let reportedQuotaSetting: string | undefined

/**
 * CLERUM_WORKFLOW_OUTPUT_QUOTA_MB as a whole number of megabytes. Anything
 * else ("2GB", "1.5", "0") leaves the default, and is logged once: read
 * leniently, "2GB" became a quota of 2 MB.
 */
function outputQuotaMB(raw: string | undefined): number {
  const text = raw?.trim() ?? ''
  if (text === '') return DEFAULT_QUOTA_MB
  if (/^\d+$/.test(text) && Number(text) > 0 && Number.isSafeInteger(Number(text))) {
    return Number(text)
  }
  if (reportedQuotaSetting !== raw) {
    reportedQuotaSetting = raw
    logger.warn(
      { component: 'ArtifactOutput', value: text.slice(0, 32), defaultMB: DEFAULT_QUOTA_MB },
      'CLERUM_WORKFLOW_OUTPUT_QUOTA_MB is not a whole number of megabytes; the default applies'
    )
  }
  return DEFAULT_QUOTA_MB
}

/**
 * Enforce the output quota of one folder before a file is written: a workflow
 * run's output, or one chat caller's folder, so in chat each user has their
 * own. A caller's folder must also leave the Host volume its free-space floor.
 *
 * Reads the ceiling from `CLERUM_WORKFLOW_OUTPUT_QUOTA_MB` (default: 50 MB).
 * Throws if the current directory usage + `incomingBytes` would exceed the cap.
 * `replacingBytes` is the size of a file the write overwrites, which stops
 * counting once it is replaced.
 *
 * Known limitation (race condition): When the LLM issues multiple tool calls
 * concurrently (e.g., generate_pdf + generate_xlsx in the same turn), both
 * calls read the directory size before either has written its file. Both see
 * the same "current" size and both pass the quota check, even though the
 * combined output would exceed the 50 MB cap. This is a best-effort soft
 * quota; the 1Gi PVC hard cap enforced by kubelet is the primary defense.
 */
export function enforceQuota(outputDir: string, incomingBytes: number, replacingBytes = 0): void {
  const quotaMB = outputQuotaMB(process.env.CLERUM_WORKFLOW_OUTPUT_QUOTA_MB)
  const quotaBytes = quotaMB * 1024 * 1024

  let size: number
  try {
    size = getDirectorySize(outputDir)
  } catch (err) {
    throw storageError(err, 'Could not measure the output folder')
  }
  const current = size - replacingBytes
  const projected = current + incomingBytes
  if (projected > quotaBytes) {
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
    throw new Error(
      `Output quota exceeded: the output folder holds ${mb(current)} MB and this file needs ` +
        `${mb(incomingBytes)} MB, over the ${quotaMB} MB limit. Make the file smaller, give ` +
        'it the name of an earlier generated file to replace that one, or ask an operator to ' +
        'raise CLERUM_WORKFLOW_OUTPUT_QUOTA_MB.'
    )
  }
  if (path.basename(outputDir) === CALLER_OUTPUTS_DIR)
    enforceFreeSpaceFloor(outputDir, incomingBytes)
}

/**
 * Whether `space` is the filesystem the root is on, judged by its size, its
 * block size and blocks: volumes of one APFS container, or an overlay root
 * over the node's disk, report the same size but not the same type or inodes.
 */
function sharesRootVolume(space: fs.BigIntStatsFs): boolean {
  try {
    const root = fs.statfsSync('/', { bigint: true })
    return root.bsize === space.bsize && root.blocks === space.blocks
  } catch {
    return false
  }
}

let unmeasurableVolumeReported = false

/** CLERUM_DEV_MODE, read as config.ts reads it. */
function devMode(): boolean {
  const value = process.env.CLERUM_DEV_MODE
  return !!value && (value.toLowerCase() === 'true' || value === '1')
}

/**
 * Every caller's folder shares the Host volume, so their quotas together do
 * not bound it: a write must leave the free space GFS keeps (freeSpaceFloor).
 * In development on the root's filesystem, the developer's own disk, that
 * share would be of the whole disk, so only the minimum is kept there. A
 * deployed Host keeps the share even on the node's disk (a local-path
 * volume), where filling it would put the node under disk pressure. Nothing is
 * removed to make room. A volume that cannot be measured does not refuse the
 * write; that is logged once.
 */
function enforceFreeSpaceFloor(outputDir: string, incomingBytes: number): void {
  let space: fs.BigIntStatsFs | undefined
  try {
    space = fs.statfsSync(outputDir, { bigint: true })
  } catch {
    space = undefined
  }
  if (!space || space.bsize <= 0n || space.blocks <= 0n || space.bavail < 0n) {
    if (!unmeasurableVolumeReported) {
      unmeasurableVolumeReported = true
      logger.warn(
        { component: 'ArtifactOutput' },
        'Could not measure the Host volume; generated files are written without the free-space floor'
      )
    }
    return
  }
  const blocks = (BigInt(incomingBytes) + space.bsize - 1n) / space.bsize
  const floor =
    devMode() && sharesRootVolume(space) ? FREE_SPACE_FLOOR_MIN_BYTES : freeSpaceFloor(space)
  if (blocks * space.bsize + floor > space.bavail * space.bsize) {
    const mb = (bytes: bigint) => (Number(bytes) / (1024 * 1024)).toFixed(1)
    throw new Error(
      `Not enough free space: the Host keeps ${mb(floor)} MB free and this file needs ` +
        `${mb(BigInt(incomingBytes))} MB. Make the file smaller, or ask an operator to free ` +
        'space on the Host.'
    )
  }
}

// ─── generate_chart ──────────────────────────────────────────────────
