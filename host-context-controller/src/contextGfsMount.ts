/**
 * Context gfs mount resolution — intent-not-authority (spec community.md §CRDs
 * (Context additions), plan P3-S03).
 *
 * A `Context.spec.gfs.mounts` entry declares INTENT only. HCC wires the mount
 * ONLY if the Context identity ALREADY holds every requested scope on the target
 * (confirmed out-of-band by control-api/gfsc against the permission store).
 * Editing the CRD can NEVER grant access — insufficient scope ⇒ `PendingMount`,
 * never an escalation.
 */

export type GfsMountStatus = 'Mounted' | 'PendingMount'

export interface GfsMountIntent {
  drive: string
  /** Target resource id (or path) the Context wants mounted. */
  target: string
  /** Scopes the mount requests (e.g. ['gfs.read']). */
  scopes: string[]
}

/**
 * Pure decision: a mount is `Mounted` iff the Context identity holds EVERY
 * requested scope; otherwise `PendingMount`. An empty request is PendingMount
 * (nothing to authorize ≠ authority). No I/O — the security invariant is here.
 */
export function decideMountStatus(
  intent: GfsMountIntent,
  heldScopes: ReadonlySet<string>
): GfsMountStatus {
  if (intent.scopes.length === 0) {
    return 'PendingMount'
  }
  return intent.scopes.every((scope) => heldScopes.has(scope)) ? 'Mounted' : 'PendingMount'
}

/** Confirms which scopes the Context identity actually holds on the target. */
export interface MountScopeConfirmer {
  heldScopes(intent: GfsMountIntent): Promise<Set<string>>
}

/**
 * Resolve a mount's status by confirming held scopes with control-api/gfsc, then
 * applying the intent-not-authority decision. The confirmer is the ONLY source
 * of authority — the CRD intent never adds to it.
 */
export async function resolveMount(
  confirmer: MountScopeConfirmer,
  intent: GfsMountIntent
): Promise<GfsMountStatus> {
  const held = await confirmer.heldScopes(intent)
  return decideMountStatus(intent, held)
}
