/**
 * Files the Host keeps for a chat caller in `users/<key>/.clerum-outputs`:
 * the save record of each generated file, the chat attachments kept in
 * `.uploads/` for a later save, and the secret scan that runs on every file
 * the agent saves to GFS from the Host volume.
 *
 * Save records live in `.clerum-outputs/.save-ledger/`, one per generated
 * name, so a generated file can be saved later only when the chat delivered
 * it (the attachment check passed) and only while its bytes are the ones
 * delivered. The folder is out of reach of the file tools and of the Desktop
 * listing, like the generated files themselves.
 */
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readOpenedArtifactBuffer, redactArtifactForDelivery } from '../artifacts/artifactBytes'
import type { ArtifactSecretEntry } from '../artifacts/artifactRedaction'
import {
  OFFICE_PACKAGE_LIMITS,
  isOoxmlPackage,
  officePackageHasText,
} from '../artifacts/officePackageText'
import { attachmentSaveName } from '../core/attachments/attachmentSave'
import { textContainsRedactableSecretEntry } from '../core/tools/generatedArtifactAttachments'
import { validatePath } from '../core/tools/pathValidation'
import type { Attachment } from '../core/types'
import { logger } from '../logger'
import { isPartialArtifactName } from '../workflow/artifactOutput'
import { ArtifactPathError, openExistingArtifactFile } from '../workflow/artifactPaths'
import { withoutWriteTimes } from '../workflow/officeBoilerplate'
import { printedForms } from '../workflow/toolText'
import { KEPT_UPLOADS_DIR, resolveCallerOutputDir } from '../workspace/callerOutputs'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'
import { decodeTextContent } from './textContent'

/** The folder of save records inside a caller's `.clerum-outputs`. */
export const SAVE_LEDGER_DIR = '.save-ledger'

/** The largest record read back; a larger file is not a record. */
export const MAX_RECORD_BYTES = 64 * 1024

/** Bytes above this are not decoded as text by the scan (an Office package is still read). */
export const SCAN_TEXT_MAX_BYTES = 4 * 1024 * 1024

/** What the attachment check decided when the file was generated. */
export interface SaveLedgerRecord {
  /** 12 hex characters, random per generation. */
  id: string
  name: string
  format: string
  /** `delivered`, or the reason the attachment check withheld the file. */
  outcome: string
  /** ISO time the record was written. */
  createdAt: string
  /** SHA-256 of the attachment bytes the chat received; only for `delivered`. */
  deliveredSha256?: string
}

/** A save record could not be written; `code` is a file-system code, never a path. */
export class SaveLedgerWriteError extends Error {
  constructor(readonly code: string) {
    super(`save record could not be written (${code})`)
    this.name = 'SaveLedgerWriteError'
  }
}

/** The record file name for a generated file name: the name's SHA-256, so any name maps to one safe file. */
export function ledgerRecordFileName(name: string): string {
  return `${createHash('sha256').update(name, 'utf8').digest('hex')}.json`
}

/** A new save id: 12 hex characters from 6 random bytes, never derived from content. */
export function newSaveId(): string {
  return randomBytes(6).toString('hex')
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'EIO'
}

/**
 * `<outputDir>/.save-ledger`, created owner-only when missing. Anything there
 * that is not a real directory (a file, a link) is refused, so a record is
 * never written through a link.
 */
function ledgerDir(outputDir: string): string {
  const dir = path.join(outputDir, SAVE_LEDGER_DIR)
  let info: fs.Stats
  try {
    info = fs.lstatSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    fs.mkdirSync(dir, { mode: 0o700 })
    info = fs.lstatSync(dir)
  }
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(dir) !== dir) {
    throw new SaveLedgerWriteError('EEXIST')
  }
  return dir
}

/**
 * Writes the record of one generation: a temporary file inside
 * `.save-ledger/` (never in `.clerum-outputs` itself, where Desktop would list
 * it), created exclusively, owner-only, synced, then renamed over the name's
 * record. Throws {@link SaveLedgerWriteError} on any failure.
 */
