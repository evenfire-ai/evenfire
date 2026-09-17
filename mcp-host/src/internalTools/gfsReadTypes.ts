import type { GfsImageSource, MemoryReservation, VisualInputBudget } from '../visualInput/policy'

export interface GfsReadOptions {
  signal?: AbortSignal
  timeoutMs?: number
  budget?: VisualInputBudget
}

/** A validated metadata/content snapshot. This object is never a tool result. */
export interface GfsFileContent {
  source: GfsImageSource
  bytes: Buffer
  /** The consumer must release the read buffer after classification/encoding. */
  reservation: MemoryReservation
}
