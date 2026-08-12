import type { TaskBrakeConfig } from '../../budget/taskBrake'
import type { ProgressReporter } from '../../progress/types.js'
import type { ToolLaneGuardrail } from '../guardrails'
import {
  AgentEventEmitter,
  ContextManageOptions,
  ContextManager,
  LoopController,
  ReasoningPort,
  Safety,
  ToolOutputProcessor,
  ToolRegistry,
} from '../interfaces'
import { DefaultToolOutputProcessor } from '../safety/toolOutputProcessor'
import type { SpilloverStorage } from '../spillover'
import { ChatMessage, Conversation, PendingApproval, ToolDefinition } from '../types'

/**
 * Configuration for the tool-use loop.
 *
 * All extension hooks have passthrough defaults. Override any subset.
 */
export interface LoopConfig {
  // Core dependencies
  reasoning: ReasoningPort
  toolRegistry: ToolRegistry
  safety: Safety
  events: AgentEventEmitter

  /**
   * P.5: the Conversation that owns this loop execution. Required because the
   * context manager and downstream plans (T1.4 anti-thrash, T2.2 prompt cache)
   * need per-session state. Plumbed in from `TaskExecutor.buildLoopConfig()`.
   * Required (not optional) on purpose: making it optional would allow a
   * silent bypass where compaction state never gets written back.
   */
  conversation: Conversation

  // Extension points
  loopController: LoopController
  contextManager: ContextManager
  toolOutputProcessor: ToolOutputProcessor

  /**
   * Tool-lane guardrail (spec §6). Absent = no guardrails configured = today's
   * behavior (no-config compatibility, spec §5). Consulted in `executeToolCalls`
   * before approval/execution: deny → bounded error, ask → suspension,
   * allow/no_decision → the existing approval path.
   */
  guardrails?: ToolLaneGuardrail

  // Progress reporting
  progressReporter?: ProgressReporter

  // Limits
  maxIterations: number
  toolTimeout: number // ms per tool execution
  toolProgressInterval: number // ms between tool_progress snapshots; 0 disables streaming

  /** Optional abort signal. When aborted, the loop exits at the next checkpoint. */
  abortSignal?: AbortSignal

  /**
   * P2 token budgets — per-task emergency brake (§5.2). When the P1 pre-task
   * budget check returned a per-task cap, `TaskExecutor` plumbs the caps + the
   * active price + a baseline snapshot of the conversation's lifetime token
   * counters (taken at task start) here. Before each LLM call the loop measures
   * the DELTA spent by THIS task (current counters − baseline, read off
   * `config.conversation`) and exits cleanly when it exceeds the cap.
   *
   * Absent when budgets are off or no per-task cap matched → the brake check is
   * a total no-op (a single short-circuiting `if`, zero network, zero overhead).
   */
  taskBrake?: TaskBrakeConfig

  /**
   * IronClaw invariant #1 (P.3): when true, PressureContextManager.manage()
   * is skipped for this loop run. Set by TaskExecutor.buildLoopConfig() when
   * the conversation has a pending_approval at config-build time.
   *
   * Fires both at suspend (the iteration that returns need_approval) and on
   * resume (the iteration that follows resumeAfterApproval). At suspend the
   * snapshot is frozen — compaction mid-iteration would mutate the messages
   * and invalidate the snapshot. On resume the messages reconstructed from
   * context_snapshot + completed_results MUST be passed verbatim to the LLM
   * or validateToolLinkages would tear the tool linkages.
   *
   * Emits `compaction:skipped` with `reason='pending_approval'` so observers
   * (activity hub, metrics) see the skipped path.
   */
  skipContextManager?: boolean

  /**
   * T1.5 — Tool-result spillover. When set, `executeSingleTool` calls
   * `spilloverStorage.maybePersist(...)` on every non-error output that is
   * not produced by `clerum__spillover_read`. Outputs over the threshold are
   * persisted out-of-band and the `tool` message ships a `SpilloverSummary`
   * in `content` plus the URI on the lateral `spillover_ref` field.
   *
   * When undefined, `executeSingleTool` returns inline content as before
   * (1:1 with the pre-T1.5 behavior).
   */
  spilloverStorage?: SpilloverStorage
  /**
   * T1.5 — Owner of any spilled blob. Required when `spilloverStorage` is set
   * so the URI carries the correct `<task_id>` segment. Plumbed from
   * `TaskExecutor.taskId`.
   */
  taskId?: string