export function writeSaveLedgerRecord(outputDir: string, record: SaveLedgerRecord): void {
  let tmp: string | undefined
  try {
    const dir = ledgerDir(outputDir)
    const target = path.join(dir, ledgerRecordFileName(record.name))
    tmp = path.join(
      dir,
      `${ledgerRecordFileName(record.name)}.${randomBytes(4).toString('hex')}.tmp`
    )
    const fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    )
    try {
      fs.writeSync(fd, JSON.stringify(record))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
    tmp = undefined
  } catch (err) {
    if (tmp) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // The temporary file expires by its own time if it cannot be removed now.
      }
    }
    if (err instanceof SaveLedgerWriteError) throw err
    throw new SaveLedgerWriteError(errorCode(err))
  }
}

/** The outcome of {@link scanForSecrets}. */
export type SecretScanResult =
  | { state: 'secret_found' }
  | { state: 'scanned' }
  | {
      state: 'not_scanned'
      reason:
        | 'empty_file'
        | 'too_large_to_scan'
        | 'office_package_unreadable'
        | 'binary_format'
        | 'scan_error'
    }

/**
 * Whether `bytes` hold a secret entry in clear, decided from the bytes alone:
 * no name, extension, format or record is consulted. Text of at most 4 MiB is
 * matched as read and in each printed form; an Office Open XML package of any
 * size is read part by part within the package limits; everything else (a
 * PDF, an image, an archive, larger text) is not read and is reported as
 * such. It never throws: a failure is reported as `scan_error`.
 */
