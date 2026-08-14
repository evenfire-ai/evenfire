import { parseSessionKey } from '../../session/types'
import { ConversationError, ConversationErrorCode } from '../errors'
import { isMcpToolName } from '../extensions/mcpApprovalGateController'
import {
  ChatMessage,
  ContextBreakdown,
  Conversation,
  ConversationState,
  PendingApproval,
  TraceContextV1,
  Turn,
  TurnToolCall,
} from '../types'
import type { SessionTokenUsage } from './conversationStore'
import {
  ConversationSessionSummary,
  ConversationStore,
  GetOrCreateOptions,
  InMemoryConversationStore,
  SessionListQuery,
  SessionMessagesQuery,
} from './conversationStore'
import { userIdFromRpcPrefix } from './sessionKeyParts'

/**
 * Manages conversation state and turn tracking.
 *
 * State transitions:
 *   Idle → Processing (start_turn)
 *   Processing → Idle (complete/fail)
 *   Processing → AwaitingApproval (tool needs approval)
 *   AwaitingApproval → Processing (approve)
 *   AwaitingApproval → Idle (deny)
 *
 * The store is injected. The default is `InMemoryConversationStore` so unit
 * tests and dev mode keep their previous behavior; production wires the
 * SQLite-backed store in `main.ts`. State-mutating methods call the matching
 * `persist*` hook on the store; for in-memory stores those are no-ops.
 *
 * IronClaw-critical methods (`suspendForApproval`, `approve`, `deny`,
 * `clearPendingApproval`) are async because the SQLite store uses sync
 * write-through (the durable state must land before the user-facing
 * notification fires). Other lifecycle methods stay sync — the store
 * absorbs them into its `enqueueAsync` queue, preserving per-sessionKey
 * ordering without blocking the caller.
 */
export class ConversationManager {
  private store: ConversationStore

  constructor(store: ConversationStore = new InMemoryConversationStore()) {
    this.store = store
  }

  /**
   * Expose the underlying store so wiring code (cold-start loader,
   * onEvict hook, shutdown drain) can reach into it without crossing
   * ConversationManager.
   */
  getStore(): ConversationStore {
    return this.store
  }

  /**
   * Swap the underlying store. Used by `main.ts` to inject the SQLite store
   * after the worker thread is ready. Safe to call before any conversation
   * has been touched; calling after sessions live in the old store would
   * orphan them.
   */
  setStore(store: ConversationStore): void {
    this.store = store
  }

  /**
   * Get or create a conversation for a session key.
   *
   * **Now async** (T2.1): on a cache miss we consult the durable store
   * (`getOrLoad`) before creating a brand-new conversation. Production
   * callsites already live in async paths (taskExecutor.run,
   * RPC handlers); tests must `await`.
   */
  async getOrCreate(sessionKey: string, opts?: GetOrCreateOptions): Promise<Conversation> {
    const cached = this.store.get(sessionKey)
    if (cached) {
      this.assertSessionOwner(cached, opts?.userId)
      return cached
    }

    const loaded = await this.store.getOrLoad(sessionKey)
    if (loaded) {
      this.assertSessionOwner(loaded, opts?.userId)
      return loaded
    }

    const parsed = parseSessionKey(sessionKey)

    const conv: Conversation = {
      id: `conv-${sessionKey}-${Date.now()}`,
      session_key: sessionKey,
      user_id: opts?.userId ?? parsed?.userId ?? sessionKey,
      state: ConversationState.Idle,
      turns: [],
      auto_approved_tools: new Set(),
      created_at: new Date(),
      updated_at: new Date(),
    }
    this.store.set(sessionKey, conv)
    await Promise.resolve(this.store.persistSessionCreate(conv, opts ?? {}))
    return conv
  }

  /**
   * List conversations whose session key begins with the given prefix.
   * Used by the sessions read endpoints; filter logic lives here so routes
   * don't reach into the underlying store directly.
   *
   * The prefix must include the trailing ":" that separates the userId+channelType
   * segments from the agent. E.g. "<userId>:rpc:" — the method extracts agent
   * and chatId from the single remaining ":" after the prefix.
   */
  listSessionsForUser(keyPrefix: string): Array<{
    key: string
    conversation: Conversation
    agent: string
    chatId: string
  }> {
    const userId = userIdFromRpcPrefix(keyPrefix)
    if (!userId) return []
    const out = [] as Array<{
      key: string
      conversation: Conversation
      agent: string
      chatId: string
    }>
    for (const { key, conversation } of this.store.listByPrefix(keyPrefix)) {
      if (conversation.user_id !== userId) continue
      const rest = key.slice(keyPrefix.length)
      const colonIdx = rest.indexOf(':')
      if (colonIdx < 0) continue
      const agent = rest.slice(0, colonIdx)
      const chatId = rest.slice(colonIdx + 1)
      out.push({ key, conversation, agent, chatId })
    }
    return out
  }

