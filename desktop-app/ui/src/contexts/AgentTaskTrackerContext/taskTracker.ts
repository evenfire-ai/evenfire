import { classifyTier } from '@hooks/useTaskTier'
import { buildResponseFileAttachments } from '@lib/chatMessageAttachments'
import { extractAssistantReply } from '@lib/format'
import type { ProgressStep } from '@/uiTypes'
import type { SessionTokensLite, TaskProgressStreamEvent } from '../../../../src/types'
import {
  type AgentTaskTracker,
  type AttachOptions,
  type ResendPayload,
  type TaskKey,
  type TaskPendingApproval,
  type TaskState,
  type TrackerCallbacks,
  parseTaskKey,
} from './types'

/** No `open` within this window → treat the stream as failed to connect. */
const CONNECTION_TIMEOUT_MS = 5_000
/** Watchdog tick cadence. */
const WATCHDOG_INTERVAL_MS = 5_000
/** No SSE event for this long (with no terminal) → trip the idle watchdog. */
const WATCHDOG_IDLE_MS = 30_000
/**
 * Max consecutive re-rejoins for one key before we stop re-rejoining and let the
 * task settle (idle/offline). A re-rejoin happens when a stream-loss terminal
 * triggers `onTrackerTerminal` → reconcile → `rejoinIfRunning`; if the re-opened
 * SSE never reaches a real `open`/terminal under sustained network stress, the
 * connect/idle timers would otherwise loop "Connecting" forever. The counter is
 * reset on a real `open`, a fresh `start`, or `resetRejoinAttempts` (P1-B).
 */
const MAX_REJOIN_ATTEMPTS = 3

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Folds the OPEN pause segment (if any) into the `pausedMs` accumulator and
 * re-establishes the §AC3 invariant `pausedAt !== undefined` ⟺ segment OPEN.
 *
 * The D.5b tier is meant to measure how long the AGENT has been working, not
 * wall-clock: freezing the clock while suspended is only half of it, because on
 * resume the age would jump back to `now - startedAt` and swallow the whole
 * human wait (approve after 10min → instant T4 "your agent is still working").
 * Closed segments live here; the open one stays covered by the `pausedAt`
 * freeze in `useTaskTier`. Idempotent (no open segment → no-op), so callers can
 * invoke it defensively on any resume/terminal path.
 */
function closePauseSegment(s: TaskState): void {
  if (s.pausedAt === undefined) return
  s.pausedMs = (s.pausedMs ?? 0) + Math.max(0, Date.now() - s.pausedAt)
  s.pausedAt = undefined
}

/**
 * Lifecycle owner for in-flight agent tasks. Lives in a React context provider
 * (so it survives controller re-renders) but is a plain class — testable
 * without React. Each task is keyed by (agentRef, chatId); the SSE progress
 * stream, the 5s connect timeout and the 30s idle watchdog are owned here, not
 * in the controller closure (pre-D.3 they lived inside `sendAgentMessage`).
 */
export class TaskTracker implements AgentTaskTracker {
  private states = new Map<TaskKey, TaskState>()
  private listeners = new Map<TaskKey, Set<(s: TaskState) => void>>()
  private unsubs = new Map<TaskKey, () => Promise<void>>()
  private connTimers = new Map<TaskKey, ReturnType<typeof setTimeout>>()
  private watchdogTimers = new Map<TaskKey, ReturnType<typeof setInterval>>()
  private terminalFired = new Set<TaskKey>()
  /**
   * Keys whose SSE already delivered a `terminal` event, set BEFORE the
   * terminal-completed branch awaits `getTaskResult`. `terminalFired` alone
   * can't guard that window: the bridge emits `closed` right behind `terminal`
   * (replay-then-close on a finished task), and `closed` running during the
   * fetch await would fire a spurious `source:'stream'` terminal, turning a
   * successful reply into a stream-loss (C-race, spec Anexo C.2 paso 4).
   */
  private terminalReceived = new Set<TaskKey>()
  /** Consecutive re-rejoins per key with no intervening real `open`/terminal. */
  private rejoinAttempts = new Map<TaskKey, number>()
  /**
   * Coordinator-owned Resend payloads keyed by taskId (B15). Explicit lifecycle:
   * written by `setResend` at send time, cleared in `release` (the key's teardown)
   * — a stream-loss on a NON-visible chat no longer destroys the payload of a
   * still-live task, since that path defers `release` to reconcile (B11).
   */
  private pendingResend = new Map<string, ResendPayload>()
  private callbacks: TrackerCallbacks = { onTerminal: () => undefined }

