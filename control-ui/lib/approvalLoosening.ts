/**
 * Loosening items for an Approvals save (spec §6.6).
 *
 * A change loosens when, after it, some tool call can happen without a person
 * where it needed one before. The per-tool save lists every item in a dialog,
 * and computes the items again at the write (§6.4 step 6).
 * `looseningItemsConfirmed` is that step's check: every item at the write must
 * be among the items the admin confirmed. `sameLooseningItems` compares two
 * lists as sets.
 *
 * PR A covers `tools` changes and the first save's policy. The ceiling,
 * channel switch, policy and approver rules arrive with PR B.
 *
 * `__tests__/approvalLoosening.oracle.test.ts` pins the tool rules to
 * mcp-host's own answers (mcp-host/test/fixtures/wire/mcp-host-approval-asks.json).
 * The function misses no loosening, and it is stricter than mcp-host only
 * where `TOOL_LOOSENING_EXCEPTIONS` says why.
 */
import { NATIVE_TOOLS, type NativeToolMeta } from '@/components/HostApprovalSection/constants'
import { type EffectiveApproval, effectiveApproval } from './approvalEffective'
import { isPlainObject } from './unknownValue'

export const LOOSENING_RULES = [
  'tool_to_skip',
  'required_to_default',
  'explicit_required_to_default_above_manual',
  'conditional_default_change',
  'custom_row_unknown_default',
  'policy_open_on_first_save',
] as const

export type LooseningRule = (typeof LOOSENING_RULES)[number]

export type LooseningItem = { path: string; rule: LooseningRule }

export type ToolLooseningException = {
  id: 'custom_row_unknown_default' | 'cron_manage_conditional_default' | 'unresolved_mcp_skip_row'
  reason: string
}

/**
 * Where the function may list an item that mcp-host's asks table does not
 * show as loosening. Each exception makes the function stricter, never laxer.
 * The oracle test requires every such item to fall under one of them, and
 * each of them to excuse at least one case.
 */
export const TOOL_LOOSENING_EXCEPTIONS: ReadonlyArray<ToolLooseningException> = [
  {
    id: 'custom_row_unknown_default',
    reason:
      'A custom row names a tool with no native row, so its default is unknown here. Removing a Required custom row and any change to Skip are items (spec §6.6). ' +
      'mcp-host answers for one plain custom name, whose default never asks, so Default → Skip shows no loosening there; the real tool behind a row may ask by default. ' +
      "This also covers removing a Required row whose name contains `__` and does not resolve to a native tool (Ruling 32(c)): §6.6 counts it as removing a Required custom row, while mcp-host ignores an MCP name's override.",
  },
  {
    id: 'cron_manage_conditional_default',
    reason:
      "cron_manage's default is conditional: it asks unless the Host is stateless and forbids schedules, and this function does not receive those Host facts. " +
      'The conditional rule lists two changes on every Host, so the function is stricter wherever the Host facts make a change harmless. ' +
      '(1) Required → Default loosens only on a stateless Host that forbids schedules; wherever the default asks, including every Host that is not stateless, it changes nothing but is listed. ' +
      '(2) Default → Skip changes nothing on a stateless Host that forbids schedules, where the default never asks, but is listed. ' +
      'The spec\'s "cron_manage as Required on a stateless Host" is the stateless subset of this exception.',
  },
  {
    id: 'unresolved_mcp_skip_row',
    reason:
      'A row whose name contains `__` and does not resolve to a native tool never takes effect: the gate asks for an MCP name before it reads overrides (mcpApprovalGateController.ts:169-178). ' +
      'The function still lists a change to Skip on such a row, as for any custom row, because the section cannot tell whether the name resolves on this Host.',
  },
]

/**
 * In auto, an explicit Required gives these tools the `admin_forced` cause and
 * a card, while their default gives `ordinary`: http_request runs and shell
 * goes to the judge (decideApproval.ts:121-133). Other Required tools ask
 * either way.
 */
const EXPLICIT_REQUIRED_ASKS_IN_AUTO: ReadonlySet<string> = new Set(['shell_exec', 'http_request'])

const NATIVE_BY_NAME: ReadonlyMap<string, NativeToolMeta> = new Map(
  NATIVE_TOOLS.map(tool => [tool.name, tool])
)

type Override = 'required' | 'default' | 'skip'

/**
 * A block's stored overrides by tool name. null and undefined values read as
 * absent, as the gate's `override ?? default` does. An absent block (an
 * inheriting Host, so the first save) or an absent `tools` has none: the code
 * defaults (spec §6.6). A `tools` that is not an object is outside the CRD
 * schema, and it also reads as the code defaults. The gate reads an override
 * only through `Object.hasOwn(tools, toolName)` (mcpApprovalGateController.ts:196),
 * which finds no tool's override in such a value.
 */
function storedOverrides(block: unknown): Map<string, unknown> {
  const overrides = new Map<string, unknown>()
  if (!isPlainObject(block) || !isPlainObject(block.tools)) return overrides
  for (const [name, value] of Object.entries(block.tools)) {
    if (value !== null && value !== undefined) overrides.set(name, value)
  }
  return overrides
}

