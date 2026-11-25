/**
 * Audit line for a Host's `spec.approval` (spec 2026-11-24-control-ui-approval-settings
 * §6.8). Every approval change made through control-api leaves one structured
 * log line that lists what changed field by field, so an operator can answer
 * "who widened this agent's approvals, and when" from the log alone.
 *
 * Privacy: the line carries no approver identity, only how many approvers were
 * added and removed per channel. Every value is a primitive cut to
 * `MAX_VALUE_LENGTH` characters.
 */
import { rootLogger } from '../observability/logger.js'
import { approvalBlocksEqual } from './hostApprovalRules.js'

/** A per-tool override map may be large; the line lists at most this many changed tools. */
export const MAX_TOOL_KEYS = 50
/** Other strings (values and field keys) are cut to this many characters. */
export const MAX_VALUE_LENGTH = 128

type Leaf = string | number | boolean | null

export type HostApprovalChange = {
  fields: Record<string, { old: Leaf; new: Leaf }>
  tools: Record<string, { old: boolean | null; new: boolean | null }>
  toolsTruncated: number
  approvers: Record<string, { added: number; removed: number }>
  blockRemoved: boolean
  inheritedBefore: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cut(text: string): string {
  return text.length > MAX_VALUE_LENGTH ? text.slice(0, MAX_VALUE_LENGTH) : text
}

/**
 * A leaf as the line shows it: primitives as they are (strings cut), absent as
 * null. A non-primitive leaf (an array outside `approvers`, which the Host CRD
 * does not define) is shown as its JSON text cut to the same length.
 */
function toLeaf(value: unknown): Leaf {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return cut(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return cut(JSON.stringify(value) ?? String(value))
}

type Walk = {
  leaves: Map<string, unknown>
  tools: Map<string, unknown>
  approvers: Map<string, unknown[]>
}

function walk(value: unknown, path: string, out: Walk): void {
  if (path === 'tools' && isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) out.tools.set(key, entry)
    return
  }
  if (path === 'tools') return
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const child = path === '' ? key : `${path}.${key}`
      if (key === 'approvers') {
        out.approvers.set(path === '' ? key : path, Array.isArray(entry) ? entry : [])
      } else {
        walk(entry, child, out)
      }
    }
    return
  }
  if (path !== '') out.leaves.set(path, value)
}

function flatten(approval: unknown): Walk {
  const out: Walk = { leaves: new Map(), tools: new Map(), approvers: new Map() }
  walk(approval, '', out)
  return out
}

function countDifference(from: unknown[], to: unknown[]): number {
  const seen = new Set(from.map(item => JSON.stringify(item)))
  return to.filter(item => !seen.has(JSON.stringify(item))).length
}

/**
 * The field-by-field difference between two `spec.approval` blocks, or `null`
 * when they are equal. `before` and `after` are the blocks themselves,
 * `undefined` when absent (`before` is undefined on create). Pure: the caller
 * logs.
 */
export function buildHostApprovalChange(input: {
  before: Record<string, unknown> | undefined
  after: Record<string, unknown> | undefined
}): HostApprovalChange | null {
  const beforeApproval = input.before
  const afterApproval = input.after
  if (approvalBlocksEqual(beforeApproval, afterApproval)) return null

  const before = flatten(beforeApproval)
  const after = flatten(afterApproval)

  const fields: HostApprovalChange['fields'] = {}
  for (const key of [...new Set([...before.leaves.keys(), ...after.leaves.keys()])].sort()) {
    const oldValue = toLeaf(before.leaves.get(key))
    const newValue = toLeaf(after.leaves.get(key))
    if (oldValue !== newValue) fields[cut(key)] = { old: oldValue, new: newValue }
  }

  const tools: HostApprovalChange['tools'] = {}
  let toolsTruncated = 0
  for (const key of [...new Set([...before.tools.keys(), ...after.tools.keys()])].sort()) {
    const asFlag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
    const oldValue = asFlag(before.tools.get(key))
    const newValue = asFlag(after.tools.get(key))
    if (oldValue === newValue) continue
    if (Object.keys(tools).length >= MAX_TOOL_KEYS) {
      toolsTruncated += 1
      continue
    }
    tools[cut(key)] = { old: oldValue, new: newValue }
  }

  const approvers: HostApprovalChange['approvers'] = {}
  for (const key of [...new Set([...before.approvers.keys(), ...after.approvers.keys()])].sort()) {
    const was = before.approvers.get(key) ?? []
    const now = after.approvers.get(key) ?? []
    const added = countDifference(was, now)
    const removed = countDifference(now, was)
    if (added > 0 || removed > 0) approvers[cut(key)] = { added, removed }
  }

  return {
    fields,
    tools,
    toolsTruncated,
    approvers,
    blockRemoved: beforeApproval !== undefined && afterApproval === undefined,
    inheritedBefore: beforeApproval === undefined,
  }
}

export function logHostApprovalChange(input: {
  change: HostApprovalChange
  host: string
  namespace: string
  operatorSub: string | null
  operationId: string | null
  via: 'host_put' | 'host_create'
}): void {
  rootLogger.child({ module: 'host-approval-audit' }).info(
    {
      event: 'host_approval_changed',
      host: input.host,
      namespace: input.namespace,
      operatorSub: input.operatorSub,
      operationId: input.operationId,
      via: input.via,
      fields: input.change.fields,
      tools: input.change.tools,
      toolsTruncated: input.change.toolsTruncated,
      approvers: input.change.approvers,
      blockRemoved: input.change.blockRemoved,
      inheritedBefore: input.change.inheritedBefore,
    },
    'Host approval settings changed'
  )
}
