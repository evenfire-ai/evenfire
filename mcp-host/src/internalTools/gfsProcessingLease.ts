/**
 * Caller-bound cleanup protection for approved local processing.
 *
 * The provider is intentionally narrower than the download store: ShellTool can
 * protect retained downloads without gaining store administration capability.
 */
export interface GfsProcessingLease {
  leaseId: string
  expiresAt: string
}

export interface GfsProcessingLeaseAcquisition {
  /** Bounded lease duration in milliseconds. Implementations enforce a ceiling. */
  durationMs?: number
}

export interface GfsProcessingLeaseProvider {
  acquireProcessingLease(options?: GfsProcessingLeaseAcquisition): Promise<GfsProcessingLease>
  releaseProcessingLease(lease: GfsProcessingLease): Promise<void>
}
// Processing leases protect retained downloads while a shell command runs.
