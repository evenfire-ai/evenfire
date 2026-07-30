import { parseTaskKey } from '@contexts/AgentTaskTrackerContext'
import type { SessionMessagesQuery, SessionMessagesResult } from '../../../../src/types'
import type { SessionFsmStore } from './sessionFsm'

/**
 * `reconcileChat` — the single gate to `loadSessionMessages` (+ `getTaskResult`)
 * for every recovery path (spec-v2 §4.3). It is single-flight per chatKey (a
 * second invocation while one runs coalesces onto the same promise) and routes
 * the server truth through the four precedence branches, dispatching
 * `SERVER_SNAPSHOT`/`RECONCILE_*` to the FSM. The side-effectful branch bodies
 * (attach a live stream, materialize/persist idle turns + durable result, evict a
 * 404 chat) are injected so the module stays pure and exhaustively unit-testable.
 *
 * Telemetry (§4.8): one `stream_recovery` emission per `RECONCILE_FINISHED`,
 * carrying `{reason, outcome}` and preserving the existing outcome names
 * (`reconcile_rejoined`, `rejoin_capped_offline`, `reconcile_replaced`,
 * `recovered_from_task_result`, `fell_through_to_resend`, `404`) plus new ones
 * (`stale_drop`, `offline`, `error`).
 */

/** Precedence-branch outcomes (stable telemetry names + Fase-3 additions). */
export type ReconcileOutcome =
  | 'reconcile_rejoined'
  | 'rejoin_capped_offline'
  | 'reconcile_replaced'
  | 'recovered_from_task_result'
  /** Durable per-task result recovered but it was an ERROR (budget deny etc.) —
   *  distinct from a durable reply so the loud caller paints the stepper red, not
   *  green (§4.8 new outcome name). */
  | 'recovered_error'
  | 'fell_through_to_resend'
  | 'stale_drop'
  | '404'
  | 'offline'
  | 'error'
  | 'noop'

export interface ReconcileChatDeps {
  fsm: SessionFsmStore
  /** Fetch the durable server session state (turns + recovery fields). */
  loadSessionMessages: (
    agentRef: string,
    chatId: string,
    query?: SessionMessagesQuery,
    stillRelevant?: () => boolean
  ) => Promise<SessionMessagesResult | undefined>
  /**
   * Server reports a live (`processing`/`awaiting_approval`) task: seed the
   * snapshot and attach a stream via the coordinator. Returns the outcome
   * (`reconcile_rejoined` on a real attach, `rejoin_capped_offline` when the
   * re-rejoin budget was exhausted). Owns its FSM dispatches (SERVER_SNAPSHOT,
   * WENT_OFFLINE on cap).
   */
  attachLiveTask: (
    chatKey: string,
    resp: SessionMessagesResult,
    snapshotEpoch: number,
    /**
     * The gate's live relevance predicate (generation + per-call `isRelevant`).
     * The branch is async — it yields on the hydration await before re-opening a
     * live stream — so it MUST re-check this after the await and bail before any
     * `attach`/dispatch, or a `reset()` (logout / team-switch) mid-await would
     * resurrect a stream in a torn-down session (R-F13 / spec §4.5-3).
     */
    stillRelevant: () => boolean
  ) => Promise<ReconcileOutcome>
  /**
   * Server reports `idle`: seed the snapshot, merge turns (replace-never-append),
   * and — when `taskIdHint` has no covering turn — fall back to the durable
   * `getTaskResult` and persist it locally (GAP-H1). Owns its FSM/persistence.
   */
  settleIdle: (
    chatKey: string,
    resp: SessionMessagesResult,
    snapshotEpoch: number,
    taskIdHint: string | undefined,
    /** Same post-await teardown guard as `attachLiveTask` (see there). */
    stillRelevant: () => boolean
  ) => Promise<ReconcileOutcome>
  /** Local eviction for a chat the server 404s (cache + sidebar + deselect). */
  evictChat: (chatKey: string) => Promise<void>
  isNetworkError: (err: unknown) => boolean
  isHttp404: (err: unknown) => boolean
  telemetry: (event: string, data: Record<string, unknown>) => void
  /** Guard: `false` aborts the reconcile mid-flight (chat switched away). */
  isStillRelevant?: (chatKey: string) => boolean
  networkRetryAttempts?: number
  networkRetryBackoffMs?: readonly number[]
}

