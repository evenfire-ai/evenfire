/**
 * Issue #666 — whether this Host can re-authorize a message's GFS file
 * references, decided per message from its own GFS token.
 *
 * A Host that has no token, or whose token carries no `gfs.read`, cannot serve
 * GFS references: they are admitted as `unsupported`. A token that is present
 * but cannot be read or decoded is a broken deployment, not a Host without
 * GFS, so the message is refused instead of being answered as if no file were
 * readable.
 *
 * Admission asks gfsc under the Host's own token, so it must not learn what an
 * operator gated behind approval: when `approval.tools` forces a GFS read tool
 * to approval, the references are admitted as `unsupported` too.
 */
import type { GfsToolScopeInspection } from '../internalTools/gfsClient'
import type { FileReferenceGfscClient } from './fileReferenceResolver'

export type FileReferenceGfsAccess =
  | { status: 'available'; client: FileReferenceGfscClient }
  | { status: 'unsupported' }
  | { status: 'credentials_failed'; errorClass: 'TokenReadError' | 'TokenDecodeError' }

/** The GFS tools whose answers admission would otherwise hand out unapproved. */
export const FILE_REFERENCE_GFS_READ_TOOLS = [
  'clerum__gfs_stat',
  'clerum__gfs_resolve',
  'clerum__gfs_read',
] as const

export interface FileReferenceGfsGateDeps {
  inspectScopes: () => GfsToolScopeInspection
  /** The effective `approval.tools` overrides, read per message. */
  approvalTools: () => Readonly<Record<string, boolean>> | undefined
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
    const tools = deps.approvalTools()
    const gatedTool = tools
      ? FILE_REFERENCE_GFS_READ_TOOLS.find(name => Object.hasOwn(tools, name) && tools[name])
      : undefined
    if (gatedTool) {
      deps.logger.warn(
        { event: 'file_reference_gfs_unavailable', reason: 'read_tool_requires_approval' },
        'Host runtime event'
      )
      return { status: 'unsupported' }
    }
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
