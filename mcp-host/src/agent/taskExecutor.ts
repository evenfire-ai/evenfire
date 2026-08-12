/**
 * TaskExecutor — runs a single task through the LLM tool-use loop.
 *
 * Disposable: created per task by AgentStateMachine, discarded on completion.
 * Holds per-task state (task, conversation, tool count) that was previously
 * singleton on the AgentStateMachine.
 */
import { snapshotTaskTokenBaseline } from '../budget/taskBrake'
import type { TaskTokenBaseline } from '../budget/taskBrake'
import { config as appConfig } from '../config'
import { maybeWrapFailover } from '../core/adapters/failoverLlmPort'
import { AdapterStaticContext, LlmPortAdapter } from '../core/adapters/llmPortAdapter'
import { CompositeToolRegistry, McpToolRegistryAdapter } from '../core/adapters/toolRegistryAdapter'
import { compactConversation } from '../core/conversation/compaction'
import { ConversationManager } from '../core/conversation/conversation'
import { LlmError, LlmErrorCode } from '../core/errors'
import { ApprovalController } from '../core/extensions/approvalController'
import type { ApprovalConfig } from '../core/extensions/approvalTypes'
import { PressureContextManager } from '../core/extensions/contextManager'
import { UnifiedApprovalGateController } from '../core/extensions/mcpApprovalGateController'
import { type GuardrailsConfig, buildToolLaneGuardrail } from '../core/guardrails'
import type { AgentEventEmitter, LlmPort, LoopController, ToolRegistry } from '../core/interfaces'
import { DeferrableToolController } from '../core/orchestration/deferrableToolController'
import type { SimpleEventEmitter } from '../core/orchestration/eventEmitter'
import { buildLoopConfig } from '../core/orchestration/loopConfig'
import type { LoopConfig } from '../core/orchestration/loopConfig'
import { DefaultLoopController } from '../core/orchestration/loopConfig'
import type { SpilloverResolver } from '../core/orchestration/spilloverResolver'
import { StubSpilloverResolver } from '../core/orchestration/spilloverResolver'
import {
  buildOutputPreview,
  executeSingleTool,
  extractInputPreview,
  runToolUseLoop,
  validateToolLinkages,
} from '../core/orchestration/toolUseLoop'
import { buildTurnContextBlock } from '../core/orchestration/turnContext'
import { DefaultReasoningFactory } from '../core/reasoning'
import {
  CAPABILITY_CONTRACT_TEXT,
  DESKTOP_ENVIRONMENT_HINT,
  DefaultPromptBuilder,
  MCP_SERVER_SELECTION_TEXT,
  MEMORY_GUIDANCE_TEXT,
  TOOL_DISCOVERY_TEXT,
  WORKFLOW_RECIPES_TEXT,
} from '../core/reasoning/promptBuilder'
import type { SystemPromptParts } from '../core/reasoning/systemPrompt'
import { BasicSafety } from '../core/safety/safety'
import type { SessionSearchService } from '../core/sessionSearch'
import { FsSpilloverResolver, SpilloverStorage } from '../core/spillover'
import { createTokenCounter } from '../core/tokenizer'
import type { TokenCounter } from '../core/tokenizer/tokenCounter'
import { registerDesktopTools } from '../core/tools/desktopTools'
import { NativeToolRegistry } from '../core/tools/nativeToolRegistry'
import { WorkflowBrokerClient } from '../core/tools/workflowBrokerClient'
import {
  requestEffectiveWorkflowList,
  resolveEffectiveWorkflowTarget,
} from '../core/tools/workflowEffectiveTargets'
import type { WorkflowCallerContext } from '../core/tools/workflowShared'
import { createWorkflowControlTokenProvider } from '../core/tools/workflowTokenProvider'
import type {
  AgentEvent,
  Attachment,
  ChatMessage,
  Conversation,
  LoopResult,
  MessageContentPart,
  PendingApproval,
  ToolDefinition,
  ToolResult,
} from '../core/types'
import { ApprovalExpiredError } from '../core/types'
import type { UsageContext } from '../core/types'
import type { TaskLifecycle } from '../lifecycle/taskLifecycle'
import type { SingleTurnProvider } from '../llm'
import type { PromptCache } from '../llm/promptCache'
import { stampStableHashGauge } from '../llm/promptCacheMetrics'
import { isLlmProvider } from '../llm/registryCore'
import type { McpManager } from '../mcp'
import { getDisplayName, sanitizeError } from '../progress/intentExtraction.js'
import {
  SseProgressReporter,
  ensureReporter,
  progressReporterRegistry,
} from '../progress/sseProgressReporter.js'
import type { Task, TaskError } from '../queue/types'
import { resolveCronTaskSessionKey, serializeSessionKey } from '../session'
import { GovernedRunReporter, UsageReporter } from '../usage/usageReporter.js'
import { resolveProviderWorkflowCallerContext } from '../workflow/providerWorkflowCallerContextClient'
import type { Workspace } from '../workspace/service'
import type { CronScheduler } from './cronScheduler'
import {
  type ProviderWorkflowAccessDenialReason,
  isProviderWorkflowChannel,
  looksLikeWorkflowAccessRequest,
  looksLikeWorkflowTriggerRequest,
  looksLikeWorkflowTriggerSuccess,
  workflowAccessDeniedResponseForMessage,
} from './providerWorkflowAccessGate'
import { TurnTimingRecorder } from './turnTiming'
import type { AgentConfig, ExecutorFailoverSupport } from './types'

export type ExecutorState = 'processing' | 'waiting_approval' | 'completed' | 'failed'

/**
 * R2 — the serialized session key a task runs under. Extracted so the agent's
 * per-task model resolver (`executeTask`) reads the SAME key the executor's
 * `run()` uses for `getOrCreate`. INVARIANT: for `source==='cron'` this MUST
 * agree with the key `cronDispatch.ts` enqueued under.
 */
export function resolveTaskSessionKey(task: Task): string {
  const msg = task.sourceMessage
  const cronSession = task.source === 'cron' ? resolveCronTaskSessionKey(task) : undefined
  return serializeSessionKey(
    cronSession ?? {
      userId: msg?.sender || 'anonymous',
      channelType: msg?.channelType || 'internal',
      channelId: msg?.channelId || 'default',
      threadId: msg?.threadId,
    }
  )
}

export interface TaskExecutorDeps {
  conversationManager: ConversationManager
  llmProvider: SingleTurnProvider
  mcpManager: McpManager | null
  workspaceService: Workspace | undefined
  config: AgentConfig
  modelName: string
  /**
   * R2 — context-window override for the effective model, read from the
   * allowlist entry by the per-task resolver. Feeds the reasoning-factory
   * breakdown denominator and the PressureContextManager budget. Undefined →
   * fall back to `CLERUM_CONTEXT_MAX_TOKENS` (today's behaviour).
   */
  contextWindowTokens?: number
  approvalConfig: ApprovalConfig | undefined
  guardrailsConfig?: GuardrailsConfig
  coreEvents: SimpleEventEmitter
  cronScheduler: CronScheduler | null
  taskLifecycle: TaskLifecycle
  /**
   * Returns operator-managed env vars (ConfigStore snapshot) for the
   * shell-tool spawn-time merge. Optional — falls back to {} when omitted.
   */
  dynamicEnvProvider?: () => Record<string, string>
  /**
   * Returns ConfigStore-managed secret name/value pairs for the output
   * sanitizer to redact from tool output. Optional — falls back to no
   * extra redaction when omitted.
   */
  secretEntriesProvider?: () => Array<{ name: string; value: string }>
  /**
   * Optional usage reporter + static host context. When both are present,
   * every successful LLM round-trip enqueues an LlmUsageEvent. Absent in
   * dev mode and in tests.
   */
  usageReporter?: UsageReporter
  usageStaticContext?: AdapterStaticContext
  governedRunReporter?: GovernedRunReporter

  /**
   * IronClaw invariant #2 (P.3 + T1.5): resolver for spillover refs in the
   * approval snapshot. Defaults to a fresh `FsSpilloverResolver` against
   * `spilloverStorage` if provided, else `StubSpilloverResolver` (passthrough
   * for inline content, throw for refs — useful for tests).
   */
  spilloverResolver?: SpilloverResolver

  /**
   * T1.5 — Tool-result spillover. When set, oversized tool outputs are
   * persisted out-of-band and the `tool` message ships a rich summary plus
   * the `spillover_ref` URI. Also drives `clerum__spillover_read` registration
   * in the native tool registry and the resolver default above.
   */
  spilloverStorage?: SpilloverStorage

  /**
   * T2.2 — Process-wide system-prompt cache. When set together with
   * `appConfig.promptCacheEnabled`, `buildLoopConfig` consults the cache
   * (keyed by sessionKey) to fetch the tiered `SystemPromptParts` and
   * forwards them to the cache-aware path of the LLM port. Absent in tests
   * and when the flag is OFF.
   */
  promptCache?: PromptCache

  /**
   * T3.1 — backend for `clerum__session_search`. When set together with a
   * `sourceMessage`, the tool is registered in the native registry. Absent
   * when the SQLite store is disabled (memory mode) or when the feature
   * flag `CLERUM_SESSION_SEARCH_ENABLED` is OFF.
   */
  sessionSearchService?: SessionSearchService