  setCallbacks(cb: TrackerCallbacks): void {
    this.callbacks = { ...this.callbacks, ...cb }
  }

  start(key: TaskKey, taskId: string, userMessageId: string): void {
    // Thin wrapper over the coordinator `attach` (single open path, spec §4.2).
    this.attach(key, taskId, userMessageId, { reason: 'send', armConnTimeout: true })
  }

  /**
   * Coordinator open path (spec-v2 §4.2). Idempotent by `(key, taskId)`:
   *  - same taskId already tracked AND still LIVE → no-op (`true`).
   *  - same taskId but its terminal already fired (a B11 deferred non-visible
   *    stream-loss left a dead zombie that was NOT released to keep its Resend
   *    payload alive during the hidden window) → `release` + re-open, so a reopen
   *    rejoin actually re-attaches the SSE instead of no-oping on the corpse.
   *  - a DIFFERENT taskId tracked → `release` the old entry first (explicit
   *    teardown of its SSE unsub + timers + resend, never a silent clobber),
   *    then open the new one — closing B6 (a fresh task over a stale one) and B7
   *    (the stale entry's unsub can't leak, `release` tears it down).
   * `reason:'rejoin'` consumes the bounded re-rejoin quota and returns `false`
   * when capped; `reason:'send'`/`'reconcile'` reset the quota (a deliberate open
   * always gets a full quota).
   */
  attach(key: TaskKey, taskId: string, anchorMessageId: string, opts: AttachOptions = {}): boolean {
    const existing = this.states.get(key)
    if (existing) {
      // Idempotent re-entry guard (B6) — but ONLY for a LIVE entry. A terminal-
      // fired zombie of the same task (B11 deferred stream-loss) is dead; fall
      // through to release + re-open so the rejoin genuinely re-subscribes.
      if (existing.taskId === taskId && !this.terminalFired.has(key)) return true
      // Re-opening the SAME task's dead zombie must NOT drop its Resend payload
      // (B11: it lives until the reopen reconcile settles). `release` clears it by
      // taskId, so preserve + restore for the identical task only.
      const preservedResend =
        existing.taskId === taskId ? this.pendingResend.get(taskId) : undefined
      this.release(key)
      if (preservedResend) this.pendingResend.set(taskId, preservedResend)
    }
    const isRejoin = opts.reason === 'rejoin'
    if (isRejoin) {
      const attempts = this.rejoinAttempts.get(key) ?? 0
      if (attempts >= MAX_REJOIN_ATTEMPTS) return false
      this.rejoinAttempts.set(key, attempts + 1)
    } else {
      // A fresh send / deliberate reconcile re-open is not a re-rejoin: reset the
      // bounded counter so it always gets its full quota.
      this.rejoinAttempts.delete(key)
    }
    const armConnTimeout = opts.armConnTimeout ?? !isRejoin
    this.startInternal(key, taskId, anchorMessageId, armConnTimeout)
    return true
  }

  setResend(taskId: string, payload: ResendPayload): void {
    this.pendingResend.set(taskId, payload)
  }

  getResend(taskId: string): ResendPayload | undefined {
    return this.pendingResend.get(taskId)
  }

  /** Alias of `ack`: total teardown for a key (SSE unsub, timers, entry, resend). */
  release(key: TaskKey): void {
    this.ack(key)
  }

  /** Release every tracked key — logout / team-switch / renderer unmount (R-F13,
   *  GAP-N4): no late terminal/side-effect can fire after this returns. */
  releaseAll(): void {
    for (const key of [...this.states.keys()]) this.release(key)
    // Any orphan unsubs (subscription resolved after its entry was released) and
    // dangling resend payloads are swept too.
    for (const [key, unsub] of [...this.unsubs.entries()]) {
      void unsub().catch(() => undefined)
      this.unsubs.delete(key)
    }
    this.pendingResend.clear()
    this.rejoinAttempts.clear()
  }

