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
 * added and removed per channel. Every value is a primitive; a string is cut to
 * `MAX_VALUE_LENGTH` characters before the line escapes control, C1,
 * bidirectional and line-separator characters, so an escaped string can reach
 * six times that length in the line.
 */
import { rootLogger } from '../observability/logger.js'
import { approvalBlocksEqual } from './hostApprovalRules.js'
import { isMcpHostNativeToolName } from './mcpHostNativeToolNames.js'
import { currentAdministrativeRequestContext } from './tracing/adminOperationContext.js'

/**
 * A per-tool override map may be large; the line lists every changed mcp-host
 * native tool, then at most this many other changed tools.
 */
export const MAX_TOOL_KEYS = 50
/**
 * The tool name of a changed-tool entry is cut to this many characters. The cut
 * name is only a label: whether a tool is native is decided on the full name.
 */
export const MAX_TOOL_NAME_LENGTH = 64
/** Other strings (values and field keys) are cut to this many characters, before any escaping. */
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
 * The Host CRD's `defaultPolicy` enum, pinned to the CRD fixture by a test. A
 * value outside it cannot be stored (the apiserver rejects it), but the summary
 * is built before that check, so it is recorded as `NOT_A_POLICY_VALUE`: an
 * admin-typed string never reaches the durable record, and the entry never
 * reads as a removal.
 */
export const DEFAULT_POLICIES: readonly string[] = [
  'cli_only',
  'channel_users',
  'designated_approvers',
]
export const NOT_A_POLICY_VALUE = '(not a policy value)'
const CHANNEL_TYPES = ['telegram', 'email', 'slack', 'teams'] as const
const CHANNEL_FIELDS = ['enabled', 'allowModeChange'] as const

