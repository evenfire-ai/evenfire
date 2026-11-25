/**
 * Version rule for Host writes (spec 2026-11-24-control-ui-approval-settings
 * §6.8): a write that changes `spec.approval` must carry the stored
 * `metadata.resourceVersion`, because only a versioned write is fenced against
 * a stale client replaying an old approval block.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Raw deep equality of two `spec.approval` values, exactly as they stand: no
 * defaulting and no pruning. Object key order is ignored, array order is not,
 * primitives compare with `===`. Both sides absent (`undefined`) are equal; an
 * absent block against a present one is a change.
 */
export function approvalBlocksEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => approvalBlocksEqual(item, b[index]))
    )
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every(key => Object.hasOwn(b, key) && approvalBlocksEqual(a[key], b[key]))
    )
  }
  return a === b
}

/** A version-less Host write changed `spec.approval`. The route answers 409 `approval_requires_version`. */
export class ApprovalRequiresVersionError extends Error {
  constructor(name: string) {
    super(`hosts/${name} spec.approval changes must carry the stored resourceVersion`)
    this.name = 'ApprovalRequiresVersionError'
  }
}
