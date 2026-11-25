/**
 * The per-tool approval save (spec §6.4 steps 2–14), and the clock its
 * requests time out on.
 *
 * The store orders the writes, not the browser. Every PUT carries the version
 * of its own fresh read, so control-api answers 409 when anything wrote the
 * Host since, and the save starts again from a new read (at most three
 * attempts). Only the `tools.<name>` leaves the admin changed, and
 * `defaultPolicy` on a first save, come from the caller; every other value is
 * the fresh read's. Every comparison is on effective values (spec decision 13,
 * ./approvalEffective).
 *
 * Requests go through the real `lib/api` client. Each carries its own signal,
 * so no read joins another read in flight, and that signal is aborted after
 * 10 s on the clock `getApprovalClock()` returns (a virtual one in tests).
 *
 * The caller owns single-flight, the draft, the dialogs and every message on
 * screen; `saveTools` returns an outcome and keeps no state between calls.
 */
import { type HostResource, REQUEST_TIMED_OUT_MESSAGE, apiSend, getHost } from './api'
import { type EffectiveApproval, effectiveApproval, toolsEqual } from './approvalEffective'
import { type LooseningItem, looseningItems, looseningItemsConfirmed } from './approvalLoosening'

export type ApprovalClock = {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type ApprovalRandom = () => number

export const realApprovalClock: ApprovalClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

let approvalClock: ApprovalClock = realApprovalClock
let approvalRandom: ApprovalRandom = Math.random

/** The clock and random source the approval protocols run on. */
export function getApprovalClock(): { clock: ApprovalClock; random: ApprovalRandom } {
  return { clock: approvalClock, random: approvalRandom }
}

/** Test-only: runs the protocols on `clock` and `random` until the reset. */
export function __setApprovalClockForTests(clock: ApprovalClock, random: ApprovalRandom): void {
  approvalClock = clock
  approvalRandom = random
}

/**
 * Test-only: restores the real clock and random source. They are the module's
 * only state: a save keeps none between calls.
 */
export function __resetHostApprovalSaveForTests(): void {
  approvalClock = realApprovalClock
  approvalRandom = Math.random
}

/** Spec §6.4 step 2, and A4 C1: each request of a per-tool save. */
const PER_TOOL_REQUEST_TIMEOUT_MS = 10_000
/** Spec §6.4 step 8: read-and-PUT pairs before giving up. */
const PER_TOOL_MAX_ATTEMPTS = 3

/** Spec §6.4 step 4, for `{ kind: 'conflict' }`. */
export const TOOLS_CHANGED_MESSAGE =
  'These settings changed since you opened them. Reload to see the latest.'
/** Spec §6.4 step 3, for `{ kind: 'created_elsewhere' }`. */
export const APPROVAL_CREATED_ELSEWHERE_MESSAGE =
  "This agent's approval settings were just created elsewhere. Reload to see them."
const MAYBE_MESSAGE = 'The save may not have applied. Reload to check.'
const GAVE_UP_MESSAGE = 'The agent kept changing while saving. Try again.'
/** Spec §6.5's refusal for a save that has no version to send. */
const RELOAD_TO_SAVE_MESSAGE = 'Reload the page to save'

/** Spec §6.4 step 9, for `{ kind: 'not_stored' }`; the caller shows what is live after it. */
export function notStoredMessage(fields: readonly string[]): string {
  return `This cluster's Host schema is older than this Control UI and did not store: ${fields.join(', ')}. Ask your platform team to apply the current CRDs.`
}

export type ToolsSaveInput = {
  /** The agent (Host) name. */
  host: string
  /**
   * The section's base `tools`, as stored: `spec.approval.tools` of the read
   * or write response the section last took while clean, before Edit (spec A4
   * S2). `undefined` when that block had no `tools`, or there was no block.
   */
  base: Record<string, unknown> | undefined
  /**
   * Whether that same read had no `spec.approval` (absent or null): the save
   * is the first save on an inheriting Host (spec decision 4).
   */
  baseInherited: boolean
  /** Every override the admin wants: true is Required, false is Skip, absent is Default. */
  draftTools: Record<string, boolean>
  /** The policy chosen in the first-save dialog. Given exactly when `baseInherited`. */
  firstSavePolicy?: 'channel_users' | 'cli_only'
  /** The items of the loosening dialog the admin confirmed for this save; [] when none showed. */
  confirmedItems: LooseningItem[]
}

/**
 * - `saved`: the Host holds the draft. `stored` is the PUT's answer
 *   (`via: 'response'`), or a read of this save that already held it
 *   (`via: 'reread'`): the step-4 read, or the step-13 re-read.
 * - `conflict`: `tools` changed since the base (`TOOLS_CHANGED_MESSAGE`).
 * - `created_elsewhere`: the block appeared or disappeared since the base
 *   (`APPROVAL_CREATED_ELSEWHERE_MESSAGE`).
 * - `reconfirm`: the write would loosen beyond the confirmed dialog; `items` is
 *   the new list to show. Nothing was written.
 * - `not_stored`: the PUT was applied, but the cluster did not keep `fields`
 *   (`notStoredMessage`). `live` maps each to its effective value now stored
 *   (./approvalEffective; null for a tool with no override, or the default
 *   shell judge).
 * - `refused`: control-api's 422, field by field.
 * - `error`: nothing was written. `message` is the formatted error of a read
 *   before the PUT (`REQUEST_TIMED_OUT_MESSAGE` when the 10 s timer ended it),
 *   of a 4xx PUT other than 409 and 422 (a 401 has already gone down the
 *   session path), or the refusal of a read that carried no version.
 * - `maybe`: the PUT got no answer or a 5xx, and the re-read did not show the
 *   draft stored (or failed). The write may still land (spec §6.4, known limit).
 * - `gave_up`: every attempt's PUT met a 409. Nothing was written.
 */
export type ToolsSaveOutcome =
  | { kind: 'saved'; stored: HostResource; via: 'response' | 'reread' }
  | { kind: 'conflict' }
  | { kind: 'created_elsewhere' }
  | { kind: 'reconfirm'; items: LooseningItem[] }
  | { kind: 'not_stored'; fields: string[]; live: Record<string, unknown> }
  | { kind: 'refused'; errors: Array<{ field: string; message: string }> }
  | { kind: 'error'; message: string }
  | { kind: 'maybe'; message: 'The save may not have applied. Reload to check.' }
  | { kind: 'gave_up'; message: 'The agent kept changing while saving. Try again.' }

/** A request's end: its value, or what it threw and whether the 10 s timer ended it. */
type Settled<T> =
  | { state: 'answered'; value: T }
  | { state: 'failed'; error: unknown; timedOut: boolean }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One request with its own signal, aborted after 10 s on the protocol clock. */
async function timed<T>(
  clock: ApprovalClock,
  send: (signal: AbortSignal) => Promise<T>
): Promise<Settled<T>> {
  const controller = new AbortController()
  const timer = clock.setTimeout(() => controller.abort(), PER_TOOL_REQUEST_TIMEOUT_MS)
  try {
    return { state: 'answered', value: await send(controller.signal) }
  } catch (error) {
    // Handed back, not dropped: every caller turns it into an outcome that
    // carries its message (steps 12 and 14) or into the step-13 re-read.
    return { state: 'failed', error, timedOut: controller.signal.aborted }
  } finally {
    clock.clearTimeout(timer)
  }
}

/** A thrown value's `status`: ApiRequestError and AuthExpiredError carry one, a failed fetch none. */
function statusOf(error: unknown): number | undefined {
  const status = isPlainObject(error) ? error.status : undefined
  return typeof status === 'number' ? status : undefined
}

/** A thrown value's message (a DOMException is not an `Error` in every realm). */
function messageOf(error: unknown): string {
  const message = isPlainObject(error) ? error.message : undefined
  return typeof message === 'string' && message.length > 0 ? message : String(error)
}

/**
 * `spec.approval` as mcp-host reads it (`host.spec.approval ||
 * CLERUM_APPROVAL_CONFIG`): absent, null, or not an object is no block.
 */
function approvalBlockOf(host: unknown): Record<string, unknown> | undefined {
  const spec = isPlainObject(host) ? host.spec : undefined
  const block = isPlainObject(spec) ? spec.approval : undefined
  return isPlainObject(block) ? block : undefined
}

/** A block's stored `tools`. One that is not an object holds no override. */
function toolsOf(block: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const tools = block?.tools
  return isPlainObject(tools) ? tools : undefined
}

function versionOf(host: unknown): string | undefined {
  const metadata = isPlainObject(host) ? host.metadata : undefined
  const version = isPlainObject(metadata) ? metadata.resourceVersion : undefined
  return typeof version === 'string' && version.length > 0 ? version : undefined
}

/** One stored override. null reads as absent, as the gate's `override ?? default` does. */
function overrideOf(tools: Record<string, unknown> | undefined, name: string): unknown {
  return tools !== undefined && Object.hasOwn(tools, name) ? (tools[name] ?? undefined) : undefined
}

/**
 * Step 5: the fresh `tools` with only the leaves the admin changed (base to
 * draft) replaced. A leaf the admin left alone keeps its fresh value.
 */
function nextTools(
  fresh: Record<string, unknown> | undefined,
  base: Record<string, unknown> | undefined,
  draft: Record<string, boolean>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...fresh }
  for (const name of new Set([...Object.keys(base ?? {}), ...Object.keys(draft)])) {
    const was = overrideOf(base, name)
    const is = overrideOf(draft, name)
    if (Object.is(was, is)) continue
    if (is === undefined) delete next[name]
    else next[name] = is
  }
  return next
}