  /**
   * R5 — provider-fallback support for THIS task. When present with a non-empty
   * `policy.fallbacks`, `buildLoopConfig` wraps the primary `LlmPort` so an
   * eligible provider error switches to the next fallback (adapter-per-attempt
   * so `usage_events` records the pair really served). Absent → no failover.
   */
  failover?: ExecutorFailoverSupport

  // Callbacks to coordinator
  onApprovalNeeded: (requestId: string, taskId: string, approval: PendingApproval) => void
  onComplete: (task: Task) => void
  onFail: (task: Task, error: TaskError) => void
}

export class TaskExecutor {
  private readonly responseSafety: BasicSafety
  readonly taskId: string
  private task: Task
  private conversation: Conversation | null = null
  private state: ExecutorState = 'processing'
  private deps: TaskExecutorDeps
  private abortController = new AbortController()
  private toolRegistryPromise: Promise<{
    registry: ToolRegistry
    loopController: LoopController
    bridge?: LoopConfig['bridge']
  }> | null = null
  private readonly spilloverResolver: SpilloverResolver
  /**
   * P.2 token counter. Built lazily on the first call to
   * `getOrCreateTokenCounter()` and shared across `runAgentLoop`,
   * `LlmPortAdapter`, and `PressureContextManager` so `recordObservedUsage`
   * accumulates across iterations of the same task.
   */
  private tokenCounter: TokenCounter | null = null
  /**
   * P2 token budgets (§5.2) — snapshot of the conversation's lifetime token
   * counters captured at task start, used as the per-task brake baseline.
   * Set in `run()` (once per task) only when the P1 verdict carried a per-task
   * cap; reused unchanged across `resumeAfterApproval`. `null` → brake disabled.
   */
  private taskTokenBaseline: TaskTokenBaseline | null = null
  private workflowCallerContextOverride: WorkflowCallerContext | null | undefined
  private workflowAccessDeniedResponse: string | null = null
  private workflowAccessDeniedReason: ProviderWorkflowAccessDenialReason | null = null
  private currentTurnToolNames = new Set<string>()
  /**
   * Latency attribution (stateless-agents): per-turn phase timing. Created at
   * run() start; emits one [TurnTiming] info line when the task completes.
   * Purely observational — never affects control flow (fail-safe recorder).
   */
  private turnTiming: TurnTimingRecorder | null = null

  // Completion tracking for graceful shutdown
  private resolveCompletion: (() => void) | null = null
  private completionPromise: Promise<void>

  constructor(task: Task, deps: TaskExecutorDeps) {
    this.task = task
    this.taskId = task.id
    this.deps = deps
    this.responseSafety = new BasicSafety(deps.secretEntriesProvider)
    // T1.5 — prefer a caller-supplied resolver (tests/mocks); else build the
    // FS-backed one from the storage; else fall back to the P.3 stub so
    // dev/test paths without spillover wired still work.
    this.spilloverResolver =
      deps.spilloverResolver ??
      (deps.spilloverStorage
        ? new FsSpilloverResolver({ storage: deps.spilloverStorage })
        : new StubSpilloverResolver())
    this.completionPromise = new Promise<void>(resolve => {
      this.resolveCompletion = resolve
    })
  }

  get executorState(): ExecutorState {
    return this.state
  }

  get pendingApproval(): PendingApproval | undefined {
    return this.conversation?.pending_approval
  }

  private approvedToolCorrelation: { toolCallId: string; approvalRequestId: string } | undefined

  /**
   * The serialized session key this executor owns (the store's LRU/evict key,
   * `<userId>:<channelType>:<channelId>[:<threadId>]`). Exposed so callers
   * (e.g. `AgentStateMachine.compactSession`) can detect "this session is
   * currently owned by an executor" without reaching into the private
   * conversation field.
   *
   * MUST agree with the key the store evicts by and the prompt-cache key.
   * Prefers `conversation.session_key` (the serialized key); falls back to
   * `user_id` only for conversations created before that field existed.
   * Do NOT return the bare `user_id`: `user_id` is `msg.sender`, which would
   * (a) never match the serialized `opts.sessionKey` in the busy guard and
   * (b) collide across channels/threads of the same user in the prompt cache.
   */
  get sessionKey(): string | undefined {
    return this.conversation?.session_key ?? this.conversation?.user_id
  }

  get sourceTask(): Task {
    return this.task
  }

  /** The AbortSignal for this executor's loop. Used by Task 3 tests. */
  get signal(): AbortSignal {
    return this.abortController.signal
  }

  async rehydrateWaitingApproval(sessionKey: string, approval: PendingApproval): Promise<void> {
    const message = this.task.sourceMessage
    this.conversation = await this.deps.conversationManager.getOrCreate(sessionKey, {
      userId: message?.sender,
      channelType: message?.channelType,
      channelId: message?.channelId,
      threadId: message?.threadId,
      source: message?.channelType,
    })
    if (
      this.conversation.pending_approval?.request_id !== approval.request_id ||
      this.conversation.activeTaskId !== this.taskId
    ) {
      throw new Error('persisted approval does not match its active conversation task')
    }
    this.task.traceContext = approval.traceContext ?? this.conversation.traceContext ?? null
    this.state = 'waiting_approval'
  }

  /**
   * Returns a promise that resolves when the executor finishes (completed, failed, or denied).
   * Used by AgentStateMachine.stop() to await graceful shutdown.
   */
  waitForCompletion(): Promise<void> {
    return this.completionPromise
  }

  /**
   * Run the task through the LLM tool-use loop.
   * On completion, calls onComplete or onFail callback.
   * On need_approval, sets state and calls onApprovalNeeded.
   */
  async run(): Promise<void> {
    console.log(`[TaskExecutor:${this.taskId}] Starting`)

    try {
      this.state = 'processing'
      this.turnTiming = new TurnTimingRecorder(this.task.createdAt)

      // 1. Resolve session key, get/create conversation
      // INVARIANT: for source==='cron' this MUST produce the same session key that
      // cronDispatch.ts enqueued the task under (both call resolveCronTaskSessionKey).
      // A divergence would run the task in a different session than it was queued in.
      const msg = this.task.sourceMessage
      const cronSession =
        this.task.source === 'cron' ? resolveCronTaskSessionKey(this.task) : undefined
      const sessionKey = resolveTaskSessionKey(this.task)
      console.log(`[TaskExecutor:${this.taskId}] Session key: ${sessionKey}`)

      const sessionLoadStart = Date.now()
      this.conversation = await this.deps.conversationManager.getOrCreate(sessionKey, {
        userId: cronSession?.userId ?? msg?.sender,
        channelType: cronSession?.channelType ?? msg?.channelType,
        channelId: cronSession?.channelId ?? msg?.channelId,
        threadId: cronSession?.threadId ?? msg?.threadId,
        source: cronSession?.channelType ?? msg?.channelType,
        // R2 — record the effective model served (resolved by the agent from the
        // session's saved selection before this executor was built) in the
        // `sessions.model` telemetry column at INSERT time.
        model: this.deps.modelName,
      })
      if (this.task.traceContext?.origin === 'channel_event' && !this.task.traceContext.sessionId) {
        this.task.traceContext = {
          ...this.task.traceContext,
          sessionId: this.conversation.id,
        }
      }
      const userInput = msg?.content || this.task.conversationHistory[0]?.content || ''
      // D3 — awaited durability barrier: the user message must be durable
      // before the LLM loop runs (it is the replay anchor after a crash). A
      // rejected write rolls back the turn inside startTurn and lands in
      // run()'s catch as a clean task failure.
      await this.deps.conversationManager.startTurn(
        this.conversation,
        userInput,
        this.taskId,
        this.task.traceContext ?? null
      )
      this.turnTiming?.addSessionLoadMs(Date.now() - sessionLoadStart)

      // P2 token budgets (§5.2) — capture the per-task brake baseline NOW, before
      // this task consumes anything. The conversation's lifetime counters are
      // session-cumulative (persist across restarts), so the brake measures the
      // DELTA vs this snapshot — a long-lived session is never aborted just for
      // accumulated history. Gated on the P1 verdict carrying a per-task cap so
      // the no-cap path stays identical to before (no baseline, brake disabled).
      this.captureTaskTokenBaseline()

      await this.prepareChannelWorkflowCallerContext()
      this.enqueueGovernedRunEvent('run_start', `task:${this.taskId}:start`)
      if (this.workflowAccessDeniedResponse && looksLikeWorkflowAccessRequest(userInput)) {
        this.logProviderWorkflowAccessDenied('request')
        await this.completeWithStaticResponse(this.workflowAccessDeniedResponse)
        return
      }

      // 2. Run the tool-use loop
      this.currentTurnToolNames.clear()
      const result = await this.runAgentLoop()

      // 3. Handle result
      await this.handleLoopResult(result)

      if (
        (this.state as ExecutorState) !== 'waiting_approval' &&
        !this.abortController.signal.aborted
      ) {
        this.state = 'completed'
        console.log(`[TaskExecutor:${this.taskId}] Completed`)
        this.turnTiming?.emit(this.taskId)
        this.deps.onComplete(this.task)
        this.resolveCompletion?.()
      } else if (this.abortController.signal.aborted) {
        console.log(`[TaskExecutor:${this.taskId}] Cancelled`)
        this.resolveCompletion?.()
      }
    } catch (error) {
      const taskError = this.toTaskError(error)
      console.error(
        `[TaskExecutor:${this.taskId}] Failed: code=${taskError.code} ` +
          `retryable=${taskError.retryable} message="${taskError.message}"`
      )
      this.state = 'failed'
      this.deps.onFail(this.task, taskError)
      this.resolveCompletion?.()
    }
  }