  /**
   * F3 (dynamic-tool-loading) — context the `clerum__tool_call` bridge intercept
   * needs in `executeToolCalls`. Present only when the host wired the
   * `McpManager` AND the discovery bridge is registered. When undefined, the
   * intercept is inert: `clerum__tool_call` falls through to the native
   * safety-net tool (which errors), and there is no auto-recover scope gate.
   *
   * - `nativeNames` — the exact set of native tool names (incl. the 3 bridges).
   *   Used to reject recursion (LOCKED #11) and to distinguish native from
   *   deferrable MCP names (membership, NOT a string heuristic).
   * - `getDeferrableCatalogNames` — returns the live set of deferrable MCP tool
   *   names (`McpManager.getAllTools()` names, minus natives). Re-derived per
   *   call so it tracks servers connecting/disconnecting (stateless; the scope
   *   gate, LOCKED #7 / Critical #7, rejects out-of-catalog names).
   */
  bridge?: {
    nativeNames: Set<string>
    getDeferrableCatalogNames: () => Set<string>
  }
}

/**
 * Default loop controller: all hooks are passthroughs.
 */
export class DefaultLoopController implements LoopController {
  shouldAccept(_content: string, _iteration: number): boolean {
    return true // Always accept text responses
  }

  onTextRejected(_content: string, _iteration: number): ChatMessage | null {
    return null // No nudge
  }

  beforeTool(
    _toolName: string,
    _params: Record<string, unknown>
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval } {
    return 'proceed' // Always proceed
  }

  onExhaustion(iteration: number): string {
    return (
      `I've reached the maximum number of tool-use iterations (${iteration}). ` +
      `Please try a more specific request.`
    )
  }

  async refreshTools(currentTools: ToolDefinition[]): Promise<ToolDefinition[]> {
    return currentTools // No refresh
  }
}

/**
 * Default context manager: passthrough (no compaction).
 */
export class DefaultContextManager implements ContextManager {
  manage(
    messages: ChatMessage[],
    _conversation: Conversation,
    _options?: ContextManageOptions
  ): ChatMessage[] {
    return messages // No compaction
  }
}

/**
 * Check whether an object implements the full LoopController interface.
 */
function isFullLoopController(obj: Partial<LoopController>): obj is LoopController {
  return (
    typeof obj.shouldAccept === 'function' &&
    typeof obj.onTextRejected === 'function' &&
    typeof obj.beforeTool === 'function' &&
    typeof obj.onExhaustion === 'function' &&
    typeof obj.refreshTools === 'function'
  )
}

/**
 * Build a complete LoopConfig with sensible defaults.
 * Only override what you need.
 *
 * When a full LoopController implementation is passed (e.g. ApprovalController),
 * it is used directly to preserve `this` context for class-based controllers.
 */
export function buildLoopConfig(params: {
  reasoning: ReasoningPort
  toolRegistry: ToolRegistry
  safety: Safety
  events: AgentEventEmitter
  conversation: Conversation
  loopController?: Partial<LoopController>
  contextManager?: ContextManager
  toolOutputProcessor?: ToolOutputProcessor
  progressReporter?: ProgressReporter
  maxIterations?: number
  toolTimeout?: number
  toolProgressInterval?: number
}): LoopConfig {
  const dc = new DefaultLoopController()

  // If a full LoopController is provided, use it directly to preserve `this` context.
  // Otherwise, build a plain object with per-method fallbacks.
  let resolvedController: LoopController
  if (params.loopController && isFullLoopController(params.loopController)) {
    resolvedController = params.loopController
  } else {
    const partial = params.loopController
    resolvedController = {
      shouldAccept: partial?.shouldAccept?.bind(partial) ?? dc.shouldAccept.bind(dc),
      onTextRejected: partial?.onTextRejected?.bind(partial) ?? dc.onTextRejected.bind(dc),
      beforeTool: partial?.beforeTool?.bind(partial) ?? dc.beforeTool.bind(dc),
      onExhaustion: partial?.onExhaustion?.bind(partial) ?? dc.onExhaustion.bind(dc),
      refreshTools: partial?.refreshTools?.bind(partial) ?? dc.refreshTools.bind(dc),
    }
  }

  return {
    reasoning: params.reasoning,
    toolRegistry: params.toolRegistry,
    safety: params.safety,
    events: params.events,
    conversation: params.conversation,
    loopController: resolvedController,
    contextManager: params.contextManager ?? new DefaultContextManager(),
    toolOutputProcessor:
      params.toolOutputProcessor ?? new DefaultToolOutputProcessor(params.safety),
    progressReporter: params.progressReporter,
    maxIterations: params.maxIterations ?? 10,
    toolTimeout: params.toolTimeout ?? 60000,
    toolProgressInterval: params.toolProgressInterval ?? 30000,
  }
}