/**
 * Whether a read already holds what this save writes (steps 4 and 13): the
 * block exists, its `tools` equal the draft on effective values, and on a
 * first save its policy is the chosen one.
 */
function holdsSave(block: Record<string, unknown> | undefined, input: ToolsSaveInput): boolean {
  if (block === undefined || !toolsEqual(toolsOf(block), input.draftTools)) return false
  if (input.firstSavePolicy === undefined) return true
  return (
    effectiveApproval(block).policy ===
    effectiveApproval({ defaultPolicy: input.firstSavePolicy }).policy
  )
}

/**
 * Step 9: each leaf whose effective value the stored block does not hold, with
 * the value it holds. A CRD-defaulted value, and a pruned value whose default
 * is the value sent, read the same on both sides: they count as stored.
 */
function unstoredLeaves(
  sent: Record<string, unknown>,
  stored: Record<string, unknown> | undefined
): Array<[string, unknown]> {
  const want = effectiveApproval(sent)
  const have = effectiveApproval(stored)
  const leaves: Array<[string, unknown]> = []
  const compare = (path: string, sentValue: unknown, liveValue: unknown) => {
    if (JSON.stringify(sentValue) !== JSON.stringify(liveValue)) leaves.push([path, liveValue])
  }
  compare('modeCeiling', want.modeCeiling, have.modeCeiling)
  compare('defaultPolicy', want.policy, have.policy)
  compare('shellClassifierModel', want.shellClassifierModel, have.shellClassifierModel)
  for (const type of Object.keys(want.channels) as Array<keyof EffectiveApproval['channels']>) {
    for (const field of ['allowModeChange', 'enabled', 'approvers'] as const) {
      compare(`channels.${type}.${field}`, want.channels[type][field], have.channels[type][field])
    }
  }
  for (const name of new Set([...Object.keys(want.tools), ...Object.keys(have.tools)])) {
    compare(`tools.${name}`, want.tools[name] ?? null, have.tools[name] ?? null)
  }
  return leaves
}