  /**
   * Async variant of `listSessionsForUser` that warms the cache with any
   * matching durable rows before returning the in-memory view. Used by
   * the RPC `sessions` listing endpoint after the SQLite store ships.
   */
  async listSessionsForUserAsync(keyPrefix: string): Promise<
    Array<{
      key: string
      conversation: Conversation
      agent: string
      chatId: string
    }>
  > {
    await this.store.prefetchUserSessions(keyPrefix)
    return this.listSessionsForUser(keyPrefix)
  }

  /**
   * Summary-only listing for `/v1/runtime/sessions`. Durable stores implement
   * this without loading transcript rows; full turn hydration stays on
   * `getSessionByKeyAsync` and the messages endpoint.
   */
  async listSessionSummariesForUserAsync(
    keyPrefix: string,
    query: SessionListQuery = {}
  ): Promise<ConversationSessionSummary[]> {
    return this.store.listSessionSummariesByPrefix(keyPrefix, query)
  }

  /**
   * Summary-preserving, bounded transcript window for `/messages`.
   * Durable stores can fetch only the requested turns instead of hydrating
   * the whole persisted conversation before slicing.
   */
  async getSessionMessagesByKeyAsync(
    key: string,
    keyPrefix: string,
    query: SessionMessagesQuery = {}
  ) {
    return this.store.getSessionMessagesByKey(key, keyPrefix, query)
  }

  /**
   * Look up a single conversation by its exact session key.
   * Used by the transcript endpoint: the full key can be reconstructed from
   * auth.sub + agent + chatId, so iterating the whole map is wasteful.
   * Returns undefined when no conversation exists for that key (cache miss).
   */
  getSessionByKey(key: string): Conversation | undefined {
    return this.store.get(key)
  }

  /**
   * Async variant of `getSessionByKey` that consults the durable store on
   * cache miss. Used by RPC handlers that need to surface historical
   * conversations after they've fallen out of the RAM cache.
   */
  async getSessionByKeyAsync(key: string): Promise<Conversation | undefined> {
    return this.store.getOrLoad(key)
  }

  /** Authenticated exact-key lookup that treats persisted ownership as authoritative. */
  async getSessionByKeyForUserAsync(
    key: string,
    userId: string
  ): Promise<Conversation | undefined> {
    const conversation = await this.store.getOrLoad(key)
    return conversation?.user_id === userId ? conversation : undefined
  }

  private assertSessionOwner(conversation: Conversation, expectedUserId?: string): void {
    if (expectedUserId !== undefined && conversation.user_id !== expectedUserId) {
      throw new ConversationError('Session access denied', ConversationErrorCode.OwnershipMismatch)
    }
  }

  /**
   * Start a new turn in the conversation.
   * Transitions: Idle → Processing
   *
   * **D3 durability barrier**: awaits the store's `persistTurnStart` — under
   * the SQLite store the user message + state flip commit as ONE transaction
   * before the turn proceeds (retry semantics replay from the last persisted
   * user message). On a rejected write the in-RAM mutation is rolled back
   * (same rationale as `suspendForApproval`) and the error propagates so the
   * caller fails the task loudly.
   */
  async startTurn(
    conversation: Conversation,
    userInput: string,
    taskId: string,
    traceContext: TraceContextV1 | null = null
  ): Promise<Turn> {
    if (conversation.state !== ConversationState.Idle) {
      throw new ConversationError(
        `Cannot start turn: conversation is ${conversation.state}`,
        ConversationErrorCode.InvalidTransition
      )
    }

    const previousTraceContext = conversation.traceContext
    conversation.state = ConversationState.Processing
    // D.1 — record the in-flight task so it can be exposed via /sessions and
    // mirrored to sessions.active_task_id by persistTurnStart.
    conversation.activeTaskId = taskId
    conversation.traceContext = traceContext
    conversation.updated_at = new Date()

    // Clear per-turn wildcard approval — each new message requires fresh approval
    conversation.auto_approved_tools.delete('*')

    const turn: Turn = {
      number: conversation.turns.length + 1,
      user_input: userInput,
      tool_calls: [],
      started_at: new Date(),
    }

    conversation.turns.push(turn)
    try {
      await Promise.resolve(this.store.persistTurnStart(conversation, userInput))
    } catch (err) {
      // Roll back the in-RAM mutation so the cached conversation is not left
      // poisoned in Processing — the next startTurn would otherwise throw
      // InvalidTransition forever. The ordinal consumed by the failed write
      // stays consumed (holes are legal; UNIQUE collisions are not).
      conversation.turns.pop()
      conversation.state = ConversationState.Idle
      conversation.activeTaskId = undefined
      conversation.traceContext = previousTraceContext
      conversation.updated_at = new Date()
      throw err
    }
    return turn
  }

