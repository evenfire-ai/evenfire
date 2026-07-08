/**
 * Agent State Machine
 *
 * Manages the processing of tasks from the message queue.
 * Coordinates TaskExecutor instances for per-task execution.
 *
 * Phase 6: Approval handling, ApprovalController wiring.
 * Concurrent refactor: Delegates execution to TaskExecutor, routes
 * approvals via approvalMap keyed by requestId.
 */
import { EventEmitter } from 'events'
import { BudgetClient, deriveBudgetAttribution } from '../budget/budgetClient'
import type { BudgetVerdict } from '../budget/types'
import { config as appConfig } from '../config'
import { AdapterStaticContext, LlmPortAdapter } from '../core/adapters/llmPortAdapter'
import { ConversationManager } from '../core/conversation/conversation'
import type { ConversationStore } from '../core/conversation/conversationStore'
// Phase 6 imports
import type { ApprovalConfig } from '../core/extensions/approvalTypes'
import { PressureContextManager } from '../core/extensions/contextManager'
// Core architecture imports
import { SimpleEventEmitter } from '../core/orchestration/eventEmitter'
import { BasicSafety } from '../core/safety/safety'
// Phase 7–8 imports
import type { SessionSearchService } from '../core/sessionSearch'
import type { SpilloverStorage } from '../core/spillover'
import { createTokenCounter } from '../core/tokenizer'
import type { AgentEventType as CoreAgentEventType, PendingApproval } from '../core/types'
import type { ReapedSession } from '../db/worker/protocol'
import type { TaskLifecycle } from '../lifecycle/taskLifecycle'
import { isTerminal } from '../lifecycle/types'
import { SingleTurnProvider } from '../llm'
import type { PromptCache } from '../llm/promptCache'
import { McpManager } from '../mcp'
import { ensureReporter } from '../progress/sseProgressReporter'
import { MessageQueue, Task } from '../queue'
import type { TaskError } from '../queue/types'
import { SessionProcessor, serializeSessionKey } from '../session'
import { UsageReporter } from '../usage/usageReporter.js'
import type { ScopedWorkspaceProvider } from '../workspace/scopedWorkspace'
import { CronScheduler } from './cronScheduler'
import { TaskExecutor } from './taskExecutor'
import {
  AgentConfig,
  AgentEvent,
  AgentEventType,
  AgentState,
  AgentStats,
  DEFAULT_AGENT_CONFIG,
} from './types'

/**
 * Pending approval info exposed via /status endpoint.
 */
export interface PendingApprovalInfo {
  requestId: string
  userId: string
  toolName: string
  parameters: Record<string, unknown>
  description: string
  since: string
}

/**
 * IronClaw invariant #3 (P.3): contract for rehydrating `pending_approvals`
 * from durable storage at cold start. T2.1 ships the SQLite-backed
 * implementation; P.3 ships the no-op so the wiring is in place.
 *
 * Pre-flight rules:
 *  - approvals where `expires_at < now()` → mark `denied:expired`, notify the
 *    user via channel of origin, do NOT rehydrate.
 *  - approvals where the snapshot has spillover refs and `probe()` reports any
 *    expired → same: `denied:expired`.
 *  - the rest → rehydrate.
 *
 * MUST be awaited before SessionProcessor starts processing new messages so a
 * user retry cannot race the rehydration.
 */
export interface ColdStartLoader {
  loadPendingApprovals(now: number): Promise<RehydratedApproval[]>
  /**
   * D.2 — boot-time reap of sessions stuck in 'processing' (their reporter died
   * with the previous pod). Optional: the NoOp loader and any non-durable store
   * skip it. Returns the reaped sessions for logging / future notification.
   */
  reapProcessingSessions?(now: number): Promise<ReapedSession[]>
  /**
   * D.8 (F7) — boot-time reap of sessions stuck in 'awaiting_approval' whose
   * approval can no longer resolve (all expired, or orphaned). Optional, same
   * contract as reapProcessingSessions. Runs before approval rehydration.
   */
  reapExpiredAwaitingApprovalSessions?(now: number): Promise<ReapedSession[]>
  /**
   * S1 — boot-time reap of EVERY 'awaiting_approval' session (live or expired).
   * No such session is resumable after a restart (executor rehydration was never
   * implemented), so the boot path reaps them all to 'idle' with a synthetic
   * APPROVAL_INTERRUPTED_BY_RESTART message (spec decision #4). Optional, same
   * contract as reapProcessingSessions; runs before approval rehydration.
   */
  reapAwaitingApprovalSessions?(now: number): Promise<ReapedSession[]>
}

export interface RehydratedApproval {
  request_id: string
  task_id: string
  approval: PendingApproval
  /**
   * Optional snapshot of the originating message — used by T2.1 to re-route
   * notifications when the cold-start sweep marks an approval as expired.
   * P.3 doesn't act on this field (NoOp loader returns []).
   */
  source_message?: Record<string, unknown>
}

/**
 * Default no-op loader: returns []. Replaced by T2.1's
 * `SqliteColdStartLoader`. With this default the bootstrap is effectively a
 * no-op and main.ts can safely skip awaiting it during P.3.
 */
export class NoOpColdStartLoader implements ColdStartLoader {
  async loadPendingApprovals(): Promise<RehydratedApproval[]> {
    return []
  }
}

/**
 * Agent State Machine for task processing.
 */
export class AgentStateMachine extends EventEmitter {
  private state: AgentState = 'idle'
  private queue: MessageQueue
  private llmProvider: SingleTurnProvider | null = null
  private mcpManager: McpManager | null = null
  private sessionProcessor: SessionProcessor | null = null
  private cronScheduler: CronScheduler | null = null
  private config: AgentConfig

  // Start time for uptime calculation
  private startedAt: Date

  // Per-task execution (managed via executor map)
  private activeExecutors = new Map<string, TaskExecutor>()
  private approvalMap = new Map<
    string,
    { taskId: string; timerId?: ReturnType<typeof setTimeout>; registeredAt: Date }
  >()
  // T1.1 — sessionKeys with an in-flight operator-triggered compaction.
  // Serializes overlapping `compactSession()` calls for the same session so
  // they don't race on shared `Conversation` state (compactionState, daily
  // log writes) across the LLM await.
  private compactionsInFlight = new Set<string>()
  // B5 — durable `clearPendingApproval` retry queue. The cancel-during-approval
  // path used to fire-and-forget the SQLite delete; a transient worker
  // failure left an orphan pending_approval row that cold-start would
  // resurrect with no source task. The retry queue + bounded backoff makes
  // the durable write best-effort with eventual consistency. Layer 2 (the
  // B7 TTL filter in `SqliteColdStartLoader`) is the safety net for rows
  // we ultimately give up on.
  private clearPendingApprovalRetries = new Map<string, { attempts: number; nextTry: number }>()
  private clearRetryTimer: ReturnType<typeof setInterval> | null = null
  private isRunning: boolean = false

