/**
 * What the Approvals tab shows, and the Host-changed notice (spec §6.5).
 *
 * The tab shows one Host object, composed from its loads and its own writes,
 * so that it never shows stale or another agent's values when loads and
 * writes race (spec §7 A4 S5, S6, L1).
 *
 * **Loads.** Each load takes a new epoch and is tagged with the Host. A load
 * applies only if it is the newest load this state started and its data is
 * this state's Host. A state's Host is fixed: the tab makes a state per agent.
 *
 * **Write groups.** A write's group owns these keys of the composed Host:
 * - `ceiling` (the off switch): `spec.approval.modeCeiling`;
 * - `tools` (the per-tool save): `spec.approval.tools`,
 *   `spec.approval.defaultPolicy`, and whether `spec.approval` exists (a first
 *   save creates it).
 * Every other key, in or out of `spec.approval`, comes from loads only.
 *
 * A write's time is when it settles: the tab calls `applyWrite` once, with the
 * stored Host its PUT answered or, after an unanswered PUT, its re-read. Each
 * successful write takes the next number of the state's write sequence, and
 * its group keeps exactly what the write stored for the group's keys, an
 * absent key included. A load records the sequence number when it starts; when
 * it lands, a group whose last write settled after that keeps the write's
 * values, and the load supplies every other key. So each group shows its own
 * write's values until a load that started after that write lands.
 *
 * **Host changed.** `notifyHostChanged` tells every Approvals tab of that
 * agent, in this document at once and in the other documents (browser tabs) of
 * this Control UI through a `BroadcastChannel`, to load again.
 */
import type { HostResource } from './api'
import { approvalBlockOf } from './approvalEffective'

export type WriteGroup = 'ceiling' | 'tools'

/** A load's place in its state: its epoch, and the write sequence when it started. */
export type ApprovalLoadToken = { epoch: number; seqAtStart: number }

export type ApprovalTabState = {
  /** Starts a load: it takes a new epoch, and every older load stops counting. */
  startLoad(): ApprovalLoadToken
  /**
   * Whether `token` is still the newest load this state started. A load
   * stays the newest after it lands, until another starts. The tab shows a
   * failed load's error, and releases Save, only for the newest load (spec
   * C10, A4 L2).
   */
  isNewestLoad(token: ApprovalLoadToken): boolean
  /**
   * Applies a landed load. False, with nothing changed, when `token` is not
   * the newest load this state started or `data` is not this state's Host.
   */
  applyLoad(token: ApprovalLoadToken, data: HostResource): boolean
  /**
   * Records a settled successful write of `group` and seeds the group's keys
   * from `stored`. True when it is recorded, even while no load has landed
   * (`snapshot()` is then still null, and the first load to land shows the
   * group's values if it started before the write). False, with nothing
   * recorded, when `stored` is not this state's Host.
   */
  applyWrite(group: WriteGroup, stored: HostResource): boolean
  /**
   * The composed Host: null until a load has applied. Each applied load or
   * write replaces it with a new object, and nothing else changes it. The
   * state tells no one of a change: the caller reads it again after an
   * `applyLoad` or `applyWrite` that returned true. Read-only.
   */
  snapshot(): HostResource | null
}

/** One key of a group, as a write stored it: present with its value, or absent. */
type Leaf = { present: true; value: unknown } | { present: false }

/**
 * What a write stored for its group's keys.
 *
 * The tools group carries `defaultPolicy` and whether the block exists on
 * every tools write, not only on a first save. This is the controller's
 * reading of spec §6.5's "with `defaultPolicy` and the block's existence on
 * a first save" (Ruling 38). The reason: the write's answer holds what was
 * stored, and the Host-changed notice the write fires starts a fresh load.
 */
type GroupValues =
  | { group: 'ceiling'; modeCeiling: Leaf }
  | { group: 'tools'; block: boolean; tools: Leaf; defaultPolicy: Leaf }

/** The tools group first: it decides whether the block, which holds the ceiling, exists. */
const OVERLAY_ORDER: readonly WriteGroup[] = ['tools', 'ceiling']

/** Every Control UI browser tab, of whatever build, posts and listens on this name. */
const HOST_CHANGED_CHANNEL = 'control-ui-host-approval-changed'

/**
 * The last epoch taken, by any state. Every load of every state takes the
 * next one, so a load token counts only in the state that started it, even
 * when the tab makes a new state for an agent it shows again. Never reset:
 * the epochs only have to differ.
 */
let lastEpoch = 0
const hostChangedListeners = new Map<string, Set<() => void>>()
let hostChangedChannel: BroadcastChannel | null = null

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether `resource` is agent `host`. A Host object always carries its name;
 * one without it cannot be shown to be this agent's, so it is refused.
 */
function isHost(resource: unknown, host: string): boolean {
  return (
    isPlainObject(resource) && isPlainObject(resource.metadata) && resource.metadata.name === host
  )
}

function leafOf(block: Record<string, unknown> | undefined, key: string): Leaf {
  return block !== undefined && Object.prototype.hasOwnProperty.call(block, key)
    ? { present: true, value: structuredClone(block[key]) }
    : { present: false }
}

function groupValuesOf(group: WriteGroup, stored: HostResource): GroupValues {
  const block = approvalBlockOf(stored)
  if (group === 'ceiling') return { group, modeCeiling: leafOf(block, 'modeCeiling') }
  return {
    group,
    block: block !== undefined,
    tools: leafOf(block, 'tools'),
    defaultPolicy: leafOf(block, 'defaultPolicy'),
  }
}