  /**
   * Complete the current turn with a response.
   * Transitions: Processing → Idle
   *
   * **D3 durability barrier**: awaits the store's `persistTurnComplete` —
   * under the SQLite store the assistant message + state flip +
   * `active_task_id` clear commit as ONE transaction. Callers MUST await this
   * BEFORE ACKing the client (`responseCallback`) so an acknowledged turn is
   * always durable. A rejected write propagates — never swallowed — and the
   * caller fails the turn (see TaskExecutor.handleLoopResult).
   */
  async completeTurn(conversation: Conversation, response: string): Promise<void> {
    if (conversation.state !== ConversationState.Processing) {
      throw new ConversationError(
        `Cannot complete turn: conversation is ${conversation.state}`,
        ConversationErrorCode.InvalidTransition
      )
    }

    const currentTurn = conversation.turns[conversation.turns.length - 1]
    if (currentTurn) {
      currentTurn.response = response
      currentTurn.completed_at = new Date()
    }

    conversation.state = ConversationState.Idle
    conversation.pending_approval = undefined
    conversation.activeTaskId = undefined // D.1 — turn done, no task in flight
    conversation.traceContext = null
    conversation.updated_at = new Date()
    await Promise.resolve(this.store.persistTurnComplete(conversation, response))
  }

  /**
   * Accumulate the token usage of one LLM call into this session's lifetime
   * totals. Mirrors the numbers onto the in-RAM `Conversation` (so the hot
   * `/sessions` and `/messages` paths serve a live count) AND enqueues the
   * durable SQLite update (so cold-loaded sessions converge). Both start from
   * the same `usage`, so they stay consistent; the durable write is
   * fire-and-forget (`enqueueAsync`), lagging RAM by microseconds — irrelevant
   * for a display counter.
   *
   * `cacheTokensReported` is OR-accumulated: a single call that reported cache
   * info (defined `cache_*`) flips it true for the session, which is what the
   * desktop uses to decide whether to show the cache breakdown.
   */
  recordSessionUsage(conversation: Conversation, usage: SessionTokenUsage): void {
    // Defensive: a malformed/buggy provider response must not poison the
    // counter. A negative value would decrement the running total and a
    // NaN/non-finite would corrupt it (and could bind NaN into the NOT NULL
    // SQLite column). Coerce each figure to a non-negative integer; preserve
    // `undefined` for cache fields (the "provider doesn't report cache" signal).
    const clamp = (n: number | undefined): number | undefined =>
      n === undefined ? undefined : Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
    const safe: SessionTokenUsage = {
      input_tokens: clamp(usage.input_tokens) ?? 0,
      output_tokens: clamp(usage.output_tokens) ?? 0,
      cache_read_tokens: clamp(usage.cache_read_tokens),
      cache_write_tokens: clamp(usage.cache_write_tokens),
    }
    conversation.input_tokens = (conversation.input_tokens ?? 0) + safe.input_tokens
    conversation.output_tokens = (conversation.output_tokens ?? 0) + safe.output_tokens
    conversation.cache_read_tokens =
      (conversation.cache_read_tokens ?? 0) + (safe.cache_read_tokens ?? 0)
    conversation.cache_write_tokens =
      (conversation.cache_write_tokens ?? 0) + (safe.cache_write_tokens ?? 0)
    // The flag reflects whether the provider REPORTED cache info (defined field),
    // independent of the value — Anthropic with a defined 0 still flips it true.
    if (safe.cache_read_tokens !== undefined || safe.cache_write_tokens !== undefined) {
      conversation.cacheTokensReported = true
    }
    // Per-turn attribution: add to the in-flight turn ONLY while a user turn is
    // being served (Processing). This counts in-loop compaction toward the turn
    // (it's spent serving it) while excluding operator /compact, which runs with
    // no in-flight turn (it still counts at the session level above). The turn's
    // total is persisted onto its final assistant message by persistTurnComplete.
    if (conversation.state === ConversationState.Processing && conversation.turns.length > 0) {
      const turn = conversation.turns[conversation.turns.length - 1]
      turn.input_tokens = (turn.input_tokens ?? 0) + safe.input_tokens
      turn.output_tokens = (turn.output_tokens ?? 0) + safe.output_tokens
      // Preserve "unreported" (undefined) faithfully: only accumulate cache when
      // the provider reported it (Anthropic's defined 0 still counts). A provider
      // that omits cache (OpenAI/zai/bailian) leaves the turn's cache undefined,
      // mirroring the session-level treatment.
      if (safe.cache_read_tokens !== undefined) {
        turn.cache_read_tokens = (turn.cache_read_tokens ?? 0) + safe.cache_read_tokens
      }
      if (safe.cache_write_tokens !== undefined) {
        turn.cache_write_tokens = (turn.cache_write_tokens ?? 0) + safe.cache_write_tokens
      }
    }
    // NOTE: intentionally does NOT bump `updated_at` — token accounting is not
    // user activity. The turn lifecycle (start/complete/cancel) owns that, so an
    // operator-triggered /compact does not advance `lastActivityAt`.
    void this.store.persistSessionUsage?.(conversation, safe)
  }