  // Core infrastructure
  private conversationManager = new ConversationManager()
  private modelName: string = 'unknown'

  // Persistent core event emitter (Gap 3 resolution: bridges agent-level events to SimpleEventEmitter)
  private coreEvents = new SimpleEventEmitter()

  // Phase 6: Approval
  private approvalConfig: ApprovalConfig | undefined

  // Phase 7–8: Workspace memory & personalization
  private workspaceProvider: ScopedWorkspaceProvider | undefined

  // T1.5 — Tool-result spillover store. Undefined when the feature flag is
  // off; populated from main.ts and propagated into each TaskExecutor.
  private spilloverStorage: SpilloverStorage | undefined

  // T2.2 — Process-wide PromptCache. Undefined when the prompt-cache flag
  // is OFF; populated from main.ts and forwarded into each TaskExecutor.
  private promptCache: PromptCache | undefined

  // T3.1 — Session search backend. Undefined when SQLite store is OFF or the
  // feature flag `CLERUM_SESSION_SEARCH_ENABLED` is false; populated from
  // main.ts and forwarded into each TaskExecutor.
  private sessionSearchService: SessionSearchService | undefined

  // ConfigStore snapshot getter, merged into shell-tool spawn env
  private dynamicEnvProvider: (() => Record<string, string>) | undefined

  // ConfigStore secret entries getter, used by output sanitizer
  private secretEntriesProvider: (() => Array<{ name: string; value: string }>) | undefined

  // LLM usage tracking — see docs/plans/llm-token-usage-tracking-*.md
  private usageReporter: UsageReporter | undefined
  private usageStaticContext: AdapterStaticContext | undefined

  // P1 token budgets — pre-task budget check. Both undefined unless
  // `CLERUM_BUDGETS_ENABLED` is on and main.ts wired them (needs runtime auth).
  private budgetClient: BudgetClient | undefined
  private getHostBudgetContext:
    | (() => {
        host_ref: string
        context_ref: string | null
        llm_secret_name: string | null
      } | null)
    | undefined

  // P2b token budgets (§5.4) — task ids whose check created a danger-zone
  // reservation in control-api (verdict carried non-empty `reservationIds`),
  // mapped to the EXACT `host_ref` that check sent. The terminal-release
  // subscriber drops the reservation early for exactly these tasks, replaying
  // the stored host_ref so control-api's claim-binding + host-scoping matches
  // the reservation (§control-api /release). The common far-from-limit task
  // makes no reservation and is never added, so no needless release call is
  // issued. Always empty when the budgets flag is off (checkTaskBudget no-ops
  // before populating it).
  private tasksWithBudgetReservation = new Map<string, string>()

  // Phase A.6: TaskLifecycle dual-write
  private lifecycle: TaskLifecycle

  // P.3 IronClaw invariant #3: cold-start loader for pending_approvals.
  // Defaults to NoOp; T2.1 swaps in the SqliteColdStartLoader.
  private coldStartLoader: ColdStartLoader = new NoOpColdStartLoader()

  constructor(queue: MessageQueue, lifecycle: TaskLifecycle, config: Partial<AgentConfig> = {}) {
    super()
    this.queue = queue
    this.lifecycle = lifecycle
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config }
    this.startedAt = new Date()

