/**
 * ApprovalController - LoopController decorator for tool approval.
 *
 * Phase 6: Wraps a delegate LoopController (UnifiedApprovalGateController)
 * and intercepts beforeTool() before the delegate's approval check fires.
 *
 * Approval decisions go through loopController.beforeTool() in toolUseLoop
 * (SPEC-UNIFIED §21). The one other decision point is the guardrail `ask`
 * lane in toolCallPolicy, which consumes only an exact one-shot grant.
 * Both read denials through core/conversation/denialPolicy.
 *
 * The decorator chain:
 *   ApprovalController (denial re-ask, re-ask for tools that start other tools
 *     while a denial is active, forced approval, live tools → delegate, exact
 *     auto_approved_tools / task_approved_tools name, then a one-shot of the
 *     same tool call id and arguments)
 *     └─ UnifiedApprovalGateController (MCP tool? → suspend. Native requiresApproval? → suspend. Else → "proceed")
 *
 * A "*" entry or an MCP server prefix in auto_approved_tools does not
 * short-circuit this gate. Gate 2 (tool.requiresApproval() inside toolUseLoop)
 * was REMOVED as part of the BUG-11 fix.
 */
import { randomUUID } from 'node:crypto'
import { logger } from '../../logger'
import { hasActiveDenials, isDenied } from '../conversation/denialPolicy'
import { LoopController, ToolRegistry } from '../interfaces'
import { ChatMessage, PendingApproval, ToolDefinition } from '../types'
import type { Conversation } from '../types'
import { oneShotMatches } from './approvalMatch'

/**
 * Native tools whose approval is scoped to the tool itself. A plain approval
 * stores the name in `task_approved_tools`, so the tool runs without a new card
 * for the rest of the current task, including after resumes; the next user
 * message starts a new task and asks again. An "always" approval stores it in
 * `auto_approved_tools`, which covers later tasks while the conversation stays
 * in memory. Neither survives a cold resume.
 */
export const SESSION_SCOPED_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  'shell_exec',
  'http_request',
  'cron_manage',
])

/**
 * Source of approvals that no stored approval may cover (the cron×stateless
 * create/enable gate). Implemented by UnifiedApprovalGateController.
 */
export interface ForcedApprovalGate {
  forcedApproval(
    toolName: string,
    params: Record<string, unknown>
  ): { type: 'suspend'; approval: PendingApproval } | null
}

export interface ApprovalControllerOptions {
  /** Cron×stateless keeps #529 autonomy: a denial must not turn a proceed
   * into a suspension for list/get/delete. Default true. */
  honorDenials?: boolean
  toolRegistry?: ToolRegistry
  /** Tools that always consult the delegate for every model-generated call. */
  liveApprovalTools?: ReadonlySet<string>
  /** Forced approvals ask on every call, before any stored approval. */
  forcedApprovalGate?: ForcedApprovalGate
}

/** cron_manage actions that start or schedule autonomous work. */
const CRON_STARTING_ACTIONS = new Set(['create', 'enable', 'trigger'])

/**
 * Tools that can run other tools out of the user's sight. While a denial is
 * active they ask again, since the denied tool could run through them.
 */
function startsOtherTools(toolName: string, params: Record<string, unknown>): boolean {
  if (toolName === 'workflow_trigger') return true
  return (
    toolName === 'cron_manage' &&
    typeof params.action === 'string' &&
    CRON_STARTING_ACTIONS.has(params.action)
  )
}

function reaskDescription(toolName: string, reask: 'denied' | 'denials_active'): string {
  return reask === 'denied'
    ? `Tool "${toolName}" was denied and must be approved again`
    : `Tool "${toolName}" can run other tools, and another tool was denied in this chat, so it must be approved again`
}

/**
 * Decorator that honors a denial, a forced approval, live tools, then an exact
 * allowlisted name, then a one-shot pending approval, before delegating.
 */
export class ApprovalController implements LoopController {
  private readonly conversation: Conversation
  private readonly delegate: LoopController
  private readonly honorDenials: boolean
  private readonly toolRegistry?: ToolRegistry
  private readonly liveApprovalTools: ReadonlySet<string>
  private readonly forcedApprovalGate: ForcedApprovalGate | undefined

  constructor(
    conversation: Conversation,
    delegate: LoopController,
    options?: ApprovalControllerOptions
  ) {
    this.conversation = conversation
    this.delegate = delegate
    this.honorDenials = options?.honorDenials !== false
    this.toolRegistry = options?.toolRegistry
    this.liveApprovalTools = options?.liveApprovalTools ?? new Set<string>()
    this.forcedApprovalGate = options?.forcedApprovalGate
  }