  /**
   * Resume execution after approval was granted.
   */
  async resumeAfterApproval(alwaysApprove: boolean): Promise<void> {
    if (this.state !== 'waiting_approval' || !this.conversation) {
      throw new Error(`Cannot resume: executor state is ${this.state}`)
    }

    console.log(`[TaskExecutor:${this.taskId}] Resuming after approval`)

    try {
      this.state = 'processing'

      // Guard: abort may have been called between approval request and resume.
      // The subscriber that aborted us already transitioned the task to cancelled.
      // Just clean up our own execution state. (PR-186 review M2; Invariant I1)
      if (this.abortController.signal.aborted) {
        console.log(`[TaskExecutor:${this.taskId}] Resume cancelled: already aborted`)
        this.resolveCompletion?.()
        return
      }

      const approvalBeforeResolution = this.conversation.pending_approval
      await this.deps.conversationManager.approve(this.conversation, alwaysApprove)
      if (approvalBeforeResolution?.tool_call_id) {
        this.approvedToolCorrelation = {
          toolCallId: approvalBeforeResolution.tool_call_id,
          approvalRequestId: approvalBeforeResolution.request_id,
        }
      }
      this.currentTurnToolNames.clear()

      const approval = this.conversation.pending_approval

      // Fallback: no snapshot, re-run from scratch
      if (!approval?.context_snapshot?.length) {
        console.log(`[TaskExecutor:${this.taskId}] No snapshot, re-running from scratch`)
        const result = await this.runAgentLoop()
        await this.handleLoopResult(result)
        if (
          (this.state as ExecutorState) !== 'waiting_approval' &&
          !this.abortController.signal.aborted
        ) {
          this.state = 'completed'
          this.deps.onComplete(this.task)
          this.resolveCompletion?.()
        } else if (this.abortController.signal.aborted) {
          console.log(`[TaskExecutor:${this.taskId}] Cancelled`)
          this.resolveCompletion?.()
        }
        return
      }

      // IronClaw invariant #2 (P.3 §4.3): resolve any spillover refs in the
      // snapshot BEFORE we execute the approved tool. If a ref is dead (TTL
      // expired or GC'd) we abort early — the audit invariant is that what
      // executes equals what the user approved. Re-running prior tools to
      // regenerate the blob could yield different output (web page changed,
      // file modified) → audit broken.
      const resolveCtx = {
        taskId: this.taskId,
        requestId: approval.request_id,
        toolName: approval.tool_name,
      }
      const resolveOnce = async (
        m: Pick<ToolResult, 'content' | 'spillover_ref'>
      ): Promise<string> => {
        // FsSpilloverResolver attaches `resolveCtx` to any ApprovalExpiredError
        // it throws. Other resolver implementations (e.g. test mocks) are
        // expected to throw their own ApprovalExpiredError directly.
        const resolver = this.spilloverResolver
        if (resolver instanceof FsSpilloverResolver) {
          return resolver.withContext(resolveCtx, () => resolver.resolve(m))
        }
        return resolver.resolve(m)
      }
      const resolvedCompletedResults: ToolResult[] = []
      try {
        for (const tr of approval.completed_results ?? []) {
          const resolvedContent = await resolveOnce({
            content: tr.content,
            spillover_ref: tr.spillover_ref,
          })
          resolvedCompletedResults.push({ ...tr, content: resolvedContent })
        }
      } catch (error) {
        if (error instanceof ApprovalExpiredError) {
          console.warn(
            `[TaskExecutor:${this.taskId}] approval_expired before tool execution:`,
            error.payload
          )
          await this.deps.conversationManager.failTurn(this.conversation!)
          this.state = 'failed'
          this.deps.onFail(this.task, {
            code: 'approval_expired',
            message: error.payload.user_message,
            retryable: false,
            provider: this.deps.llmProvider.getProviderType(),
          })
          this.resolveCompletion?.()
          return
        }
        throw error
      }

      // Execute approved tool outside loop.
      // IronClaw invariant #1: the snapshot's frozen messages must reach the
      // LLM verbatim — compaction would invalidate validateToolLinkages.
      const loopConfig = await this.buildLoopConfig({ skipContextManager: true })
      const suspendedCall = {
        id: approval.tool_call_id,
        name: approval.tool_name,
        arguments: approval.parameters,
      }
      const displayName = getDisplayName(suspendedCall.name)
      console.log(`[TaskExecutor:${this.taskId}] Executing approved tool: ${suspendedCall.name}`)
      this.currentTurnToolNames.add(suspendedCall.name)

      // executeToolCalls emits reportToolStart AFTER the approval gate, so approved
      // tools bypass it entirely. Emit the SSE bookends here so the UI sees the
      // full tool_start → tool_progress × N → tool_complete sequence (matching the
      // normal non-approval path). Without this, the UI has no step card to update
      // on tool_progress and is stuck visually on the approval dialog.
      const reporter = progressReporterRegistry.get(this.taskId)
      if (reporter) {
        reporter.reportToolStart({
          taskId: '', // overridden by SseProgressReporter
          toolCallId: suspendedCall.id,
          toolName: suspendedCall.name,
          displayName,
          intentSummary: approval.intent_summary ?? `Using ${displayName}...`,
          iteration: 0,
          stepIndex: 0,
          totalSteps: 1,
          inputPreview: extractInputPreview(suspendedCall.name, suspendedCall.arguments),
        })
      }

      const execStart = Date.now()
      const toolResult = await executeSingleTool(suspendedCall, loopConfig)

      if (reporter) {
        reporter.reportToolComplete({
          taskId: '',
          toolCallId: toolResult.tool_call_id,
          toolName: toolResult.name,
          displayName,
          durationMs: Date.now() - execStart,
          isError: toolResult.is_error ?? false,
          errorSummary: toolResult.is_error ? sanitizeError(toolResult.content) : undefined,
          iteration: 0,
          stepIndex: 0,
          totalSteps: 1,
          outputPreview: buildOutputPreview(toolResult.rawContent ?? toolResult.content),
          metadata: toolResult.metadata,
        })
      }

      // Reconstruct messages using the resolved completed_results.
      // `resolvedCompletedResults` is `approval.completed_results` with any
      // spillover refs swapped in for their blob bodies (invariant #2).
      const messages: ChatMessage[] = [
        ...approval.context_snapshot,
        ...resolvedCompletedResults.map((tr: ToolResult) => ({
          role: 'tool' as const,
          content: tr.content,
          tool_call_id: tr.tool_call_id,
          name: tr.name,
        })),
        {
          role: 'tool' as const,
          content: toolResult.content,
          tool_call_id: toolResult.tool_call_id,
          name: toolResult.name,
        },
      ]

      validateToolLinkages(messages)

      const previousAttachments = [
        ...(approval.attachments || []),
        ...this.collectAttachments([...(approval.completed_results || []), toolResult]),
      ]
      const result = await runToolUseLoop(loopConfig, messages)

      // Preserve attachments
      if (previousAttachments.length > 0) {
        if (result.type === 'response' || result.type === 'exhaustion') {
          result.attachments = [...previousAttachments, ...(result.attachments || [])]
        } else if (result.type === 'need_approval') {
          result.approval.attachments = [
            ...(result.approval.attachments || []),
            ...previousAttachments,
          ]
          result.approval.completed_results = [
            ...(approval.completed_results || []),
            toolResult,
            ...(result.approval.completed_results || []),
          ]
        }
      }

      await this.handleLoopResult(result)
      if (
        (this.state as ExecutorState) !== 'waiting_approval' &&
        !this.abortController.signal.aborted
      ) {
        this.state = 'completed'
        this.turnTiming?.emit(this.taskId)
        this.deps.onComplete(this.task)
        this.resolveCompletion?.()
      } else if (this.abortController.signal.aborted) {
        console.log(`[TaskExecutor:${this.taskId}] Cancelled`)
        this.resolveCompletion?.()
      }
    } catch (error) {
      const taskError = this.toTaskError(error)
      console.error(
        `[TaskExecutor:${this.taskId}] Resume failed: code=${taskError.code} ` +
          `retryable=${taskError.retryable} message="${taskError.message}"`
      )
      this.state = 'failed'
      this.deps.onFail(this.task, taskError)
      this.resolveCompletion?.()
    }
  }