    // Subscribe to TaskLifecycle cancel transitions (spec §4.4)
    this.subscribeLifecycle()
    // P2b token budgets (§5.4) — release danger-zone reservations on terminal.
    this.subscribeBudgetReleaseOnTerminal()
  }

  /**
   * Set the LLM provider.
   */
  setLLMProvider(provider: SingleTurnProvider, modelName?: string): void {
    this.llmProvider = provider
    if (modelName) {
      this.modelName = modelName
    }
    console.log('[Agent] LLM provider set')
  }

  /**
   * Set the MCP manager.
   */
  setMcpManager(manager: McpManager): void {
    this.mcpManager = manager
    console.log('[Agent] MCP manager set')
  }

  /**
   * Set the session processor for concurrent session-based dispatch.
   */
  setSessionProcessor(processor: SessionProcessor): void {
    this.sessionProcessor = processor
    console.log('[Agent] Session processor set')
  }

  /**
   * Set the cron scheduler for scheduled task management.
   */
  setCronScheduler(scheduler: CronScheduler): void {
    this.cronScheduler = scheduler
    console.log('[Agent] Cron scheduler set')
  }

  /**
   * Phase 7–8: Set the workspace service for persistent memory and personalization.
   */
  setWorkspaceProvider(provider: ScopedWorkspaceProvider): void {
    this.workspaceProvider = provider
    console.log('[Agent] Workspace provider set')
  }

  /**
   * T1.5 — Inject the spillover storage so each TaskExecutor can persist
   * oversized tool outputs and register the `clerum__spillover_read` tool.
   * Optional; when omitted the agent behaves bit-identical to pre-T1.5.
   */
  setSpilloverStorage(storage: SpilloverStorage | undefined): void {
    this.spilloverStorage = storage
    console.log(`[Agent] Spillover storage ${storage ? 'set' : 'cleared'}`)
  }

  /**
   * T2.2 — Inject the process-wide PromptCache. Called from `main.ts` after
   * the conversation store + workspace service exist. The cache hooks
   * `conversationStore.onEvict` to drop entries when sessions leave the LRU.
   */
  setPromptCache(cache: PromptCache | undefined): void {
    this.promptCache = cache
    console.log(`[Agent] Prompt cache ${cache ? 'set' : 'cleared'}`)
  }

  /**
   * T3.1 — Inject the session search backend. When set together with a
   * `sourceMessage`, each TaskExecutor registers `clerum__session_search`.
   * Optional; when omitted the tool is not exposed (no degraded mode — the
   * caller simply does not see it in the registry).
   */
  setSessionSearchService(service: SessionSearchService | undefined): void {
    this.sessionSearchService = service
    console.log(`[Agent] Session search service ${service ? 'set' : 'cleared'}`)
  }

  /**
   * Inject the ConfigStore snapshot getter so shell-tool subprocesses
   * see operator-managed env vars (per-Host CM/Secret + LLM key).
   */
  setDynamicEnvProvider(provider: () => Record<string, string>): void {
    this.dynamicEnvProvider = provider
    console.log('[Agent] Dynamic env provider set')
  }

  /**
   * Inject the ConfigStore secret-entries getter so the output sanitizer
   * can redact ConfigStore-managed secret values from tool stdout.
   */
  setSecretEntriesProvider(provider: () => Array<{ name: string; value: string }>): void {
    this.secretEntriesProvider = provider
    console.log('[Agent] Secret entries provider set')
  }

  /**
   * Inject the LLM usage reporter and the host's static attribution
   * context. Both must be set together; either being undefined disables
   * usage capture for this agent.
   */
  setUsageReporter(reporter: UsageReporter, staticContext: AdapterStaticContext): void {
    this.usageReporter = reporter
    this.usageStaticContext = staticContext
    console.log('[Agent] Usage reporter set')
  }

  /**
   * P1 token budgets (§5.1) — inject the BudgetClient and a lazy getter for the
   * host attribution fields. `getHostContext` reads `currentHost` (a main.ts
   * global, NOT an AgentStateMachine member) at call time so Host CRD updates
   * are reflected. Only wired when `CLERUM_BUDGETS_ENABLED` is on.
   */
  setBudgetCheck(
    client: BudgetClient,
    getHostContext: () => {
      host_ref: string
      context_ref: string | null
      llm_secret_name: string | null
    } | null
  ): void {
    this.budgetClient = client
    this.getHostBudgetContext = getHostContext
    console.log('[Agent] Budget check wired')
  }

  /**
   * P1 token budgets (§5.1) — one-shot pre-task budget check. Builds the
   * control-api request from the host context (host_ref/context_ref/
   * llm_secret_name), the active provider/model, and the per-task attribution
   * derived from the Task (source_kind/user_id/team_id/cron_job_id).
   *
   * No-op `{allowed:true}` (no network) when the budgets flag is off or the
   * client/host context is not wired. Delegates fail-open semantics to
   * `BudgetClient.check` — this method itself never throws on a transport error.
   */
  async checkTaskBudget(task: Task): Promise<BudgetVerdict> {
    if (!appConfig.budgetsEnabled || !this.budgetClient || !this.getHostBudgetContext) {
      return { allowed: true }
    }
    const hostCtx = this.getHostBudgetContext()
    if (!hostCtx || !this.llmProvider) {
      return { allowed: true }
    }
    const attribution = deriveBudgetAttribution(task)
    const verdict = await this.budgetClient.check({
      host_ref: hostCtx.host_ref,
      context_ref: hostCtx.context_ref,
      llm_secret_name: hostCtx.llm_secret_name,
      provider: this.llmProvider.getProviderType(),
      model: this.modelName,
      source_kind: attribution.source_kind,
      user_id: attribution.user_id,
      team_id: attribution.team_id,
      recipe_name: attribution.recipe_name,
      cron_job_id: attribution.cron_job_id,
      // P2b (§5.4) — stable correlation so control-api can attach any
      // danger-zone reservation to this task; `task.id` is stable for its life.
      task_ref: task.id,
    })
    // P2b (§5.4) — remember tasks that carry a reservation so the terminal
    // subscriber only issues a release for them. We key on reservationIds (not
    // `allowed`): control-api self-releases reservations when it denies, so a
    // denied verdict normally arrives with reservationIds=[] and is not tracked;
    // tracking on the field stays correct even if a stray reservation survives.
    if (verdict.reservationIds && verdict.reservationIds.length > 0) {
      // Store the SAME host_ref the check used so the early release replays it
      // verbatim (control-api binds the release to it and only drops matching
      // reservations); the value is the per-instance host identity.
      this.tasksWithBudgetReservation.set(task.id, hostCtx.host_ref)
    }
    return verdict
  }

  /**
   * P1 token budgets (§5.3) — deliver a budget-denied verdict to the user
   * through the SAME canonical failure path as any task error: responseCallback
   * (channel / sync-POST / polling) + queue.failTask → lifecycle 'failed' (SSE
   * terminal + queue 'task:failed' listener cleanup) + the agent 'task:failed'
   * activity event. `reason` is the machine reason from control-api; the user
   * sees the friendly message below.
   */
  handleBudgetDenied(task: Task, reason?: string): void {
    console.warn(`[Agent] Task ${task.id} denied by budget: ${reason ?? 'budget_exceeded'}`)
    this.handleTaskFailure(task, {
      code: 'BUDGET_EXCEEDED',
      message: "This period's consumption budget has been reached. Please try again later.",
      // Not retryable: the period spend will not have changed on an immediate
      // retry, so it would just be denied again until the budget resets.
      retryable: false,
      provider: this.llmProvider?.getProviderType() ?? 'unknown',
    })
  }

  /**
   * P2b token budgets (§5.4) — early reservation release.
   *
   * Subscribes to the SINGLE canonical terminal sink: every task — completed,
   * failed, cancelled, brake-tripped, or shutdown-drained — ends with a
   * `lifecycle.transition` to a terminal state (queue.completeTask → 'completed',
   * queue.failTask → 'failed', cancel/drain → 'cancelled'). Hooking the terminal
   * transition therefore covers ALL branches uniformly, including the
   * cancel-during-approval and brake paths that never reach the executor's
   * onComplete/onFail callbacks.
   *
   * For tasks that carried a danger-zone reservation, it tells control-api to
   * drop the reservation NOW instead of waiting for the TTL. Best-effort and
   * fire-and-forget: it is never awaited on the terminal path, so it cannot
   * delay the user's response, and `BudgetClient.release` is itself fail-open —
   * a lost release just lets the reservation expire by TTL (§0.2). No-op when
   * the budgets flag is off (the tracking map stays empty).
   */
  private subscribeBudgetReleaseOnTerminal(): void {
    this.lifecycle.on('transition', ev => {
      if (!isTerminal(ev.to)) return
      // Atomic check-and-remove: only release tasks we recorded a reservation
      // for, and only once even if a terminal transition somehow re-fires. The
      // stored value is the host_ref the check used, replayed on the release so
      // control-api's claim-binding + host-scoping matches the reservation.
      const hostRef = this.tasksWithBudgetReservation.get(ev.taskId)
      if (hostRef === undefined) return
      this.tasksWithBudgetReservation.delete(ev.taskId)
      if (!this.budgetClient) return
      // Fire-and-forget — NOT awaited. release() never throws (fail-open), but
      // guard defensively so a rejected promise never becomes an unhandled one.
      this.budgetClient.release({ task_ref: ev.taskId, host_ref: hostRef }).catch(() => undefined)
    })
  }

  /**
   * Phase 6: Set the approval configuration (from Host CRD or dev env).
   */
  setApprovalConfig(config: ApprovalConfig | undefined): void {
    this.approvalConfig = config
    console.log('[Agent] Approval config set:', config?.defaultPolicy || 'none')
  }

  /**
   * P.3 IronClaw invariant #3: install a cold-start loader. T2.1 calls this
   * with the SqliteColdStartLoader; tests can inject a fake.
   */
  setColdStartLoader(loader: ColdStartLoader): void {
    this.coldStartLoader = loader
    console.log('[Agent] Cold-start loader set')
  }

  /**
   * T2.1: inject a custom `ConversationStore` (typically the SQLite-backed
   * implementation built by `createConversationStore`). Must be called BEFORE
   * `agent.bootstrap()` so the cold-start loader sees the durable store.
   * Default is the in-memory store created in the ConversationManager
   * constructor.
   */
  setConversationStore(store: ConversationStore): void {
    this.conversationManager.setStore(store)
    console.log('[Agent] Conversation store set')
  }

  /**
   * P.3 IronClaw invariant #3: rehydrate `pending_approvals` from durable
   * storage before any new messages are processed. Idempotent and safe to
   * skip when the loader is the NoOp default (the case during P.3).
   *
   * MUST be awaited in main.ts before `start()` once T2.1 wires the real
   * SqliteColdStartLoader, otherwise a user retry could race the rehydration
   * and create duplicate approvals.
   */
  async bootstrap(): Promise<void> {
    const now = Date.now()

    // D.2 PHASE 1 — reap sessions stuck in 'processing' (their reporter died
    // with the previous pod) BEFORE accepting traffic. Idempotent; runs before
    // approval rehydration so a session left in processing+pending isn't both
    // reaped and rehydrated (disjoint sets: reap touches state='processing',
    // approvals touch state='awaiting_approval'). Order is for clean logs.
    if (typeof this.coldStartLoader.reapProcessingSessions === 'function') {
      try {
        const reaped = await this.coldStartLoader.reapProcessingSessions(now)
        if (reaped.length > 0) {
          console.log(`[Agent] Reaped ${reaped.length} processing session(s) on boot`)
        }
      } catch (err) {
        // A reap failure must not block boot; pending approvals still rehydrate.
        console.error('[Agent] Processing reaper failed on boot:', err)
      }
    }

    // S1 PHASE 1b — reap ALL sessions stuck in 'awaiting_approval' (live or
    // expired). Until executor resume exists, a restart-interrupted approval is
    // un-resumable: handleApproval finds an empty activeExecutors post-restart and
    // returns "Task is no longer awaiting approval" WITHOUT transitioning the
    // session, leaving the chat stuck on "Connecting" indefinitely. So per spec
    // decision #4 ("pod restart = reap, not auto-resume") we reap every
    // awaiting_approval session to 'idle' + a synthetic interruption message,
    // making the chat immediately usable (the desktop offers Resend). MUST run
    // before PHASE 2: the reaper deletes the stale pending_approvals rows in the
    // same transaction as the state flip, so loadPendingApprovals below has
    // nothing left to stamp.
    if (typeof this.coldStartLoader.reapAwaitingApprovalSessions === 'function') {
      try {
        const reaped = await this.coldStartLoader.reapAwaitingApprovalSessions(now)
        if (reaped.length > 0) {
          console.log(
            `[Agent] Reaped ${reaped.length} awaiting-approval session(s) on boot (restart-interrupted)`
          )
        }
      } catch (err) {
        // Non-blocking, same as PHASE 1: a reap failure must not stall boot.
        console.error('[Agent] Awaiting-approval reaper failed on boot:', err)
      }
    }

    // PHASE 2 / P.3 — load pending approvals. After the PHASE 1b reap there should
    // be nothing left to rehydrate (every awaiting_approval row was deleted with
    // its session's state flip). We still call it to surface any TTL/spillover
    // notifications the loader emits and to keep the contract stable for when
    // executor resume eventually lands. We do NOT stamp approvalMap: a stamped
    // entry with no executor is exactly the S1 bug (handleApproval would hit an
    // empty activeExecutors and dead-end), and the session is already reaped.
    const rehydrated = await this.coldStartLoader.loadPendingApprovals(now)
    if (rehydrated.length > 0) {
      console.warn(
        `[Agent] loadPendingApprovals returned ${rehydrated.length} approval(s) after the awaiting-approval reap; not stamping (un-resumable until executor resume exists)`
      )
    }
  }

  /**
   * Phase 6: Public accessor for the conversation manager.
   */
  getConversationManager(): ConversationManager {
    return this.conversationManager
  }

  /**
   * Gap 3 resolution: Public accessor for the core SimpleEventEmitter.
   *
   * This emitter carries ALL 12 AgentEventType events through the typed
   * SimpleEventEmitter (core layer), bridging agent-level events that
   * previously only flowed through the Node.js EventEmitter.
   */
  getCoreEvents(): SimpleEventEmitter {
    return this.coreEvents
  }

  /**
   * T1.1 — operator-triggered compaction (`POST /v1/runtime/compact`).
   *
   * The endpoint reaches the agent through this method; it constructs a
   * one-shot `PressureContextManager` using the same deps that
   * `TaskExecutor.buildLoopConfig` wires for in-loop compaction, runs
   * `manage()` with `forceTier: 'summarize'`, and emits the same
   * `context:compacted` event the in-loop path emits (P1-002 unified bus).
   *
   * Pre-flight:
   *  - 404 when the session does not exist.
   *  - 409 when `pending_approval !== undefined` (IronClaw invariant #1).
   *  - 409 when an executor is actively driving this session (it owns the
   *    snapshot — racing a manual compaction would cause a torn write).
   *
   * `_previousSummary` does NOT persist across calls in T1.1: every endpoint
   * invocation builds a fresh manager. T2.1 (SQLite store) is what makes
   * delta-patch survive cross-call (§18.4 of the plan). Today's
   * compactSession() always produces a full re-summary.
   */
  async compactSession(opts: {
    sessionKey: string
    focus?: string
    useMainLlm?: boolean
  }): Promise<
    | { kind: 'ok'; before: number; after: number; focus: string | null }
    | { kind: 'not_found' }
    | { kind: 'pending_approval' }
    | { kind: 'session_busy' }
    | { kind: 'error'; message: string }
  > {
    const conv = this.conversationManager.getSessionByKey(opts.sessionKey)
    if (!conv) {
      return { kind: 'not_found' }
    }
    if (conv.pending_approval !== undefined) {
      return { kind: 'pending_approval' }
    }
    // Refuse if any active executor owns this session — the executor's
    // PressureContextManager is the source of truth while it's running.
    for (const exec of this.activeExecutors.values()) {
      if (exec.sessionKey === opts.sessionKey) {
        return { kind: 'session_busy' }
      }
    }
    // Refuse if another operator-triggered compaction is already in flight
    // for this session. Without this, two overlapping `POST /v1/runtime/compact`
    // calls would both pass the executor check, then race on
    // `conv.compactionState` and on the daily-log append across the LLM await.
    if (this.compactionsInFlight.has(opts.sessionKey)) {
      return { kind: 'session_busy' }
    }

    if (!this.llmProvider) {
      return { kind: 'error', message: 'LLM provider not initialized' }
    }

    this.compactionsInFlight.add(opts.sessionKey)
    try {
      const tokenCounter = createTokenCounter(this.llmProvider, this.modelName, {
        offline: appConfig.tokenizerOffline,
      })
      const llmPort = new LlmPortAdapter(
        this.llmProvider,
        this.modelName,
        this.llmProvider.getProviderType(),
        this.usageReporter,
        this.usageStaticContext,
        undefined,
        tokenCounter,
        // Operator-triggered /compact still spends LLM tokens on this session —
        // count them toward the session's lifetime totals (crit #2).
        usage => this.conversationManager.recordSessionUsage(conv, usage)
      )
      const manager = new PressureContextManager(
        appConfig.contextMaxTokens,
        this.workspaceProvider?.forSessionKey(opts.sessionKey),
        llmPort,
        tokenCounter,
        {
          dryRun: appConfig.tokenizerDryrun,
          structuredSummaryEnabled: appConfig.compactionStructuredSummary,
          events: this.coreEvents,
        }
      )

      const messagesBefore = this.conversationManager.buildMessageHistory(conv)
      const messagesAfter = await manager.manage(messagesBefore, conv, {
        focus: opts.focus,
        forceTier: 'summarize',
        useMainLlm: opts.useMainLlm,
      })

      // P1-002 — unified `context:compacted` event so T2.2 (prompt cache
      // invalidation) doesn't need to distinguish manual vs. in-loop
      // compactions. The in-loop emitter lives in `toolUseLoop.ts:103,298`.
      this.coreEvents.emit({
        type: 'context:compacted',
        data: {
          conversationId: conv.id,
          sessionKey: opts.sessionKey,
          triggeredBy: 'operator',
          focus: opts.focus ?? null,
          before: messagesBefore.length,
          after: messagesAfter.length,
        },
        timestamp: new Date(),
      })

      return {
        kind: 'ok',
        before: messagesBefore.length,
        after: messagesAfter.length,
        focus: opts.focus ?? null,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Agent] compactSession failed:', err)
      return { kind: 'error', message }
    } finally {
      this.compactionsInFlight.delete(opts.sessionKey)
    }
  }

  /**
   * Phase 6: Get pending approvals for the /status endpoint.
   * Collects from all active executors in waiting_approval state.
   */
  getPendingApprovals(): PendingApprovalInfo[] {
    const approvals: PendingApprovalInfo[] = []
    for (const executor of this.activeExecutors.values()) {
      if (executor.executorState === 'waiting_approval' && executor.pendingApproval) {
        const msg = executor.sourceTask.sourceMessage
        const entry = this.approvalMap.get(executor.pendingApproval.request_id)
        approvals.push({
          requestId: executor.pendingApproval.request_id,
          userId: msg?.sender || 'anonymous',
          toolName: executor.pendingApproval.tool_name,
          parameters: executor.pendingApproval.parameters,
          description: executor.pendingApproval.description,
          since: entry?.registeredAt?.toISOString() ?? new Date().toISOString(),
        })
      }
    }
    return approvals
  }

  /**
   * Register an approval request with timeout timer.
   * Called from TaskExecutor's onApprovalNeeded callback.
   */
  private registerApproval(
    requestId: string,
    taskId: string,
    task: Task,
    approval: PendingApproval
  ): void {
    // Start timeout timer
    let timerId: ReturnType<typeof setTimeout> | undefined
    if (this.config.approvalTimeout > 0) {
      timerId = setTimeout(() => {
        this.handleApprovalTimeout(requestId)
      }, this.config.approvalTimeout)
    }

    this.approvalMap.set(requestId, {
      taskId,
      timerId,
      registeredAt: new Date(),
    })

    // Build notification and emit event
    const msg = task.sourceMessage
    const userId = msg?.sender || 'anonymous'
    const notificationMsg = this.buildApprovalNotification(approval, userId, msg?.channelType)
    console.log(`[Agent] Tool ${approval.tool_name} needs approval. ${notificationMsg}`)
    this.emitEvent('tool:approval_needed', {
      taskId,
      toolName: approval.tool_name,
      requestId: approval.request_id,
      userId,
      notification: notificationMsg,
    })
  }

  /**
   * Handle approval timeout: auto-deny the executor and clean up.
   */
  private handleApprovalTimeout(requestId: string): void {
    const entry = this.approvalMap.get(requestId)
    if (!entry) return

    const executor = this.activeExecutors.get(entry.taskId)
    if (!executor || executor.executorState !== 'waiting_approval') return

    console.warn(`[Agent] Approval timeout for request ${requestId}. Auto-denying.`)

    // Clean up coordinator state FIRST so transition subscribers always observe
    // consistent state (PR-193 review #2). EventEmitter.emit() is synchronous;
    // current subscribers filter ev.to !== 'cancelled' and early-exit, but a
    // future subscriber reading approvalMap/activeExecutors on a non-cancel
    // terminal would see stale entries.
    this.approvalMap.delete(requestId)
    this.activeExecutors.delete(entry.taskId)
    this.releaseSessionForTask(executor.sourceTask)

    // Now fire the lifecycle transition. Subscribers see clean coordinator state.
    // Distinguishes timeout-triggered denial from user-triggered denial in the
    // audit trail (PR-186 review M6). Subsequent transitions from executor.deny()'s
    // downstream queue.completeTask become AlreadyTerminal no-ops.
    this.lifecycle.transition(entry.taskId, 'completed', 'approval_timeout')

    // deny() propagates denialMessage via responseCallback. Downstream
    // queue.completeTask → lifecycle.transition('completed', 'natural') is
    // AlreadyTerminal no-op. onComplete's activeExecutors.delete is a no-op
    // (already deleted above).
    //
    // T2.1: deny() is now async (sync write-through to delete pending_approval
    // before the channel notification fires). Fire-and-forget here so the
    // timeout handler returns promptly; errors are logged. Wrap in
    // Promise.resolve so legacy synchronous test doubles (which return void)
    // still flow through the same path.
    Promise.resolve(executor.deny()).catch(err => {
      console.error(`[Agent] executor.deny() raised after timeout:`, err)
    })
  }

  /**
   * Phase 6: Handle an approval decision.
   * Looks up by requestId -> approvalMap -> activeExecutors.
   */
  async handleApproval(
    userId: string,
    requestId: string,
    alwaysApprove: boolean,
    channelType?: string,
    channelId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const entry = this.approvalMap.get(requestId)
    if (!entry) {
      return { success: false, error: `No pending approval for request ${requestId}` }
    }

    const executor = this.activeExecutors.get(entry.taskId)
    if (!executor || executor.executorState !== 'waiting_approval') {
      this.approvalMap.delete(requestId)
      return { success: false, error: 'Task is no longer awaiting approval' }
    }

    // Clear timeout
    if (entry.timerId) clearTimeout(entry.timerId)
    this.approvalMap.delete(requestId)

    // Emit approval granted event via emitEvent so it reaches BOTH the Node
    // EventEmitter (where messageHandler.onApprovalConsumed subscribes to
    // clear pendingTaskResults) AND coreEvents (where eventWiring subscribes
    // to publish activity). Direct coreEvents.emit bypassed the Node EE, so
    // PR #291's cache-clear listener never fired in production.
    const toolName = executor.pendingApproval?.tool_name || 'unknown'
    this.emitEvent('tool:approval_granted', {
      toolName,
      requestId,
      userId,
      alwaysApprove,
      taskId: entry.taskId,
    })

    // Resume execution (fire and forget).
    // Session release happens in onComplete/onFail callbacks.
    executor.resumeAfterApproval(alwaysApprove).catch(err => {
      console.error(`[Agent] Resume after approval failed:`, err)
    })

    return { success: true }
  }

  /**
   * Phase 6: Handle a denial decision.
   * Looks up by requestId -> approvalMap -> activeExecutors.
   */
  async handleDenial(
    userId: string,
    requestId: string,
    channelType?: string,
    channelId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const entry = this.approvalMap.get(requestId)
    if (!entry) {
      return { success: false, error: `No pending approval for request ${requestId}` }
    }

    const executor = this.activeExecutors.get(entry.taskId)
    if (!executor || executor.executorState !== 'waiting_approval') {
      this.approvalMap.delete(requestId)
      return { success: false, error: 'Task is no longer awaiting approval' }
    }

    // Clear timeout
    if (entry.timerId) clearTimeout(entry.timerId)
    this.approvalMap.delete(requestId)

    const toolName = executor.pendingApproval?.tool_name || 'unknown'
    this.emitEvent('tool:approval_denied', {
      toolName,
      requestId,
      userId,
      taskId: entry.taskId,
    })

    // T2.1: deny() is now async. We await so the HTTP 200 only returns once
    // the durable pending_approval row is gone (IronClaw write-through). A
    // future restart cannot resurrect a phantom approval. Promise.resolve()
    // wraps legacy synchronous test doubles.
    try {
      await Promise.resolve(executor.deny())
    } catch (err) {
      console.error(`[Agent] executor.deny() failed:`, err)
    }
    this.activeExecutors.delete(entry.taskId)
    this.releaseSessionForTask(executor.sourceTask)

    return { success: true }
  }

  /**
   * Start the agent (begin processing tasks).
   */
  start(): void {
    if (this.isRunning) {
      console.log('[Agent] Already running')
      return
    }

    console.log('[Agent] Starting agent')
    this.isRunning = true
    // B5 — start the clear-pending-approval retry drain. Every 30s we try
    // every entry whose `nextTry` has passed. The interval is `.unref()`'d
    // so it doesn't keep the process alive on its own.
    if (this.clearRetryTimer === null) {
      this.clearRetryTimer = setInterval(() => {
        this.drainClearPendingApprovalRetries()
      }, 30_000)
      this.clearRetryTimer.unref()
    }
    this.setState('idle')
  }

  /**
   * Stop the agent (finish current tasks, then stop).
   */
  async stop(): Promise<void> {
    console.log('[Agent] Stopping agent')
    this.isRunning = false

    // B5 — stop the clear-pending-approval retry drain. Anything still in
    // the map will be re-loaded on next boot by `loadAllPendingApprovals`
    // (and filtered by the B7 TTL guard if too old).
    if (this.clearRetryTimer !== null) {
      clearInterval(this.clearRetryTimer)
      this.clearRetryTimer = null
    }

    // Shutdown drain — transition every non-terminal task to cancelled with
    // reason='system_shutdown' (spec §5.7). This fires the same subscribers
    // as a user cancel: executor.abort() for processing tasks, approval cleanup
    // for waiting_approval, SSE emission for clients.
    const drained = this.lifecycle.drainNonTerminal()
    if (drained > 0) {
      console.log(`[Agent] Shutdown drain cancelled ${drained} non-terminal tasks`)
    }

    // Clear all approval timers (drain already cleared the approvalMap entries
    // for waiting_approval tasks; this is a defensive sweep for any residuals)
    for (const [_requestId, entry] of this.approvalMap) {
      if (entry.timerId) clearTimeout(entry.timerId)
    }
    this.approvalMap.clear()

    // Await active executors with a bounded grace period (spec §5.7)
    if (this.activeExecutors.size > 0) {
      const gracePeriodMs = 10_000
      await Promise.race([
        Promise.all(Array.from(this.activeExecutors.values()).map(e => e.waitForCompletion())),
        new Promise(r => setTimeout(r, gracePeriodMs)),
      ])
    }

    this.setState('idle')
  }

  /**
   * Pause the agent (stop processing new tasks).
   */
  pause(): void {
    console.log('[Agent] Pausing agent')
    this.isRunning = false
    this.setState('paused')
  }

  /**
   * Resume the agent.
   */
  resume(): void {
    console.log('[Agent] Resuming agent')
    this.isRunning = true
    this.setState('idle')
  }

  /**
   * Get current agent state.
   * Aggregate: priority waiting_approval > processing > idle.
   */
  getState(): AgentState {
    if (!this.isRunning) return this.state // respect paused/error
    for (const exec of this.activeExecutors.values()) {
      if (exec.executorState === 'waiting_approval') return 'waiting_approval'
    }
    if (this.activeExecutors.size > 0) return 'processing'
    return this.state
  }

  /**
   * Get agent statistics. Derived from TaskLifecycle for accuracy.
   * Legacy fields totalToolCalls and lastTaskCompletedAt return stub values
   * for wire-compat — they were removed in Phase E.
   */
  getStats(): AgentStats {
    const lifecycleStats = this.lifecycle.getStats()
    return {
      state: this.getState(),
      currentTaskId:
        this.activeExecutors.size > 0 ? (this.activeExecutors.keys().next().value ?? null) : null,
      tasksProcessed: lifecycleStats.completed + lifecycleStats.failed + lifecycleStats.cancelled,
      tasksSucceeded: lifecycleStats.completed,
      tasksFailed: lifecycleStats.failed,
      totalToolCalls: 0, // removed in Phase E — deprecated field; return 0 for wire-compat
      uptime: Date.now() - this.startedAt.getTime(),
      lastTaskCompletedAt: null, // removed in Phase E — deprecated; returns null
    }
  }

  /**
   * Execute a single task by delegating to a TaskExecutor.
   * Creates executor, registers callbacks, and awaits run().
   * Returns true if the task is suspended (awaiting approval), false otherwise.
   */
  public async executeTask(task: Task): Promise<boolean> {
    console.log(`[Agent] Dispatching task ${task.id} to executor`)

    if (!this.llmProvider) {
      this.handleTaskFailure(task, {
        code: 'LLM_API_CALL_FAILED',
        message: 'LLM provider not initialized',
        retryable: false,
        provider: 'unknown',
      })
      return false
    }

    const executor = new TaskExecutor(task, {
      conversationManager: this.conversationManager,
      llmProvider: this.llmProvider,
      mcpManager: this.mcpManager,
      workspaceService: this.workspaceProvider?.forSource(task.sourceMessage),
      config: this.config,
      modelName: this.modelName,
      approvalConfig: this.approvalConfig,
      coreEvents: this.coreEvents,
      cronScheduler: this.cronScheduler,
      taskLifecycle: this.lifecycle,
      dynamicEnvProvider: this.dynamicEnvProvider,
      secretEntriesProvider: this.secretEntriesProvider,
      usageReporter: this.usageReporter,
      usageStaticContext: this.usageStaticContext,
      spilloverStorage: this.spilloverStorage,
      promptCache: this.promptCache,
      sessionSearchService: this.sessionSearchService,
      onApprovalNeeded: (requestId, taskId, approval) => {
        this.registerApproval(requestId, taskId, task, approval)
      },
      onComplete: t => {
        this.activeExecutors.delete(t.id)
        this.releaseSessionForTask(t)
        this.queue.completeTask(t)
        this.emitEvent('task:completed', { task: t })
      },
      onFail: (t: Task, error: TaskError) => {
        this.activeExecutors.delete(t.id)
        this.releaseSessionForTask(t)
        this.handleTaskFailure(t, error)
      },
    })

    this.activeExecutors.set(task.id, executor)

    try {
      await executor.run()
    } finally {
      // Remove if completed/failed but NOT if waiting_approval
      if (executor.executorState !== 'waiting_approval') {
        this.activeExecutors.delete(task.id)
      }
    }

    return executor.executorState === 'waiting_approval'
  }

  /**
   * Phase 6: Build a human-readable approval notification message.
   */
  private buildApprovalNotification(
    approval: PendingApproval,
    _userId: string,
    channelType?: string
  ): string {
    const workflowName =
      approval.tool_name === 'workflow_trigger' && typeof approval.parameters.name === 'string'
        ? approval.parameters.name.trim()
        : ''

    const paramSummary =
      Object.keys(approval.parameters).length > 0
        ? JSON.stringify(approval.parameters).substring(0, 200)
        : 'none'

    // Check if the user's channel can approve
    const canApproveViaChannel =
      this.approvalConfig && this.approvalConfig.defaultPolicy !== 'cli_only'

    if (workflowName && canApproveViaChannel) {
      return [
        `Approval needed to run workflow ${workflowName}.`,
        channelType === 'slack'
          ? 'Use the approval buttons to continue or cancel.'
          : 'Reply /approve to continue or /deny to cancel.',
      ].join(' ')
    }

    if (workflowName) {
      return [
        `Approval needed to run workflow ${workflowName}.`,
        'Please approve through the configured approval channel.',
      ].join(' ')
    }

    if (canApproveViaChannel) {
      return (
        `Tool \`${approval.tool_name}\` requires approval. ` +
        `Parameters: ${paramSummary}. ` +
        (channelType === 'slack'
          ? `Use the approval controls to continue or cancel.`
          : `Reply /approve or /deny to this message.`)
      )
    }

    return (
      `Tool \`${approval.tool_name}\` requires approval. ` +
      `Parameters: ${paramSummary}. ` +
      `Request ID: ${approval.request_id}. ` +
      `Please approve via CLI: POST /approve`
    )
  }

  /**
   * Release a suspended session in the SessionProcessor after approval resolves.
   */
  private releaseSessionForTask(task: Task): void {
    if (!this.sessionProcessor?.releaseSuspendedSession) return
    const msg = task.sourceMessage
    const sessionKey = serializeSessionKey({
      userId: msg?.sender || 'anonymous',
      channelType: msg?.channelType || 'internal',
      channelId: msg?.channelId || 'default',
      threadId: msg?.threadId,
    })
    this.sessionProcessor.releaseSuspendedSession(sessionKey)
  }

  /**
   * Handle task failure — the single delivery point for user-visible errors.
   * See docs/superpowers/specs/2026-04-10-llm-error-handling-design.md, Layer E.
   */
  private handleTaskFailure(task: Task, error: TaskError): void {
    console.error(
      `[Agent] Task ${task.id} failed: ` +
        `code=${error.code} retryable=${error.retryable} provider=${error.provider} ` +
        `message="${error.message}"`
    )

    // Deliver to user via canonical callback — this is the core bug fix.
    // Previously responseCallback was never called on failure.
    if (task.responseCallback) {
      task.responseCallback({ error }).catch(cbErr => {
        console.error(`[Agent] responseCallback threw on failure delivery:`, cbErr)
      })
    }

    // §5.3.1 — guarantee a registered SSE reporter BEFORE the terminal transition
    // for failures that never reached the executor (budget deny, null llmProvider,
    // any pre-executor path). The executor is the only OTHER place that constructs
    // a reporter; when a task fails before it exists, no reporter is subscribed to
    // the lifecycle, so the terminal SSE event is lost and the desktop stream hangs
    // on `waitFor(taskId, 180_000)` for the full timeout. Creating one here (which
    // registers it → wakes the blocked waiter as a microtask) means the reporter is
    // subscribed when the synchronous failTask→transition('failed') below fires, so
    // it buffers/emits the terminal in ~0ms instead of ~180s.
    //
    // Guard (CRITICAL, anti-leak): only create when the task is NOT already
    // terminal. If it were, the following transition returns already_terminal and
    // the reporter's lifecycle handler never emits a terminal → the fresh reporter
    // keeps completedAt=Infinity and is never evicted by the TTL sweep (reporter +
    // lifecycle-listener leak). Idempotent for the executor path: a reporter that
    // already exists is returned as-is (no duplicate, no double terminal).
    //
    // Fail-open: on any error we log and fall through — the durable result was
    // already stored above and failTask still runs, so the worst case degrades to
    // the pre-fix ~180s poll, never worse.
    try {
      // Only create a reporter when a COMPLETING terminal transition will follow:
      // the task must be registered AND not-yet-terminal. `isTerminal` alone
      // returns false for an unregistered task too, whose failTask→transition
      // returns not_found (no emit) — a reporter created then would keep
      // completedAt=Infinity and never be evicted by the TTL sweep (leak).
      const record = this.lifecycle.get(task.id)
      if (record && !this.lifecycle.isTerminal(task.id)) {
        ensureReporter(task.id, this.lifecycle, new BasicSafety(this.secretEntriesProvider))
      }
    } catch (err) {
      console.error('[Agent] ensure progress reporter failed', err)
    }

    // Terminal SSE emission is handled by SseProgressReporter's lifecycle subscription.
    // queue.failTask calls lifecycle.transition('failed'), which SseProgressReporter
    // intercepts to emit the typed 'terminal' event automatically.
    this.queue.failTask(task, error)
    this.emitEvent('task:failed', { task, error })
  }

  /**
   * Subscribe to TaskLifecycle transition events. On `to='cancelled'`, route to the
   * appropriate cleanup branch (processing or waiting_approval).
   *
   * Wrapped in try/catch per Invariant I11: Node EventEmitter.emit() halts on the
   * first thrown error. A throwing subscriber would stall terminal SSE emission
   * (B.5 adds SseProgressReporter as a later subscriber). Log + swallow.
   *
   * Processing branch: executor.abort() signals the AbortController. The tool-use
   * loop exits at its next checkpoint, and run()'s finally block handles
   * activeExecutors.delete — do NOT delete here.
   *
   * Waiting-approval branch: executor.run() has already returned (suspended), so
   * run()'s finally will NOT re-fire. We must do ALL cleanup here.
   */
  private subscribeLifecycle(): void {
    this.lifecycle.on('transition', ev => {
      if (ev.to !== 'cancelled') return
      const executor = this.activeExecutors.get(ev.taskId)
      if (!executor) return

      try {
        if (executor.pendingApproval) {
          // Waiting-approval branch: executor.run() has already returned (suspended).
          // We must do ALL cleanup here — the finally block in run() will not re-fire.
          const reqId = executor.pendingApproval.request_id
          const entry = this.approvalMap.get(reqId)
          if (entry?.timerId) clearTimeout(entry.timerId)
          this.approvalMap.delete(reqId)

          const msg = executor.sourceTask.sourceMessage
          const sessionKey = serializeSessionKey({
            userId: msg?.sender || 'anonymous',
            channelType: msg?.channelType || 'internal',
            channelId: msg?.channelId || 'default',
            threadId: msg?.threadId,
          })
          this.conversationManager.cancelTurnBySessionKey(sessionKey)
          // T2.1: clearPendingApproval is async (IronClaw write-through for
          // the cancel-during-approval path). B5 — wrapped in a bounded
          // retry queue so transient SQLite failures don't leave an orphan
          // pending_approval row. `tryClearPendingApproval` is fire-and-
          // forget by design (the lifecycle subscriber is sync); the retry
          // timer drains pending failures.
          this.tryClearPendingApproval(sessionKey)
          this.releaseSessionForTask(executor.sourceTask)
          executor.abort() // defensive; no-op while suspended
          this.activeExecutors.delete(ev.taskId) // explicit — no finally will run
          return
        }

        // Processing branch: executor is in the tool-use loop.
        // run()'s finally block handles activeExecutors.delete after the loop exits.
        executor.abort()
      } catch (err) {
        console.error('[TaskLifecycle subscriber] cleanup raised', { taskId: ev.taskId, err })
        // Invariant I11: do NOT re-throw; SseProgressReporter must still fire
      }
    })
  }

  // ─── B5 — clear-pending-approval retry queue ────────────────────────────

  /** Max number of attempts before we drop a clearPendingApproval entry
   *  and rely on the cold-start TTL filter (B7) as last-resort cleanup. */
  private static readonly CLEAR_RETRY_MAX_ATTEMPTS = 10
  /** Base backoff (ms). Each retry waits `base * 2^(attempt-1)`, capped at 1h. */
  private static readonly CLEAR_RETRY_BASE_MS = 5_000
  private static readonly CLEAR_RETRY_CAP_MS = 3_600_000

  /**
   * Attempt to clear a pending approval and enqueue a retry on failure.
   * Replaces the legacy fire-and-forget `.catch(log)` pattern so transient
   * SQLite errors don't silently leak orphan `pending_approval` rows that
   * cold-start would later resurrect.
   */
  private tryClearPendingApproval(sessionKey: string): void {
    this.conversationManager
      .clearPendingApproval(sessionKey)
      .then(() => {
        // Success — drop any prior retry bookkeeping.
        this.clearPendingApprovalRetries.delete(sessionKey)
      })
      .catch(err => {
        this.scheduleClearRetry(sessionKey, err)
      })
  }

  private scheduleClearRetry(sessionKey: string, lastErr: unknown): void {
    const prior = this.clearPendingApprovalRetries.get(sessionKey)
    const attempts = (prior?.attempts ?? 0) + 1
    if (attempts > AgentStateMachine.CLEAR_RETRY_MAX_ATTEMPTS) {
      console.error(
        `[Agent] clearPendingApproval exhausted ${attempts - 1} retries for sessionKey=${sessionKey}. ` +
          `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}. ` +
          `The SQLite row is now an orphan; cold-start TTL filter (B7) will eventually drop it.`
      )
      this.clearPendingApprovalRetries.delete(sessionKey)
      return
    }
    const backoff = Math.min(
      AgentStateMachine.CLEAR_RETRY_BASE_MS * 2 ** (attempts - 1),
      AgentStateMachine.CLEAR_RETRY_CAP_MS
    )
    const nextTry = Date.now() + backoff
    this.clearPendingApprovalRetries.set(sessionKey, { attempts, nextTry })
    console.warn(
      `[Agent] clearPendingApproval failed (attempt ${attempts}, retrying in ${backoff}ms): ` +
        `sessionKey=${sessionKey}, err=${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    )
  }

  private drainClearPendingApprovalRetries(): void {
    if (this.clearPendingApprovalRetries.size === 0) return
    const now = Date.now()
    for (const [sessionKey, entry] of this.clearPendingApprovalRetries) {
      if (entry.nextTry > now) continue
      // Re-attempt. `tryClearPendingApproval` either deletes the entry on
      // success or re-schedules via `scheduleClearRetry`.
      this.tryClearPendingApproval(sessionKey)
    }
  }

  /**
   * Set the agent state.
   */
  private setState(newState: AgentState): void {
    if (this.state === newState) return

    const oldState = this.state
    this.state = newState

    console.log(`[Agent] State: ${oldState} -> ${newState}`)
    this.emitEvent('state:changed', { oldState, newState })
  }

  /** Agent-level events that should also be bridged to the core SimpleEventEmitter. */
  private static readonly BRIDGED_EVENT_TYPES = new Set([
    'state:changed',
    'task:completed',
    'task:failed',
    'task:started',
    'tool:approval_granted',
    'tool:approval_denied',
  ])

  private emitEvent(type: AgentEventType, data: unknown): void {
    const event: AgentEvent = {
      type,
      data,
      timestamp: new Date(),
    }
    this.emit(type, event)
    this.emit('event', event)

    if (AgentStateMachine.BRIDGED_EVENT_TYPES.has(type)) {
      this.coreEvents.emit({
        type: type as CoreAgentEventType,
        data: data as Record<string, unknown>,
        timestamp: event.timestamp,
      })
    }
  }
}
