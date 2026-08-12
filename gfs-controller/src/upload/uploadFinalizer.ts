import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { Pool } from 'pg'
import { GfsError } from '../api/errors'
import type { GfsResource } from '../api/read'
import type { DbAuditSink, PermissionClient } from '../authz/permissionClient'
import { resolveAuthzContext } from '../authz/subjectResolver'
import { GfsWriteService, type TxClient } from '../db/writeStore'
import type { UploadPartRow, UploadSessionRow } from './uploadSession'

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

/**
 * Production upload finalizer seam. Keeping this closure in a small module
 * makes the writer's stream, permission-epoch recheck, and same-transaction
 * receipt update executable in focused tests instead of hiding them behind
 * the process bootstrap.
 */
export function createGfsUploadFinalizer(
  deps: GfsUploadFinalizerDeps
): (
  session: UploadSessionRow,
  parts: UploadPartRow[],
  signal?: AbortSignal,
  deadlineAtMs?: number
) => Promise<{ resourceId: string; version: number; sha256: string }> {
  return async (session, parts, signal, deadlineAtMs) => {
    const capturedPermissionEpoch = deps.permissions.permissionEpoch()
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
    const onPublished = async (
      client: TxClient,
      published: GfsResource,
      publicationSignal?: AbortSignal
    ): Promise<void> => {
      publicationSignal?.throwIfAborted()
      if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
        throw new GfsError('precondition_failed', 'upload finalization timed out')
      }
      const currentPermissionEpoch = deps.permissions.permissionEpoch()
      if (
        capturedPermissionEpoch.bypassed ||
        currentPermissionEpoch.bypassed ||
        currentPermissionEpoch.generation !== capturedPermissionEpoch.generation
      ) {
        throw new GfsError(
          'precondition_failed',
          'authorization changed during upload finalization'
        )
      }
      const targetRid = session.operation === 'create' ? session.parentRid : session.resourceRid
      if (!targetRid) throw new GfsError('path_invalid', 'upload target is required')
      const targetContext = await resolveAuthzContext(deps.pool, {
        sub: session.ownerSubject,
        drive: session.drive,
      })
      const decision = await deps.permissions.authorize(targetContext, targetRid, 'write')
      publicationSignal?.throwIfAborted()
      if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
        throw new GfsError('precondition_failed', 'upload finalization timed out')
      }
      const postAuthorizationEpoch = deps.permissions.permissionEpoch()
      if (
        postAuthorizationEpoch.bypassed ||
        postAuthorizationEpoch.generation !== capturedPermissionEpoch.generation
      ) {
        throw new GfsError(
          'precondition_failed',
          'authorization changed during upload finalization'
        )
      }
      if (!decision.allowed) {
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
    const resource =
      session.operation === 'create'
        ? await deps.writeService.create({
            drive: session.drive,
            parentId: session.parentRid!,
            name: session.resourceName!,
            kind: 'file',
            resourceId: session.uploadId,
            content: source,
            mutation,
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
            onPublished,
            signal,
            deadlineAtMs,
          })
    if (!resource.contentSha256) throw new GfsError('internal', 'published upload has no checksum')
    return {
      resourceId: resource.resourceId,
      version: resource.version,
      sha256: resource.contentSha256,
    }
  }
}
