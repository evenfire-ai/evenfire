/**
 * Artifact-reference publishing (spec community.md §CRDs (WorkflowRecipe); plan
 * P4-S06). Publishing an artifact creates a gfs RESOURCE — its own resourceId,
 * permissions and gfs:// URI — that POINTS AT the artifact-store object; it never
 * copies the bytes. Requires `write` on the destination folder, emits audit, and
 * once the underlying artifact expires the reference resolves to gone(410,
 * reason=artifact_expired). Pure planning + status; the create/audit is the
 * publish path's I/O.
 */

export type PublishErrorCode = 'invalid_request' | 'path_invalid'

export class PublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'PublishError'
  }
}

export interface PublishRequest {
  drive: string
  /** Destination folder — the publisher must hold `write` here. */
  parentResourceId: string
  name: string
  /** Pointer to the artifact-store object (a reference, never copied). */
  artifactRef: string
  /** Epoch ms the underlying artifact expires; null/undefined = no expiry. */
  artifactExpiresAt?: number | null
}

export interface PublishPlan {
  drive: string
  parentResourceId: string
  name: string
  kind: 'file'
  artifactRef: string
  artifactExpiresAt: number | null
  /** The permission the publisher must hold (on the destination folder). */
  requiredCheck: { resourceId: string; op: 'write' }
}

// Control chars (incl. NUL) are never valid — mirrors gfs-controller move.ts /
// control-api resources.ts so a published name cannot smuggle bytes those paths
// reject (review finding: name-validator drift).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

function validateName(raw: string): string {
  const name = raw.normalize('NFC')
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    CONTROL_CHARS.test(name)
  ) {
    throw new PublishError('path_invalid', `invalid name: ${JSON.stringify(raw)}`)
  }
  return name
}

/** Validate + plan a publish. Throws PublishError; the caller checks `write`. */
export function planPublish(req: PublishRequest): PublishPlan {
  if (typeof req.artifactRef !== 'string' || req.artifactRef.length === 0) {
    throw new PublishError(
      'invalid_request',
      'artifactRef is required (publishing is by reference)'
    )
  }
  if (!req.parentResourceId) {
    throw new PublishError('invalid_request', 'parentResourceId is required')
  }
  return {
    drive: req.drive,
    parentResourceId: req.parentResourceId,
    name: validateName(req.name),
    kind: 'file',
    artifactRef: req.artifactRef,
    artifactExpiresAt: req.artifactExpiresAt ?? null,
    requiredCheck: { resourceId: req.parentResourceId, op: 'write' },
  }
}

/**
 * A published reference is `live` until its artifact expires; afterwards resolve
 * MUST report gone(410, reason=artifact_expired) — distinguishing an expired
 * reference from a tombstoned resource.
 */
export function resolvePublishedStatus(
  artifactExpiresAt: number | null,
  nowMs: number
): 'live' | 'expired' {
  return artifactExpiresAt !== null && nowMs >= artifactExpiresAt ? 'expired' : 'live'
}