  /**
   * Record the send-time context-window breakdown snapshot for this session.
   *
   * Captured by `DefaultReasoningPort.buildMessages` from the raw per-bucket
   * `countSync` counts (local, cheap). The `totalInputTokens` left here is
   * PROVISIONAL (= Σbuckets); the usage sink (`onUsageRecorded`, runs in the
   * same call's `recordUsage`) overwrites it with the provider's authoritative
   * `input_tokens` so the displayed total matches the `N/M` exactly (#8).
   *
   * RAM-only by design (decision LOCKED #4): the snapshot is ephemeral and
   * recomputed every turn, so it is NOT persisted to SQLite. A cold-load has
   * no "current prompt" until the next turn (null is acceptable).
   */
  recordContextBreakdown(
    conversation: Conversation,
    raw: { buckets: ContextBreakdown['buckets']; maxTokens: number }
  ): void {
    const sum = Object.values(raw.buckets).reduce((a, b) => a + b, 0)
    conversation.contextBreakdown = {
      buckets: raw.buckets,
      totalInputTokens: sum, // provisional; the usage sink finalizes it (#8)
      maxTokens: raw.maxTokens,
      capturedAtTurn: conversation.turns?.length ?? 0,
    }
    // NOTE: intentionally does NOT bump `updated_at` — the breakdown is token
    // accounting recomputed every turn, not user activity (same invariant as
    // `recordSessionUsage`). The turn lifecycle owns `updated_at`.
  }

  /**
   * Fail the current turn.
   * Transitions: Processing → Idle
   *
   * Awaited durability barrier (parity with completeTurn): the failure ACK
   * sent after this resolves must describe a state that is already durable —
   * under the SQLite store the state flip + `active_task_id` clear commit as
   * one awaited worker op. A rejected write propagates — never swallowed.
   */
  async failTurn(conversation: Conversation): Promise<void> {
    conversation.state = ConversationState.Idle
    conversation.pending_approval = undefined
    conversation.activeTaskId = undefined // D.1 — turn done, no task in flight
    conversation.traceContext = null
    conversation.updated_at = new Date()

    const currentTurn = conversation.turns[conversation.turns.length - 1]
    if (currentTurn) {
      currentTurn.completed_at = new Date()
    }
    await Promise.resolve(this.store.persistTurnFail(conversation))
  }

