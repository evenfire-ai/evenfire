import type { PendingApproval } from '../types'

/** Deep-equal for JSON-like tool arguments. Key order does not matter. */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => sameJsonValue(item, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key])
  )
}

/**
 * The one-shot grant is the exact call the user approved: same tool call id
 * and the same arguments. A later call of the same name with new arguments
 * or a new id does not match.
 */
export function oneShotMatches(
  pending: PendingApproval,
  toolName: string,
  params: Record<string, unknown>,
  toolCallId?: string
): boolean {
  if (pending.tool_name !== toolName) return false
  if (!pending.tool_call_id || !toolCallId || pending.tool_call_id !== toolCallId) return false
  return sameJsonValue(pending.parameters ?? {}, params ?? {})
}
