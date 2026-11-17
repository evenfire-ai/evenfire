import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { Pool } from 'pg'
import { GfsError } from '../api/errors'
import type { GfsResource } from '../api/read'
import type { Decision } from '../authz/resolve'
import type {
  AuthzContext,
  DbAuditSink,
  PermissionClient,
  PermissionEpoch,
  RefusedWithin,
} from '../authz/permissionClient'
import { permissionEpochMoved, stillAuthorized } from '../authz/reconfirm'
import { resolveAuthzContext } from '../authz/subjectResolver'
import { GfsWriteService, type TxClient } from '../db/writeStore'
import type { UploadPartRow, UploadPrincipal, UploadSessionRow } from './uploadSession'

function orderedUploadStream(
  storageMountPath: string,
  parts: readonly UploadPartRow[],
  signal?: AbortSignal
): Readable {
  return Readable.from(
    (async function* () {
      for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
        signal?.throwIfAborted()
        const root = resolve(storageMountPath)
        const expectedPath = resolve(
          root,
          '.uploads',
          part.uploadId,
          'parts',
          `${part.partNumber}.part`
        )
        if (
          part.stagingPath !== expectedPath ||
          !part.stagingPath.startsWith(`${root}/.uploads/${part.uploadId}/parts/`)
        ) {
          throw new GfsError('path_invalid', 'staged upload part path is invalid')
        }
        const handle = await open(part.stagingPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const buffer = Buffer.allocUnsafe(64 * 1024)
        const digest = createHash('sha256')
        let bytes = 0
        try {
          for (;;) {
            signal?.throwIfAborted()
            const result = await handle.read(buffer, 0, buffer.length, null)
            if (result.bytesRead === 0) break
            const chunk = Buffer.from(buffer.subarray(0, result.bytesRead))
            bytes += result.bytesRead
            digest.update(chunk)
            yield chunk
          }
        } finally {
          await handle.close().catch(() => undefined)
        }
        if (bytes !== part.lengthBytes || digest.digest('hex') !== part.sha256) {
          throw new GfsError(
            'checksum_mismatch',
            `staged upload part ${part.partNumber} failed verification`
          )
        }
      }
    })()
  )
}

export interface GfsUploadFinalizerDeps {
  pool: Pool
  storageMountPath: string
  permissions: PermissionClient
  writeService: Pick<GfsWriteService, 'create' | 'replace'>
  audit: DbAuditSink
}

/** Settled result of the pre-publication re-authorization. */
type ReauthorizationOutcome =
  | { ok: true; decision: Decision; subjects: readonly string[]; epoch: PermissionEpoch }
  | { ok: false; error: unknown }

/**
 * Production upload finalizer seam. Keeping this closure in a small module
 * makes the writer's stream, the in-transaction authority re-check, and the
 * same-transaction receipt update executable in focused tests instead of
 * hiding them behind the process bootstrap.
 *
 * The re-authorization reads the subject and permission stores and appends its
 * decision audit row on the pool, so it runs in `beforePublication`, before the
 * writer opens the publication transaction. Running it inside that transaction
 * would hold one client plus the drive structure (or row) lock while waiting for
 * a second client from the same pool (issue #1398). `beforePublication` skips
 * the re-authorization when abort or deadline already fail, and otherwise
 * captures the permission epoch and stores the settled outcome. `onPublished`
 * applies it inside the transaction in this order: abort and deadline; the
 * subject re-read on the transaction's own client (which catches subject changes
 * committed while the transaction waited for its lock); the stored outcome; the
 * decision, re-decided on that client when the permission epoch moved or the
 * subject set changed in a way that could change it; abort and deadline again.
 * The writer's own checks (missing target, tombstone, name conflict, stale
 * ifMatch) still take precedence, and the transactor's deadline handling still
 * applies to every error. A re-decision that denies or fails leaves its
 * in-transaction row to the rollback, so after the publication transaction has
 * ended the finalizer appends that decision's row on the pool.
 */