/** A stored value read on one side of the change. */
function readOverride(value: unknown, side: 'before' | 'after'): Override {
  if (value === undefined) return 'default'
  if (value === true) return 'required'
  if (value === false) return 'skip'
  // Outside the CRD schema, which types the values as boolean. The gate reads
  // a truthy value as asking and a falsy one as not. Take the side that can
  // only over-report: asking before the change, not asking after it.
  return side === 'before' ? 'required' : 'skip'
}

/** The rule one tool's change falls under, or null when it loosens nothing. */
function toolRule(
  name: string,
  from: Override,
  to: Override,
  ceiling: EffectiveApproval['modeCeiling']
): LooseningRule | null {
  if (from === to) return null
  const native = NATIVE_BY_NAME.get(name)
  if (native === undefined) {
    // A custom row (spec §6.6), clerum__tool_call included: its default is unknown.
    return from === 'required' || to === 'skip' ? 'custom_row_unknown_default' : null
  }
  const asksByDefault = native.codeDefault === 'required' || native.conditional !== undefined
  if (to === 'skip') {
    // Ruling 32(a) narrows spec §6.6's "Required → Default on a tool whose
    // default is Skip loosens, and so does any change toward Skip." to tools
    // that can ask before the change. A tool that never asks by default runs
    // without a card both before and after a Default → Skip change.
    return from === 'required' || asksByDefault ? 'tool_to_skip' : null
  }
  // Toward Required, or Skip → Default, never loosens.
  if (from !== 'required' || to !== 'default') return null
  if (native.conditional !== undefined) return 'conditional_default_change'
  if (!asksByDefault) return 'required_to_default'
  // A ceiling outside the three values reads as above Manual: the stricter side.
  if (EXPLICIT_REQUIRED_ASKS_IN_AUTO.has(name) && ceiling !== 'manual') {
    return 'explicit_required_to_default_above_manual'
  }
  return null
}

/**
 * The loosening items of a save, at most one per path, in path order.
 *
 * - `before` is the stored block the save is built on: `undefined` for an
 *   inheriting Host, which reads as the code defaults (spec §6.6).
 * - `after` is the block the save writes.
 * - `ceiling` is the stored ceiling at the write. In PR A a per-tool save never
 *   changes it.
 * - `firstSave` adds the first save's policy rule. The save protocol keeps it
 *   aligned with `before === undefined`: its inheritance check stops a save
 *   whose block appeared or disappeared since the section's base (spec §6.4
 *   step 3). The function does not check the pair.
 *
 * Paths are independent. mcp-host's answer for one tool never depends on
 * another tool's override, so the items of a multi-path save are the union of
 * its single-path items (spec A6).
 *
 * One cross-tool effect is registration, not asking (Ruling 21):
 * - On a Host with a GFS download store, `tools.shell_exec: false` unregisters
 *   `clerum__gfs_download`. That tightens: a call that cannot happen neither
 *   asks nor runs.
 * - shell_exec Skip → Default registers the never-asking download tool again.
 *   Loosening is defined over calls that can happen both before and after a
 *   change, so that is outside it.
 * A shell_exec change is therefore never an item for `clerum__gfs_download`.
 */
export function looseningItems(input: {
  before: Record<string, unknown> | undefined
  after: Record<string, unknown>
  ceiling: 'manual' | 'auto' | 'allow_all'
  firstSave: boolean
}): LooseningItem[] {
  const before = storedOverrides(input.before)
  const after = storedOverrides(input.after)
  const items: LooseningItem[] = []
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name)
    const is = after.get(name)
    // Unchanged, A→B→A included (decision 13).
    if (Object.is(was, is)) continue
    const rule = toolRule(
      name,
      readOverride(was, 'before'),
      readOverride(is, 'after'),
      input.ceiling
    )
    if (rule !== null) items.push({ path: `tools.${name}`, rule })
  }
  // The open policy counts on a first save even though it is the code default:
  // the cluster default it replaces may have been stricter (spec §6.6).
  if (input.firstSave && effectiveApproval(input.after).policy === 'open') {
    items.push({ path: 'defaultPolicy', rule: 'policy_open_on_first_save' })
  }
  return items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** An item's identity: its path and rule. */
function itemKey(item: LooseningItem): string {
  return JSON.stringify([item.path, item.rule])
}

/**
 * Whether every item at the write is among the items the admin confirmed (spec
 * §6.4 step 6). A confirmed item that is gone by the write does not count
 * against it.
 */
export function looseningItemsConfirmed(
  confirmed: LooseningItem[],
  atWrite: LooseningItem[]
): boolean {
  const keys = new Set(confirmed.map(itemKey))
  return atWrite.every(item => keys.has(itemKey(item)))
}

/** Whether two item lists hold the same items, by path and rule, in any order. */
export function sameLooseningItems(a: LooseningItem[], b: LooseningItem[]): boolean {
  const left = new Set(a.map(itemKey))
  const right = new Set(b.map(itemKey))
  return left.size === right.size && [...left].every(key => right.has(key))
}