  /**
   * Convert an unknown thrown error into a structured TaskError.
   * LlmError → pass through its code/message/retryable/provider.
   * Anything else → retryable ApiCallFailed with provider from the LLM.
   */
  private toTaskError(error: unknown): TaskError {
    if (error instanceof LlmError) {
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        provider: error.provider,
      }
    }
    return {
      code: LlmErrorCode.ApiCallFailed,
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      provider: this.deps.llmProvider.getProviderType(),
    }
  }

  /**
   * Deny the pending approval.
   *
   * **IronClaw write-through (T2.1)**: `ConversationManager.deny` awaits the
   * durable pending_approval delete before returning, so we await here too —
   * the channel notification (responseCallback) only fires after the DB
   * mutation lands. Callers that fire-and-forget should attach `.catch(...)`.
   */
  async deny(): Promise<void> {
    if (this.state !== 'waiting_approval' || !this.conversation) return

    const toolName = this.conversation.pending_approval?.tool_name || 'unknown'
    await this.deps.conversationManager.deny(this.conversation)

    // Terminal SSE event emitted automatically when onComplete → queue.completeTask
    // → lifecycle.transition('completed') fires (SseProgressReporter subscription).

    const denialMessage = `Tool \`${toolName}\` was denied by the user. The operation was not performed.`
    if (this.task.responseCallback) {
      this.task.responseCallback({ response: denialMessage }).catch(err => {
        console.error(`[TaskExecutor:${this.taskId}] Failed to send denial:`, err)
      })
    }

    this.state = 'completed'
    this.deps.onComplete(this.task)
    this.resolveCompletion?.()
  }

  /**
   * Signal an abort. The loop exits at its next checkpoint.
   *
   * Idempotent self-healing: drives the TaskLifecycle transition to 'cancelled'
   * before firing the AbortController. In the normal v2 flow the AgentStateMachine
   * lifecycle subscriber already transitioned the task before calling abort(), so
   * this transition() call returns AlreadyTerminal — a zero-cost no-op. For any
   * future direct caller that bypasses the subscriber (shutdown paths, test helpers,
   * new approval-denial flows), the task self-heals to 'cancelled' instead of being
   * stranded at 'processing'.
   *
   * Critically this does NOT write task.status directly — only TaskLifecycle writes
   * task state (Invariant I1 preserved). PR-193 review #1.
   */
  abort(): void {
    this.deps.taskLifecycle.transition(this.task.id, 'cancelled', 'user_requested')
    this.abortController.abort()
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * P2 token budgets (§5.2) — snapshot the conversation's lifetime token
   * counters as the per-task brake baseline. No-op (leaves `taskTokenBaseline`
   * null → brake disabled) unless the P1 verdict carried a per-task cap.
   */
  private captureTaskTokenBaseline(): void {
    if (!this.hasTaskBudgetCap() || !this.conversation) return
    this.taskTokenBaseline = snapshotTaskTokenBaseline(this.conversation)
  }

  /** True when the P1 budget verdict carried a per-task cap (tokens or cost). */
  private hasTaskBudgetCap(): boolean {
    const v = this.task.budgetVerdict
    return !!v && (v.maxTaskTokens != null || v.maxTaskCost != null)
  }

  /**
   * R2.6 — model-aware context window. The allowlist entry for the effective
   * model wins; falls back to the fixed `CLERUM_CONTEXT_MAX_TOKENS` env when the
   * allowlist carries no `contextWindowTokens` (or is unavailable/degraded).
   */
  private contextMaxTokens(): number {
    return this.deps.contextWindowTokens ?? appConfig.contextMaxTokens
  }

  private getOrCreateTokenCounter(): TokenCounter {
    if (!this.tokenCounter) {
      this.tokenCounter = createTokenCounter(this.deps.llmProvider, this.deps.modelName, {
        offline: appConfig.tokenizerOffline,
      })
      // Fire warmup asynchronously. `count()` awaits internally if it races.
      void this.tokenCounter.warmup().catch(err => {
        console.warn(`[TaskExecutor:${this.taskId}] tokenCounter.warmup failed:`, err)
      })
    }
    return this.tokenCounter
  }

  private async runAgentLoop(): Promise<LoopResult> {
    const historyStart = Date.now()
    let messages = this.deps.conversationManager.buildMessageHistory(this.conversation!)
    messages = compactConversation(messages, undefined, undefined, this.getOrCreateTokenCounter(), {
      enabled: appConfig.compactionPrePruneEnabled,
      options: {
        protectedTailTurns: appConfig.compactionPrePruneProtectedTailTurns,
        summaryThresholdTokens: appConfig.compactionPrePruneSummaryTokens,
        maxArgsBytes: appConfig.compactionPrePruneMaxArgsBytes,
        dedupEnabled: appConfig.compactionPrePruneDedup,
        oneLineSummariesEnabled: appConfig.compactionPrePruneOneLine,
        jsonSafeTruncateEnabled: appConfig.compactionPrePruneJsonTruncate,
        stripMediaEnabled: appConfig.compactionPrePruneStripMedia,
      },
    })
    // History rehydration + pre-prune compaction are part of the session-load
    // cost the user pays before the first model byte.
    this.turnTiming?.addSessionLoadMs(Date.now() - historyStart)
    const sourceMessageAttachments = this.buildSourceMessageContentParts()
    if (sourceMessageAttachments.length > 0) {
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.role === 'user') {
        messages[messages.length - 1] = {
          ...lastMessage,
          contentParts: sourceMessageAttachments,
        }
      }
    }
    // T2.2 — when the prompt cache is on, the volatile per-turn metadata
    // (date, channel, sender, cron) moves out of the (now byte-stable) system
    // prompt and into a `<turn-context>` block prepended to the LAST user
    // message of the turn. Only the first user message of the turn gets it;
    // `tool` messages keep their content untouched.
    if (appConfig.promptCacheEnabled) {
      this.prependTurnContextBlock(messages)
    }
    const promptAssemblyStart = Date.now()
    const loopConfig = await this.buildLoopConfig()
    if (this.turnTiming) {
      // buildLoopConfig assembles the tool registry (MCP schemas) and the
      // system identity (workspace files / tiered prompt parts).
      this.turnTiming.addPromptAssemblyMs(Date.now() - promptAssemblyStart)
      let inputChars = 0
      for (const m of messages) {
        if (typeof m.content === 'string') inputChars += m.content.length
      }
      this.turnTiming.setInputCharsApprox(inputChars)
    }
    return runToolUseLoop(loopConfig, messages)
  }

  /**
   * T2.2 — prepend the `<turn-context>` block to the latest user message
   * (mutates in place). The block carries date/channel/sender/cron; an empty
   * cron source still produces a valid block. For cron-originated turns with
   * no human user text we inject a synthetic `<cron task>` placeholder so the
   * wire shape stays consistent (P1-004 §5.5).
   */
  private prependTurnContextBlock(messages: ChatMessage[]): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'user') continue
      const block = buildTurnContextBlock({
        date: new Date(),
        channel: {
          type: this.task.sourceMessage?.channelType ?? 'internal',
          sender: this.task.sourceMessage?.sender ?? null,
        },
        cron: this.task.cronJobId
          ? {
              jobId: this.task.cronJobId,
              scheduledFor: new Date().toISOString(),
            }
          : undefined,
      })
      const isCron = this.task.cronJobId !== undefined
      const baseContent =
        m.content && m.content.length > 0 ? m.content : isCron ? '<cron task>' : m.content
      messages[i] = { ...m, content: block + baseContent }
      return
    }
  }

  private async handleLoopResult(result: LoopResult): Promise<void> {
    // T1.4 — clear anti-thrash bookkeeping at any terminal outcome. `need_approval`
    // is NOT terminal (it suspends), so the state must survive into resume.
    if (this.conversation && result.type !== 'need_approval' && this.conversation.compactionState) {
      this.conversation.compactionState = undefined
    }
    switch (result.type) {
      case 'response':
      case 'exhaustion': {
        const rawContent = result.type === 'response' ? result.content : result.message
        const guardedContent = await this.guardProviderWorkflowTriggerClaim(rawContent)
        const sanitized = this.responseSafety.sanitizeAssistantResponse(guardedContent)
        const content = sanitized.content
        if (sanitized.was_modified) {
          this.deps.coreEvents.emit({
            type: 'safety:output_sanitized',
            data: {
              toolName: 'assistant_response',
              originalLength: guardedContent.length,
              sanitizedLength: content.length,
              taskId: this.taskId,
            },
            timestamp: new Date(),
          })
        }
        // D3 — awaited durability barrier: the turn must be durable BEFORE the
        // client ACK (responseCallback). On a rejected write, follow the
        // need_approval pattern below: fail the turn and rethrow so run()'s
        // catch surfaces a clean failure — the client never gets an ACK for a
        // turn that was not persisted.
        try {
          await this.deps.conversationManager.completeTurn(this.conversation!, content)
        } catch (err) {
          await this.deps.conversationManager.failTurn(this.conversation!)
          throw err
        }
        if (this.task.responseCallback) {
          await this.task.responseCallback({
            response: content,
            attachments: result.attachments,
          })
        }
        // Terminal SSE event emitted automatically when onComplete → queue.completeTask
        // → lifecycle.transition('completed') fires (SseProgressReporter subscription).
        break
      }

      case 'need_approval': {
        // Durable write FIRST: under sqlite/dual the suspend can reject. We
        // must not tell the client "suspended" (SSE) or register the approval
        // before the durable state lands — otherwise a rejected write leaves a
        // contradictory SSE + an un-resolvable, poisoned conversation. On
        // failure, reset the turn (→ Idle) and rethrow so run()'s catch
        // surfaces it as a clean failure (CRIT-1 / sqlite-stores-10).
        try {
          await this.deps.conversationManager.suspendForApproval(
            this.conversation!,
            result.approval
          )
        } catch (err) {
          await this.deps.conversationManager.failTurn(this.conversation!)
          throw err
        }
        const reporter = progressReporterRegistry.get(this.taskId)
        if (reporter) {
          reporter.emitSuspended(
            getDisplayName(result.approval.tool_name),
            result.approval.request_id
          )
        }
        this.state = 'waiting_approval'
        this.deps.onApprovalNeeded(result.approval.request_id, this.taskId, result.approval)
        break
      }

      case 'cancelled': {
        // Release the conversation turn lock AND scrub the cancelled user_input from
        // LLM history so it does not leak into the next turn (BUG-9).
        // cancelTurn sets a synthetic assistant response on the current turn so that
        // buildMessageHistory emits a clean user↔assistant alternation.
        this.deps.conversationManager.cancelTurn(this.conversation!)
        // NOTE: We do NOT write task.status or task.completedAt here — TaskLifecycle is the
        // single writer (Invariant I1). The cancel subscriber in AgentStateMachine already
        // transitioned the task to cancelled before the loop checkpoint fired executor.abort().
        // Calling lifecycle.transition again would return AlreadyTerminal — redundant and
        // misleading.
        console.log(`[TaskExecutor:${this.taskId}] Cancelled: ${result.reason ?? 'no reason'}`)
        this.enqueueGovernedRunEvent('run_end', `task:${this.taskId}:end`, {
          status: 'cancelled',
        })
        break
      }

      case 'error': {
        await this.deps.conversationManager.failTurn(this.conversation!)
        throw result.error
      }

      default: {
        const _exhaustive: never = result
        void _exhaustive
      }
    }
  }

  private async completeWithStaticResponse(rawContent: string): Promise<void> {
    this.ensureProgressReporter()
    const sanitized = this.responseSafety.sanitizeAssistantResponse(rawContent)
    const content = sanitized.content
    if (sanitized.was_modified) {
      this.deps.coreEvents.emit({
        type: 'safety:output_sanitized',
        data: {
          toolName: 'assistant_response',
          originalLength: rawContent.length,
          sanitizedLength: content.length,
          taskId: this.taskId,
        },
        timestamp: new Date(),
      })
    }
    // D3 — same barrier-before-ACK contract as handleLoopResult 'response'.
    try {
      await this.deps.conversationManager.completeTurn(this.conversation!, content)
    } catch (err) {
      await this.deps.conversationManager.failTurn(this.conversation!)
      throw err
    }
    this.task.result = {
      response: content,
      model: this.deps.modelName,
      toolsUsed: [],
    }
    if (this.task.responseCallback) {
      await this.task.responseCallback({ response: content })
    }
    this.state = 'completed'
    console.log(`[TaskExecutor:${this.taskId}] Completed with static response`)
    this.deps.onComplete(this.task)
    this.resolveCompletion?.()
  }

  private ensureProgressReporter(): SseProgressReporter {
    // Idempotent get-or-create via the shared registry helper (same construction
    // site now reused by AgentStateMachine.handleTaskFailure for pre-executor
    // failures). Static fail-closed responses bypass the tool loop, but channel
    // readers still rely on the task lifecycle terminal event to update the user.
    return ensureReporter(
      this.taskId,
      this.deps.taskLifecycle,
      new BasicSafety(this.deps.secretEntriesProvider)
    )
  }

  /**
   * R5 — wrap the primary `LlmPort` with provider-failover when a policy is
   * wired for this task. Fallback entries are served by their OWN adapters,
   * built with the SAME per-task usage sink as the primary (so session token
   * accounting + `usage_events` stay correct) and a per-pair token counter.
   * Returns the primary unchanged when no policy / no fallbacks (byte-identical).
   */
  private wrapFailoverPort(primaryPort: LlmPortAdapter, conversation: Conversation): LlmPort {
    const support = this.deps.failover
    if (!support || support.policy.fallbacks.length === 0) return primaryPort
    const primaryProvider = this.deps.llmProvider.getProviderType()
    const primaryModel = this.deps.modelName
    return maybeWrapFailover({
      primaryPort,
      primaryPair: { provider: primaryProvider, model: primaryModel },
      engine: support.engine,
      policy: support.policy,
      buildFallbackPort: index => {
        const entry = support.policy.fallbacks[index]
        const provider = support.buildProvider(entry)
        if (!provider) return null
        // R5.7 — a SAME-provider fallback (other key) respects the session's
        // model; a CROSS-provider fallback serves its fixed entry model
        // (ignoring the session selection). Drives usage_events + the tokenizer.
        const servedModel = entry.provider === primaryProvider ? primaryModel : entry.model
        const counter = createTokenCounter(provider, servedModel, {
          offline: appConfig.tokenizerOffline,
        })
        return new LlmPortAdapter(
          provider,
          servedModel,
          provider.getProviderType(),
          this.deps.usageReporter,
          this.deps.usageStaticContext,
          this.buildDefaultUsageContext(),
          counter,
          usage => {
            this.deps.conversationManager.recordSessionUsage(conversation, usage)
            if (conversation.contextBreakdown && usage.input_tokens > 0) {
              conversation.contextBreakdown.totalInputTokens = usage.input_tokens
            }
          }
        )
      },
    })
  }

  private async buildLoopConfig(opts?: {
    /**
     * IronClaw invariant #1 (P.3): when `true`, the loop will skip
     * `contextManager.manage()` for the entire run. Set by
     * `resumeAfterApproval` so the snapshot reaches the LLM verbatim.
     *
     * When omitted, derived from `this.conversation.pending_approval`. The
     * fall-through default exists so that callers (e.g. `runAgentLoop` on
     * the initial turn) don't need to know about IronClaw — the conversation
     * shape decides.
     */
    skipContextManager?: boolean
  }): Promise<LoopConfig> {
    const progressReporter = this.ensureProgressReporter()

    const tokenCounter = this.getOrCreateTokenCounter()

    // Capture the conversation in a local const (not `this.conversation!` inside
    // the closure) so a later reassignment of `this.conversation` can't re-point
    // the usage sink at a different session.
    const conversation = this.conversation!
    const llmPort = new LlmPortAdapter(
      this.deps.llmProvider,
      this.deps.modelName,
      this.deps.llmProvider.getProviderType(),
      this.deps.usageReporter,
      this.deps.usageStaticContext,
      this.buildDefaultUsageContext(),
      tokenCounter,
      usage => {
        this.deps.conversationManager.recordSessionUsage(conversation, usage)
        // F1.3b — finalize the send-time breakdown's provisional total
        // (Σbuckets) with the provider's authoritative `input_tokens` from the
        // SAME call. Runs inside the usage sink so there is no lag/race (#8).
        if (conversation.contextBreakdown && usage.input_tokens > 0) {
          conversation.contextBreakdown.totalInputTokens = usage.input_tokens
        }
      }
    )

    // R5 — wrap the primary port with provider-failover when a policy is wired.
    // Each fallback entry gets its OWN adapter (built with the SAME per-task
    // usage sink + a per-pair token counter) so `usage_events` records the pair
    // really served. No policy → returns `llmPort` unchanged (byte-identical).
    const effectiveLlmPort = this.wrapFailoverPort(llmPort, conversation)

    const metadata: Record<string, unknown> = {}
    if (this.task.sourceMessage) {
      if (this.task.sourceMessage.channelType === 'rpc') {
        metadata.channelType = 'desktop'
      } else {
        metadata.channelType = this.task.sourceMessage.channelType
        metadata.sender = this.task.sourceMessage.sender
      }
    }

    const { registry, loopController, bridge } = await this.buildToolRegistry()

    // T2.2 — when the prompt-cache flag is ON and we have the dependencies
    // wired (PromptCache + WorkspaceService), build the tiered
    // `SystemPromptParts` once per session via the cache and ship them
    // out-of-band through `ReasoningPort`. Otherwise fall back to the legacy
    // single-string identity built by `buildSystemIdentity`.
    const reasoningFactory = new DefaultReasoningFactory(
      effectiveLlmPort,
      undefined,
      metadata,
      // F1.4 — wire the send-time context-window-breakdown capture. The sink is
      // bound to the captured `conversation` local (not `this.conversation!`) so
      // a later reassignment can't re-point it at a different session.
      tokenCounter,
      raw => this.deps.conversationManager.recordContextBreakdown(conversation, raw),
      this.contextMaxTokens()
    )
    const parts = await this.maybeGetOrBuildParts(registry.listDefinitions())
    const reasoning = parts
      ? reasoningFactory.createWithParts(parts)
      : reasoningFactory.create(await this.buildSystemIdentity(llmPort))

    const contextManager = new PressureContextManager(
      this.contextMaxTokens(),
      this.deps.workspaceService,
      effectiveLlmPort,
      tokenCounter,
      {
        dryRun: appConfig.tokenizerDryrun,
        ineffectiveRatio: appConfig.compactionIneffectiveRatio,
        ineffectiveMaxRun: appConfig.compactionIneffectiveMaxRun,
        events: this.deps.coreEvents,
        taskId: this.taskId,
        prePruneEnabled: appConfig.compactionPrePruneEnabled,
        prePruneOptions: {
          protectedTailTurns: appConfig.compactionPrePruneProtectedTailTurns,
          summaryThresholdTokens: appConfig.compactionPrePruneSummaryTokens,
          maxArgsBytes: appConfig.compactionPrePruneMaxArgsBytes,
          dedupEnabled: appConfig.compactionPrePruneDedup,
          oneLineSummariesEnabled: appConfig.compactionPrePruneOneLine,
          jsonSafeTruncateEnabled: appConfig.compactionPrePruneJsonTruncate,
          stripMediaEnabled: appConfig.compactionPrePruneStripMedia,
        },
        // T1.1 — structured summary template. Default OFF until the
        // bake-week confirms ≥80% `parseStatus:'ok'` on the configured model.
        structuredSummaryEnabled: appConfig.compactionStructuredSummary,
        // T2.2 — when a `summarize` tier runs we invalidate the prompt cache
        // (P0-005 §5.7): the daily-log snapshot is now stale (the summary just
        // got appended to it), and the next turn should re-snapshot.
        onCompactionEffective: this.deps.promptCache
          ? () => {
              const key = this.sessionKey
              if (key) this.deps.promptCache!.invalidate(key, 'compact')
            }
          : undefined,
      }
    )

    const loopConfig = buildLoopConfig({
      reasoning,
      toolRegistry: registry,
      safety: new BasicSafety(this.deps.secretEntriesProvider),
      events: this.buildTrackingEventEmitter(),
      // P.5: conversation is always set by the time buildLoopConfig runs —
      // runAgentLoop / resumeAfterApproval both construct it after
      // `getOrCreate(sessionKey)`. The non-null assertion mirrors how the
      // surrounding code already accesses `this.conversation!`.
      conversation: this.conversation!,
      loopController,
      contextManager,
      progressReporter,
      maxIterations: this.deps.config.maxToolCallsPerTask || 10,
      toolTimeout: appConfig.nativeTool.toolTimeout,
      toolProgressInterval: appConfig.nativeTool.toolProgressInterval,
    })
    loopConfig.abortSignal = this.abortController.signal
    // Guardrails (spec §6) — build the tool-lane guardrail from the Host block.
    // Undefined when no rules are configured (no-config compatibility, §5); a
    // malformed set throws here (fail-closed admission, §3/§5).
    loopConfig.guardrails = buildToolLaneGuardrail(this.deps.guardrailsConfig)
    // §6.3: cron/autonomous tasks have no human to answer an approval, so a
    // guardrail `ask` there fails safe to deny.
    loopConfig.executionMode = this.task.source === 'cron' ? 'unattended' : 'interactive'
    loopConfig.skipContextManager =
      opts?.skipContextManager ?? this.conversation?.pending_approval !== undefined
    // T1.5 — pass the storage + taskId down so `executeSingleTool` can persist
    // oversized outputs and stamp `spillover_ref` on the result.
    loopConfig.spilloverStorage = this.deps.spilloverStorage
    loopConfig.taskId = this.taskId
    // F3 (dynamic-tool-loading): context the `clerum__tool_call` bridge intercept
    // needs in `executeToolCalls`. Undefined when no McpManager is wired.
    loopConfig.bridge = bridge
    // P2 token budgets (§5.2): wire the per-task emergency brake when the P1
    // verdict carried a per-task cap AND we captured a start-of-task baseline.
    // Same baseline is reused across resumeAfterApproval (set once in run()), so
    // the delta spans the whole task. Left undefined otherwise → loop no-op.
    const verdict = this.task.budgetVerdict
    if (this.taskTokenBaseline && this.hasTaskBudgetCap() && verdict) {
      loopConfig.taskBrake = {
        maxTaskTokens: verdict.maxTaskTokens ?? null,
        maxTaskCost: verdict.maxTaskCost ?? null,
        price: verdict.price ?? null,
        baseline: this.taskTokenBaseline,
      }
    }
    return loopConfig
  }

  private buildTrackingEventEmitter(): AgentEventEmitter {
    return {
      emit: (event: AgentEvent) => {
        if (event.type === 'tool:called') {
          const toolName = typeof event.data.toolName === 'string' ? event.data.toolName.trim() : ''
          if (toolName) this.currentTurnToolNames.add(toolName)
        }
        if (event.type === 'llm:completed') {
          const iteration = typeof event.data.iteration === 'number' ? event.data.iteration : 0
          // Each approval resume starts a fresh loop at iteration zero.
          const occurrence = `${event.timestamp.getTime()}-${iteration}`
          this.enqueueGovernedRunEvent(
            'llm_call',
            `task:${this.taskId}:llm:${occurrence}`,
            {
              status: 'succeeded',
              model: this.deps.modelName,
              attempt: iteration + 1,
            },
            event.timestamp
          )
        }
        if (event.type === 'tool:completed') {
          const callId =
            typeof event.data.toolCallId === 'string'
              ? event.data.toolCallId
              : `${event.data.toolName ?? 'tool'}:${event.timestamp.getTime()}`
          this.enqueueGovernedToolCompletion(
            callId,
            typeof event.data.toolName === 'string' ? event.data.toolName : 'tool',
            event.data.toolKind === 'mcp_server_tool' || event.data.toolKind === 'workflow'
              ? event.data.toolKind
              : 'internal_tool',
            typeof event.data.toolSourceRef === 'string'
              ? event.data.toolSourceRef.trim() || null
              : null,
            Boolean(event.data.is_error),
            event.timestamp
          )
        }
        this.turnTiming?.recordEvent(event.type, event.data)
        this.deps.coreEvents.emit(event)
      },
      on: this.deps.coreEvents.on.bind(this.deps.coreEvents),
      off: this.deps.coreEvents.off.bind(this.deps.coreEvents),
    }
  }

  private enqueueGovernedToolCompletion(
    toolCallId: string,
    toolName: string,
    toolKind: 'internal_tool' | 'mcp_server_tool' | 'workflow',
    toolSourceRef: string | null,
    isError: boolean,
    occurredAt: Date
  ): void {
    const approvalRequestId =
      this.approvedToolCorrelation?.toolCallId === toolCallId
        ? this.approvedToolCorrelation.approvalRequestId
        : undefined
    this.enqueueGovernedRunEvent(
      'tool_call',
      `task:${this.taskId}:tool:${toolCallId}`,
      {
        status: isError ? 'failed' : 'succeeded',
        tool_name: toolName,
        tool_kind: toolKind,
        ...(toolSourceRef ? { tool_source_ref: toolSourceRef } : {}),
      },
      occurredAt,
      approvalRequestId
    )
    if (approvalRequestId) this.approvedToolCorrelation = undefined
  }

  private enqueueGovernedRunEvent(
    eventType: 'run_start' | 'llm_call' | 'tool_call' | 'approval' | 'token_usage' | 'run_end',
    sourceEventId: string,
    payload?: {
      status?: string
      error_class?: string
      tool_name?: string
      tool_kind?: 'internal_tool' | 'mcp_server_tool' | 'workflow'
      tool_source_ref?: string
      model?: string
      attempt?: number
      count?: number
    },
    occurredAt = new Date(),
    approvalRequestId?: string
  ): void {
    const trace = this.task.traceContext
    const hostRef = this.deps.usageStaticContext?.host_ref
    if (!trace || !hostRef) return
    this.deps.governedRunReporter?.enqueue({
      sourceEventId,
      occurredAt: occurredAt.toISOString(),
      eventType,
      runId: trace.runId,
      approvalRequestId,
      hostRef,
      sessionId: trace.sessionId ?? null,
      origin: trace.origin,
      ...(payload ? { payload } : {}),
    })
  }

  private async guardProviderWorkflowTriggerClaim(rawContent: string): Promise<string> {
    if (this.currentTurnToolNames.has('workflow_trigger')) return rawContent
    const sourceMessageContent = this.task.sourceMessage?.content ?? ''
    const sourceLooksLikeTriggerRequest = looksLikeWorkflowTriggerRequest(sourceMessageContent)
    const usedWorkflowReadTool = [...this.currentTurnToolNames].some(
      toolName => toolName.startsWith('workflow_') && toolName !== 'workflow_trigger'
    )
    if (usedWorkflowReadTool && !sourceLooksLikeTriggerRequest) return rawContent
    if (!looksLikeWorkflowTriggerSuccess(rawContent) && !sourceLooksLikeTriggerRequest) {
      return rawContent
    }

    const context = this.workflowCallerContextOverride
    if (
      !context ||
      !context.targetUserId ||
      (context.originChannelType !== 'telegram' &&
        context.originChannelType !== 'slack' &&
        context.originChannelType !== 'teams')
    ) {
      if (
        this.workflowAccessDeniedResponse &&
        isProviderWorkflowChannel(this.task.sourceMessage?.channelType)
      ) {
        this.logProviderWorkflowAccessDenied('trigger_claim')
        return this.workflowAccessDeniedResponse
      }
      return rawContent
    }
    const workflowContext: WorkflowCallerContext & { targetUserId: string } = {
      ...context,
      targetUserId: context.targetUserId,
    }

    try {
      return await this.resolveUnverifiedProviderWorkflowTriggerClaim(workflowContext)
    } catch (error) {
      console.warn(
        `[TaskExecutor:${this.taskId}] Could not resolve unverified provider workflow trigger claim; failing closed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return 'I could not verify that a workflow was triggered from this message. List workflows and run the workflow by name again.'
    }
  }

  private async resolveUnverifiedProviderWorkflowTriggerClaim(
    context: WorkflowCallerContext & { targetUserId: string }
  ): Promise<string> {
    const workflowName = await this.workflowNameMentionedInCurrentMessage(context)
    if (!workflowName) {
      return 'I could not verify which workflow should be triggered. List workflows and run the workflow by name again.'
    }

    const client = this.workflowBrokerClient()
    const resolution = await resolveEffectiveWorkflowTarget(client, context, workflowName)
    if (resolution.kind !== 'unique') {
      return resolution.message
    }

    return `I could not verify that ${workflowName} was triggered. Run ${workflowName} again so I can request approval from this conversation.`
  }

  private async workflowNameMentionedInCurrentMessage(
    context: WorkflowCallerContext & { targetUserId: string }
  ): Promise<string | null> {
    const content = this.task.sourceMessage?.content ?? ''
    const normalizedContent = content.toLocaleLowerCase('en-US')
    if (!normalizedContent.trim()) return null

    const result = await requestEffectiveWorkflowList(this.workflowBrokerClient(), context)
    const record =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {}
    const items = Array.isArray(record.items) ? record.items : []
    const names = items
      .flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const name = (item as Record<string, unknown>).name
        return typeof name === 'string' && name.trim() ? [name.trim()] : []
      })
      .sort((a, b) => b.length - a.length)

    const listedName =
      names.find(name => normalizedContent.includes(name.toLocaleLowerCase('en-US'))) ?? null
    if (listedName) return listedName

    const commandMatch = normalizedContent.match(
      /\b(?:run|trigger|start|execute)\s+([a-z0-9][a-z0-9._-]*)/
    )
    return commandMatch?.[1] ?? null
  }

  private workflowBrokerClient(): WorkflowBrokerClient {
    const getEnv = (key: string) => process.env[key]
    return new WorkflowBrokerClient(getEnv, createWorkflowControlTokenProvider(getEnv))
  }

  /**
   * Build the default UsageContext for this task. The adapter falls back to
   * this when an individual CompletionRequest doesn't carry its own.
   *
   * Mapping rules (v1):
   * - task.source = 'channel' + channelType = 'rpc' → source_kind = 'desktop',
   *     user_id = sender (the Desktop App is *not* a third-party channel; the
   *     RPC route stamps message.sender with the authenticated user's `sub`,
   *     so the UUID belongs in user_id, not sender.)
   * - task.source = 'channel'  → source_kind = 'channel', sender + channel_type from sourceMessage
   * - task.source = 'cron'     → source_kind = 'cron', cron_job_id from task.cronJobId
   * - task.source = 'internal' → source_kind = 'desktop'
   * Workflow-recipe LLM calls go through workflowService and are tagged
   * separately at that call site.
   */
  private buildDefaultUsageContext(): UsageContext | undefined {
    const t = this.task
    if (t.source === 'channel') {
      if (t.sourceMessage?.channelType === 'rpc') {
        const teamId =
          typeof t.sourceMessage.metadata?.teamId === 'string'
            ? t.sourceMessage.metadata.teamId.trim()
            : ''
        return {
          source_kind: 'desktop',
          traceContext: t.traceContext ?? null,
          team_id: teamId || null,
          user_id: t.sourceMessage.sender ?? null,
          task_id: t.id,
        }
      }
      return {
        source_kind: 'channel',
        traceContext: t.traceContext ?? null,
        sender: t.sourceMessage?.sender ?? null,
        channel_type: t.sourceMessage?.channelType ?? null,
        task_id: t.id,
      }
    }
    if (t.source === 'cron') {
      return {
        source_kind: 'cron',
        traceContext: t.traceContext ?? null,
        cron_job_id: t.cronJobId ?? null,
        task_id: t.id,
      }
    }
    if (t.source === 'internal') {
      return {
        source_kind: 'desktop',
        traceContext: t.traceContext ?? null,
        task_id: t.id,
      }
    }
    return { source_kind: 'unknown', traceContext: t.traceContext ?? null, task_id: t.id }
  }

  /**
   * T2.2 — get-or-build the tiered `SystemPromptParts` for this session.
   * Returns `undefined` when the cache flag is OFF or when no `PromptCache`
   * / `WorkspaceService` is wired (legacy path stays bit-identical). When
   * present the parts are looked up by sessionKey; a miss reads the four
   * identity files + a fresh `snapshotDailyLogs(2)` (frozen for the life of
   * this session) and runs the parts through `DefaultPromptBuilder.buildParts`.
   *
   * The lookup is per-task; the cache lives on the process and survives
   * across tasks of the same session, so multi-turn conversations get a
   * single build amortized over many LLM calls.
   */
  private async maybeGetOrBuildParts(
    tools: ToolDefinition[]
  ): Promise<SystemPromptParts | undefined> {
    if (!appConfig.promptCacheEnabled) return undefined
    if (!this.deps.promptCache || !this.deps.workspaceService) return undefined
    const sessionKey = this.sessionKey
    if (!sessionKey) return undefined

    const cached = this.deps.promptCache.get(sessionKey)
    // R2 — the system prompt embeds the model name, so a cache entry built for a
    // different (e.g. just-swapped) model is a miss: rebuild, but keep the frozen
    // dailyLogSnapshot so the daily-freeze invariant holds.
    if (cached?.parts && cached.model === this.deps.modelName) return cached.parts

    const dailyLogSnapshot =
      cached?.dailyLogSnapshot ?? (await this.deps.workspaceService.snapshotDailyLogs(2))
    const identityFiles = await this.deps.workspaceService.readIdentityFiles()
    const builder = new DefaultPromptBuilder()
    const hasMemoryTools = tools.some(t => t.name.startsWith('memory_'))
    const hasCapabilities = tools.some(t => t.name === 'clerum__get_capabilities')
    const hasDesktopTools = tools.some(
      t => t.name.startsWith('desktop_') || t.name.startsWith('browser_')
    )
    // Tool-presence gates MUST mirror `buildSystemPrompt` exactly so the cache
    // path emits byte-identical guidance to the legacy path. Note `includes('__')`
    // (not a strict MCP-server check) matches the legacy MCP-selection gate,
    // which also fires for `clerum__get_capabilities`.
    const hasWorkflowTools = tools.some(t => t.name.startsWith('workflow_'))
    // NOTE: this is intentionally still true when the bridge is active — the
    // `clerum__tool_search/describe/call` native/bridge tools also contain `__`,
    // so `MCP_SERVER_SELECTION_TEXT` still emits. That is fine: `TOOL_DISCOVERY_TEXT`
    // (gated below and emitted right after) clarifies the discovery flow. We do NOT
    // tighten the heuristic here — a stricter check would alter the flag-OFF default
    // path on native-only hosts and break the byte-identical guarantee. A deeper
    // suppression is deferred for that reason.
    const hasMcpTools = tools.some(t => t.name.includes('__'))
    // F4.1 — tool-discovery guidance gates on the bridge's presence, mirroring
    // `buildSystemPrompt` exactly so both prompt paths emit byte-identical text.
    // The static feature flag is ANDed in explicitly so the guidance is provably
    // never emitted on a default-OFF host; with the flag OFF clerum__tool_search
    // is not registered either, so this is belt-and-suspenders (LOCKED #5).
    const hasToolDiscovery =
      appConfig.dynamicToolsEnabled && tools.some(t => t.name === 'clerum__tool_search')
    const capabilities = hasCapabilities ? CAPABILITY_CONTRACT_TEXT : ''
    const platformHints: string[] = []
    if (hasDesktopTools) {
      platformHints.push(DESKTOP_ENVIRONMENT_HINT)
    }

    const parts = builder.buildParts({
      identityFiles,
      dailyLogSnapshot,
      model: this.deps.modelName,
      provider: this.deps.llmProvider.getProviderType(),
      platformHints,
      capabilities,
      workflowGuidance: hasWorkflowTools ? WORKFLOW_RECIPES_TEXT : '',
      mcpServerGuidance: hasMcpTools ? MCP_SERVER_SELECTION_TEXT : '',
      toolDiscoveryGuidance: hasToolDiscovery ? TOOL_DISCOVERY_TEXT : '',
      memoryGuidance: hasMemoryTools ? MEMORY_GUIDANCE_TEXT : '',
    })
    this.deps.promptCache.set(sessionKey, { parts, dailyLogSnapshot, model: this.deps.modelName })
    // P1-005: persist the stable_hash for auditability and so post-eviction
    // rebuilds in the same session can verify identity-files didn't drift.
    if (this.conversation) {
      this.deps.conversationManager.recordSystemPromptStableHash(
        this.conversation,
        parts.stableHash
      )
    }
    stampStableHashGauge(sessionKey, parts.stableHash)
    return parts
  }

  private async buildSystemIdentity(llmPort: LlmPortAdapter): Promise<string> {
    const providerType = this.deps.llmProvider.getProviderType()
    const modelLine =
      `You are an AI assistant powered by the ${this.deps.modelName} model (provider: ${providerType}). ` +
      'Use the available tools when needed to help the user.'

    if (this.deps.workspaceService) {
      const workspaceIdentity = await this.deps.workspaceService.assembleSystemPrompt()
      return workspaceIdentity ? `${workspaceIdentity}\n\n---\n\n${modelLine}` : modelLine
    }
    return modelLine
  }

  private async buildToolRegistry(): Promise<{
    registry: ToolRegistry
    loopController: LoopController
    bridge?: LoopConfig['bridge']
  }> {
    if (!this.toolRegistryPromise) {
      this.toolRegistryPromise = this.createToolRegistry()
    }

    try {
      return await this.toolRegistryPromise
    } catch (error) {
      this.toolRegistryPromise = null
      throw error
    }
  }

  private async createToolRegistry(): Promise<{
    registry: ToolRegistry
    loopController: LoopController
    bridge?: LoopConfig['bridge']
  }> {
    const workflowCallerContext =
      this.workflowCallerContextOverride === undefined
        ? await this.prepareChannelWorkflowCallerContext()
        : this.workflowCallerContextOverride
    const nativeRegistry = new NativeToolRegistry(
      appConfig.nativeTool,
      this.conversation!.id,
      this.deps.cronScheduler ?? undefined,
      this.task.sourceMessage,
      this.deps.workspaceService,
      this.deps.dynamicEnvProvider,
      workflowCallerContext,
      {
        maxBytes: appConfig.attachmentMaxBytes,
        secretEntriesProvider: this.deps.secretEntriesProvider,
      },
      this.deps.spilloverStorage,
      this.deps.sessionSearchService,
      // F2 (dynamic-tool-loading): backs the read-only discovery meta-tools
      // (clerum__tool_search / clerum__tool_describe). Reuses the same manager
      // already threaded into the MCP tool registry below.
      this.deps.mcpManager ?? undefined,
      // F3/F4 (dynamic-tool-loading): static feature flag. Gates registration of
      // the 3 bridge tools so a default-OFF host stays byte-identical to today.
      appConfig.dynamicToolsEnabled,
      // §13 (stateless agents): the active provider's credential slot is the
      // only one that survives into shell_exec's child env.
      this.deps.llmProvider.getProviderType()
    )
    await registerDesktopTools(nativeRegistry)
    const mcpRegistry = this.deps.mcpManager
      ? new McpToolRegistryAdapter(this.deps.mcpManager)
      : nativeRegistry
    const compositeRegistry = this.deps.mcpManager
      ? new CompositeToolRegistry(nativeRegistry, mcpRegistry)
      : nativeRegistry

    // Cron tasks run autonomously by design: the human trust decision happens at
    // job-creation time, so the runtime approval gate does NOT apply per-tool at
    // fire time (there is no user to approve). Containment is infrastructural
    // (Context allowlist, NetworkPolicy, tool-call and duration limits). See
    // issue #529.
    //
    // NARROW EXCEPTION (cron×stateless self-propagation containment): a
    // cron-sourced task may still call cron_manage. On a stateless host,
    // cron_manage create/enable each pin the pod awake (activeCronSchedules) and
    // let an already-approved schedule autonomously spawn/enable MORE schedules
    // — a prompt-injection self-propagation + cost lever. So on a stateless host
    // we DO wrap a cron-sourced task with the approval chain, but in
    // `cronManageGateOnly` mode: ONLY cron_manage create/enable can suspend;
    // every other tool call (incl. cron_manage list/get/delete/disable/trigger
    // and all non-cron_manage work) keeps #529's autonomy and proceeds. The
    // resulting suspension has no human to answer it in an autonomous run — that
    // is the desired containment: the suspicious create/enable is BLOCKED, not
    // auto-approved.
    const interactiveApprovalApplies = appConfig.enableApproval && this.task.source !== 'cron'
    const cronManageGateApplies =
      appConfig.enableApproval && this.task.source === 'cron' && appConfig.statelessLifecycle
    const approvalApplies = interactiveApprovalApplies || cronManageGateApplies
    const baseController = approvalApplies
      ? new UnifiedApprovalGateController(
          compositeRegistry,
          this.deps.approvalConfig,
          nativeRegistry,
          // Cron×stateless: forces HITL approval for cron_manage create/enable on
          // stateless hosts regardless of the per-tool approval override.
          // `cronManageGateOnly` narrows that to be the ONLY gate for a
          // cron-sourced task, preserving #529 autonomy for every other tool.
          {
            statelessLifecycle: appConfig.statelessLifecycle,
            cronManageGateOnly: cronManageGateApplies,
          }
        )
      : new DefaultLoopController()
    const innerController = approvalApplies
      ? new ApprovalController(this.conversation!, baseController)
      : baseController

    // F3/F4 (dynamic-tool-loading): the ENTIRE bridge surface is gated on the
    // STATIC feature flag (LOCKED #5: default OFF, opt-in). When the flag is OFF
    // we do NOT wrap with the DeferrableToolController and do NOT wire the bridge
    // context, so the controller chain is exactly as it was before this feature
    // (ApprovalController → UnifiedApprovalGateController → DefaultLoopController,
    // or the bare cron branch) and the executeToolCalls intercept stays inert
    // (resolveBridgeCall is a no-op when config.bridge is absent). With the flag
    // OFF the 3 bridge tools are not registered either (see NativeToolRegistry),
    // so the host is byte-identical to today.
    const mcpManager = this.deps.mcpManager
    if (!appConfig.dynamicToolsEnabled) {
      return { registry: compositeRegistry, loopController: innerController }
    }

    // F3 (dynamic-tool-loading): wrap the inner controller (approval OR cron
    // branch) with the OUTERMOST DeferrableToolController so cron sessions also
    // get the stable swap. `nativeNames` is the exact native set (incl. the 3
    // bridges) — membership decides native vs deferrable (Critical: clerum__*
    // contains `__` but is native). The controller latches `bridgeActive` on its
    // first refreshTools (LOCKED #6). When there is no McpManager there are no
    // deferrable tools, so the controller stays passthrough.
    const nativeNames = new Set(nativeRegistry.listDefinitions().map(d => d.name))
    // LOCKED #6: the latch lives on the session-scoped Conversation, NOT on the
    // per-task controller, so a server connecting/disconnecting BETWEEN turns
    // cannot flip `tools[]` and re-introduce cache invalidation. Ephemeral RAM
    // (not a DB column), recomputed on cold-load — consistent with #3.
    const conversation = this.conversation!
    const loopController: LoopController = new DeferrableToolController(
      innerController,
      nativeNames,
      {
        dynamicToolsEnabled: appConfig.dynamicToolsEnabled,
        dynamicToolsThreshold: appConfig.dynamicToolsThreshold,
      },
      {
        get: () => conversation.dynamicToolsBridgeActive,
        set: value => {
          conversation.dynamicToolsBridgeActive = value
        },
      }
    )

    // The bridge intercept (executeToolCalls) needs `nativeNames` + the live
    // deferrable catalog. Only wired when an McpManager is present — otherwise
    // there is nothing to defer and the intercept stays inert.
    const bridge: LoopConfig['bridge'] = mcpManager
      ? {
          nativeNames,
          getDeferrableCatalogNames: () =>
            new Set(
              mcpManager
                .getAllTools()
                .map(t => t.name)
                .filter(name => !nativeNames.has(name))
            ),
        }
      : undefined

    return { registry: compositeRegistry, loopController, bridge }
  }

  private async prepareChannelWorkflowCallerContext(): Promise<
    WorkflowCallerContext | null | undefined
  > {
    if (this.workflowCallerContextOverride !== undefined) return this.workflowCallerContextOverride

    const message = this.task.sourceMessage
    if (!message || message.channelType === 'rpc') {
      this.workflowAccessDeniedResponse = null
      this.workflowAccessDeniedReason = null
      this.workflowCallerContextOverride = undefined
      return undefined
    }
    if (
      message.channelType !== 'telegram' &&
      message.channelType !== 'slack' &&
      message.channelType !== 'teams'
    ) {
      this.workflowAccessDeniedResponse = null
      this.workflowAccessDeniedReason = null
      this.workflowCallerContextOverride = null
      return null
    }
    if (!message.providerIdentity) {
      this.setProviderWorkflowAccessDenied(message, 'missing_provider_identity')
      return null
    }

    try {
      const context = await resolveProviderWorkflowCallerContext(
        message,
        key => process.env[key],
        this.task.traceContext
      )
      if (context) {
        this.workflowAccessDeniedResponse = null
        this.workflowAccessDeniedReason = null
        this.workflowCallerContextOverride = context
        return context
      }
    } catch (error) {
      console.warn(
        `[TaskExecutor:${this.taskId}] Provider workflow identity resolution failed; closing channel workflow access: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    this.setProviderWorkflowAccessDenied(message, 'unverified_provider_identity')
    return null
  }

  private setProviderWorkflowAccessDenied(
    message: NonNullable<Task['sourceMessage']>,
    reason: ProviderWorkflowAccessDenialReason
  ): void {
    this.workflowCallerContextOverride = null
    this.workflowAccessDeniedResponse = workflowAccessDeniedResponseForMessage(message)
    this.workflowAccessDeniedReason = reason
  }

  private logProviderWorkflowAccessDenied(stage: 'request' | 'trigger_claim'): void {
    const message = this.task.sourceMessage
    const channel = isProviderWorkflowChannel(message?.channelType)
      ? message.channelType
      : 'unknown'
    console.warn(
      `[TaskExecutor:${this.taskId}] Provider workflow access denied: channel=${channel} stage=${stage} reason=${
        this.workflowAccessDeniedReason ?? 'unverified_provider_identity'
      }`
    )
  }

  private collectAttachments(results: ToolResult[]): Attachment[] {
    const attachments: Attachment[] = []
    for (const r of results) {
      if (r.attachments) {
        attachments.push(...r.attachments)
      }
    }
    return attachments
  }

  private buildSourceMessageContentParts(): MessageContentPart[] {
    const providerType = this.deps.llmProvider.getProviderType()
    // getProviderType() always returns a registered LlmProvider, so in practice
    // this never drops images for a known provider — that's the point: a new
    // registry provider keeps its image attachments instead of silently losing
    // them to a stale allow-list.
    if (!isLlmProvider(providerType)) {
      return []
    }
    const sourceAttachments = this.task.sourceMessage?.attachments
    if (!sourceAttachments || sourceAttachments.length === 0) {
      return []
    }
    const imageParts = sourceAttachments
      .filter(
        att =>
          att.kind === 'image' && (att.mimeType === 'image/jpeg' || att.mimeType === 'image/png')
      )
      .map(
        (att): MessageContentPart => ({
          type: 'image',
          mimeType: att.mimeType as 'image/jpeg' | 'image/png',
          data: att.dataBase64,
        })
      )
    if (!imageParts.length) {
      return []
    }
    const userText = this.task.sourceMessage?.content?.trim() || 'User attached image(s).'
    return [{ type: 'text', text: userText }, ...imageParts]
  }
}