  /**
   * Mark the current turn as cancelled by the user.
   *
   * Unlike failTurn, this sets a synthetic assistant response on the turn
   * so that buildMessageHistory emits a clean user↔assistant alternation —
   * preventing the cancelled user_input from leaking into the next LLM call
   * (see BUG-9).
   *
   * Distinct from deny (which is a user decision on a specific tool and
   * appends explicit denial messages to history). Cancel ≠ deny per
   * spec §5.3.
   *
   * Transitions: Processing | AwaitingApproval → Idle
   */
  cancelTurn(conversation: Conversation): void {
    conversation.state = ConversationState.Idle
    conversation.pending_approval = undefined
    conversation.activeTaskId = undefined // D.1 — turn done, no task in flight
    conversation.traceContext = null
    conversation.updated_at = new Date()
    const currentTurn = conversation.turns[conversation.turns.length - 1]
    if (currentTurn) {
      currentTurn.response = '[Task cancelled by user before completion]'
      currentTurn.completed_at = new Date()
    }
    void this.store.persistTurnCancel(conversation)
  }

  /**
   * Session-key variant of cancelTurn, used by the AgentStateMachine cancel
   * subscriber which only holds sessionKey (not Conversation).
   * No-op for unknown session keys.
   *
   * Stays sync: the cancel subscriber is invoked synchronously by the
   * lifecycle EventEmitter and must not introduce async hops (see I11).
   */
  cancelTurnBySessionKey(sessionKey: string): void {
    const conv = this.store.get(sessionKey)
    if (!conv) return
    this.cancelTurn(conv)
  }

  /**
   * Suspend for approval.
   * Transitions: Processing → AwaitingApproval
   *
   * **IronClaw write-through (T2.1)**: the durable pending_approval row
   * MUST land before the channel notification fires. The store handles
   * that via `enqueueSync`; this method awaits the ACK before returning.
   */
  async suspendForApproval(conversation: Conversation, approval: PendingApproval): Promise<void> {
    if (conversation.state !== ConversationState.Processing) {
      throw new ConversationError(
        `Cannot suspend: conversation is ${conversation.state}`,
        ConversationErrorCode.InvalidTransition
      )
    }

    const prevState = conversation.state
    const prevApproval = conversation.pending_approval
    const prevApprovalTraceContext = approval.traceContext
    approval.traceContext = conversation.traceContext ?? null
    conversation.state = ConversationState.AwaitingApproval
    conversation.pending_approval = approval
    conversation.updated_at = new Date()
    try {
      await this.store.persistSuspend(conversation, approval)
    } catch (err) {
      // Under the sqlite/dual store the durable write can reject (worker
      // timeout, SQLITE_BUSY, worker exit). Roll back the in-RAM mutation so
      // the cached conversation is not left poisoned in AwaitingApproval — the
      // next `startTurn` would otherwise throw InvalidTransition. The caller
      // (TaskExecutor.handleLoopResult) surfaces the failure as a failed turn.
      conversation.state = prevState
      conversation.pending_approval = prevApproval
      approval.traceContext = prevApprovalTraceContext
      conversation.updated_at = new Date()
      throw err
    }
  }

  /**
   * Resume after approval.
   * Transitions: AwaitingApproval → Processing
   *
   * Per-server approval: any approval of an MCP tool auto-approves all tools
   * from the same MCP server for the rest of the conversation. This prevents
   * repeated approval prompts when the LLM calls multiple tools from the same server.
   *
   * When alwaysApprove=true, also stores the individual tool name (backwards compat).
   *
   * **IronClaw write-through**: awaits durable approval-state mutation.
   */
  async approve(conversation: Conversation, alwaysApprove: boolean): Promise<void> {
    if (conversation.state !== ConversationState.AwaitingApproval) {
      throw new ConversationError(
        `Cannot approve: conversation is ${conversation.state}`,
        ConversationErrorCode.InvalidTransition
      )
    }

    const requestId = conversation.pending_approval?.request_id
    if (conversation.pending_approval) {
      const toolName = conversation.pending_approval.tool_name

      // "Approve once, run all" — any approval auto-approves all subsequent tools in this turn.
      // The user only needs to approve once per task, not per tool call.
      conversation.auto_approved_tools.add('*')

      // MCP tools: also auto-approve the entire server for future turns
      if (isMcpToolName(toolName)) {
        const serverPrefix = toolName.split('__')[0]
        conversation.auto_approved_tools.add(serverPrefix)
      }

      // alwaysApprove also stores the individual tool name (for future turns)
      if (alwaysApprove) {
        conversation.auto_approved_tools.add(toolName)
      }
    }

    conversation.state = ConversationState.Processing
    conversation.updated_at = new Date()
    if (requestId) {
      await this.store.persistApprovalResolved(conversation, requestId, 'approve')
    }
  }

