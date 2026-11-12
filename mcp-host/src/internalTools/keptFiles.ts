/**
 * Files the Host keeps for a chat caller in `users/<key>/.clerum-outputs`:
 * the save record of each generated file, and the secret scan that runs on
 * every file the agent saves to GFS from the Host volume.
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
import type { ArtifactSecretEntry } from '../artifacts/artifactRedaction'
import {
  OFFICE_PACKAGE_LIMITS,
  isOoxmlPackage,
  officePackageHasText,
} from '../artifacts/officePackageText'
import { textContainsRedactableSecretEntry } from '../core/tools/generatedArtifactAttachments'
import { logger } from '../logger'
import { withoutWriteTimes } from '../workflow/officeBoilerplate'
import { printedForms } from '../workflow/toolText'
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