function flatten(approval: unknown): Walk {
  const out: Walk = { leaves: new Map(), tools: new Map(), approvers: new Map() }
  if (!isRecord(approval)) return out
  for (const key of TOP_LEVEL_FIELDS) {
    if (!Object.hasOwn(approval, key)) continue
    const value = approval[key]
    const isPolicy = typeof value === 'string' && DEFAULT_POLICIES.includes(value)
    // null and undefined stay absent; any other non-enum value is the marker.
    out.leaves.set(
      key,
      key === 'defaultPolicy' && value !== null && value !== undefined && !isPolicy
        ? NOT_A_POLICY_VALUE
        : value
    )
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
 * (U+0080-U+009F), the Arabic letter mark (U+061C), the bidirectional marks
 * and embeddings (U+200E-U+200F, U+202A-U+202E), the bidirectional isolates
 * (U+2066-U+2069) and the line and paragraph separators (U+2028-U+2029).
 */
const ESCAPED_IN_SUMMARY =
  /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/**
 * JSON text with those characters written as `\uXXXX` escapes. `JSON.stringify`
 * escapes only U+0000 to U+001F, and the trace read drops a summary that holds
 * a control character, so a valid summary would vanish from the detail read.
 * The escapes parse back to the same strings.
 */
function encode(value: unknown): string {
  return JSON.stringify(value).replace(ESCAPED_IN_SUMMARY, unicodeEscape)
}

function unicodeEscape(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
}

/**
 * A string as the log line shows it: the same characters as `encode` escapes,
 * written as `\uXXXX` text (the logger's JSON would otherwise carry them raw).
 */
function lineText(text: string): string {
  return text.replace(ESCAPED_IN_SUMMARY, unicodeEscape)
}

function lineLeaf(value: Leaf): Leaf {
  return typeof value === 'string' ? lineText(value) : value
}

/** The change with every string made safe to show in the line. */
function lineSafe(change: HostApprovalChange): HostApprovalChange {
  return {
    ...change,
    fields: Object.fromEntries(
      Object.entries(change.fields).map(([key, entry]) => [
        lineText(key),
        { old: lineLeaf(entry.old), new: lineLeaf(entry.new) },
      ])
    ),
    tools: change.tools.map(entry => ({ ...entry, name: lineText(entry.name) })),
  }
}

/** Stands for a string value too long to keep when the summary overflows (Ruling 73, tier 2). */
export const VALUE_TOO_LONG = '(value too long)'

/** The enum values of the audited fields that have one (the Host CRD's). */
export const FIELD_ENUMS: Record<string, readonly string[]> = {
  modeCeiling: ['manual', 'auto', 'allow_all'],
  defaultPolicy: DEFAULT_POLICIES,
}
const TOO_LONG_ESCAPED_LENGTH = JSON.stringify(VALUE_TOO_LONG).length

export type SummaryOptions = {
  /** Tests only: the native-name predicate. Defaults to mcp-host's registry. */
  isNative?: (name: string) => boolean
  /** The Host, for the oversize warning. */
  host?: string
}

/**
 * The change as the JSON text kept on the administrative intent event
 * (`summary`, spec §6.8). The text is always valid JSON of at most
 * `MAX_APPROVAL_CHANGE_SUMMARY_LENGTH` characters, never a JSON string cut
 * mid-way. Native tool entries are kept ahead of everything else except the
 * changed `modeCeiling` and `defaultPolicy`, which rank above them (Ruling
 * 76), in four tiers:
 *
 * 1. Entries of other tools are dropped one by one, from the end, and counted
 *    into `toolsTruncated`, until the text fits.
 * 2. A string value becomes `VALUE_TOO_LONG` only if it is not a CRD enum value
 *    of its field, not one of this audit's own markers, and its escaped form
 *    is longer than the marker's escaped form. Enum and boolean values always
 *    keep their old and new, and the approver counts stay. The text then
 *    carries `valuesShortened: true`.
 * 3. The field values fall back to counts: a counts-only object marked
 *    `truncated: true` (field, tool and approver-channel counts, the approver
 *    totals and the two flags) that holds every native entry and the changed
 *    `modeCeiling` and `defaultPolicy`, old and new (they decide whether a
 *    person is asked, and who). The other fields show only as counts.
 * 4. Only if even that cannot fit (mcp-host gaining about 15 more native
 *    tools), native entries are cut from the end of the counts-only object,
 *    which keeps `modeCeiling` and `defaultPolicy`, counted in
 *    `nativeToolsTruncated`, and a `host_approval_summary_oversize` warning
 *    is logged, so nothing disappears silently.
 */
export function serializeApprovalChangeSummary(
  change: HostApprovalChange,
  options: SummaryOptions = {}
): string {
  const isNative = options.isNative ?? isMcpHostNativeToolName
  const entries = [
    ...change.tools.filter(entry => isNative(entry.name)),
    ...change.tools.filter(entry => !isNative(entry.name)),
  ]
  const nativeCount = entries.filter(entry => isNative(entry.name)).length
  const fits = (text: string): boolean => text.length <= MAX_APPROVAL_CHANGE_SUMMARY_LENGTH

  // Tier 1.
  for (let kept = entries.length; kept >= nativeCount; kept -= 1) {
    const text = encode({
      ...change,
      tools: entries.slice(0, kept),
      toolsTruncated: change.toolsTruncated + (entries.length - kept),
    })
    if (fits(text)) return text
  }

  // Tier 2.
  let valuesShortened = false
  const shorten = (field: string, value: Leaf): Leaf => {
    if (typeof value !== 'string') return value
    if (value === VALUE_TOO_LONG || value === NOT_A_POLICY_VALUE) return value
    if (Object.hasOwn(FIELD_ENUMS, field) && FIELD_ENUMS[field].includes(value)) return value
    // Judged on the escaped form, the form the cap is checked on.
    if (encode(value).length <= TOO_LONG_ESCAPED_LENGTH) return value
    valuesShortened = true
    return VALUE_TOO_LONG
  }
  const shortFields = Object.fromEntries(
    Object.entries(change.fields).map(([key, entry]) => [
      key,
      { old: shorten(key, entry.old), new: shorten(key, entry.new) },
    ])
  )
  const natives = entries.slice(0, nativeCount)
  const markerText = encode({
    ...change,
    fields: shortFields,
    ...(valuesShortened ? { valuesShortened: true } : {}),
    tools: natives,
    toolsTruncated: change.toolsTruncated + (entries.length - nativeCount),
  })
  if (fits(markerText)) return markerText

  // Tiers 3 and 4. The two fields that decide whether a person is asked and
  // who (modeCeiling, defaultPolicy) keep their old and new beside the counts.
  const counts = Object.values(change.approvers)
  const keyFields = Object.fromEntries(
    Object.entries(shortFields).filter(([key]) => Object.hasOwn(FIELD_ENUMS, key))
  )
  const countsOnly = (tools: HostApprovalToolChange[], cut: number): Record<string, unknown> => ({
    truncated: true,
    ...(Object.keys(keyFields).length > 0 ? { fields: keyFields } : {}),
    tools,
    ...(cut > 0 ? { nativeToolsTruncated: cut } : {}),
    fieldCount: Object.keys(change.fields).length,
    toolCount: entries.length + change.toolsTruncated,
    approverChannelCount: counts.length,
    approversAdded: counts.reduce((sum, entry) => sum + entry.added, 0),
    approversRemoved: counts.reduce((sum, entry) => sum + entry.removed, 0),
    blockRemoved: change.blockRemoved,
    inheritedBefore: change.inheritedBefore,
  })
  const tier3 = encode(countsOnly(natives, 0))
  if (fits(tier3)) return tier3

  // Tier 4: native entries are cut from the end until the text fits. With
  // none left it always fits, the two fields included: its strings are enum
  // values, this audit's markers or values no longer than VALUE_TOO_LONG
  // (tier 2), and the rest are counts and flags.
  let kept = natives.length
  let text = tier3
  while (kept > 0 && !fits(text)) {
    kept -= 1
    text = encode(countsOnly(natives.slice(0, kept), natives.length - kept))
  }
  const cutNatives = natives.length - kept
  rootLogger.child({ module: 'host-approval-audit' }).warn(
    {
      event: 'host_approval_summary_oversize',
      host: options.host ?? null,
      requestId: currentAdministrativeRequestContext()?.requestId ?? null,
      length: tier3.length,
      limit: MAX_APPROVAL_CHANGE_SUMMARY_LENGTH,
      nativeToolsTruncated: cutNatives,
    },
    'Host approval summary too long for its native tool entries'
  )
  return text
}

/**
 * The summary for the intent event of a Host write, or `undefined` when the
 * `spec.approval` blocks are equal (no summary is written then). Arguments are
 * `spec.approval` values; anything that is not an object counts as absent.
 */
export function buildApprovalChangeSummary(input: {
  before: unknown
  after: unknown
  host?: string
}): string | undefined {
  const asBlock = (value: unknown): Record<string, unknown> | undefined =>
    isRecord(value) ? value : undefined
  const change = buildHostApprovalChange({
    before: asBlock(input.before),
    after: asBlock(input.after),
  })
  return change ? serializeApprovalChangeSummary(change, { host: input.host }) : undefined
}

export function logHostApprovalChange(input: {
  change: HostApprovalChange
  host: string
  namespace: string
  operatorSub: string | null
  operationId: string | null
  via: 'host_put' | 'host_create'
}): void {
  const change = lineSafe(input.change)
  rootLogger.child({ module: 'host-approval-audit' }).info(
    {
      event: 'host_approval_changed',
      host: input.host,
      namespace: input.namespace,
      operatorSub: input.operatorSub,
      operationId: input.operationId,
      via: input.via,
      fields: change.fields,
      tools: change.tools,
      toolsTruncated: change.toolsTruncated,
      approvers: change.approvers,
      blockRemoved: change.blockRemoved,
      inheritedBefore: change.inheritedBefore,
    },
    'Host approval settings changed'
  )
}
