/**
 * Shared, side-effect-free constants and geometry helpers for GFS Upload v2.
 *
 * The writer owns the authoritative arithmetic used by the capability
 * response, session admission, and part routes. The separately packaged web
 * and Desktop clients mirror the wire values at their boundaries rather than
 * importing writer code; contract tests pin those copies to this definition.
 * The route remains capability-gated: disabled deployments still advertise the
 * legacy surface and reject v2 mutations.
 */

export const GFS_UPLOAD_V2_PRODUCT_MAX_BYTES = 209_715_200
export const GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES = 1_073_741_824
export const GFS_UPLOAD_V2_PREFERRED_PART_BYTES = 8 * 1024 * 1024
export const GFS_UPLOAD_V2_MAX_PART_BYTES = 16 * 1024 * 1024
export const GFS_UPLOAD_V2_MIN_PART_BYTES = 1 * 1024 * 1024
export const GFS_UPLOAD_V2_DEFAULT_CONCURRENCY = 4
export const GFS_UPLOAD_V2_FALLBACK_CONCURRENCY = 2
export const GFS_UPLOAD_V2_INSTABILITY_FAILURE_THRESHOLD = 3
export const GFS_UPLOAD_V2_MAX_PART_COUNT = 1024
export const GFS_UPLOAD_V2_METADATA_BODY_MAX_BYTES = 64 * 1024
export const GFS_UPLOAD_V2_COMPLETE_BODY_MAX_BYTES = 16 * 1024
export const GFS_UPLOAD_V2_SESSION_TTL_SECONDS = 24 * 60 * 60
export const GFS_UPLOAD_V2_PART_TIMEOUT_MS = 300_000
export const GFS_UPLOAD_V2_FINALIZE_TIMEOUT_MS = 600_000
export const GFS_UPLOAD_V2_STALE_PART_LEASE_MS = 600_000

const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export type GfsUploadOperation = 'create' | 'replace'

export interface GfsUploadGeometry {
  expectedBytes: number
  partBytes: number
}

export interface GfsUploadPartGeometry {
  partNumber: number
  offsetBytes: number
  lengthBytes: number
}

export type GfsUploadGeometryErrorCode =
  | 'invalid_expected_bytes'
  | 'invalid_part_bytes'
  | 'part_count_exceeded'
  | 'invalid_part_number'
  | 'invalid_part_offset'
  | 'invalid_part_length'
  | 'part_offset_mismatch'
  | 'part_length_mismatch'

export class GfsUploadGeometryError extends Error {
  readonly code: GfsUploadGeometryErrorCode

  constructor(code: GfsUploadGeometryErrorCode, message: string) {
    super(message)
    this.name = 'GfsUploadGeometryError'
    this.code = code
  }
}

export function partCountFor({ expectedBytes, partBytes }: GfsUploadGeometry): number {
  validateGeometry({ expectedBytes, partBytes })
  if (expectedBytes === 0) return 0
  return Math.ceil(expectedBytes / partBytes)
}

export function validateGeometry({ expectedBytes, partBytes }: GfsUploadGeometry): void {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
  ) {
    throw new GfsUploadGeometryError(
      'invalid_expected_bytes',
      `expectedBytes must be an integer from 0 through ${GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES}`
    )
  }
  if (
    !Number.isSafeInteger(partBytes) ||
    partBytes < GFS_UPLOAD_V2_MIN_PART_BYTES ||
    partBytes > GFS_UPLOAD_V2_MAX_PART_BYTES
  ) {
    throw new GfsUploadGeometryError(
      'invalid_part_bytes',
      `partBytes must be an integer from ${GFS_UPLOAD_V2_MIN_PART_BYTES} through ${GFS_UPLOAD_V2_MAX_PART_BYTES}`
    )
  }
  const count = expectedBytes === 0 ? 0 : Math.ceil(expectedBytes / partBytes)
  if (count > GFS_UPLOAD_V2_MAX_PART_COUNT) {
    throw new GfsUploadGeometryError(
      'part_count_exceeded',
      `part count ${count} exceeds ${GFS_UPLOAD_V2_MAX_PART_COUNT}`
    )
  }
}

export function partGeometry(
  geometry: GfsUploadGeometry,
  partNumber: number
): GfsUploadPartGeometry {
  validateGeometry(geometry)
  const count = partCountFor(geometry)
  if (!Number.isSafeInteger(partNumber) || partNumber < 0 || partNumber >= count) {
    throw new GfsUploadGeometryError('invalid_part_number', `invalid part number ${partNumber}`)
  }
  const offsetBytes = partNumber * geometry.partBytes
  if (offsetBytes >= geometry.expectedBytes) {
    throw new GfsUploadGeometryError('invalid_part_offset', `invalid part offset ${offsetBytes}`)
  }
  const lengthBytes = Math.min(geometry.partBytes, geometry.expectedBytes - offsetBytes)
  if (lengthBytes <= 0 || lengthBytes > GFS_UPLOAD_V2_MAX_PART_BYTES) {
    throw new GfsUploadGeometryError('invalid_part_length', `invalid part length ${lengthBytes}`)
  }
  return { partNumber, offsetBytes, lengthBytes }
}

export function validatePartGeometry(
  geometry: GfsUploadGeometry,
  part: GfsUploadPartGeometry
): void {
  if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 0) {
    throw new GfsUploadGeometryError(
      'invalid_part_number',
      'partNumber must be a non-negative integer'
    )
  }
  if (!Number.isSafeInteger(part.offsetBytes) || part.offsetBytes < 0) {
    throw new GfsUploadGeometryError(
      'invalid_part_offset',
      'offsetBytes must be a non-negative integer'
    )
  }
  if (!Number.isSafeInteger(part.lengthBytes) || part.lengthBytes <= 0) {
    throw new GfsUploadGeometryError(
      'invalid_part_length',
      'lengthBytes must be a positive integer'
    )
  }
  const expected = partGeometry(geometry, part.partNumber)
  if (part.offsetBytes !== expected.offsetBytes) {
    throw new GfsUploadGeometryError(
      'part_offset_mismatch',
      `part ${part.partNumber} offset must be ${expected.offsetBytes}`
    )
  }
  if (part.lengthBytes !== expected.lengthBytes) {
    throw new GfsUploadGeometryError(
      'part_length_mismatch',
      `part ${part.partNumber} length must be ${expected.lengthBytes}`
    )
  }
}

/** Route recognition is exact so the broad legacy JSON parser cannot capture v2 binary parts. */
export function isGfsUploadV2Route(pathname: string): boolean {
  return (
    pathname === '/v1/capabilities' ||
    pathname === '/v1/uploads' ||
    new RegExp(
      `^/v1/uploads/${UUID_PATH}(?:/status|/parts/[0-9]+|/pause|/resume|/complete)?$`,
      'i'
    ).test(
      pathname
    )
  )
}

/** Capability payload used while the writer feature flag is disabled. */
export function disabledGfsUploadV2Capability(): {
  enabled: false
  maxFileBytes: 0
  preferredChunkBytes: 0
  maxChunkBytes: 0
} {
  return { enabled: false, maxFileBytes: 0, preferredChunkBytes: 0, maxChunkBytes: 0 }
}
