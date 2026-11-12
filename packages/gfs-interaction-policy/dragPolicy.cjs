'use strict'

/**
 * Pure, browser-safe drag-and-drop move policy shared by Control UI and
 * Desktop. Transport-free by contract: every function takes observed facts
 * (IDs, held permission bits, canonical server paths, known cache links) and
 * returns a verdict or plan. React, fetch, Electron IPC, TanStack Query and
 * credentials stay outside this module.
 *
 * Server authority: every verdict here is FEEDBACK, not enforcement. The move
 * PATCH re-validates structure (cycle/self guard), destination kind and
 * parent permissions atomically; `server-check-required` deliberately defers
 * unproved ancestry to that guard instead of denying ordinary users whose
 * grants start below the drive root.
 */

/**
 * Maximum move PATCH attempts per user gesture (numbered-name conflicts),
 * within the existing absolute GFS_UPLOAD_NAME_RETRY_LIMIT name ceiling.
 */
const GFS_MOVE_MAX_NETWORK_ATTEMPTS = 3

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Fast structural decision for an internal drag (rev-2 §3.1).
 *
 * Facts (all observations, never guesses):
 * - source.resourceId / drive / kind / parentKnown / parentResourceId
 * - target.resourceId / drive (target is a directory row or node)
 * - targetAncestorIds: ancestors of the TARGET from a currently loaded tree
 *   chain or readable breadcrumb, nearest-first. Optional.
 * - knownSourceAncestorIds: currently known ancestors of the SOURCE (its
 *   physical parent and any breadcrumb above it). Optional.
 *
 * Rules:
 * 1. same id → deny 'self'
 * 2. drive mismatch → deny 'cross-drive'
 * 3. observed physical root source (parentKnown && null parent) → deny 'root-source'
 * 4. observed same parent → deny 'same-parent'
 * 5. files have no descendants → observed-safe 'file'
 * 6. source appears in the target's known chain → deny 'descendant'
 * 7. the chain reaches a known ancestor of the source without passing the
 *    source → observed-safe 'common-anchor' (a path out of the source's
 *    subtree must cross an ancestor of the source before/above it)
 * 8. anything unproved → 'server-check-required' (drop stays possible; the
 *    server cycle guard is the authority)
 */
function decideDragStructure(input) {
  const source = input?.source
  const target = input?.target
  if (!source || !target)
    throw new TypeError('decideDragStructure requires source and target facts')
  if (!isNonEmptyString(source.resourceId) || !isNonEmptyString(target.resourceId)) {
    throw new TypeError('decideDragStructure requires non-empty resource ids')
  }
  if (source.resourceId === target.resourceId) return { kind: 'deny', reason: 'self' }
  if (source.drive !== target.drive) return { kind: 'deny', reason: 'cross-drive' }
  if (source.parentKnown === true && source.parentResourceId == null) {
    return { kind: 'deny', reason: 'root-source' }
  }
  if (source.parentKnown === true && source.parentResourceId === target.resourceId) {
    return { kind: 'deny', reason: 'same-parent' }
  }
  if (source.kind === 'file') return { kind: 'observed-safe', evidence: 'file' }

  const chain = Array.isArray(input.targetAncestorIds) ? input.targetAncestorIds : []
  const knownSourceAncestors =
    input.knownSourceAncestorIds instanceof Set ? input.knownSourceAncestorIds : new Set()
  for (const ancestorId of chain) {
    if (ancestorId === source.resourceId) return { kind: 'deny', reason: 'descendant' }
    if (knownSourceAncestors.has(ancestorId))
      return { kind: 'observed-safe', evidence: 'common-anchor' }
  }
  if (chain.length > 0 && chain[chain.length - 1] === null) {
    // The observation walked to the physical root without meeting the source:
    // equivalent to the common-anchor proof (root is an ancestor of source).
    return { kind: 'observed-safe', evidence: 'known-chain' }
  }
  return { kind: 'server-check-required' }
}