  shouldAccept(content: string, iteration: number): boolean {
    return this.delegate.shouldAccept(content, iteration)
  }

  onTextRejected(content: string, iteration: number): ChatMessage | null {
    return this.delegate.onTextRejected(content, iteration)
  }

  /**
   * Order: denial re-ask, re-ask for tools that start other tools while a
   * denial is active, forced approval, live tools, exact allowlisted name
   * (auto_approved_tools / task_approved_tools), one-shot of the same tool call
   * id and arguments, otherwise the delegate.
   *
   * A forced approval (cron×stateless create/enable) always suspends: no stored
   * approval covers it, and the approved frozen call runs directly on resume.
   * Live-approval tools always consult the delegate.
   *
   * One-shot approval matches the call the user just approved. A later call
   * of the same name with different arguments or a new id suspends again.
   */
  beforeTool(
    toolName: string,
    params: Record<string, unknown>,
    toolCallId?: string
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval } {
    if (this.honorDenials && isDenied(this.conversation, toolName)) {
      logger.info(
        { event: 'approval_reask_required', toolName },
        'Previously denied tool requires approval again'
      )
      return this.reask(toolName, params, toolCallId, 'denied')
    }

    if (
      this.honorDenials &&
      hasActiveDenials(this.conversation) &&
      startsOtherTools(toolName, params)
    ) {
      logger.info(
        { event: 'approval_reask_required', toolName, reason: 'chat_has_denials' },
        'A tool that can start other tools requires approval while a tool denial is active'
      )
      return this.reask(toolName, params, toolCallId, 'denials_active')
    }

    const forced = this.forcedApprovalGate?.forcedApproval(toolName, params)
    if (forced) return forced

    // The approved frozen call executes directly in resumeAfterApproval.
    // Every model-generated live call needs a new delegate decision; retained
    // snapshot data and persistent approvals cannot authorize another invocation.
    if (this.liveApprovalTools.has(toolName)) {
      const decision = this.delegate.beforeTool(toolName, params, toolCallId)
      return typeof decision === 'object'
        ? {
            ...decision,
            approval: { ...decision.approval, authorization_scope: 'exact_invocation' },
          }
        : decision
    }

    // Exact-name grants: "always" approvals, then this task's plain
    // session-scoped approvals.
    if (
      this.conversation.auto_approved_tools.has(toolName) ||
      this.conversation.task_approved_tools?.has(toolName) === true
    ) {
      return 'proceed'
    }

    const pending = this.conversation.pending_approval
    if (pending && oneShotMatches(pending, toolName, params, toolCallId)) {
      this.conversation.pending_approval = undefined
      return 'proceed'
    }

    return this.delegate.beforeTool(toolName, params, toolCallId)
  }

  /**
   * Suspend for a re-ask. The gate's own card (and its description, e.g. the
   * stateless cron cost warning) is kept and only marked; when the gate would
   * proceed, a re-ask card is built here. A re-ask authorizes only the call it
   * shows: it never offers Always approve.
   */
  private reask(
    toolName: string,
    params: Record<string, unknown>,
    toolCallId: string | undefined,
    reask: 'denied' | 'denials_active'
  ): 'skip' | { type: 'suspend'; approval: PendingApproval } {
    const decision = this.delegate.beforeTool(toolName, params, toolCallId)
    if (decision === 'skip') return decision
    const approval =
      decision === 'proceed'
        ? this.reapproval(toolName, params, reaskDescription(toolName, reask))
        : decision.approval
    return {
      type: 'suspend',
      approval: {
        ...approval,
        reask,
        authorization_scope: 'exact_invocation',
      },
    }
  }

  private reapproval(
    toolName: string,
    params: Record<string, unknown>,
    description: string
  ): PendingApproval {
    const tool = this.toolRegistry?.get(toolName) ?? null
    const trace = tool?.traceDescriptor?.(params)
    return {
      request_id: randomUUID(),
      tool_name: toolName,
      ...(trace ? { tool_kind: trace.kind, tool_source_ref: trace.sourceRef } : {}),
      parameters: params,
      description,
      tool_call_id: '',
      context_snapshot: [],
    }
  }

  onExhaustion(iteration: number): string {
    return this.delegate.onExhaustion(iteration)
  }

  async refreshTools(currentTools: ToolDefinition[]): Promise<ToolDefinition[]> {
    return this.delegate.refreshTools(currentTools)
  }
}