export function scanForSecrets(bytes: Buffer, entries: ArtifactSecretEntry[]): SecretScanResult {
  try {
    if (bytes.length === 0) return { state: 'not_scanned', reason: 'empty_file' }
    const holds = (text: string): boolean => textContainsRedactableSecretEntry(text, entries)
    if (bytes.length <= SCAN_TEXT_MAX_BYTES) {
      const text = decodeTextContent(bytes)
      if (text !== null) {
        if (entries.length === 0) return { state: 'scanned' }
        return holds(text) || printedForms(text).some(holds)
          ? { state: 'secret_found' }
          : { state: 'scanned' }
      }
    }
    if (isOoxmlPackage(bytes)) {
      if (entries.length === 0) return { state: 'scanned' }
      const found = officePackageHasText(
        bytes,
        text => holds(withoutWriteTimes(text)),
        OFFICE_PACKAGE_LIMITS,
        holds
      )
      if (found === true) return { state: 'secret_found' }
      if (found === false) return { state: 'scanned' }
      return { state: 'not_scanned', reason: 'office_package_unreadable' }
    }
    if (bytes.length > SCAN_TEXT_MAX_BYTES)
      return { state: 'not_scanned', reason: 'too_large_to_scan' }
    return { state: 'not_scanned', reason: 'binary_format' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    logger.warn(
      {
        component: 'KeptFiles',
        errorName: err instanceof Error ? err.name : typeof err,
        ...(typeof code === 'string' ? { errorCode: code } : {}),
      },
      'Secret scan failed; the file is reported as not scanned'
    )
    return { state: 'not_scanned', reason: 'scan_error' }
  }
}

// ---------------------------------------------------------------------------
// Reading the caller's kept files: the sources of the GFS write tools and the
// listing. Every file is opened with the artifact opener (no link followed,
// regular files only, non-blocking) and read within the artifact bound.
// ---------------------------------------------------------------------------

/** Where the sources of one chat caller come from; every path is the caller's own. */
export interface KeptFileSources {
  /** The verified caller root `<host>/users/<key>`; its `.clerum-outputs` holds the kept files. */
  callerRoot?: string
  /** The caller's workspace root, from which `sourcePath` is resolved. */
  callerWorkspacePath?: string
  /** The Host's current secret entries, for redaction and the scan. */
  secretEntries: () => ArtifactSecretEntry[]
}

/** A file read from one of the sources, ready to upload. */
export interface ResolvedSourceFile {
  source: 'generated_file' | 'source_path' | 'kept_upload'
  bytes: Buffer
  secretScan: SecretScanResult
}

/** Why a source could not be used. `argument` marks a call to correct, not a missing file. */
export interface SourceRefusal {
  error: string
  argument?: true
}

export type SourceResolution = ResolvedSourceFile | SourceRefusal

export function isSourceRefusal(value: SourceResolution): value is SourceRefusal {
  return 'error' in value
}

function retentionHours(): number {
  return Math.round(GFS_FILE_LIMITS.retentionMs / 3_600_000)
}

/** The message of `kept_file_not_found`; it carries the retention in hours, as digits. */
export function keptFileNotFound(): SourceRefusal {
  return {
    error:
      `kept_file_not_found: no such file for this user: it was never created, ` +
      `it expired after ${retentionHours()} hours, or it was deleted`,
  }
}

export const KEPT_FILES_UNAVAILABLE =
  'kept_files_unavailable: this conversation has no private file folder on this Host, so no kept file can be used'
export const SOURCE_PATH_UNAVAILABLE =
  'source_path_unavailable: this conversation has no private workspace on this Host, so sourcePath cannot be used'
export const SOURCE_PATH_INVALID =
  'source_path_invalid: give the relative path of a regular file in your workspace; reserved folders and paths whose first part starts with a dot are refused'
export const DOWNLOADS_HINT =
  'source_path_invalid: a downloaded copy cannot be saved from .gfs-downloads; write the changed file outside .gfs-downloads, for example in outputs/, and save that path with sourcePath'
export const NO_SAVE_ID = 'this file has no save id: call again with generatedFile only'
export const HAS_SAVE_ID =
  'this file has a save id: call clerum__kept_files_list and pass its id as generatedFileId'
export const WITHHELD_SENTENCE =
  'this file was not delivered to the chat because it holds a protected value or could not be checked, so it cannot be saved; generate it again without that value'
/** For a withheld file whose outcome is not about a protected value or a failed check. */
export const WITHHELD_OTHER_SENTENCE =
  'this file was not delivered to the chat, so it cannot be saved; generate it again'

/** Withheld outcomes about a protected value, or a check that could not run. */
const PROTECTED_VALUE_OUTCOMES = new Set([
  'binary_redaction_unavailable',
  'binary_source_payload_unavailable',
  'text_redaction_unavailable',
  'office_package_unreadable',
])

function withheldSentence(outcome: string): string {
  return PROTECTED_VALUE_OUTCOMES.has(outcome) ? WITHHELD_SENTENCE : WITHHELD_OTHER_SENTENCE
}
export const FILE_CONTAINS_SECRET =
  'file_contains_secret: the file holds a protected value of this Host, so it was not saved'

/** `name_format_mismatch`: the generated file's format, and the ending its GFS name needs. */
export function nameFormatMismatch(format: string): SourceRefusal {
  return {
    error: `name_format_mismatch: this file is a ${format} file: give it a name that ends in .${format}`,
  }
}

/**
 * Maps an opener or reader failure: a missing, refused or invalid name is the
 * source's not-found answer; a file over the bound is `limit_exceeded`; any
 * other failure (a read error, a file changed during the read) says so with
 * its code and is never reported as missing.
 */
function readFailure(err: unknown, notFound: () => SourceRefusal): SourceRefusal {
  if (err instanceof ArtifactPathError) {
    if (err.status === 400 || err.status === 403 || err.status === 404) return notFound()
    if (err.status === 413) {
      return { error: 'limit_exceeded: the file is larger than the Host can save to GFS' }
    }
    return { error: `could not read the file (${err.code ?? 'EIO'})` }
  }
  return { error: `could not read the file (${errorCode(err)})` }
}

/** Reads `name` directly inside `dir` through the artifact opener, within `maxBytes`. */
function readKeptFile(dir: string, name: string, maxBytes?: number): Buffer {
  const opened = openExistingArtifactFile(dir, name)
  try {
    return readOpenedArtifactBuffer(opened, maxBytes)
  } finally {
    try {
      fs.closeSync(opened.fd)
    } catch {
      // Closing after the outcome is known.
    }
  }
}

function isRecord(value: unknown): value is SaveLedgerRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    /^[0-9a-f]{12}$/.test(r.id) &&
    typeof r.name === 'string' &&
    typeof r.format === 'string' &&
    typeof r.outcome === 'string' &&
    typeof r.createdAt === 'string' &&
    (r.deliveredSha256 === undefined || typeof r.deliveredSha256 === 'string')
  )
}

