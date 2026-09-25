/**
 * Issue #666 — whether this Host can re-authorize a message's GFS file
 * references, decided per message from its own GFS token.
 *
 * A Host that has no token, or whose token carries no `gfs.read`, cannot serve
 * GFS references: they are admitted as `unsupported`. A token that is present
 * but cannot be read or decoded is a broken deployment, not a Host without
 * GFS, so the message is refused instead of being answered as if no file were
 * readable.
 */
import type { GfsToolScopeInspection } from '../internalTools/gfsClient'
import type { FileReferenceGfscClient } from './fileReferenceResolver'

export type FileReferenceGfsAccess =
  | { status: 'available'; client: FileReferenceGfscClient }
  | { status: 'unsupported' }
  | { status: 'credentials_failed'; errorClass: 'TokenReadError' | 'TokenDecodeError' }

export interface FileReferenceGfsGateDeps {
  inspectScopes: () => GfsToolScopeInspection
  client: FileReferenceGfscClient
  logger: {
    warn: (obj: Record<string, unknown>, msg: string) => void
    error: (obj: Record<string, unknown>, msg: string) => void
  }
}

export function createFileReferenceGfsGate(
  deps: FileReferenceGfsGateDeps
): () => FileReferenceGfsAccess {
  return () => {
    const inspection = deps.inspectScopes()
    if (inspection.status === 'ok' && inspection.scopes.has('gfs.read'))
      return { status: 'available', client: deps.client }
    if (inspection.status === 'token_unreadable' || inspection.status === 'token_undecodable') {
      deps.logger.error(
        { event: 'file_reference_gfs_unavailable', reason: inspection.status },
        'Host runtime event'
      )
      return {
        status: 'credentials_failed',
        errorClass:
          inspection.status === 'token_unreadable' ? 'TokenReadError' : 'TokenDecodeError',
      }
    }
    deps.logger.warn(
      {
        event: 'file_reference_gfs_unavailable',
        reason: inspection.status === 'ok' ? 'missing_gfs_read' : inspection.status,
      },
      'Host runtime event'
    )
    return { status: 'unsupported' }
  }
}