export function createGfsUploadFinalizer(
  deps: GfsUploadFinalizerDeps
): (
  session: UploadSessionRow,
  parts: UploadPartRow[],
  signal?: AbortSignal,
  deadlineAtMs?: number,
  principal?: UploadPrincipal
) => Promise<{ resourceId: string; version: number; sha256: string }> {
  return async (session, parts, signal, deadlineAtMs, principal) => {
    const source = {
      stream: orderedUploadStream(deps.storageMountPath, parts, signal),
      expectedBytes: session.expectedBytes,
      ...(session.wholeSha256 ? { expectedSha256: session.wholeSha256 } : {}),
    }
    const mutation = {
      subject: session.primarySubject,
      requestId: session.uploadId,
      audit: deps.audit,
    }
    const targetRid = session.operation === 'create' ? session.parentRid : session.resourceRid
    const reauthorizationPrincipal = principal ?? {
      drive: session.drive,
      ownerSubject: session.ownerSubject,
      primarySubject: session.primarySubject,
    }
    const reauthorizationClaims = {
      sub: reauthorizationPrincipal.ownerSubject,
      drive: reauthorizationPrincipal.drive,
      ...(reauthorizationPrincipal.authGeneration === undefined
        ? {}
        : { authGeneration: reauthorizationPrincipal.authGeneration }),
      ...(reauthorizationPrincipal.principalType
        ? { principalType: reauthorizationPrincipal.principalType }
        : {}),
      ...(reauthorizationPrincipal.brokeredAuthority
        ? { brokeredAuthority: reauthorizationPrincipal.brokeredAuthority }
        : {}),
    }
    const rejectIfExpired = (activeSignal?: AbortSignal): void => {
      activeSignal?.throwIfAborted()
      if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
        throw new GfsError('precondition_failed', 'upload finalization timed out')
      }
    }
    let reauthorization: ReauthorizationOutcome | undefined
    let refused: { context: AuthzContext; refusal: RefusedWithin } | undefined
    const beforePublication = async (hookSignal?: AbortSignal): Promise<void> => {
      try {
        rejectIfExpired(hookSignal)
        if (!targetRid) throw new GfsError('path_invalid', 'upload target is required')
        // Captured immediately before the decision it qualifies, as copy does.
        const epoch = deps.permissions.permissionEpoch()
        const context = await resolveAuthzContext(deps.pool, reauthorizationClaims)
        const decision = await deps.permissions.authorize(context, targetRid, 'write')
        reauthorization = { ok: true, decision, subjects: context.subjects, epoch }
      } catch (error) {
        // Not a fallback: onPublished rethrows this error inside the
        // transaction, after the writer's own checks, its abort and deadline
        // checks and the subject re-read, the position the error had before
        // #1398. When one of those rejects first, that rejection wins, as it
        // did then.
        reauthorization = { ok: false, error }
      }
    }
    const onPublished = async (
      client: TxClient,
      published: GfsResource,
      publicationSignal?: AbortSignal
    ): Promise<void> => {
      rejectIfExpired(publicationSignal)
      if (!targetRid) throw new GfsError('path_invalid', 'upload target is required')
      if (!reauthorization) {
        throw new GfsError('internal', 'upload was not re-authorized before publication')
      }
      // The transaction may have waited for the structure or row lock since the
      // re-authorization. Re-read the subject on this transaction's client (never
      // the pool, #1398) so a retirement, membership removal, admin or link
      // revocation, or generation bump committed during that wait is caught. A
      // denied subject propagates unchanged, as before #1398.
      const current = await resolveAuthzContext(client, reauthorizationClaims)
      if (!reauthorization.ok) throw reauthorization.error
      // Read after the subject reads, so an invalidation processed while they
      // awaited is seen.
      const now = deps.permissions.permissionEpoch()
      const verdict = await stillAuthorized(client, {
        decided: { subjects: reauthorization.subjects, allowed: reauthorization.decision.allowed },
        current,
        requests: [{ resourceId: targetRid, op: 'write' }],
        epochMoved: permissionEpochMoved(reauthorization.epoch, now),
        authorizeWithin: async (db, ctx, requests) => {
          try {
            const decisions = await deps.permissions.authorizeWithin(db, ctx, requests)
            const denied = requests.filter((_, index) => !decisions[index].allowed)
            if (denied.length > 0) refused = { context: ctx, refusal: { denied } }
            return decisions
          } catch (error) {
            refused = { context: ctx, refusal: { failed: requests, error } }
            throw error
          }
        },
      })
      // The subject reads and a re-decision awaited on the client.
      rejectIfExpired(publicationSignal)
      if (!verdict.allowed) {
        throw new GfsError('forbidden', 'upload authorization was revoked before publication')
      }
      const completed = await client.query(
        `UPDATE gfs_upload_sessions
            SET state = 'completed', result_resource_id = $2, result_version = $3,
                result_sha256 = $4, completed_at = now(), updated_at = now()
          WHERE upload_id = $1 AND state = 'finalizing' AND session_epoch = $5
          RETURNING upload_id`,
        [
          session.uploadId,
          published.resourceId,
          published.version,
          published.contentSha256,
          session.sessionEpoch,
        ]
      )
      publicationSignal?.throwIfAborted()
      if (completed.rows.length !== 1) {
        throw new GfsError('upload_aborted', 'upload session changed before publication')
      }
    }
    let resource: GfsResource
    try {
      resource =
        session.operation === 'create'
          ? await deps.writeService.create({
              drive: session.drive,
              parentId: session.parentRid!,
              name: session.resourceName!,
              kind: 'file',
              resourceId: session.uploadId,
              content: source,
              mutation,
              beforePublication,
              onPublished,
              signal,
              deadlineAtMs,
            })
          : await deps.writeService.replace({
              drive: session.drive,
              resourceId: session.resourceRid!,
              ifMatch: session.ifMatch ?? undefined,
              content: source,
              mutation,
              beforePublication,
              onPublished,
              signal,
              deadlineAtMs,
            })
    } catch (error) {
      // The publication transaction has ended and its client is released. A
      // re-decision refused inside it left no durable row: record it now, on the pool.
      if (refused) await deps.permissions.auditRefusedWithin(refused.context, refused.refusal)
      throw error
    }
    if (!resource.contentSha256) throw new GfsError('internal', 'published upload has no checksum')
    return {
      resourceId: resource.resourceId,
      version: resource.version,
      sha256: resource.contentSha256,
    }
  }
}
