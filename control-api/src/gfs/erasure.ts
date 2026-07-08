/**
 * gfs hard-delete / erasure (spec plan §Security and compliance; plan P5-S03).
 * Unlike a tombstone (soft delete), erasure permanently purges every object-
 * store version of a resource (GDPR right-to-erasure) and records a NON-CONTENT
 * audit row — the audit proves the erasure happened without re-introducing the
 * erased bytes anywhere. Pure planning; the purge + audit INSERT are I/O.
 */

export class ErasureError extends Error {
  constructor(
    readonly code: 'invalid_request',
    message?: string
  ) {
    super(message ?? code)
    this.name = 'ErasureError'
  }
}

/** A NON-content audit entry: records the erasure event, never the erased bytes. */
export interface ErasureAuditEntry {
  op: 'erasure'
  resourceId: string
  outcome: 'erased'
  /** Invariant: an erasure audit row carries no content (GDPR). */
  containsContent: false
  versionsPurged: number
}

export interface ErasurePlan {
  resourceId: string
  /** Object-store version keys to purge (all of them — no version survives). */
  purgeKeys: string[]
  auditEntry: ErasureAuditEntry
}

export function planErasure(resourceId: string, objectVersionKeys: string[]): ErasurePlan {
  if (!resourceId) {
    throw new ErasureError('invalid_request', 'resourceId is required')
  }
  const purgeKeys = [...objectVersionKeys]
  return {
    resourceId,
    purgeKeys,
    auditEntry: {
      op: 'erasure',
      resourceId,
      outcome: 'erased',
      containsContent: false,
      versionsPurged: purgeKeys.length,
    },
  }
}
