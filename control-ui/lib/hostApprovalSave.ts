/**
 * The two approval writes of the Approvals tab, and the clock their requests
 * time out on: the per-tool save (spec §6.4 steps 2–14) and "Set to Manual
 * now" (spec §6.3 steps 1–6).
 *
 * The store orders the writes, not the browser. Every PUT carries the version
 * of its own fresh read, so control-api answers 409 when anything wrote the
 * Host since, and the write starts again from a new read. Each write sends
 * only its own leaves: the per-tool save the `tools.<name>` leaves the admin
 * changed (and `defaultPolicy` on a first save), the switch
 * `modeCeiling: manual`. Every other value is the fresh read's. Every
 * comparison is on effective values (spec decision 13, ./approvalEffective).
 *
 * Requests go through the real `lib/api` client. Each carries its own signal,
 * so no read joins another read in flight, and that signal is aborted on the
 * clock `getApprovalClock()` returns (a virtual one in tests): after 10 s in
 * the per-tool save, after 8 s in the switch. The switch's backoff and its
 * 20 s budget run on the same clock.
 *
 * `saveTools` keeps no state between calls: its caller owns single-flight, the
 * draft, the dialogs and every message on screen. The switch is single-flight
 * per Host for the whole page, so it keeps the running switches here (spec
 * §6.3 step 1); its caller owns the report (step 7).
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
/** Spec §6.3 step 1: the switch running for each Host in this page. */
const runningSwitches = new Map<string, Promise<OffSwitchOutcome>>()
/** Told whenever a switch starts or ends, for any Host. */
const settingManualListeners = new Set<() => void>()

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
 * Test-only: restores the real clock and random source, and forgets every
 * running switch and every `subscribeSettingManual` listener. A run already
 * started still ends, on the clock it started with, but no longer holds its
 * Host's slot or notifies anyone.
 */