function setLeaf(block: Record<string, unknown>, key: string, leaf: Leaf): void {
  if (leaf.present) block[key] = structuredClone(leaf.value)
  else delete block[key]
}

/** Puts a group's values into `target`, a copy this module owns. */
function overlay(target: HostResource, values: GroupValues): void {
  if (values.group === 'tools') {
    // The write stored no block, so the composed Host shows none. A save
    // never stores none today: it writes `spec.approval.tools`.
    if (!values.block) {
      if (isPlainObject(target.spec)) delete target.spec.approval
      return
    }
    const block = approvalBlockOf(target) ?? {}
    setLeaf(block, 'tools', values.tools)
    setLeaf(block, 'defaultPolicy', values.defaultPolicy)
    target.spec = { ...(isPlainObject(target.spec) ? target.spec : {}), approval: block }
    return
  }
  // The ceiling lives in the block, and whether the block exists is not the
  // ceiling group's key: on a composed Host with no block it has no place, so
  // the tab shows what the load (or a tools write) says about the block.
  const block = approvalBlockOf(target)
  if (block) setLeaf(block, 'modeCeiling', values.modeCeiling)
}

/**
 * The display state of one Approvals tab for agent `host`.
 *
 * It checks data only against its own Host. A continuation that still holds
 * the state of an agent the tab no longer shows gets `true` from it, so the
 * tab checks that the state is its current one before it writes component
 * state (spec §6.5 "After unmount").
 */
export function createApprovalTabState(host: string): ApprovalTabState {
  /** The epoch of the newest load this state started. */
  let newestEpoch = 0
  /** The write sequence: successful writes recorded so far. */
  let seq = 0
  /** Each group's last successful write: its sequence number and what it stored. */
  const lastWrites: Partial<Record<WriteGroup, { seq: number; values: GroupValues }>> = {}
  /** The load shown, and the write sequence when it started. */
  let shown: { data: HostResource; seqAtStart: number } | null = null
  let composed: HostResource | null = null

  function compose(): void {
    if (!shown) return
    const next = structuredClone(shown.data)
    for (const group of OVERLAY_ORDER) {
      const write = lastWrites[group]
      if (write && write.seq > shown.seqAtStart) overlay(next, write.values)
    }
    composed = next
  }

  function isNewestLoad(token: ApprovalLoadToken): boolean {
    return token.epoch === newestEpoch
  }

  return {
    startLoad() {
      lastEpoch += 1
      newestEpoch = lastEpoch
      return { epoch: newestEpoch, seqAtStart: seq }
    },
    isNewestLoad,
    applyLoad(token, data) {
      if (!isNewestLoad(token) || !isHost(data, host)) return false
      shown = { data: structuredClone(data), seqAtStart: token.seqAtStart }
      compose()
      return true
    },
    applyWrite(group, stored) {
      if (!isHost(stored, host)) return false
      seq += 1
      lastWrites[group] = { seq, values: groupValuesOf(group, stored) }
      compose()
      return true
    },
    snapshot: () => composed,
  }
}

function isBrowser(): boolean {
  return typeof window !== 'undefined'
}

/** The pattern of readRequestCache's channel: opened lazily, only in a browser that has one. */
function ensureHostChangedChannel(): BroadcastChannel | null {
  if (!isBrowser() || typeof BroadcastChannel === 'undefined') return null
  if (!hostChangedChannel) {
    hostChangedChannel = new BroadcastChannel(HOST_CHANGED_CHANNEL)
    hostChangedChannel.onmessage = event => {
      // Only this module posts here, always with the agent's name; a message
      // without one names no agent that a tab could load. A notice heard is
      // never posted again: two browser tabs would make each other load forever.
      const host = (event.data as { host?: unknown } | null)?.host
      if (typeof host === 'string') tellHostChangedListeners(host)
    }
  }
  return hostChangedChannel
}

function tellHostChangedListeners(host: string): void {
  const listeners = hostChangedListeners.get(host)
  if (!listeners) return
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch (error) {
      // A listener's bug must not keep the other tabs, here or in other
      // browser tabs, from loading again. control-ui has no client logger: its
      // client code reports caught errors to the browser console (lib/api.ts).
      console.warn(
        `Host-changed notice for agent ${host}: a listener threw; the other listeners were still told.`,
        error
      )
    }
  }
}

/**
 * Tells every Approvals tab of agent `host` to load again: in this document at
 * once, and in the other documents of this Control UI through the channel,
 * whose payload is `{ host }`. A channel never hears its own message, so this
 * document's tabs hear it once.
 */
export function notifyHostChanged(host: string): void {
  tellHostChangedListeners(host)
  ensureHostChangedChannel()?.postMessage({ host })
}

/**
 * Calls `listener` on every notice for agent `host`, from this document or
 * another. A listener that throws is reported to the console, and the others
 * are still called. Returns the unsubscribe function.
 */
export function subscribeHostChanged(host: string, listener: () => void): () => void {
  // Opened now, not on the first notice: a document that only listens must
  // still hear the others.
  ensureHostChangedChannel()
  let listeners = hostChangedListeners.get(host)
  if (!listeners) {
    listeners = new Set()
    hostChangedListeners.set(host, listeners)
  }
  listeners.add(listener)
  const own = listeners
  return () => {
    own.delete(listener)
    if (own.size === 0 && hostChangedListeners.get(host) === own) {
      hostChangedListeners.delete(host)
    }
  }
}

/** Test-only: forgets every Host-changed listener and closes the channel; the next use opens a new one. */
export function __resetHostApprovalDisplayForTests(): void {
  hostChangedListeners.clear()
  if (hostChangedChannel) {
    hostChangedChannel.close()
    hostChangedChannel = null
  }
}