/**
 * The Host a PUT answers. control-api answers `{ ...host, warnings }` when a
 * write newly assigns a stale model (resources.ts). A body with no `spec` is no
 * Host.
 */
function answeredHost(value: unknown): HostResource | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.spec)) return undefined
  const host: Record<string, unknown> = { ...value }
  delete host.warnings
  return host as HostResource
}

/** Step 11: control-api's 422 lists `errors: [{ field, message }]`. */
function refusal(error: unknown): ToolsSaveOutcome {
  const body = isPlainObject(error) ? error.body : undefined
  const errors = isPlainObject(body) ? body.errors : undefined
  if (!Array.isArray(errors) || errors.length === 0) {
    // Not the list this step shows: the formatted error says what control-api answered.
    return { kind: 'error', message: messageOf(error) }
  }
  return {
    kind: 'refused',
    errors: errors.map(entry => ({
      field: isPlainObject(entry) && typeof entry.field === 'string' ? entry.field : '',
      message:
        isPlainObject(entry) && typeof entry.message === 'string'
          ? entry.message
          : JSON.stringify(entry),
    })),
  }
}

/**
 * Step 13: after a PUT with no answer, or a 5xx, a fresh read decides. It is a
 * success, seeded from that read, only if it holds the draft. The inheritance
 * check does not apply to it: a block holding exactly what this save sent is
 * the save's own outcome, whoever's write stored it.
 */
async function decideFromReread(
  clock: ApprovalClock,
  input: ToolsSaveInput
): Promise<ToolsSaveOutcome> {
  const read = await timed(clock, signal => getHost(input.host, { signal }))
  // A failed re-read leaves the outcome unknown. Its own error is not shown:
  // the message tells the admin to reload, which shows what is stored.
  if (read.state === 'answered' && holdsSave(approvalBlockOf(read.value), input)) {
    return { kind: 'saved', stored: read.value, via: 'reread' }
  }
  return { kind: 'maybe', message: MAYBE_MESSAGE }
}

