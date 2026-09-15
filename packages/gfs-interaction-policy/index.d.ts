export declare const GFS_RESOURCE_NAME_MAX_LENGTH: number
export declare const GFS_UPLOAD_NAME_RETRY_LIMIT: number
export declare const GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE: string

export declare function normalizeGfsResourceName(name: string): Promise<string>

/** Precondition: name has already passed through normalizeGfsResourceName. */
export declare function nextAvailableGfsResourceName(
  name: string,
  occupiedNames: Iterable<string>
): string

export declare function isGfsNameConflict(error: unknown): boolean

export type GfsUploadNameRetryDecision = 'retry' | 'exhausted' | 'terminal'

export declare function gfsUploadNameRetryDecision(
  error: unknown,
  options: {
    attempt: number
    retryLimit?: number
    resuming?: boolean
  }
): GfsUploadNameRetryDecision

export interface GfsUploadNameReservation {
  reserveNext(options?: { exact?: boolean }): string
  markConflict(name: string): void
  markSuccess(name: string): void
  release(): void
}

export interface GfsUploadNameReservationBook {
  begin(
    parentKey: string,
    normalizedName: string,
    occupiedNames: Set<string>
  ): GfsUploadNameReservation
  reservedNames(parentKey: string): string[]
}

export declare function createGfsUploadNameReservationBook(): GfsUploadNameReservationBook