  /**
   * Clear the bounded re-rejoin counter for a key. Called by a deliberate,
   * user-initiated reconcile (e.g. opening the chat via `switchToChat`) so the
   * user always gets a fresh rejoin quota — only the automatic stream-loss
   * terminal → rejoin cycle is what the cap is meant to stop.
   */
  resetRejoinAttempts(key: TaskKey): void {
    this.rejoinAttempts.delete(key)
  }

  rejoinIfRunning(key: TaskKey, taskId: string, userMessageId?: string): boolean {
    if (this.states.has(key)) return true // already following this key
    // Bound re-rejoins: a stream-loss terminal triggers a reconcile that may
    // re-rejoin a still-`processing` task. If the re-opened SSE keeps failing to
    // `open` under sustained network stress, this would loop "Connecting"
    // forever. After the cap, stop re-rejoining and settle (no entry created →
    // idle/offline). The counter resets on a real `open` (genuine reconnect), a
    // fresh `start` (new send), or `resetRejoinAttempts` (user-initiated
    // reconcile) — never on the stream-loss `ack`, which would defeat the cap
    // (P1-B). Return `false` on the capped no-op so the controller can surface a
    // recovery affordance (offline banner) instead of a frozen stepper.
    const attempts = this.rejoinAttempts.get(key) ?? 0
    if (attempts >= MAX_REJOIN_ATTEMPTS) return false
    this.rejoinAttempts.set(key, attempts + 1)
    // Do NOT arm the 5s connect-timeout on a rejoin: a rejoin under the same
    // network stress that dropped the stream legitimately needs longer to
    // re-open, and a hard `source:'stream'` terminal here would immediately
    // re-rejoin (the loop). The 30s idle watchdog remains the real liveness guard.
    this.startInternal(key, taskId, userMessageId ?? '<unknown>', false)
    return true
  }

  private startInternal(
    key: TaskKey,
    taskId: string,
    userMessageId: string,
    armConnTimeout: boolean
  ): void {
    const now = Date.now()
    this.states.set(key, {
      taskId,
      userMessageId,
      status: 'connecting',
      startedAt: now,
      lastEventAt: now,
      steps: [],
      currentIteration: 0,
    })
    this.terminalFired.delete(key)
    this.terminalReceived.delete(key)
    this.emit(key)
    if (armConnTimeout) this.armConnectionTimeout(key)
    this.armWatchdog(key)
    void this.openSse(key, taskId)
  }

  get(key: TaskKey): TaskState | undefined {
    return this.states.get(key)
  }