  /**
   * Deny approval.
   * Transitions: AwaitingApproval → Idle
   *
   * **IronClaw write-through**: durable mutation lands before returning.
   */
  async deny(conversation: Conversation): Promise<void> {
    if (conversation.state !== ConversationState.AwaitingApproval) {
      throw new ConversationError(
        `Cannot deny: conversation is ${conversation.state}`,
        ConversationErrorCode.InvalidTransition
      )
    }

    const requestId = conversation.pending_approval?.request_id
    conversation.state = ConversationState.Idle
    conversation.pending_approval = undefined
    conversation.activeTaskId = undefined // D.1 — deny is terminal (→ Idle), no task in flight
    conversation.traceContext = null
    conversation.updated_at = new Date()
    if (requestId) {
      await this.store.persistApprovalResolved(conversation, requestId, 'deny')
    }
  }

  /**
   * Clear pending approval on cancel-during-waiting_approval path (spec §4.4, §5.3).
   * Distinct from deny() — does NOT append assistant/user messages to history and
   * does NOT require the conversation to be in AwaitingApproval state.
   * The task is being cancelled, not denied; conversation state should reflect a
   * cancelled interruption, not a user decision on the tool.
   *
   * Also resets conversation.state to Idle so the next startTurn can proceed
   * without throwing "Cannot start turn: conversation is awaiting_approval". (BUG-8)
   *
   * Safe on unknown sessionKey (no-op).
   *
   * **IronClaw write-through**: durable mutation lands before returning.
   */
  async clearPendingApproval(sessionKey: string): Promise<void> {
    const conv = this.store.get(sessionKey)
    if (!conv) return
    const requestId = conv.pending_approval?.request_id
    conv.pending_approval = undefined
    conv.state = ConversationState.Idle // release the turn lock (BUG-8)
    conv.activeTaskId = undefined
    conv.traceContext = null
    conv.updated_at = new Date()
    if (requestId) {
      await this.store.persistApprovalResolved(conv, requestId, 'cancel')
    }
  }

  /**
   * Record a tool call in the current turn.
   */
  recordToolCall(conversation: Conversation, toolCall: TurnToolCall): void {
    const currentTurn = conversation.turns[conversation.turns.length - 1]
    if (currentTurn) {
      currentTurn.tool_calls.push(toolCall)
    }
    void this.store.persistToolCall(conversation, toolCall)
  }

  /**
   * T2.2 — Persist the system-prompt stable hash for auditability. Called by
   * the prompt-cache wiring whenever a new `SystemPromptParts.stableHash` is
   * computed for a session. The store-level method enqueues the update onto
   * the worker thread (async write-through).
   */
  recordSystemPromptStableHash(conversation: Conversation, stableHash: string): void {
    void Promise.resolve(this.store.persistSystemPromptStableHash(conversation, stableHash))
  }

  /**
   * R2 — upsert the session's model selection for a provider and write it
   * through to the durable `model_selections` column. Full-overwrite of the
   * in-RAM map (this manager owns it); the store re-serializes on persist. The
   * per-task resolver reads this map after a cold-load to honour the choice.
   */
  setModelSelection(conversation: Conversation, provider: string, model: string): void {
    conversation.modelSelections = { ...(conversation.modelSelections ?? {}), [provider]: model }
    void Promise.resolve(this.store.persistModelSelections?.(conversation))
  }

  /**
   * Build the ChatMessage[] history from conversation turns.
   * Used to reconstruct messages for the ReasoningPort.
   *
   * Risk 5.1: Must produce messages compatible with the new format
   * (including tool role and tool_calls).
   */
  buildMessageHistory(conversation: Conversation): ChatMessage[] {
    const messages: ChatMessage[] = []

    for (const turn of conversation.turns) {
      // User message
      messages.push({ role: 'user', content: turn.user_input })

      // Tool calls are tracked for analytics, but the actual
      // wire-protocol messages are maintained by the loop, not here.

      // Response
      if (turn.response) {
        messages.push({ role: 'assistant', content: turn.response })
      }
    }

    return messages
  }
}
