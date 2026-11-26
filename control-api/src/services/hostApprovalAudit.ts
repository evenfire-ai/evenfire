/**
 * Audit line for a Host's `spec.approval` (spec 2026-11-24-control-ui-approval-settings
 * §6.8). Every approval change made through control-api leaves one structured
 * log line that lists what changed field by field, so an operator can answer
 * "who widened this agent's approvals, and when" from the log alone.
 *
 * Completeness: every changed mcp-host native tool is always listed; other
 * changed tools are capped (`MAX_TOOL_KEYS`) and the rest are counted in
 * `toolsTruncated`. Changed tools are an array of `{ name, old, new }` so a
 * tool name never meets an object member or a logger redaction path.
 *
 * Privacy: the line carries no approver identity, only how many approvers were
 * added and removed per channel. Every value is a primitive cut to
 * `MAX_VALUE_LENGTH` characters.
 */
import { rootLogger } from '../observability/logger.js'
import { approvalBlocksEqual } from './hostApprovalRules.js'
import { isMcpHostNativeToolName } from './mcpHostNativeToolNames.js'

/**
 * A per-tool override map may be large; the line lists every changed mcp-host
 * native tool, then at most this many other changed tools.
 */
export const MAX_TOOL_KEYS = 50
/** Tool names (the keys of `tools`) are cut to this many characters. */
export const MAX_TOOL_NAME_LENGTH = 64
/** Other strings (values and field keys) are cut to this many characters. */
export const MAX_VALUE_LENGTH = 128

type Leaf = string | number | boolean | null

export type HostApprovalToolChange = { name: string; old: boolean | null; new: boolean | null }