  subscribe(key: TaskKey, fn: (s: TaskState) => void): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(fn)
    const current = this.states.get(key)
    if (current) fn({ ...current }) // sync-up: immediate emit of current state
    return () => {
      const s = this.listeners.get(key)
      s?.delete(fn)
      if (s && s.size === 0) this.listeners.delete(key)
    }
  }

  ack(key: TaskKey): void {
    // Drop the coordinator-owned Resend payload for this key's task (B15): the
    // teardown is the single lifecycle point, so an ack without a terminal no
    // longer retains the base64 attachments forever.
    const acked = this.states.get(key)
    if (acked) this.pendingResend.delete(acked.taskId)
    this.states.delete(key)
    // Listener registrations belong to the SUBSCRIBERS (the active chat's
    // mirror effect, placeholders), not to the task: they were never torn down
    // by an ack conceptually, and deleting them here silenced every later task
    // on the same key — the active-chat mirror only re-subscribes on a
    // chat/agent switch, so the next send rendered a frozen 'connecting'
    // stepper (B1, spec Anexo C.1). Subscribers remove themselves via the
    // unsubscribe fn returned by `subscribe`, which already prunes empty sets.
    this.terminalFired.delete(key)
    this.terminalReceived.delete(key)
    // NOTE: intentionally do NOT reset `rejoinAttempts` here. The stream-loss
    // reconcile acks the key BEFORE re-rejoining (useAgentChatController), so
    // resetting here would zero the counter every cycle and defeat the cap. The
    // counter is reset only on a real `open` (genuine reconnect) or a fresh
    // `start` (new send) — both guarantee a clean quota.
    this.clearTimers(key)
    const unsub = this.unsubs.get(key)
    if (unsub) {
      void unsub().catch(() => undefined)
      this.unsubs.delete(key)
    }
  }

  async cancel(key: TaskKey): Promise<void> {
    const state = this.states.get(key)
    if (!state) return
    const { agentRef } = parseTaskKey(key)
    // Cross-ref D.3 P1: cancelTask signature is (hostRef, taskId) — no hostRefs[].
    await window.clerum.rpc.cancelTask(agentRef, state.taskId)
    // Do not mutate state here — wait for the SSE `terminal: cancelled`.
  }

  private emit(key: TaskKey): void {
    const state = this.states.get(key)
    if (!state) return
    const set = this.listeners.get(key)
    if (set) set.forEach(fn => fn({ ...state })) // shallow copy → referential change
  }

  /** Apply a mutation to the state and notify subscribers. */
  private mutate(key: TaskKey, fn: (s: TaskState) => void): void {
    const state = this.states.get(key)
    if (!state) return
    fn(state)
    this.emit(key)
  }

  private armConnectionTimeout(key: TaskKey): void {
    const timer = setTimeout(() => {
      this.connTimers.delete(key)
      // A genuine `terminal` already arrived and is awaiting `getTaskResult`
      // (a slow durable fetch can outlast the 5s connect window). The terminal
      // implies the stream connected, so there is nothing to time out — the
      // real terminal handler owns completion and will fire/clear on its own.
      // Skipping (mirrors the SSE `closed`/`error` guards) avoids overwriting a
      // successful reply with a spurious `source:'stream'` failure. One-shot: no
      // re-arm needed. When no terminal is pending this is a real dead-connect →
      // fail as before.
      if (this.terminalReceived.has(key)) return
      this.mutate(key, s => {
        s.status = 'failed'
        s.terminalResult = {
          kind: 'error',
          source: 'stream',
          message: 'Progress stream connection timeout',
        }
      })
      void this.fireTerminal(key)
    }, CONNECTION_TIMEOUT_MS)
    this.connTimers.set(key, timer)
  }

  private armWatchdog(key: TaskKey): void {
    const timer = setInterval(() => {
      const state = this.states.get(key)
      if (!state) {
        this.clearWatchdog(key)
        return
      }
      // A genuine `terminal` already arrived and is awaiting `getTaskResult`
      // (a slow durable fetch can exceed the 30s idle window). The real
      // `terminal` handler owns completion and will fire/clear on its own — the
      // watchdog must NOT pre-empt it with a spurious stream-loss (mirrors the
      // SSE `closed`/`error` guards, which also skip once `terminalReceived`).
      // The interval is left running but simply no-ops each tick until the
      // terminal path settles: `getTaskResult` is bounded by the RPC request
      // timeout, so it always resolves or rejects into `fireTerminal` (both the
      // success and the `result_fetch` catch branches), which clears every timer
      // via `clearTimers`. No re-arm, no unbounded interval.
      if (this.terminalReceived.has(key)) return
      if (Date.now() - state.lastEventAt > WATCHDOG_IDLE_MS) {
        this.clearWatchdog(key)
        this.mutate(key, s => {
          s.status = 'failed'
          s.terminalResult = {
            kind: 'error',
            source: 'stream',
            message: 'Watchdog: no terminal SSE received within 30s',
          }
        })
        void this.fireTerminal(key)
      }
    }, WATCHDOG_INTERVAL_MS)
    this.watchdogTimers.set(key, timer)
  }

  private clearConnectionTimeout(key: TaskKey): void {
    const t = this.connTimers.get(key)
    if (t) {
      clearTimeout(t)
      this.connTimers.delete(key)
    }
  }

  private clearWatchdog(key: TaskKey): void {
    const t = this.watchdogTimers.get(key)
    if (t) {
      clearInterval(t)
      this.watchdogTimers.delete(key)
    }
  }

  private clearTimers(key: TaskKey): void {
    this.clearConnectionTimeout(key)
    this.clearWatchdog(key)
  }

  private async openSse(key: TaskKey, taskId: string): Promise<void> {
    const { agentRef } = parseTaskKey(key)
    try {
      const unsub = await window.clerum.rpc.subscribeTaskProgress(agentRef, taskId, event =>
        this.handleEvent(key, event)
      )
      // B7 — staleness by (key, taskId), not key alone: between `attach` and this
      // await resolving, the entry may have been RELEASED (acked/terminal) or
      // REPLACED by a fresh task (`attach` of a new taskId released this one and
      // opened another). Storing this now-stale unsub under `key` would either
      // leak it (release already ran) or overwrite the live task's unsub (replace)
      // — a doubled/orphaned socket (GAP-D4). Only keep it when the entry is still
      // THIS exact task.
      if (this.states.get(key)?.taskId !== taskId) {
        void unsub().catch(() => undefined)
        return
      }
      this.unsubs.set(key, unsub)
    } catch (err) {
      this.clearTimers(key)
      this.mutate(key, s => {
        s.status = 'failed'
        s.terminalResult = { kind: 'error', source: 'stream', message: errMessage(err) }
      })
      void this.fireTerminal(key)
    }
  }

  private async handleEvent(key: TaskKey, event: TaskProgressStreamEvent): Promise<void> {
    const state = this.states.get(key)
    if (!state || this.terminalFired.has(key)) return
    state.lastEventAt = Date.now()

    switch (event.type) {
      case 'waiting':
        // De-collapsed from `open` (spec-v2 §4.5-1, R6/B2b). The connection is
        // ESTABLISHED (server acknowledged the subscription) but the reporter is
        // NOT live yet — the task may be queued behind another (FIFO per session).
        // So: clear the 5s connect-timeout (a legitimately queued fresh send must
        // not be failed as a dead connect) but DO NOT reset the bounded re-rejoin
        // counter — `waiting` does not prove task liveness. Only a real `open`
        // does. Leaving the status at 'connecting' shows an honest Queued/Connecting
        // stepper. `lastEventAt` is already bumped above (resets the idle watchdog).
        this.clearConnectionTimeout(key)
        return

      case 'open':
        this.clearConnectionTimeout(key)
        // A real `open` proves the (re-)joined stream is live → reset the bounded
        // re-rejoin counter so a future, unrelated drop gets its full quota. (Only
        // a real `open` resets it now — the bridge no longer collapses `waiting`
        // into `open`, so a mere connection-established no longer resets the cap.)
        this.rejoinAttempts.delete(key)
        this.mutate(key, s => {
          // Don't downgrade a suspended approval to 'streaming': on a rejoin the
          // server replays the sticky `suspended` event to the late subscriber
          // (V2) BEFORE `open`, so `pendingApproval` may already be set — the
          // `open` must preserve it until a real post-approve event arrives.
          if (!s.pendingApproval) s.status = 'streaming'
        })
        return

      case 'tool_start': {
        const data = event.data as Record<string, unknown>
        const step: ProgressStep = {
          toolCallId: typeof data.toolCallId === 'string' ? data.toolCallId : crypto.randomUUID(),
          toolName: typeof data.toolName === 'string' ? data.toolName : 'unknown',
          displayName:
            typeof data.displayName === 'string'
              ? data.displayName
              : typeof data.toolName === 'string'
                ? data.toolName
                : 'Tool',
          intentSummary: typeof data.intentSummary === 'string' ? data.intentSummary : '',
          iteration: typeof data.iteration === 'number' ? data.iteration : 0,
          stepIndex: typeof data.stepIndex === 'number' ? data.stepIndex : 0,
          totalSteps: typeof data.totalSteps === 'number' ? data.totalSteps : 0,
          state: 'running',
          inputPreview: typeof data.inputPreview === 'string' ? data.inputPreview : undefined,
        }
        const wasSuspended = state.status === 'suspended'
        this.mutate(key, s => {
          s.status = 'streaming'
          s.llmElapsedMs = undefined
          s.steps = [...s.steps, step]
          s.currentIteration = step.iteration || s.currentIteration
          // Execution moved past the approval (decided on ANY surface: in-chat,
          // notification, another device) — drop it so the suspended affordance
          // can't linger on a running task, and CLOSE the pause segment: the wait
          // is over and must not count as agent work in the D.5b tier (§AC3).
          if (wasSuspended) {
            s.pendingApproval = undefined
            closePauseSegment(s)
          }
        })
        if (wasSuspended) this.fireResumed(key)
        return
      }

      case 'tool_progress': {
        const data = event.data as Record<string, unknown>
        const targetId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
        const elapsedMs = typeof data.elapsedMs === 'number' ? data.elapsedMs : undefined
        const rawPreview = data.outputPreview
        const hasNewPreview =
          rawPreview &&
          typeof rawPreview === 'object' &&
          Array.isArray((rawPreview as { headLines?: unknown }).headLines)
        const freshPreview = hasNewPreview
          ? (rawPreview as ProgressStep['liveOutputPreview'])
          : undefined
        this.mutate(key, s => {
          s.steps = s.steps.map(step =>
            step.toolCallId === targetId && step.state === 'running'
              ? { ...step, elapsedMs, liveOutputPreview: freshPreview ?? step.liveOutputPreview }
              : step
          )
        })
        return
      }

      case 'tool_complete': {
        const data = event.data as Record<string, unknown>
        const targetId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
        const isError = Boolean(data.isError) || Boolean(data.errorSummary)
        const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined
        const errorSummary = typeof data.errorSummary === 'string' ? data.errorSummary : undefined
        const metadata =
          data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
            ? (data.metadata as Record<string, unknown>)
            : undefined
        const rawPreview = data.outputPreview
        const outputPreview =
          rawPreview &&
          typeof rawPreview === 'object' &&
          Array.isArray((rawPreview as { headLines?: unknown }).headLines)
            ? (rawPreview as ProgressStep['outputPreview'])
            : undefined
        const rawTokens = data.tokens as
          | { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown }
          | undefined
        const tokens =
          rawTokens &&
          typeof rawTokens === 'object' &&
          typeof rawTokens.input === 'number' &&
          typeof rawTokens.output === 'number' &&
          (rawTokens.cacheRead === undefined || typeof rawTokens.cacheRead === 'number') &&
          (rawTokens.cacheWrite === undefined || typeof rawTokens.cacheWrite === 'number')
            ? (rawTokens as SessionTokensLite)
            : undefined
        this.mutate(key, s => {
          s.steps = s.steps.map(step =>
            step.toolCallId === targetId
              ? {
                  ...step,
                  state: isError ? ('error' as const) : ('completed' as const),
                  metadata,
                  durationMs,
                  tokens,
                  errorSummary,
                  outputPreview,
                }
              : step
          )
        })
        return
      }

      case 'llm_in_progress': {
        const data = event.data as Record<string, unknown>
        const elapsedMs = typeof data.elapsedMs === 'number' ? data.elapsedMs : undefined
        const iteration = typeof data.iteration === 'number' ? data.iteration : undefined
        const wasSuspended = state.status === 'suspended'
        this.mutate(key, s => {
          s.status = 'streaming'
          s.llmElapsedMs = elapsedMs
          s.currentIteration = iteration ?? s.currentIteration
          // Same resume bookkeeping as `tool_start` — the approval was decided and
          // the pause segment closes here too (§AC3, tier = active time).
          if (wasSuspended) {
            s.pendingApproval = undefined
            closePauseSegment(s)
          }
        })
        if (wasSuspended) this.fireResumed(key)
        return
      }

      case 'suspended': {
        const sd = event.data
        // OPEN a pause segment: stamp `pausedAt` ONLY on the TRANSITION into
        // suspended (§AC3 freezes the D.5b tier timer at `pausedAt` so an approval
        // wait can't escalate the nudges; the segment is closed into `pausedMs` on
        // resume/terminal, which is what keeps the tier measuring ACTIVE time once
        // the task runs again). This event is NOT once-per-suspension: mcp-host keeps the last
        // `suspended` as a sticky event and replays it to every new subscriber, and
        // the main-process bridge (`appService.startTaskProgressStream`) reconnects
        // the SSE transparently whenever the 300s RPC token lapses mid-stream
        // (`auth-expired`) — i.e. roughly every 5 min on a long approval wait. Each
        // replay re-entering this branch used to re-stamp `pausedAt = now`, turning
        // the "frozen" age (`pausedAt - startedAt`) back into full wall-clock and
        // escalating the task to T3/T4/T5 while it sat suspended. Guarding on the
        // PREVIOUS status keeps a genuine RE-suspension correct: a decided approval
        // routes through `tool_start`/`llm_in_progress`, which set status back to
        // 'streaming', so the next `suspended` is a real transition and re-stamps.
        const wasSuspended = state.status === 'suspended'
        this.mutate(key, s => {
          s.status = 'suspended'
          if (!wasSuspended) s.pausedAt = Date.now()
          s.pendingApproval = sd.requestId
            ? {
                requestId: sd.requestId,
                displayName: sd.displayName || 'Unknown Tool',
                // U5: preserved so downstream (stepper prompt, deep-link
                // correlation) can distinguish a connect_required suspension and
                // resume the right task. Undefined for ordinary approvals.
                reason: sd.reason,
                mcpServerName: sd.mcpServerName,
              }
            : undefined
        })
        const updated = this.states.get(key)
        if (updated?.pendingApproval) this.callbacks.onSuspended?.(key, { ...updated })
        return
      }

      case 'terminal': {
        // Mark the terminal as RECEIVED before any await: the bridge emits
        // `closed` immediately behind `terminal` on a finished task, and the
        // completed branch below awaits `getTaskResult` — without this flag the
        // `closed` handler would win that window and fire a spurious
        // stream-loss terminal, discarding the successful reply (C-race).
        this.terminalReceived.add(key)
        const td = event.data
        if (td.status === 'cancelled') {
          this.mutate(key, s => {
            s.status = 'cancelled'
            s.terminalResult = { kind: 'cancelled', reason: td.reason }
          })
          await this.fireTerminal(key)
          return
        }
        if (td.status === 'failed' && td.error?.message) {
          this.mutate(key, s => {
            s.status = 'failed'
            s.terminalResult = {
              kind: 'error',
              source: 'failed',
              message: td.error!.message!,
              code: td.error!.code,
              provider: td.error!.provider,
            }
          })
          await this.fireTerminal(key)
          return
        }
        // status === 'completed' (or 'failed' with no message) → fetch the result
        const completedTaskId = state.taskId
        try {
          const { agentRef } = parseTaskKey(key)
          const result = await window.clerum.rpc.getTaskResult(agentRef, completedTaskId, [
            agentRef,
          ])
          // Re-check identity after the await (mirrors openSse's B7 guard): an
          // `attach`/resend may have RELEASED this key or REPLACED it with a fresh
          // task while `getTaskResult` was in flight. Writing the old reply over the
          // new task's state — and letting `fireTerminal` stamp `terminalFired` on
          // it — would corrupt the live task into a permanent zombie (H2). Bail so
          // only the superseding task's own terminal settles it.
          if (this.states.get(key)?.taskId !== completedTaskId) return
          const reply = extractAssistantReply(result)
          const attachments = buildResponseFileAttachments(result)
          this.mutate(key, s => {
            s.status = 'completed'
            s.terminalResult = {
              kind: 'reply',
              content: reply,
              ...(attachments.length ? { attachments } : {}),
            }
          })
        } catch {
          // Same post-await identity guard on the failure branch — a replacement
          // during the await must not have its state overwritten with this error.
          if (this.states.get(key)?.taskId !== completedTaskId) return
          this.mutate(key, s => {
            s.status = 'failed'
            s.terminalResult = {
              kind: 'error',
              source: 'result_fetch',
              message: 'Failed to retrieve task result after completion',
            }
          })
        }
        await this.fireTerminal(key)
        return
      }

      case 'error': {
        // Transport-level stream error. Pre-stream-recovery this fell through to
        // `default` (the 30s watchdog would eventually fail it). Now the bridge
        // only emits `error` after exhausting its reconnect attempts (or on
        // task_not_found_or_expired), so treat it as a definitive stream-loss
        // terminal immediately — `onTrackerTerminal` then reconciles against the
        // server (which may still hold the result or a pending approval). This
        // closes the ~30s dead window between "bridge gave up" and "watchdog".
        if (this.terminalFired.has(key) || this.terminalReceived.has(key)) return
        this.mutate(key, s => {
          s.status = 'failed'
          s.terminalResult = {
            kind: 'error',
            source: 'stream',
            message: event.message || 'Progress stream error',
          }
        })
        await this.fireTerminal(key)
        return
      }

      case 'gone': {
        // Structured transport give-up (spec-v2 §4.5-2, R6): the main-process
        // bridge exhausted its bounded reconnect or hit task_not_found_or_expired.
        // NOT a task failure — treat it exactly like a definitive `error`
        // stream-loss: fire a `source:'stream'` terminal so `onTrackerTerminal`
        // reconciles against the server (re-attach if the server is still non-idle,
        // else settle with the durable result / offline). The `reason` is carried
        // through for telemetry/diagnostics.
        if (this.terminalFired.has(key) || this.terminalReceived.has(key)) return
        this.mutate(key, s => {
          s.status = 'failed'
          s.terminalResult = {
            kind: 'error',
            source: 'stream',
            message: `Progress stream gone (${event.reason})`,
          }
        })
        await this.fireTerminal(key)
        return
      }

      case 'closed':
        if (!this.terminalFired.has(key) && !this.terminalReceived.has(key)) {
          this.mutate(key, s => {
            s.status = 'failed'
            s.terminalResult = {
              kind: 'error',
              source: 'stream',
              message: 'Progress stream closed without terminal event',
            }
          })
          await this.fireTerminal(key)
        }
        return

      default:
        // heartbeat / thinking / unknown — lastEventAt already bumped (resets watchdog).
        return
    }
  }

  /**
   * A suspended task received a post-approval event — the approval was decided
   * (approve on any surface, or deny of the single tool with the loop going
   * on). Lets the controller flip the per-chat `awaiting_approval` badge back
   * to `processing`; a stale badge would otherwise feed the approval re-seed
   * effect and re-stamp a decided approval (C.2 loop, ingredients i+iv).
   */
  private fireResumed(key: TaskKey): void {
    const state = this.states.get(key)
    if (state) this.callbacks.onResumed?.(key, { ...state })
  }

  private async fireTerminal(key: TaskKey): Promise<void> {
    if (this.terminalFired.has(key)) return
    this.terminalFired.add(key)
    this.clearTimers(key)
    // A task can reach terminal with its pause segment still OPEN — a denied
    // approval that ends the run goes suspended → `terminal: cancelled` with no
    // resume event in between, and a gate can also fail/time out. Close it here so
    // the §AC3 invariant holds at terminal and the totals below are complete.
    // Guarded: `mutate` always emits, and the common case (no open segment) must
    // not fire an extra notification to every subscriber on each terminal.
    if (this.states.get(key)?.pausedAt !== undefined) this.mutate(key, s => closePauseSegment(s))
    const state = this.states.get(key)
    if (!state) return
    // Telemetry (§4.8): the coordinator owns the task lifecycle, so it emits the
    // duration + elapsed-time tier on the terminal (moved off the hook, which
    // previously logged it in `onTrackerTerminal`). `duration_ms` stays wall-clock
    // (that's what the user waited), but the tier is classified off `active_ms`:
    // the tier exists to describe how long the AGENT worked, and a long approval
    // wait would otherwise report a T4/T5 that no nudge ever showed.
    const durationMs = Date.now() - state.startedAt
    const pausedMs = state.pausedMs ?? 0
    const activeMs = Math.max(0, durationMs - pausedMs)
    console.log('[telemetry] task_duration_seconds', {
      duration_ms: durationMs,
      paused_ms: pausedMs,
      active_ms: activeMs,
      status: state.status,
      tier_at_terminal: classifyTier(activeMs),
    })
    // B8 — a throwing consumer callback must never wedge the coordinator: the
    // timers are already cleared above (before the await), and the error is caught
    // and reported via telemetry instead of bubbling as an unhandled rejection.
    // Ack stays the consumer's job
    // (a zombie entry may need to survive until a reconcile), so a throw before
    // the consumer's ack still surfaces here rather than being silently lost.
    try {
      await this.callbacks.onTerminal(key, { ...state })
    } catch (err) {
      console.error('[telemetry] terminal_callback_error', { key, message: errMessage(err) })
      // B8 — a THROW (not an intentional early `return`, e.g. B11's non-visible
      // defer) means the consumer never reached its `ack`/defer decision: the
      // entry + its SSE subscription would leak forever as a `terminalFired`
      // zombie. Defensively tear the key down here. This only runs on an
      // unexpected exception, so it can't defeat B11's deliberate deferral (which
      // returns normally and is not caught).
      this.ack(key)
    }
    // No automatic ack — the consumer acks once it has persisted/consumed the
    // terminal state. This lets a controller sitting on a different chat pick up
    // the result when the user returns.
  }
}