/** Saves the per-tool overrides of one agent (spec §6.4 steps 2–14). */
export async function saveTools(input: ToolsSaveInput): Promise<ToolsSaveOutcome> {
  const { firstSavePolicy } = input
  if (input.baseInherited !== (firstSavePolicy !== undefined)) {
    throw new Error(
      input.baseInherited
        ? 'saveTools: a first save on an inheriting agent needs the chosen firstSavePolicy (spec decision 4)'
        : 'saveTools: firstSavePolicy is written only by the first save on an inheriting agent (spec decision 4)'
    )
  }
  const firstSave = firstSavePolicy !== undefined
  const { clock } = getApprovalClock()
  const path = `/api/v1/admin/hosts/${encodeURIComponent(input.host)}`

  for (let attempt = 1; attempt <= PER_TOOL_MAX_ATTEMPTS; attempt += 1) {
    // Step 2: a read of its own; the signal keeps it out of the in-flight GET join.
    const read = await timed(clock, signal => getHost(input.host, { signal }))
    // Step 14: nothing was written, so the caller keeps the draft and shows this.
    if (read.state === 'failed') {
      return {
        kind: 'error',
        message: read.timedOut ? REQUEST_TIMED_OUT_MESSAGE : messageOf(read.error),
      }
    }
    const fresh = read.value
    const freshBlock = approvalBlockOf(fresh)

    // Step 3: the block appeared, or disappeared, since the section's base.
    if ((freshBlock === undefined) !== input.baseInherited) return { kind: 'created_elsewhere' }

    // Step 4: an earlier attempt or save already stored the draft; otherwise
    // `tools` must still be the base.
    if (holdsSave(freshBlock, input)) return { kind: 'saved', stored: fresh, via: 'reread' }
    if (!toolsEqual(toolsOf(freshBlock), input.base)) return { kind: 'conflict' }

    // Step 5. On a first save step 3 left no block to build on.
    const tools = nextTools(toolsOf(freshBlock), input.base, input.draftTools)
    const nextBlock: Record<string, unknown> = firstSave
      ? { defaultPolicy: firstSavePolicy, tools }
      : { ...freshBlock, tools }

    // Step 6: from the fresh block to the next one, at the fresh ceiling. A
    // first save is measured against the code defaults (spec §6.6).
    const items = looseningItems({
      before: firstSave ? undefined : freshBlock,
      after: nextBlock,
      ceiling: effectiveApproval(freshBlock).modeCeiling,
      firstSave,
    })
    if (!looseningItemsConfirmed(input.confirmedItems, items)) return { kind: 'reconfirm', items }

    // Step 7: never a PUT without the version of this read.
    const version = versionOf(fresh)
    if (version === undefined) return { kind: 'error', message: RELOAD_TO_SAVE_MESSAGE }
    const spec = isPlainObject(fresh.spec) ? fresh.spec : {}
    const put = await timed(clock, signal =>
      apiSend(
        'PUT',
        path,
        { metadata: { resourceVersion: version }, spec: { ...spec, approval: nextBlock } },
        {},
        {},
        { signal }
      )
    )

    if (put.state === 'answered') {
      const stored = answeredHost(put.value)
      // An answer this save cannot read tells it no more than no answer.
      if (stored === undefined) return decideFromReread(clock, input)
      // Step 9.
      const unstored = unstoredLeaves(nextBlock, approvalBlockOf(stored))
      if (unstored.length > 0) {
        return {
          kind: 'not_stored',
          fields: unstored.map(([field]) => field),
          live: Object.fromEntries(unstored),
        }
      }
      // Step 10.
      return { kind: 'saved', stored, via: 'response' }
    }

    const status = put.timedOut ? undefined : statusOf(put.error)
    // Step 8: the Host changed since this attempt's read.
    if (status === 409) continue
    // Step 11.
    if (status === 422) return refusal(put.error)
    // Step 12: another 4xx. apiSend has already sent a 401 down the session path.
    if (status !== undefined && status < 500) {
      return { kind: 'error', message: messageOf(put.error) }
    }
    // Step 13: no answer, or a 5xx (the proxy's 502 and 504 included).
    return decideFromReread(clock, input)
  }
  return { kind: 'gave_up', message: GAVE_UP_MESSAGE }
}