/**
 * The save record of `name` in `outputDir`, or undefined when there is none or
 * it cannot be read as one (missing, not a regular file, too large, malformed,
 * or naming another file).
 */
export function readSaveLedgerRecord(
  outputDir: string,
  name: string
): SaveLedgerRecord | undefined {
  let raw: Buffer
  try {
    raw = readKeptFile(
      path.join(outputDir, SAVE_LEDGER_DIR),
      ledgerRecordFileName(name),
      MAX_RECORD_BYTES
    )
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    return isRecord(parsed) && parsed.name === name ? parsed : undefined
  } catch {
    return undefined
  }
}

type OutputLookup = { dir: string } | SourceRefusal

function keptOutputDir(sources: KeptFileSources): OutputLookup {
  if (!sources.callerRoot) return { error: KEPT_FILES_UNAVAILABLE }
  const lookup = resolveCallerOutputDir(sources.callerRoot, { create: false })
  if ('dir' in lookup) return lookup
  if ('missing' in lookup) return keptFileNotFound()
  return { error: KEPT_FILES_UNAVAILABLE }
}

function regularFileExists(dir: string, name: string): boolean {
  try {
    const opened = openExistingArtifactFile(dir, name)
    fs.closeSync(opened.fd)
    return true
  } catch {
    return false
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * A generated file of the caller's `.clerum-outputs`. With a save record the
 * call must give its id: the record must be the latest generation of the name,
 * delivered to the chat, and the file's bytes as redacted now must hash to
 * what the chat received; the redacted bytes are uploaded. Without a record
 * (a dashboard, or a file generated before records existed) the call names the
 * file only and its bytes as read are uploaded. Both go through the scan.
 * `createName`, for a new GFS file, must end in the record's format.
 */
export function resolveGeneratedFile(
  sources: KeptFileSources,
  name: string,
  generatedFileId: string | undefined,
  createName?: string
): SourceResolution {
  const out = keptOutputDir(sources)
  if ('error' in out) return out
  const record = readSaveLedgerRecord(out.dir, name)
  if (!record) {
    if (generatedFileId !== undefined) {
      return regularFileExists(out.dir, name)
        ? { error: NO_SAVE_ID, argument: true }
        : keptFileNotFound()
    }
    let bytes: Buffer
    try {
      bytes = readKeptFile(out.dir, name)
    } catch (err) {
      return readFailure(err, keptFileNotFound)
    }
    return {
      source: 'generated_file',
      bytes,
      secretScan: scanForSecrets(bytes, sources.secretEntries()),
    }
  }
  if (generatedFileId === undefined) return { error: HAS_SAVE_ID, argument: true }
  if (record.id !== generatedFileId) {
    return {
      error:
        `kept_file_replaced: a newer file was generated under this name at ${record.createdAt}; ` +
        `call clerum__kept_files_list for its id, or ask the user which file they mean`,
    }
  }
  if (record.outcome !== 'delivered' || record.deliveredSha256 === undefined) {
    return { error: `kept_file_withheld (${record.outcome}): ${withheldSentence(record.outcome)}` }
  }
  let bytes: Buffer
  try {
    bytes = readKeptFile(out.dir, name)
  } catch (err) {
    return readFailure(err, keptFileNotFound)
  }
  const entries = sources.secretEntries()
  const delivered = redactArtifactForDelivery(record.format, bytes, entries).buffer
  if (createHash('sha256').update(delivered).digest('hex') !== record.deliveredSha256) {
    return {
      error:
        'kept_file_changed: the file or the Host protected values changed since it was generated; generate it again',
    }
  }
  if (createName !== undefined && extensionOf(createName) !== record.format) {
    return nameFormatMismatch(record.format)
  }
  return {
    source: 'generated_file',
    bytes: delivered,
    secretScan: scanForSecrets(delivered, entries),
  }
}

/**
 * A regular file of the caller's workspace, by its path relative to the
 * workspace root: `validatePath` refuses absolute paths, `..`, links out of the
 * root and reserved folders at any depth; a first part that starts with a dot
 * is refused too (tool configuration under the shell's home). A refused path
 * that goes through `.gfs-downloads` gets the hint that says how to proceed.
 */
export function resolveSourcePath(sources: KeptFileSources, sourcePath: string): SourceResolution {
  const root = sources.callerWorkspacePath
  if (!root) return { error: SOURCE_PATH_UNAVAILABLE }
  const invalid = (): SourceRefusal => ({
    error: sourcePath.split(/[\\/]+/).includes('.gfs-downloads')
      ? DOWNLOADS_HINT
      : SOURCE_PATH_INVALID,
  })
  const checked = validatePath(sourcePath, root)
  if (!checked.valid) return invalid()
  const first = sourcePath.split(/[\\/]+/).find(segment => segment !== '' && segment !== '.')
  if (first === undefined || first.startsWith('.')) return invalid()
  let bytes: Buffer
  try {
    bytes = readKeptFile(path.dirname(checked.resolved), path.basename(checked.resolved))
  } catch (err) {
    return readFailure(err, invalid)
  }
  return {
    source: 'source_path',
    bytes,
    secretScan: scanForSecrets(bytes, sources.secretEntries()),
  }
}

/** One entry of {@link listKeptFiles}. */
export interface KeptFileEntry {
  kind: 'generated' | 'upload'
  name: string
  id?: string
  format: string
  createdAt: string
  sizeBytes: number
  canSave: boolean
  reason?: string
  /** Where the entry lives, for the delete; never shown to the model. */
  location: KeptFileLocation
}

/** A kept file's path and identity as listed, and its record's. */
export interface KeptFileLocation {
  file: string
  fileIdentity: { dev: number; ino: number; mtimeMs: number }
  record?: string
  recordIdentity?: { dev: number; ino: number; size: number }
}

function identityOf(file: string): { dev: number; ino: number; size: number } | undefined {
  try {
    const info = fs.lstatSync(file)
    return info.isFile() ? { dev: info.dev, ino: info.ino, size: info.size } : undefined
  } catch {
    return undefined
  }
}

function located(file: string, info: fs.Stats, record?: string): KeptFileLocation {
  const recordIdentity = record === undefined ? undefined : identityOf(record)
  return {
    file,
    fileIdentity: { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs },
    ...(record !== undefined && recordIdentity !== undefined ? { record, recordIdentity } : {}),
  }
}

/**
 * Every kept file of the caller, oldest first and uncut: generated files with
 * their record's id and verdict (a file with no record has no id and is saved
 * by name). Files still being written are skipped. Nothing else of the caller
 * root is read. No folder yet is an empty list.
 */
export function listKeptFiles(callerRoot: string): KeptFileEntry[] {
  const lookup = resolveCallerOutputDir(callerRoot, { create: false })
  if ('missing' in lookup) return []
  if (!('dir' in lookup)) throw new KeptFilesUnavailableError()
  const entries: KeptFileEntry[] = []
  for (const dirent of fs.readdirSync(lookup.dir, { withFileTypes: true })) {
    if (!dirent.isFile() || isPartialArtifactName(dirent.name)) continue
    let info: fs.Stats
    try {
      info = fs.lstatSync(path.join(lookup.dir, dirent.name))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const record = readSaveLedgerRecord(lookup.dir, dirent.name)
    if (record) {
      const delivered = record.outcome === 'delivered'
      entries.push({
        kind: 'generated',
        name: dirent.name,
        id: record.id,
        format: record.format,
        createdAt: record.createdAt,
        sizeBytes: info.size,
        canSave: delivered,
        ...(delivered ? {} : { reason: record.outcome }),
        location: located(
          path.join(lookup.dir, dirent.name),
          info,
          path.join(lookup.dir, SAVE_LEDGER_DIR, ledgerRecordFileName(dirent.name))
        ),
      })
    } else {
      entries.push({
        kind: 'generated',
        name: dirent.name,
        format: extensionOf(dirent.name),
        createdAt: info.mtime.toISOString(),
        sizeBytes: info.size,
        canSave: true,
        reason: 'no_record',
        location: located(path.join(lookup.dir, dirent.name), info),
      })
    }
  }
  entries.push(...listKeptUploads(callerRoot))
  return entries.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.name.localeCompare(b.name)
  )
}

/**
 * The caller's kept attachments: an upload is listed only when both its
 * `<id>.bin` and a readable `<id>.json` exist; a half-written or leftover half
 * is not shown and leaves by its own time.
 */
function listKeptUploads(callerRoot: string): KeptFileEntry[] {
  const lookup = resolveCallerOutputDir(callerRoot, { create: false, subfolder: KEPT_UPLOADS_DIR })
  if ('missing' in lookup) return []
  if (!('dir' in lookup)) throw new KeptFilesUnavailableError()
  const entries: KeptFileEntry[] = []
  for (const dirent of fs.readdirSync(lookup.dir, { withFileTypes: true })) {
    const match = UPLOAD_BYTES_NAME.exec(dirent.name)
    if (!dirent.isFile() || !match) continue
    const id = match[1]!
    let info: fs.Stats
    try {
      info = fs.lstatSync(path.join(lookup.dir, dirent.name))
    } catch {
      continue
    }
    const record = readUploadRecord(lookup.dir, id)
    if (!info.isFile() || !record) continue
    entries.push({
      kind: 'upload',
      name: record.name,
      id,
      format: extensionOf(record.name),
      createdAt: record.createdAt,
      sizeBytes: info.size,
      canSave: true,
      location: located(
        path.join(lookup.dir, dirent.name),
        info,
        path.join(lookup.dir, `${id}.json`)
      ),
    })
  }
  return entries
}

/**
 * The no-room offer for a refused keep: the bytes short and the caller's own
 * files that have an id (files with no record cannot be deleted), oldest
 * first, from the uncut list.
 */
export function buildKeepOffer(
  callerRoot: string,
  neededBytes: number,
  now: number
): {
  neededBytes: number
  deletable: Array<{
    kind: 'generated' | 'upload'
    id: string
    name: string
    sizeBytes: number
    ageHours: number
  }>
} {
  const deletable = listKeptFiles(callerRoot)
    .filter(entry => entry.id !== undefined)
    .map(entry => ({
      kind: entry.kind,
      id: entry.id!,
      name: entry.name,
      sizeBytes: entry.sizeBytes,
      ageHours: Math.max(0, Math.floor((now - Date.parse(entry.createdAt)) / 3_600_000)),
    }))
  return { neededBytes, deletable }
}

/** One file to delete, as the model names it from the listing. */
export interface KeptFileToDelete {
  kind: 'generated' | 'upload'
  id: string
  name: string
}

export type KeptFileDeletion =
  | { status: 'mismatch' }
  | {
      status: 'done'
      files: Array<KeptFileToDelete & { result: 'deleted' | 'not_found' }>
      freedBytes: number
    }

/**
 * Deletes the caller's own recorded files named by kind, id and name, from
 * the uncut list, so a file the listing tool's first entries do not show can
 * still be deleted. Every name must equal its entry's, or nothing is deleted.
 * Each removal is one synchronous block that removes only the file listed
 * (same dev and inode), file then record. A file with no record, a file that
 * expired or was regenerated since the listing, and another caller's id are
 * `not_found`; a generated file newer than its record is being regenerated
 * and is `not_found` too.
 */
export function deleteKeptFiles(
  callerRoot: string,
  requested: readonly KeptFileToDelete[]
): KeptFileDeletion {
  const entries = listKeptFiles(callerRoot)
  const find = (file: KeptFileToDelete) =>
    entries.find(
      entry => entry.kind === file.kind && entry.id !== undefined && entry.id === file.id
    )
  for (const file of requested) {
    const entry = find(file)
    if (entry && entry.name !== file.name) return { status: 'mismatch' }
  }
  let freedBytes = 0
  const files = requested.map(file => {
    const entry = find(file)
    const location = entry?.location
    if (!entry || !location?.record || !location.recordIdentity) {
      return { ...file, result: 'not_found' as const }
    }
    if (
      entry.kind === 'generated' &&
      Math.floor(location.fileIdentity.mtimeMs) > Date.parse(entry.createdAt)
    ) {
      return { ...file, result: 'not_found' as const }
    }
    if (!unlinkIfSame(location.file, location.fileIdentity)) {
      return { ...file, result: 'not_found' as const }
    }
    freedBytes += entry.sizeBytes
    if (unlinkIfSame(location.record, location.recordIdentity)) {
      freedBytes += location.recordIdentity.size
    }
    return { ...file, result: 'deleted' as const }
  })
  return { status: 'done', files, freedBytes }
}

/** Removes `file` only while it is the file identified, in one synchronous block. */
function unlinkIfSame(file: string, identity: { dev: number; ino: number }): boolean {
  try {
    const now = fs.lstatSync(file)
    if (!now.isFile() || now.dev !== identity.dev || now.ino !== identity.ino) return false
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

const UPLOAD_ID = /^[0-9a-f]{12}$/
const UPLOAD_BYTES_NAME = /^([0-9a-f]{12})\.bin$/

interface UploadRecord {
  id: string
  name: string
  createdAt: string
}

function readUploadRecord(dir: string, id: string): UploadRecord | undefined {
  let raw: Buffer
  try {
    raw = readKeptFile(dir, `${id}.json`, MAX_RECORD_BYTES)
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    return parsed.id === id &&
      typeof parsed.name === 'string' &&
      typeof parsed.createdAt === 'string' &&
      Number.isFinite(Date.parse(parsed.createdAt))
      ? { id, name: parsed.name, createdAt: parsed.createdAt }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * A kept attachment of the caller, by its id: its record and its bytes, then
 * the scan. Uploads are scanned like every other file source, so a later save
 * of a file the user attached can be refused for a protected value it holds.
 */
export function resolveKeptUpload(
  sources: KeptFileSources,
  uploadedFileId: string
): SourceResolution {
  if (!UPLOAD_ID.test(uploadedFileId)) {
    return {
      error: 'uploadedFileId must be the 12-character id clerum__kept_files_list gives',
      argument: true,
    }
  }
  if (!sources.callerRoot) return { error: KEPT_FILES_UNAVAILABLE }
  const lookup = resolveCallerOutputDir(sources.callerRoot, {
    create: false,
    subfolder: KEPT_UPLOADS_DIR,
  })
  if ('missing' in lookup) return keptFileNotFound()
  if (!('dir' in lookup)) return { error: KEPT_FILES_UNAVAILABLE }
  if (!readUploadRecord(lookup.dir, uploadedFileId)) return keptFileNotFound()
  let bytes: Buffer
  try {
    bytes = readKeptFile(lookup.dir, `${uploadedFileId}.bin`)
  } catch (err) {
    return readFailure(err, keptFileNotFound)
  }
  return {
    source: 'kept_upload',
    bytes,
    secretScan: scanForSecrets(bytes, sources.secretEntries()),
  }
}

/** Why a message's attachments were not kept, and for a space refusal the bytes short. */
export interface KeepRefusal {
  code: string
  neededBytes?: number
}

/**
 * The guards of a keep at admission, then the keep. A Host whose token cannot
 * write to GFS has no tool that could save a kept file, so it keeps nothing
 * and says nothing (undefined). Otherwise a message with no sender, a caller
 * root that does not verify or no download store is refused with its code.
 */
export async function keepIncomingAttachments(input: {
  message: { sender?: string; attachments?: readonly Attachment[] }
  canWriteGfs: boolean
  callerRoot: string | undefined
  store: KeptReservations | null | undefined
}): Promise<KeepRefusal | undefined> {
  if (!input.canWriteGfs) return undefined
  if (!input.message.sender) return { code: 'no_sender' }
  if (!input.callerRoot) return { code: 'caller_root_unavailable' }
  if (!input.store) return { code: 'store_unavailable' }
  return keepMessageAttachments({
    attachments: input.message.attachments ?? [],
    callerRoot: input.callerRoot,
    store: input.store,
  })
}

/** The store side of a keep: one reservation for the message's bytes. */
export interface KeptReservations {
  reserveKept(input: { callerIdentity: string; sizeBytes: number }): Promise<() => void>
}

/**
 * Keeps the attachments of one message that carry bytes (files and images) in
 * the caller's `.clerum-outputs/.uploads/`, so they can be saved in a later
 * turn: one reservation for their total, then, outside the store's section,
 * per attachment `<id>.bin` and its record `<id>.json`, both created
 * exclusively and owner-only. All or nothing: a write error removes what this
 * call wrote. Returns the refusal, or undefined when every attachment is kept.
 */
export async function keepMessageAttachments(input: {
  attachments: readonly Attachment[]
  callerRoot: string
  store: KeptReservations
}): Promise<KeepRefusal | undefined> {
  const withBytes = input.attachments.filter(
    attachment => typeof attachment.dataBase64 === 'string'
  )
  if (withBytes.length === 0) return undefined
  const lookup = resolveCallerOutputDir(input.callerRoot, {
    create: true,
    subfolder: KEPT_UPLOADS_DIR,
  })
  if (!('dir' in lookup)) {
    return { code: 'kept_files_unavailable' }
  }
  const dir = lookup.dir
  const decoded: Array<{ name: string; bytes: Buffer }> = []
  for (const attachment of withBytes) {
    // Admission lets no file through without a usable name; one that has none is refused here.
    const name = attachmentSaveName(attachment)
    if (name === null) return { code: 'attachment_name_missing' }
    decoded.push({ name, bytes: Buffer.from(attachment.dataBase64!, 'base64') })
  }
  const total = decoded.reduce((sum, item) => sum + item.bytes.byteLength, 0)
  let release: () => void
  try {
    release = await input.store.reserveKept({
      callerIdentity: path.basename(input.callerRoot),
      sizeBytes: total,
    })
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    const neededBytes = (err as { neededBytes?: unknown })?.neededBytes
    return {
      code: typeof code === 'string' ? code : 'store_unavailable',
      ...(typeof neededBytes === 'number' ? { neededBytes } : {}),
    }
  }
  const written: string[] = []
  try {
    for (const { name, bytes } of decoded) {
      const id = newSaveId()
      const createdAt = new Date().toISOString()
      for (const [file, data] of [
        [`${id}.bin`, bytes],
        [`${id}.json`, Buffer.from(JSON.stringify({ id, name, createdAt }))],
      ] as const) {
        const target = path.join(dir, file)
        const handle = await fs.promises.open(
          target,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW ?? 0),
          0o600
        )
        written.push(target)
        try {
          await handle.writeFile(data)
        } finally {
          await handle.close()
        }
      }
    }
    return undefined
  } catch (err) {
    for (const file of written) {
      try {
        await fs.promises.unlink(file)
      } catch {
        // Left behind, it is not listed and expires by its own time.
      }
    }
    return { code: `write_failed_${errorCode(err).toLowerCase()}` }
  } finally {
    release()
  }
}

/** The caller's kept folder exists but cannot be verified. */
export class KeptFilesUnavailableError extends Error {
  constructor() {
    super(KEPT_FILES_UNAVAILABLE)
    this.name = 'KeptFilesUnavailableError'
  }
}