export function __resetHostApprovalSaveForTests(): void {
  approvalClock = realApprovalClock
  approvalRandom = Math.random
  runningSwitches.clear()
  settingManualListeners.clear()
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

/** A request's end: its value, or what it threw and whether its timer ended it. */
type Settled<T> =
  | { state: 'answered'; value: T }
  | { state: 'failed'; error: unknown; timedOut: boolean }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One request with its own signal, aborted after `timeoutMs` on the protocol clock. */
async function timed<T>(
  clock: ApprovalClock,
  timeoutMs: number,
  send: (signal: AbortSignal) => Promise<T>
): Promise<Settled<T>> {
  const controller = new AbortController()
  const timer = clock.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return { state: 'answered', value: await send(controller.signal) }
  } catch (error) {
    // Handed back, not dropped: every caller turns it into an outcome that
    // carries its message (per-tool steps 12 and 14, switch step 6), into the
    // per-tool step-13 re-read, or into the switch's next attempt (step 4).
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

/**
 * control-api's 422 lists `errors: [{ field, message }]` (per-tool step 11,
 * switch step 6). undefined when the body carries no such list.
 */
function fieldErrors(error: unknown): Array<{ field: string; message: string }> | undefined {
  const body = isPlainObject(error) ? error.body : undefined
  const errors = isPlainObject(body) ? body.errors : undefined
  if (!Array.isArray(errors) || errors.length === 0) return undefined
  return errors.map(entry => ({
    field: isPlainObject(entry) && typeof entry.field === 'string' ? entry.field : '',
    message:
      isPlainObject(entry) && typeof entry.message === 'string'
        ? entry.message
        : JSON.stringify(entry),
  }))
}

/** Step 11. */
function refusal(error: unknown): ToolsSaveOutcome {
  const errors = fieldErrors(error)
  // Not the list this step shows: the formatted error says what control-api answered.
  return errors ? { kind: 'refused', errors } : { kind: 'error', message: messageOf(error) }
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
  const read = await timed(clock, PER_TOOL_REQUEST_TIMEOUT_MS, signal =>
    getHost(input.host, { signal })
  )
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
    const read = await timed(clock, PER_TOOL_REQUEST_TIMEOUT_MS, signal =>
      getHost(input.host, { signal })
    )
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
    const put = await timed(clock, PER_TOOL_REQUEST_TIMEOUT_MS, signal =>
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

/** Spec §6.3 step 2, and A4 C1: each request of a switch run. */
const OFF_SWITCH_REQUEST_TIMEOUT_MS = 8_000
/** Spec §6.3 step 4: no attempt starts later than this after the call. */
const OFF_SWITCH_BUDGET_MS = 20_000
/**
 * Spec §6.3 step 4's jitter. Retry n waits a random time in [half, whole) of
 * min(cap, base · 2^(n−1)): never less than 125 ms, never more than 2 s, so six
 * retries take under 8 s whatever the random source draws (A4 L3).
 */
const OFF_SWITCH_BACKOFF_BASE_MS = 250
const OFF_SWITCH_BACKOFF_CAP_MS = 2_000
/** What the fallback command shows for a value no read gave, or one that is no Kubernetes name. */
const NAMESPACE_PLACEHOLDER = '<namespace>'
const NAME_PLACEHOLDER = '<name>'
/** A Kubernetes namespace: an RFC 1123 label. */
const KUBERNETES_NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
/** A Kubernetes object name: an RFC 1123 subdomain (apimachinery's pattern and length). */
const KUBERNETES_NAME =
  /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/
/** The last error of an attempt whose read, or whose PUT's 2xx answer, held no Host. */
const NO_HOST_MESSAGE = 'Control API answered without a Host.'

/**
 * - `saved`: the ceiling is Manual now, and this run wrote it, or may have.
 *   `stored` is the PUT's answer, or, after a PUT whose answer was lost or a
 *   5xx, the run's next read once it shows Manual (T4u).
 * - `already`: the run's read found the ceiling Manual (an absent or invalid
 *   ceiling included), and no attempt of this run may have written. `stored`
 *   is that read: this module never gives null. `inherited` is true when the
 *   Host has no `spec.approval` (absent or null). mcp-host reads the ceiling
 *   from the Host's own block only, so such a Host runs Manual, and the switch
 *   never creates the block (spec §6.3 step 3).
 * - `failed`: nothing this run sent is known to have stored Manual. `message`
 *   is the last error: the client's formatted error of the last request,
 *   `REQUEST_TIMED_OUT_MESSAGE` for one the 8 s timer ended, each
 *   `field: message` of a 422, the step-9 message for a PUT answer that does
 *   not hold Manual, or spec §6.5's "Reload the page to save" for a read with
 *   no version. `fallback` is the how-to's kubectl command (step 6).
 */
export type OffSwitchOutcome =
  | { kind: 'saved'; stored: HostResource }
  | { kind: 'already'; stored: HostResource | null; inherited: boolean }
  | { kind: 'failed'; message: string; fallback: string }

/** An attempt the run makes again (spec §6.3 step 4), after `retryAfterMs` and a backoff. */
type OffSwitchRetry = { kind: 'retry'; message: string; retryAfterMs: number }

type OffSwitchRun = {
  host: string
  clock: ApprovalClock
  /** The namespace of this run's latest successful read. */
  namespace?: string
  /** The caller's namespace, for the fallback when no read of this run succeeded. */
  callerNamespace?: string
  /** A PUT of this run may have been applied: it was sent, and its answer was lost or a 5xx. */
  mayHaveWritten: boolean
}

/**
 * "Set to Manual now" for agent `host` (spec §6.3 steps 1–6). It lowers the
 * ceiling to `manual` and changes nothing else in `spec`.
 *
 * Single-flight per Host in this page (step 1): a call while a switch runs
 * for `host` returns the running promise and sends nothing, and its `options`
 * are not used. `isSettingManual` and `subscribeSettingManual` show the
 * running switch in every mounted tab.
 *
 * `options.namespace` is the Host's namespace as the calling tab last loaded
 * it. Only the failure's kubectl fallback uses it, and only when no read of
 * this run succeeded: the switch decides nothing from page data (spec A5 C6).
 */
export function setManualNow(
  host: string,
  options: { namespace?: string } = {}
): Promise<OffSwitchOutcome> {
  const running = runningSwitches.get(host)
  if (running) return running
  const run: Promise<OffSwitchOutcome> = runOffSwitch(host, options.namespace).finally(() => {
    // After a test reset the slot is free, or holds a newer run.
    if (runningSwitches.get(host) !== run) return
    runningSwitches.delete(host)
    notifySettingManual()
  })
  runningSwitches.set(host, run)
  notifySettingManual()
  return run
}

/** Whether "Set to Manual now" is running for agent `host` in this page. */
export function isSettingManual(host: string): boolean {
  return runningSwitches.has(host)
}

/**
 * Calls `listener` whenever a switch starts or ends, for any Host; it reads
 * `isSettingManual` for its own. Returns the unsubscribe function.
 */
export function subscribeSettingManual(listener: () => void): () => void {
  settingManualListeners.add(listener)
  return () => {
    settingManualListeners.delete(listener)
  }
}

function notifySettingManual(): void {
  for (const listener of Array.from(settingManualListeners)) listener()
}

/** Spec §6.3 steps 2–6, on the clock and random source of the call. */
async function runOffSwitch(
  host: string,
  callerNamespace: string | undefined
): Promise<OffSwitchOutcome> {
  const { clock, random } = getApprovalClock()
  const deadline = clock.now() + OFF_SWITCH_BUDGET_MS
  const run: OffSwitchRun = { host, clock, callerNamespace, mayHaveWritten: false }
  for (let retry = 1; ; retry += 1) {
    const result = await offSwitchAttempt(run)
    if (result.kind !== 'retry') return result
    // Step 4: no new attempt starts later than 20 s after the call. A
    // Retry-After that ends past that leaves no attempt to make.
    const now = clock.now()
    if (now >= deadline || now + result.retryAfterMs > deadline) {
      return offSwitchFailed(run, result.message)
    }
    await sleep(clock, Math.min(result.retryAfterMs + backoffMs(retry, random), deadline - now))
  }
}

/** One attempt (spec §6.3 steps 2–5): a fresh read, and a PUT unless it is already Manual. */
async function offSwitchAttempt(run: OffSwitchRun): Promise<OffSwitchOutcome | OffSwitchRetry> {
  const { clock, host } = run
  // Step 2: a read of its own; the signal keeps it out of the in-flight GET join (C9).
  const read = await timed(clock, OFF_SWITCH_REQUEST_TIMEOUT_MS, signal =>
    getHost(host, { signal })
  )
  if (read.state === 'failed') {
    return {
      kind: 'retry',
      message: read.timedOut ? REQUEST_TIMED_OUT_MESSAGE : messageOf(read.error),
      retryAfterMs: retryAfterMsOf(read.error),
    }
  }
  const fresh = read.value
  // An answer that is no Host says nothing about the ceiling.
  if (!isHostObject(fresh)) return { kind: 'retry', message: NO_HOST_MESSAGE, retryAfterMs: 0 }
  run.namespace = namespaceOf(fresh) ?? run.namespace
  const block = approvalBlockOf(fresh)

  // Step 3. Only a run that sent nothing that may have landed says "already".
  if (ceilingIsManual(block)) {
    if (run.mayHaveWritten) return { kind: 'saved', stored: fresh }
    return { kind: 'already', stored: fresh, inherited: block === undefined }
  }

  // Step 4: the fresh spec with `modeCeiling: manual`, never without this read's version.
  const version = versionOf(fresh)
  if (version === undefined) return offSwitchFailed(run, RELOAD_TO_SAVE_MESSAGE)
  const spec = isPlainObject(fresh.spec) ? fresh.spec : {}
  const put = await timed(clock, OFF_SWITCH_REQUEST_TIMEOUT_MS, signal =>
    apiSend(
      'PUT',
      `/api/v1/admin/hosts/${encodeURIComponent(host)}`,
      {
        metadata: { resourceVersion: version },
        spec: { ...spec, approval: { ...block, modeCeiling: 'manual' } },
      },
      {},
      {},
      { signal }
    )
  )

  if (put.state === 'answered') {
    const stored = answeredHost(put.value)
    if (stored === undefined) {
      // A 2xx this run cannot read: the write was accepted, so the next read decides.
      run.mayHaveWritten = true
      return { kind: 'retry', message: NO_HOST_MESSAGE, retryAfterMs: 0 }
    }
    // Step 5: the step-9 prune check on the switch's one leaf, on effective
    // values. An older CRD prunes modeCeiling, and absent is Manual: stored.
    if (ceilingIsManual(approvalBlockOf(stored))) return { kind: 'saved', stored }
    return offSwitchFailed(run, notStoredMessage(['modeCeiling']))
  }

  const status = put.timedOut ? undefined : statusOf(put.error)
  const message = put.timedOut ? REQUEST_TIMED_OUT_MESSAGE : messageOf(put.error)
  // Step 4: the Host changed since this attempt's read (either 409 reason), or
  // a 429. Neither stored anything.
  if (status === 409) return { kind: 'retry', message, retryAfterMs: 0 }
  if (status === 429) return { kind: 'retry', message, retryAfterMs: retryAfterMsOf(put.error) }
  // Step 6. apiSend has already sent a 401 down the session path.
  if (status === 422) return offSwitchFailed(run, fieldErrorsMessage(put.error) ?? message)
  if (status !== undefined && status < 500) return offSwitchFailed(run, message)
  // Step 4: no answer (the 8 s timer included), or a 5xx, 502 or 504. The
  // write may have landed, so from here this run never says "already".
  run.mayHaveWritten = true
  return { kind: 'retry', message, retryAfterMs: 0 }
}

/**
 * Whether mcp-host runs this block's ceiling as Manual. It reads the ceiling
 * from the Host's own block only, so no block, and an absent or invalid
 * ceiling, are Manual (spec decision 13).
 */
function ceilingIsManual(block: Record<string, unknown> | undefined): boolean {
  return effectiveApproval(block).modeCeiling === 'manual'
}

/** A read's answer is a Host object when it has `metadata`, as every Kubernetes object does. */
function isHostObject(value: unknown): value is HostResource {
  return isPlainObject(value) && isPlainObject(value.metadata)
}

function namespaceOf(host: HostResource): string | undefined {
  const namespace = host.metadata?.namespace
  return typeof namespace === 'string' && namespace.length > 0 ? namespace : undefined
}

/**
 * A 429's `Retry-After` as the client read it (the header, or the body's
 * `retryAfterSeconds`), in ms; 0 when it gave none. The client's `retryAtMs`
 * is on the real clock, so it is not used.
 */
function retryAfterMsOf(error: unknown): number {
  const seconds = isPlainObject(error) ? error.retryAfterSeconds : undefined
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : 0
}

/** Retry `retry`'s backoff (1-based): see `OFF_SWITCH_BACKOFF_BASE_MS`. */
function backoffMs(retry: number, random: ApprovalRandom): number {
  const whole = Math.min(OFF_SWITCH_BACKOFF_CAP_MS, OFF_SWITCH_BACKOFF_BASE_MS * 2 ** (retry - 1))
  return Math.floor(whole / 2 + random() * (whole / 2))
}

function sleep(clock: ApprovalClock, ms: number): Promise<void> {
  return new Promise(resolve => {
    clock.setTimeout(resolve, ms)
  })
}

/** Step 6: a 422's errors on one line, each `field: message`. */
function fieldErrorsMessage(error: unknown): string | undefined {
  return fieldErrors(error)
    ?.map(({ field, message }) => (field ? `${field}: ${message}` : message))
    .join('; ')
}

function offSwitchFailed(run: OffSwitchRun, message: string): OffSwitchOutcome {
  return {
    kind: 'failed',
    message,
    fallback: offSwitchFallback(run.host, run.namespace ?? run.callerNamespace),
  }
}

/**
 * Spec §6.3 step 6: the how-to's command that lowers the ceiling by hand. The
 * admin pastes it into a shell, so a name or namespace that is no Kubernetes
 * name (no Host can have one) stays a placeholder, as does a namespace nothing
 * gave.
 */
function offSwitchFallback(name: string, namespace: string | undefined): string {
  const ns =
    namespace !== undefined && KUBERNETES_NAMESPACE.test(namespace)
      ? namespace
      : NAMESPACE_PLACEHOLDER
  const host = KUBERNETES_NAME.test(name) ? name : NAME_PLACEHOLDER
  return `kubectl -n ${ns} patch host ${host} --type=json -p '[{"op":"replace","path":"/spec/approval/modeCeiling","value":"manual"}]'`
}
