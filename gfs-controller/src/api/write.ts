/**
 * gfs write planning (spec community.md §Agent write security, §Move/rename/
 * delete; plan P4-S01). Pure, side-effect-free validation of a create/replace/
 * delete the gfsc writer uses before touching the store. The actual byte write
 * + the permission check (against the store) happen in the writer; this module
 * decides WHICH permission the op needs and enforces the agent-write invariants:
 *
 *   - create  → `write` on the destination parent.
 *   - replace → `write` on the resource.
 *   - delete  → `delete` on the resource (a destructive bit agents are
 *               default-denied — only an operator grant confers it).
 *   - Agent (host) writes REQUIRE `If-Match` (writer-routed optimistic
 *     concurrency); a stale `If-Match` is `precondition_failed`.
 */

export type GfsPermission = 'read' | 'write' | 'delete' | 'manage_acl' | 'share'
export type WriteOp = 'create' | 'replace' | 'delete'

export type WriteErrorCode = 'invalid_request' | 'if_match_required' | 'precondition_failed'

export class WriteError extends Error {
  constructor(
    readonly code: WriteErrorCode,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'WriteError'
  }
}

export interface PermissionCheck {
  resourceId: string
  op: GfsPermission
}

export interface WriteRequest {
  op: WriteOp
  /** Target resource (replace/delete). */
  resourceId?: string
  /** Destination parent (create). */
  parentId?: string
  /** Current version of the target, when known (replace/delete). */
  currentVersion?: number
  ifMatch?: number
  /** True iff the writing subject is an agent (a host). */
  isAgent: boolean
}

export interface WritePlan {
  op: WriteOp
  checks: PermissionCheck[]
  requiresIfMatch: boolean
}

/** Throw precondition_failed when a provided If-Match does not match the version. */
export function assertIfMatch(currentVersion: number | undefined, ifMatch: number | undefined): void {
  if (ifMatch !== undefined && currentVersion !== undefined && ifMatch !== currentVersion) {
    throw new WriteError('precondition_failed', `If-Match ${ifMatch} != version ${currentVersion}`)
  }
}

export function planWrite(req: WriteRequest): WritePlan {
  // Agent writes are writer-routed conditional writes: If-Match is mandatory for
  // any mutation of an existing resource (replace/delete). create has no prior
  // version to guard.
  const mutatesExisting = req.op === 'replace' || req.op === 'delete'
  const requiresIfMatch = req.isAgent && mutatesExisting
  if (requiresIfMatch && req.ifMatch === undefined) {
    throw new WriteError('if_match_required', `agent ${req.op} requires If-Match`)
  }
  assertIfMatch(req.currentVersion, req.ifMatch)

  const checks: PermissionCheck[] = []
  switch (req.op) {
    case 'create': {
      if (!req.parentId) throw new WriteError('invalid_request', 'create requires a destination parent')
      checks.push({ resourceId: req.parentId, op: 'write' })
      break
    }
    case 'replace': {
      if (!req.resourceId) throw new WriteError('invalid_request', 'replace requires a resourceId')
      checks.push({ resourceId: req.resourceId, op: 'write' })
      break
    }
    case 'delete': {
      if (!req.resourceId) throw new WriteError('invalid_request', 'delete requires a resourceId')
      // `delete` is a destructive bit agents are default-denied — only an
      // operator/admin grant of `delete` lets the check below pass.
      checks.push({ resourceId: req.resourceId, op: 'delete' })
      break
    }
  }

  return { op: req.op, checks, requiresIfMatch }
}
