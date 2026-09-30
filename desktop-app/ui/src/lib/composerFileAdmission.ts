import { classifyBytes } from '@clerum/gfs-interaction-policy'
import {
  COMPOSER_FILE_ENTRY_METADATA_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_FILE_BYTES,
  COMPOSER_MAX_NON_IMAGE_BODY_BYTES,
  COMPOSER_MAX_TOTAL_FILE_BASE64_BYTES,
  COMPOSER_REQUEST_ENVELOPE_BYTES,
} from '@constants/attachments'
import type { ComposerFileAttachment } from '../uiTypes'

const FILE_NAME_MAX_CODE_POINTS = 255
const BASE64_CHUNK_BYTES = 0x8000
// eslint-disable-next-line no-control-regex -- the host rejects control characters in a file name
const CONTROL_OR_SEPARATOR = /[\u0000-\u001f\u007f/]/

const textEncoder = new TextEncoder()

export type ComposerFileAdmissionContext = {
  /** Images and files already attached to the message. */
  attachedCount: number
  /**
   * Files already attached. Their base64 counts against the file quota; their
   * name and fixed fields count against the non-image share.
   */
  files: ReadonlyArray<Pick<ComposerFileAttachment, 'filename' | 'sizeBytes'>>
  /** UTF-8 length of the message text as it will be sent. */
  textBytes: number
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Length of the canonical base64 of `sizeBytes` bytes. */
export function base64Length(sizeBytes: number): number {
  return Math.ceil(sizeBytes / 3) * 4
}

/**
 * Bytes one `kind:'file'` entry adds to the JSON request body besides its
 * base64: the file name and the fixed fields. rpc-proxy and mcp-host charge
 * these to the non-image share; only the base64 is credited to the file quota.
 */
export function composerFileDetailBytes(file: { filename: string }): number {
  return (
    textEncoder.encode(JSON.stringify(file.filename)).length + COMPOSER_FILE_ENTRY_METADATA_BYTES
  )
}

/** Bytes of base64 the file quota is charged for these files. */
export function composerFileBase64Bytes(files: ReadonlyArray<{ sizeBytes: number }>): number {
  return files.reduce((total, file) => total + base64Length(file.sizeBytes), 0)
}

/**
 * Bytes of one request body that rpc-proxy and mcp-host credit to neither the
 * image quota nor the file quota: the JSON envelope, the message text and the
 * non-base64 fields of every `kind:'file'`.
 */
export function composerNonImageBodyBytes(input: {
  files: ReadonlyArray<{ filename: string }>
  textBytes: number
}): number {
  return (
    COMPOSER_REQUEST_ENVELOPE_BYTES +
    input.textBytes +
    input.files.reduce((total, file) => total + composerFileDetailBytes(file), 0)
  )
}

/**
 * Bytes of the whole request body: the non-image share plus the base64 of the
 * files and of the images. An image entry is counted with the same fixed-field
 * allowance as a file entry, which is an upper bound.
 */
export function composerRequestBodyBytes(input: {
  files: ReadonlyArray<{ filename: string; sizeBytes: number }>
  textBytes: number
  imageBase64Bytes: number
  imageCount: number
}): number {
  return (
    composerNonImageBodyBytes(input) +
    composerFileBase64Bytes(input.files) +
    input.imageBase64Bytes +
    input.imageCount * COMPOSER_FILE_ENTRY_METADATA_BYTES
  )
}

export function fileNameProblem(filename: string): string | null {
  if (filename.length === 0) return 'has no name'
  if (filename.normalize('NFC') !== filename) return 'has a name that is not NFC-normalized'
  if ([...filename].length > FILE_NAME_MAX_CODE_POINTS) {
    return `has a name longer than ${FILE_NAME_MAX_CODE_POINTS} characters`
  }
  if (filename === '.' || filename === '..') return 'has an invalid name'
  if (CONTROL_OR_SEPARATOR.test(filename)) return 'has a name with "/" or control characters'
  return null
}

/**
 * Checks a picked file against the per-message limits before any byte is
 * read. Returns the reason to show the user, or `null` when it can be read.
 */
export function composerFileAdmissionError(
  file: { name: string; size: number },
  context: ComposerFileAdmissionContext
): string | null {
  const nameProblem = fileNameProblem(file.name)
  if (nameProblem) return `${file.name || 'The file'} ${nameProblem}.`
  if (file.size > COMPOSER_MAX_FILE_BYTES) {
    return `${file.name} is ${formatFileSize(file.size)}; a file can be at most ${formatFileSize(COMPOSER_MAX_FILE_BYTES)}.`
  }
  if (context.attachedCount >= COMPOSER_MAX_ATTACHMENTS) {
    return `A message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments.`
  }
  const files = [...context.files, { filename: file.name, sizeBytes: file.size }]
  if (composerFileBase64Bytes(files) > COMPOSER_MAX_TOTAL_FILE_BASE64_BYTES) {
    return `${file.name} does not fit: the files in a message can take at most ${formatFileSize(COMPOSER_MAX_TOTAL_FILE_BASE64_BYTES)} once encoded.`
  }
  const bodyBytes = composerNonImageBodyBytes({ files, textBytes: context.textBytes })
  if (bodyBytes > COMPOSER_MAX_NON_IMAGE_BODY_BYTES) {
    return `${file.name} does not fit: the text and file details can take at most ${formatFileSize(COMPOSER_MAX_NON_IMAGE_BODY_BYTES)} per message once encoded.`
  }
  return null
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
  }
  return btoa(binary)
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Reads a picked file completely and returns it `ready` to send, or `failed`
 * with the reason. The bytes read must match the size the picker reported: a
 * file that changes on disk while it is read is not sent.
 */
export async function readComposerFile(file: File, id: string): Promise<ComposerFileAttachment> {
  const base = {
    id,
    type: 'file' as const,
    filename: file.name,
    sizeBytes: file.size,
    declaredMediaType: file.type,
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength !== file.size) {
      return {
        ...base,
        status: 'failed',
        error: `${file.name} changed while it was being read. Attach it again.`,
      }
    }
    const classification = classifyBytes({
      bytes,
      totalByteLength: bytes.byteLength,
      declaredMediaType: file.type === '' ? null : file.type,
      filename: file.name,
    })
    return {
      ...base,
      status: 'ready',
      classification,
      dataBase64: toBase64(bytes),
      digestHex: await sha256Hex(bytes),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...base, status: 'failed', error: `${file.name} could not be read: ${reason}` }
  }
}
