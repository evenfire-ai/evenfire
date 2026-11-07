import type { Readable } from 'node:stream'
import type { GfsVerifiedClaims } from '../auth/verify'
import type {
  AuthorizationRequest,
  AuthzContext,
  PermissionClient,
} from '../authz/permissionClient'
import type { Decision } from '../authz/resolve'
import { GfsSubjectResolutionDeniedError } from '../authz/subjectResolver'
import { checkTokenCeiling } from '../authz/tokenCeiling'
import type { DeadlinePool } from '../db/deadlineQuery'
import { withReadAdmissionSnapshot } from '../db/deadlineQuery'
import { PgResourceStore, type Queryable } from '../db/resourceStore'
import { GfsError } from './errors'
import { type BlobReader, type GfsResourceView, downloadResource } from './read'

export interface ReadAdmissionResult {
  resource: GfsResourceView
  stream: Readable
}

export interface ReadAdmissionDependencies {
  pool: DeadlinePool
  permissions: PermissionClient
  resolveContext: (
    db: Queryable,
    claims: GfsVerifiedClaims,
    requestId?: string
  ) => Promise<AuthzContext>
  blobs: BlobReader
}

interface AdmittedSnapshot {
  ctx: AuthzContext
  decision: Decision
  denial?: GfsError
  read?: { resource: GfsResourceView; stream: Readable }
}

function deniedDecision(): Decision {
  return {
    allowed: false,
    via: null,
    matchedSubject: null,
    authorizationSource: null,
  }
}

function fallbackAuditContext(claims: GfsVerifiedClaims, requestId?: string): AuthzContext {
  const linkedAdmin = claims.brokeredAuthority
  return {
    drive: claims.drive,
    subjects: [],
    isOperator: false,
    primarySubject: claims.sub,
    ...(linkedAdmin
      ? {
          desktopUserId: linkedAdmin.desktopUserId,
          effectiveControlAdminId: linkedAdmin.controlAdminId,
          authoritySource: 'linked-admin' as const,
        }
      : claims.principalType === 'user'
        ? { desktopUserId: claims.sub, authoritySource: 'user-session' as const }
        : {}),
    requestId,
  }
}

function isPostgresFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
}

/**
 * Admit a content read using one fresh PostgreSQL snapshot. The current token
 * subject/lifecycle, token ceiling, permission rows, resource metadata and blob
 * generation are read or captured under that snapshot. The shared permission
 * cache is neither consulted nor populated by this path.
 *
 * Audit writes occur only after the read-only snapshot releases its connection.
 * An audit failure prevents the captured stream from being returned to the HTTP
 * owner; an already-open blob handle is destroyed on that path.
 */
export async function admitGfsContentRead(
  deps: ReadAdmissionDependencies,
  claims: GfsVerifiedClaims,
  requestId: string | undefined,
  resourceId: string
): Promise<ReadAdmissionResult> {
  const request: AuthorizationRequest = { resourceId, op: 'read' }
  let auditContext = fallbackAuditContext(claims, requestId)
  let openedStream: Readable | undefined
  let snapshotCompleted = false

  try {
    const admitted = await withReadAdmissionSnapshot(deps.pool, async client => {
      const ctx = await deps.resolveContext(client, claims, requestId)
      auditContext = ctx
      const store = new PgResourceStore(client)

      // A path-bound token needs the resource path for its existing token
      // ceiling. This row read is on the same client/snapshot as authorization.
      let resourcePath: string | null = null
      if (claims.pathBindings.length > 0) {
        resourcePath = (await store.getResource(claims.drive, resourceId))?.pathCache ?? null
      }
      const ceiling = checkTokenCeiling({
        scopes: claims.scopes,
        pathBindings: claims.pathBindings,
        op: 'read',
        resourcePath,
      })
      if (!ceiling.allowed) {
        return {
          ctx,
          decision: deniedDecision(),
          denial: new GfsError('forbidden', 'token does not authorize read', ceiling.reason),
        } satisfies AdmittedSnapshot
      }

      const [decision] = await deps.permissions.authorizeFreshWithinSnapshot(ctx, [request], client)
      if (!decision.allowed) {
        return {
          ctx,
          decision,
          denial: new GfsError('forbidden', 'not authorized to read this resource'),
        } satisfies AdmittedSnapshot
      }

      // downloadResource reads the row and opens its immutable blob generation
      // through the same snapshot-selected ResourceStore. The returned stream
      // is opened before COMMIT, so a concurrent replacement cannot switch the
      // admitted version or remove the open file from beneath the reader.
      const read = await downloadResource(store, deps.blobs, claims.drive, resourceId)
      // Keep an outer cleanup handle before COMMIT: if the transaction's
      // outcome is unknown, the snapshot helper rejects without returning its
      // callback value, but this already-open file stream must still close.
      openedStream = read.stream
      return { ctx, decision, read } satisfies AdmittedSnapshot
    })
    openedStream = admitted.read?.stream
    snapshotCompleted = true

    try {
      await deps.permissions.recordReadAdmission(admitted.ctx, request, admitted.decision)
    } catch {
      throw new GfsError('not_mounted', 'read authorization audit is unavailable')
    }
    if (admitted.denial) {
      throw admitted.denial
    }
    if (!admitted.read) {
      throw new GfsError('internal', 'content admission returned no resource stream')
    }
    return admitted.read
  } catch (error) {
    if (openedStream && !openedStream.destroyed) openedStream.destroy()
    if (!snapshotCompleted) {
      try {
        await deps.permissions.recordReadAdmissionFailure(
          auditContext,
          request,
          error instanceof GfsSubjectResolutionDeniedError
            ? 'subject_not_current'
            : 'read_admission_failed'
        )
      } catch {
        // Authorization remains fail-closed when the audit sink is unavailable.
        throw new GfsError('not_mounted', 'read authorization audit is unavailable')
      }
    }

    if (error instanceof GfsSubjectResolutionDeniedError) {
      throw new GfsError('forbidden', 'principal is not authorized for GFS')
    }
    if (error instanceof GfsError) throw error
    if (isPostgresFailure(error)) {
      throw new GfsError('not_mounted', 'read authorization store is unavailable')
    }
    throw error
  }
}
