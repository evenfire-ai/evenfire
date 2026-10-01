import type { GfsImageSource, MemoryReservation, VisualInputBudget } from '../visualInput/policy'

export interface GfsReadOptions {
  signal?: AbortSignal
  timeoutMs?: number
  deadlineMs?: number
  budget?: VisualInputBudget
  /**
   * #666 — the version a structured file reference was taken at. A metadata
   * snapshot at any other version fails with `version_conflict` before the
   * content is requested.
   */
  expectedVersion?: number
}

/** A validated metadata/content snapshot. This object is never a tool result. */
export interface GfsFileContent {
  source: GfsImageSource
  bytes: Buffer
  /** The consumer must release the read buffer after classification/encoding. */
  reservation: MemoryReservation
}