/** Normalize a server-returned canonical path for comparison ('' → null). */
function normalizeCanonicalPath(value) {
  if (typeof value !== 'string') return null
  if (value.length === 0) return null
  if (value === '/') return '/'
  let normalized = value
  if (!normalized.startsWith('/')) normalized = `/${normalized}`
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

/** Parent path of a canonical path; null for the root itself, undefined when unknown. */
function parentPathOf(canonicalPath) {
  const normalized = normalizeCanonicalPath(canonicalPath)
  if (normalized === null) return undefined
  if (normalized === '/') return null
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash === 0 ? '/' : normalized.slice(0, lastSlash)
}

/**
 * Control UI structural decision from canonical server paths (rev-2 §3.2).
 * Paths must come from current authorized views (resolve/by-path); a null or
 * absent path never certifies structure — it yields server-check-required.
 */
function decideDragPathStructure(input) {
  const sourcePath = normalizeCanonicalPath(input?.sourcePath)
  const targetPath = normalizeCanonicalPath(input?.targetPath)
  if (sourcePath === null || targetPath === null) return { kind: 'server-check-required' }
  if (sourcePath === targetPath) return { kind: 'deny', reason: 'self' }
  if (sourcePath === '/') return { kind: 'deny', reason: 'root-source' }
  if (targetPath === parentPathOf(sourcePath)) return { kind: 'deny', reason: 'same-parent' }
  if (targetPath === `${sourcePath}/` || targetPath.startsWith(`${sourcePath}/`)) {
    return { kind: 'deny', reason: 'descendant' }
  }
  return { kind: 'observed-safe', evidence: 'fresh-path' }
}

/**
 * Exact move-authority decision (rev-2 §3.3). MOVE needs write AND delete on
 * the physical source parent plus write on the destination; bits are
 * independent and each may arrive from direct/inherited grants, shares or
 * team membership. Operators are intrinsic (pass all bits; the app decides).
 *
 * `held` arrays mirror the affordances wire shape; null means "not yet known"
 * (checking). `unavailable` reports a probe that could not answer.
 */
function decideDragAuthority(input) {
  if (input?.unavailable) {
    return { kind: 'unavailable', reason: input.unavailable }
  }
  const sourceParentHeld = input?.sourceParentHeld ?? null
  const destinationHeld = input?.destinationHeld ?? null
  if (sourceParentHeld === null || destinationHeld === null) return { kind: 'checking' }
  const sourceBits = sourceParentHeld instanceof Set ? sourceParentHeld : new Set(sourceParentHeld)
  const destinationBits =
    destinationHeld instanceof Set ? destinationHeld : new Set(destinationHeld)
  // Destination first (the surface the user is acting on), then the two
  // independent source-parent bits in UX-matrix order.
  if (!destinationBits.has('write')) return { kind: 'deny', reason: 'destination-write' }
  if (!sourceBits.has('write')) return { kind: 'deny', reason: 'source-write' }
  if (!sourceBits.has('delete')) return { kind: 'deny', reason: 'source-delete' }
  return { kind: 'observed-allowed', checkedAt: input.checkedAt ?? 0 }
}

/**
 * Pure refresh plan after a committed move (rev-2 §6). Given the receipt and
 * the currently known parent links from cached listings (child resourceId →
 * parent folder resourceId), produce the selective convergence sets:
 * - refetchChildIds: old + new parent (deduped, null-free) whose children
 *   listings are immediately stale.
 * - staleResourceIds: the moved resource plus every KNOWN descendant reached
 *   through cached parent links (an observation, never a claim that the set
 *   covers the whole physical subtree).
 */
function planMoveConvergence(receipt, known) {
  const resourceId = receipt?.resourceId
  if (!isNonEmptyString(resourceId)) {
    throw new TypeError('planMoveConvergence requires a receipt resourceId')
  }
  const refetchChildIds = []
  for (const parentId of [receipt.oldParentId, receipt.newParentId]) {
    if (isNonEmptyString(parentId) && !refetchChildIds.includes(parentId)) {
      refetchChildIds.push(parentId)
    }
  }
  const childParentByResourceId =
    known?.childParentByResourceId instanceof Map ? known.childParentByResourceId : new Map()
  const staleResourceIds = [resourceId]
  const seen = new Set([resourceId])
  // Breadth-first over cached links; bounded by the known-cache size.
  let frontier = [resourceId]
  while (frontier.length > 0) {
    const next = []
    for (const parentId of frontier) {
      for (const [childId, parentOfChild] of childParentByResourceId) {
        if (parentOfChild === parentId && !seen.has(childId)) {
          seen.add(childId)
          staleResourceIds.push(childId)
          next.push(childId)
        }
      }
    }
    frontier = next
  }
  return { refetchChildIds, staleResourceIds }
}

module.exports = {
  GFS_MOVE_MAX_NETWORK_ATTEMPTS,
  decideDragAuthority,
  decideDragPathStructure,
  decideDragStructure,
  normalizeCanonicalPath,
  parentPathOf,
  planMoveConvergence,
}