export interface ReconcileChatArgs {
  reason: string
  /** The task this reconcile is settling — drives the idle durable fallback. */
  taskIdHint?: string
  /** Bounded page or delta request used by the authoritative transcript fetch. */
  messagesQuery?: SessionMessagesQuery
  /**
   * Per-call relevance guard (in addition to the dep-level `isStillRelevant` and
   * the `reset()` generation). A `switchToChat`-initiated reconcile passes the
   * "chat still active" predicate here so a fast A→B→A switch aborts THIS run
   * mid-fetch — WITHOUT imposing an active-chat requirement on background
   * reconciles (system:resume / bell approval on a non-visible chat), which omit
   * it and stay always-relevant. Replaces the Phase-2 AbortController.
   */
  isRelevant?: () => boolean
}

export interface ReconcileChat {
  /**
   * Resolves to the precedence-branch `ReconcileOutcome` so a loud caller (the
   * stream-loss terminal in `onTrackerTerminal`) can decide the follow-up UX —
   * the Resend banner on `fell_through_to_resend`/`error`, the progress/activity
   * repaint + FSM terminal on a settle outcome, or nothing on a rejoin (§4.3 /
   * spec-v2 Paso 2). A coalesced concurrent trigger resolves to the in-flight
   * run's outcome (single-flight); silent callers (switchToChat) just ignore it.
   */
  (chatKey: string, args: ReconcileChatArgs): Promise<ReconcileOutcome>
  /** Whether a reconcile is currently in flight for the chat (single-flight). */
  isInFlight: (chatKey: string) => boolean
  /** Invalidate and detach the current run for one chat while leaving others alone. */
  supersede: (chatKey: string) => void
  /**
   * Abort every in-flight reconcile (logout / team-switch / renderer teardown):
   * bumps a generation so any run past its next relevance check bails BEFORE its
   * side-effectful branch, and drops the coalescing map. Without this a reconcile
   * mid-backoff could resurrect a just-cleared tracker/FSM entry after
   * `releaseAll()`/`fsm.reset()` (security review, defense-in-depth).
   */
  reset: () => void
}

