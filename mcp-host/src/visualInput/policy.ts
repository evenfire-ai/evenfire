import { createHash } from 'node:crypto'

/** Admission limits for source reads, distinct from outbound download limits. */
export const VISUAL_INPUT_LIMITS = Object.freeze({
  fileBytes: 3 * 1024 * 1024,
  metadataBytes: 64 * 1024,
  errorBytes: 8 * 1024,
  readBytesPerTurn: 24 * 1024 * 1024,
  residentBytesPerTurn: 96 * 1024 * 1024,
  requestBytes: 12 * 1024 * 1024,
  imagesPerRequest: 3,
  dimension: 4096,
  pixels: 4_000_000,
  readTimeoutMs: 30_000,
  validationTimeoutMs: 5_000,
})

export type VisualInputErrorCode =
  | 'limit_exceeded'
  | 'unsupported_format'
  | 'invalid_image'
  | 'version_conflict'
  | 'invalid_response'
  | 'incomplete_response'
  | 'cancelled'
  | 'timeout'

/** Public categories are fixed; upstream messages never become this error's text. */
export class VisualInputError extends Error {
  constructor(readonly code: VisualInputErrorCode) {
    super(`GFS read failed (${code})`)
    this.name = 'VisualInputError'
  }
}

export interface GfsImageSource {
  kind: 'gfs'
  drive: string
  resourceId: string
  gfsUri: string
  version: number
  name: string
}

export interface VisualImage {
  source: GfsImageSource
  mimeType: 'image/png' | 'image/jpeg'
  dataBase64: string
  sizeBytes: number
  width: number
  height: number
}

export type ImageInputCapability =
  | {
      status: 'supported'
      provider: string
      model: string
      evidence: string
    }
  | { status: 'unsupported' | 'unknown' }

export interface VisualInputContext {
  budget: VisualInputBudget
  resolveCapability(signal?: AbortSignal): Promise<ImageInputCapability>
}

export interface MemoryReservation {
  release(): void
}

/**
 * Synchronous reservations make admission atomic across concurrent async reads.
 * These count retained payloads and estimated decode surfaces, not process RSS.
 * Native decoder overhead is isolated separately; this is not an OS memory cap.
 */
export class VisualInputBudget {
  private consumed = 0
  private closed = false
  private readonly retained = new Map<string, { data: string; reservation: MemoryReservation }>()

  constructor(
    private readonly residentLimit = VISUAL_INPUT_LIMITS.residentBytesPerTurn,
    private readonly readLimit = VISUAL_INPUT_LIMITS.readBytesPerTurn,
    alreadyReadBytes = 0,
    private readonly ledger = { resident: 0, external: new Set<string>(), externalOverflow: false }
  ) {
    for (const limit of [residentLimit, readLimit]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid visual input limit')
    }
    if (
      !Number.isSafeInteger(alreadyReadBytes) ||
      alreadyReadBytes < 0 ||
      alreadyReadBytes > readLimit
    )
      throw new Error('Invalid visual input budget snapshot')
    this.consumed = alreadyReadBytes
  }

  get residentBytes(): number {
    return this.ledger.resident
  }

  get readBytes(): number {
    return this.consumed
  }

  get remainingReadBytes(): number {
    return this.readLimit - this.consumed
  }

  get isClosed(): boolean {
    return this.closed
  }

  get hasEncodedImages(): boolean {
    return this.retained.size > 0
  }

  /** Existing images stay owned by the conversation/other tools. Count them
   * conservatively across pauses, without changing their delivery contracts. */
  observeExternalImage(data: string): void {
    if (this.closed || this.ledger.externalOverflow) return
    if (data.length * 2 > this.residentLimit) {
      this.ledger.externalOverflow = true
      return
    }
    const key = createHash('sha256').update(data).digest('hex')
    if (this.ledger.external.has(key)) return
    this.ledger.external.add(key)
    if (data.length * 2 > this.residentLimit - this.ledger.resident) {
      this.ledger.externalOverflow = true
      return
    }
    this.ledger.resident += data.length * 2
  }

  reserve(bytes: number): MemoryReservation {
    this.assertSize(bytes)
    if (
      this.closed ||
      this.ledger.externalOverflow ||
      bytes > this.residentLimit - this.ledger.resident
    )
      throw new VisualInputError('limit_exceeded')
    this.ledger.resident += bytes
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.ledger.resident -= bytes
      },
    }
  }

  consumeRead(bytes: number): void {
    this.assertSize(bytes)
    if (this.closed) throw new VisualInputError('limit_exceeded')
    if (bytes > this.readLimit - this.consumed) {
      // The transport has already produced this chunk. Do not refund work on
      // rejection and let repeated failed reads obtain an unlimited allowance.
      this.consumed = this.readLimit
      throw new VisualInputError('limit_exceeded')
    }
    this.consumed += bytes
  }

  /** Share the actual encoded string, not just its accounting, across rereads. */
  encodeImage(bytes: Buffer): string {
    if (this.closed) throw new VisualInputError('limit_exceeded')
    const key = createHash('sha256').update(bytes).digest('hex')
    const existing = this.retained.get(key)
    if (existing) return existing.data
    const reservation = this.reserve(4 * Math.ceil(bytes.byteLength / 3) * 2)
    try {
      const data = bytes.toString('base64')
      this.retained.set(key, { data, reservation })
      return data
    } catch (error) {
      reservation.release()
      throw error
    }
  }

  /** Stop admission before disposing all turn-owned results. */
  close(): void {
    this.closed = true
    for (const { reservation } of this.retained.values()) reservation.release()
    this.retained.clear()
  }

  /** Warm resumes still count buffers whose cancelled I/O has not exited yet. */
  resume(alreadyReadBytes = this.consumed): VisualInputBudget {
    if (!this.closed) throw new Error('Cannot resume an open visual input budget')
    return new VisualInputBudget(
      this.residentLimit,
      this.readLimit,
      Math.max(alreadyReadBytes, this.consumed),
      this.ledger
    )
  }

  private assertSize(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid visual input size')
  }
}
