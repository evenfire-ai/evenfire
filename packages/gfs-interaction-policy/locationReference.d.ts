import type { FileReferenceErrorCode } from './fileReference'

export interface LocationReferenceSource {
  kind: 'gfs'
  drive: string
  resourceId: string
  /** `gfs://<drive>/<rid>`, the rid being resourceId as 32 lowercase hex digits. */
  gfsUri: string
}

/**
 * A Global Files folder the turn is about, as the place to create, save or
 * list files. It names no version or size: a folder changes whenever
 * something is created inside it.
 */
export interface LocationReferenceV1 {
  schemaVersion: 1
  /** Derived, never chosen: `gfs-folder:<drive>:<resourceId>`. */
  id: string
  /** Same rules as FileReferenceV1.name. Builders normalize to NFC. */
  name: string
  source: LocationReferenceSource
}

export type LocationReferenceParseResult =
  | { ok: true; value: LocationReferenceV1 }
  | { ok: false; code: FileReferenceErrorCode; message: string }

export declare const LOCATION_REFERENCE_SCHEMA_VERSION: 1

/**
 * The maximum number of location references one message may carry. mcp-host
 * admission and the Desktop composer both enforce this single export.
 */
export declare const LOCATION_REFERENCE_MAX_COUNT: 1

export declare function parseLocationReferenceV1(input: unknown): LocationReferenceParseResult

export declare function deriveLocationReferenceId(source: LocationReferenceSource): string

export declare function buildGfsLocationReference(fields: {
  drive: string
  resourceId: string
  gfsUri: string
  name: string
}): LocationReferenceParseResult
