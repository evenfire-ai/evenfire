import type { FileClass, FileClassification, FileDetection } from './fileClassifier'

export type FileReferenceSource =
  | { kind: 'attachment'; attachmentId: string; messageId: string }
  | { kind: 'gfs'; drive: string; resourceId: string; gfsUri: string; version: number }

export interface FileReferenceDigest {
  algorithm: 'sha256'
  /** 64 lowercase hex characters. */
  hex: string
}

export interface FileReferenceV1 {
  schemaVersion: 1
  /**
   * Derived, never chosen: `att:<messageId>:<attachmentId>@sha256:<hex>` or
   * `gfs:<drive>:<resourceId>@v<version>`.
   */
  id: string
  source: FileReferenceSource
  /** Base name, NFC, 1-255 code points, no path separators or control characters. */
  name: string
  declaredMediaType: string | null
  detectedMediaType: string
  class: FileClass
  detection: FileDetection
  mismatch: boolean
  byteLength: number
  /** Required for attachments, optional for GFS resources. */
  digest?: FileReferenceDigest
  textReadable: boolean
  reader: 'text' | 'none'
  modelImageInput: 'candidate' | 'unsupported'
}

export type FileReferenceErrorCode =
  | 'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED'
  | 'FILE_REFERENCE_INVALID'

export type FileReferenceParseResult =
  | { ok: true; value: FileReferenceV1 }
  | { ok: false; code: FileReferenceErrorCode; message: string }

export declare const FILE_REFERENCE_SCHEMA_VERSION: 1

export declare function parseFileReferenceV1(input: unknown): FileReferenceParseResult

export declare function deriveFileReferenceId(
  source: FileReferenceSource,
  digest?: FileReferenceDigest
): string

export declare function buildAttachmentFileReference(fields: {
  attachmentId: string
  messageId: string
  name: string
  declaredMediaType?: string | null
  byteLength: number
  digestHex: string
  classification: FileClassification
}): FileReferenceParseResult

export declare function buildGfsFileReference(fields: {
  drive: string
  resourceId: string
  gfsUri: string
  version: number
  name: string
  declaredMediaType?: string | null
  byteLength: number
  digestHex?: string
  classification: FileClassification
}): FileReferenceParseResult