const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_BACKOFF_MS = [200, 400, 600] as const

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createReconcileChat(deps: ReconcileChatDeps): ReconcileChat {
  const inFlight = new Map<string, Promise<ReconcileOutcome>>()
  // The best `taskIdHint` seen for the in-flight run per chatKey. A coalesced
  // second caller (single-flight below) would otherwise silently drop its hint,
  // so a hint-less run started first could skip the idle durable `getTaskResult`
  // fallback (GAP-H1) that a later, hint-bearing caller needed. The run reads this
  // at `settleIdle` time, so a hint that arrives before the fetch resolves is
  // still honoured (M6).
  const inFlightHint = new Map<string, string | undefined>()
  const chatGenerations = new Map<string, number>()
  const attempts = deps.networkRetryAttempts ?? DEFAULT_RETRY_ATTEMPTS
  const backoff = deps.networkRetryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
  // Bumped by `reset()`; a run started under an older generation is no longer
  // relevant (its session/team was torn down).
  let generation = 0

  async function fetchWithRetry(
    agentRef: string,
    chatId: string,
    stillRelevant: () => boolean,
    query?: SessionMessagesQuery
  ): Promise<SessionMessagesResult | undefined> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!stillRelevant()) return undefined
      try {
        return await deps.loadSessionMessages(agentRef, chatId, query, stillRelevant)
      } catch (err) {
        if (!stillRelevant()) return undefined
        // Non-network (404, etc.) rethrows to the branch handler; a network blip
        // is retried with backoff up to the cap (mirrors switchToChat P2-A).
        if (!deps.isNetworkError(err) || attempt === attempts - 1) throw err
      }
      if (!stillRelevant()) return undefined
      await delay(backoff[attempt] ?? backoff[backoff.length - 1] ?? 600)
    }
    return undefined
  }

  async function run(chatKey: string, args: ReconcileChatArgs): Promise<ReconcileOutcome> {
    const startGeneration = generation
    const startChatGeneration = chatGenerations.get(chatKey) ?? 0
    const { agentRef, chatId } = parseTaskKey(chatKey)
    // Relevant only while (a) no `reset()` happened since this run began AND (b)
    // the injected chat-level guard still holds.
    const stillRelevant = () =>
      generation === startGeneration &&
      (chatGenerations.get(chatKey) ?? 0) === startChatGeneration &&
      (deps.isStillRelevant?.(chatKey) ?? true) &&
      (args.isRelevant?.() ?? true)
    // R2 anchor: the epoch at the START of the fetch, so a snapshot that a newer
    // local SEND_STARTED superseded is dropped by the reducer.
    const snapshotEpoch = deps.fsm.getState(chatKey)?.epoch ?? 0
    deps.fsm.dispatch(chatKey, { type: 'RECONCILE_STARTED' })
    let outcome: ReconcileOutcome = 'noop'
    try {
      const resp = await fetchWithRetry(agentRef, chatId, stillRelevant, args.messagesQuery)
      if (!resp) {
        outcome = 'noop'
        return outcome
      }
      if (!stillRelevant()) {
        outcome = 'stale_drop'
        return outcome
      }
      const serverLive =
        (resp.state === 'processing' || resp.state === 'awaiting_approval') && !!resp.activeTaskId
      outcome = serverLive
        ? await deps.attachLiveTask(chatKey, resp, snapshotEpoch, stillRelevant)
        : await deps.settleIdle(
            chatKey,
            resp,
            snapshotEpoch,
            // Prefer a hint a coalesced caller merged in (M6) over this run's own.
            inFlightHint.get(chatKey) ?? args.taskIdHint,
            stillRelevant
          )
      return outcome
    } catch (err) {
      if (!stillRelevant()) {
        outcome = 'stale_drop'
        return outcome
      }
      if (deps.isHttp404(err)) {
        await deps.evictChat(chatKey)
        deps.fsm.dispatch(chatKey, { type: 'RESET' })
        outcome = '404'
      } else if (deps.isNetworkError(err)) {
        deps.fsm.dispatch(chatKey, { type: 'WENT_OFFLINE' })
        outcome = 'offline'
      } else {
        // Log the message only (not the raw error object, which may echo a server
        // response body) — matching the tracker's telemetry style.
        console.error('[reconcileChat] failed', {
          chatKey,
          reason: args.reason,
          message: errMessage(err),
        })
        outcome = 'error'
      }
      return outcome
    } finally {
      // RESET already tore the entry down on 404; re-dispatching FINISHED would
      // resurrect an empty entry, so skip the finalizer in that case.
      if (
        outcome !== '404' &&
        generation === startGeneration &&
        (chatGenerations.get(chatKey) ?? 0) === startChatGeneration
      ) {
        deps.fsm.dispatch(chatKey, { type: 'RECONCILE_FINISHED' })
      }
      deps.telemetry('stream_recovery', { reason: args.reason, outcome })
    }
  }

  const reconcile = ((chatKey: string, args: ReconcileChatArgs): Promise<ReconcileOutcome> => {
    // Single-flight: coalesce a concurrent trigger onto the running promise.
    const existing = inFlight.get(chatKey)
    if (existing) {
      // Adopt a taskIdHint the in-flight run lacks so its idle durable fallback
      // (GAP-H1) still fires for this coalesced caller (M6). A run that already has
      // a hint keeps it (first concrete task wins).
      if (args.taskIdHint && !inFlightHint.get(chatKey)) {
        inFlightHint.set(chatKey, args.taskIdHint)
      }
      return existing
    }
    inFlightHint.set(chatKey, args.taskIdHint)
    const promise = run(chatKey, args).finally(() => {
      // reset() permits a fresh reconcile for the same key while this older
      // promise is still settling. Only clear the entry we actually own.
      if (inFlight.get(chatKey) === promise) {
        inFlight.delete(chatKey)
        inFlightHint.delete(chatKey)
      }
    })
    inFlight.set(chatKey, promise)
    return promise
  }) as ReconcileChat
  reconcile.isInFlight = (chatKey: string) => inFlight.has(chatKey)
  reconcile.supersede = (chatKey: string) => {
    chatGenerations.set(chatKey, (chatGenerations.get(chatKey) ?? 0) + 1)
    inFlight.delete(chatKey)
    inFlightHint.delete(chatKey)
  }
  reconcile.reset = () => {
    generation += 1
    inFlight.clear()
    inFlightHint.clear()
    chatGenerations.clear()
  }
  return reconcile
}