export type HostApprovalChange = {
  fields: Record<string, { old: Leaf; new: Leaf }>
  /**
   * An array, not a map keyed by tool name: a request-supplied name such as
   * `__proto__` cannot collide with an object's own members, two names that
   * share their first 64 characters stay two entries, and no logger redaction
   * path (`*.access_token` and the like) can match a tool name.
   */
  tools: HostApprovalToolChange[]
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

/**
 * The audited approval leaves (spec §6.8), an allowlist. Any other key, at any
 * level, is ignored: the request body is not pruned yet when the summary is
 * built, so a non-schema key could otherwise carry identities or crowd out the
 * real change. They match the Host CRD approval schema
 * (control-ui/test/fixtures/wire/host-crd-approval.current.json).
 */
const TOP_LEVEL_FIELDS = ['modeCeiling', 'defaultPolicy', 'shellClassifierModel'] as const
/**
 * The Host CRD's `defaultPolicy` enum. A value outside it cannot be stored (the
 * apiserver rejects it), but the summary is built before that check, so it is
 * kept out: an admin-typed string never reaches the durable record.
 */
const DEFAULT_POLICIES: readonly string[] = ['cli_only', 'channel_users', 'designated_approvers']
const CHANNEL_TYPES = ['telegram', 'email', 'slack', 'teams'] as const
const CHANNEL_FIELDS = ['enabled', 'allowModeChange'] as const

function flatten(approval: unknown): Walk {
  const out: Walk = { leaves: new Map(), tools: new Map(), approvers: new Map() }
  if (!isRecord(approval)) return out
  for (const key of TOP_LEVEL_FIELDS) {
    if (!Object.hasOwn(approval, key)) continue
    if (key === 'defaultPolicy' && !DEFAULT_POLICIES.includes(String(approval[key]))) continue
    out.leaves.set(key, approval[key])
  }
  if (isRecord(approval.channels)) {
    for (const type of CHANNEL_TYPES) {
      const channel = approval.channels[type]
      if (!isRecord(channel)) continue
      for (const field of CHANNEL_FIELDS) {
        if (Object.hasOwn(channel, field))
          out.leaves.set(`channels.${type}.${field}`, channel[field])
      }
      if (Object.hasOwn(channel, 'approvers')) {
        out.approvers.set(
          `channels.${type}`,
          Array.isArray(channel.approvers) ? channel.approvers : []
        )
      }
    }
  }
  if (isRecord(approval.tools)) {
    for (const [key, entry] of Object.entries(approval.tools)) out.tools.set(key, entry)
  }
  return out
}

function countDifference(from: unknown[], to: unknown[]): number {
  const seen = new Set(from.map(item => JSON.stringify(item)))
  return to.filter(item => !seen.has(JSON.stringify(item))).length
}

/**
 * The field-by-field difference between two `spec.approval` blocks, or `null`
 * when they are equal. `before` and `after` are the blocks themselves,
 * `undefined` when absent (`before` is undefined on create). Only the audited
 * leaves count (see `flatten`); `null` also when only other keys differ. Pure:
 * the caller logs.
 */
export function buildHostApprovalChange(input: {
  before: Record<string, unknown> | null | undefined
  after: Record<string, unknown> | null | undefined
}): HostApprovalChange | null {
  // `null` counts as absent, as mcp-host's effective approval
  // (`host.spec.approval || cluster default`) does.
  const beforeApproval = input.before ?? undefined
  const afterApproval = input.after ?? undefined
  if (approvalBlocksEqual(beforeApproval, afterApproval)) return null

  const before = flatten(beforeApproval)
  const after = flatten(afterApproval)

  const fields: HostApprovalChange['fields'] = {}
  for (const key of [...new Set([...before.leaves.keys(), ...after.leaves.keys()])].sort()) {
    const oldValue = toLeaf(before.leaves.get(key))
    const newValue = toLeaf(after.leaves.get(key))
    if (oldValue !== newValue) fields[cut(key)] = { old: oldValue, new: newValue }
  }

  // Every changed key that is an mcp-host native tool name is listed first, in
  // key order, whatever else changed; then at most MAX_TOOL_KEYS other changed
  // keys, in key order. The rest are counted. A flood of unrelated keys
  // therefore cannot push a native tool's change out of the line.
  const native: HostApprovalToolChange[] = []
  const other: HostApprovalToolChange[] = []
  for (const key of [...new Set([...before.tools.keys(), ...after.tools.keys()])].sort()) {
    const asFlag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
    const oldValue = asFlag(before.tools.get(key))
    const newValue = asFlag(after.tools.get(key))
    if (oldValue === newValue) continue
    const entry = { name: key.slice(0, MAX_TOOL_NAME_LENGTH), old: oldValue, new: newValue }
    ;(isMcpHostNativeToolName(key) ? native : other).push(entry)
  }
  const tools = [...native, ...other.slice(0, MAX_TOOL_KEYS)]
  const toolsTruncated = Math.max(0, other.length - MAX_TOOL_KEYS)

  const approvers: HostApprovalChange['approvers'] = {}
  for (const key of [...new Set([...before.approvers.keys(), ...after.approvers.keys()])].sort()) {
    const was = before.approvers.get(key) ?? []
    const now = after.approvers.get(key) ?? []
    const added = countDifference(was, now)
    const removed = countDifference(now, was)
    if (added > 0 || removed > 0) approvers[cut(key)] = { added, removed }
  }

  // Nothing to report when the block is present on both sides or absent on
  // both and only keys outside the audited leaves differ. A block that appears
  // or disappears is always reported, even an empty one: `{}` is truthy, so it
  // replaces the cluster default (and removing it restores that default).
  if (
    (beforeApproval === undefined) === (afterApproval === undefined) &&
    Object.keys(fields).length === 0 &&
    tools.length === 0 &&
    toolsTruncated === 0 &&
    Object.keys(approvers).length === 0
  ) {
    return null
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

/** The stored summary on the administrative intent event is JSON of at most this many characters. */
export const MAX_APPROVAL_CHANGE_SUMMARY_LENGTH = 4096

/**
 * Characters `JSON.stringify` leaves raw that can make a summary read
 * misleadingly or that the trace read refuses: DEL, the C1 controls
 * (U+0080-U+009F), the bidirectional marks and embeddings (U+200E-U+200F,
 * U+202A-U+202E) and the bidirectional isolates (U+2066-U+2069).
 */
const ESCAPED_IN_SUMMARY = /[\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * JSON text with those characters written as `\uXXXX` escapes. `JSON.stringify`
 * escapes only U+0000 to U+001F, and the trace read drops a summary that holds
 * a control character, so a valid summary would vanish from the detail read.
 * The escapes parse back to the same strings.
 */
function encode(value: unknown): string {
  return JSON.stringify(value).replace(
    ESCAPED_IN_SUMMARY,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/**
 * The change as the JSON text kept on the administrative intent event
 * (`summary`, spec §6.8). The text is always valid JSON of at most
 * `MAX_APPROVAL_CHANGE_SUMMARY_LENGTH` characters, never a JSON string cut
 * mid-way:
 *
 * 1. Entries of other tools are dropped one by one, from the end, and counted
 *    into `toolsTruncated`, until the text fits. Native tool entries are never
 *    dropped.
 * 2. If it still does not fit with only the native entries (many changed
 *    fields), the field values fall back to counts: the text is a counts-only
 *    object marked `truncated: true` (field, tool and approver-channel counts,
 *    the approver totals and the two flags) that also holds every native
 *    entry. All native entries together take about 3,100 characters and the
 *    rest of that object is bounded, so it always fits.
 */
export function serializeApprovalChangeSummary(change: HostApprovalChange): string {
  const entries = [
    ...change.tools.filter(entry => isMcpHostNativeToolName(entry.name)),
    ...change.tools.filter(entry => !isMcpHostNativeToolName(entry.name)),
  ]
  const nativeCount = entries.filter(entry => isMcpHostNativeToolName(entry.name)).length
  for (let kept = entries.length; kept >= nativeCount; kept -= 1) {
    const text = encode({
      ...change,
      tools: entries.slice(0, kept),
      toolsTruncated: change.toolsTruncated + (entries.length - kept),
    })
    if (text.length <= MAX_APPROVAL_CHANGE_SUMMARY_LENGTH) return text
  }
  const counts = Object.values(change.approvers)
  return encode({
    truncated: true,
    tools: entries.slice(0, nativeCount),
    fieldCount: Object.keys(change.fields).length,
    toolCount: entries.length + change.toolsTruncated,
    approverChannelCount: counts.length,
    approversAdded: counts.reduce((sum, entry) => sum + entry.added, 0),
    approversRemoved: counts.reduce((sum, entry) => sum + entry.removed, 0),
    blockRemoved: change.blockRemoved,
    inheritedBefore: change.inheritedBefore,
  })
}

/**
 * The summary for the intent event of a Host write, or `undefined` when the
 * `spec.approval` blocks are equal (no summary is written then). Arguments are
 * `spec.approval` values; anything that is not an object counts as absent.
 */
export function buildApprovalChangeSummary(input: {
  before: unknown
  after: unknown
}): string | undefined {
  const asBlock = (value: unknown): Record<string, unknown> | undefined =>
    isRecord(value) ? value : undefined
  const change = buildHostApprovalChange({
    before: asBlock(input.before),
    after: asBlock(input.after),
  })
  return change ? serializeApprovalChangeSummary(change) : undefined
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
