/**
 * ApprovalController - LoopController decorator for tool approval.
 *
 * Phase 6: Wraps a delegate LoopController (UnifiedApprovalGateController)
 * and intercepts beforeTool() before the delegate's approval check fires.
 *
 * There is a SINGLE approval gate in the code (SPEC-UNIFIED §21):
 *   loopController.beforeTool() in toolUseLoop.ts
 *
 * The decorator chain:
 *   ApprovalController (denial suspend, then exact auto_approved_tools name,
 *     then one-shot of the same tool call id and arguments → "proceed")
 *     └─ UnifiedApprovalGateController (MCP tool? → suspend. Native requiresApproval? → suspend. Else → "proceed")
 *
 * A "*" entry or an MCP server prefix in auto_approved_tools does not
 * short-circuit this gate. Gate 2 (tool.requiresApproval() inside toolUseLoop)
 * was REMOVED as part of the BUG-11 fix. All approval decisions now flow
 * through this single gate.
 */
import { randomUUID } from 'node:crypto'
import { logger } from '../../logger'
import { LoopController, ToolRegistry } from '../interfaces'
import { ChatMessage, PendingApproval, ToolDefinition } from '../types'
import type { Conversation } from '../types'
import { oneShotMatches } from './approvalMatch'

export interface ApprovalControllerOptions {
  /** Cron×stateless keeps #529 autonomy: a denial must not turn a proceed
   * into a suspension for list/get/delete. Default true. */
  honorDenials?: boolean
  toolRegistry?: ToolRegistry
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
 * Decorator that honors a denial, then an exact allowlisted name, then a
 * one-shot pending approval, before delegating.
 */
export class ApprovalController implements LoopController {
  private readonly conversation: Conversation
  private readonly delegate: LoopController
  private readonly honorDenials: boolean
  private readonly toolRegistry?: ToolRegistry

  constructor(
    conversation: Conversation,
    delegate: LoopController,
    options?: ApprovalControllerOptions
  ) {
    this.conversation = conversation
    this.delegate = delegate
    this.honorDenials = options?.honorDenials !== false
    this.toolRegistry = options?.toolRegistry
  }

  shouldAccept(content: string, iteration: number): boolean {
    return this.delegate.shouldAccept(content, iteration)
  }

  onTextRejected(content: string, iteration: number): ChatMessage | null {
    return this.delegate.onTextRejected(content, iteration)
  }

  /**
   * Order: denial suspend, exact auto_approved_tools name, one-shot of the
   * same tool call id and arguments, otherwise the delegate.
   *
   * A denied tool is not allowed through an exact name. If the delegate
   * would proceed, suspend so the tool must be approved again. An exact
   * allowlisted name returns "proceed" without consulting the delegate.
   *
   * One-shot approval matches the call the user just approved. A later call
   * of the same name with different arguments or a new id suspends again.
   */
  beforeTool(
    toolName: string,
    params: Record<string, unknown>,
    toolCallId?: string
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval } {
    if (this.honorDenials && this.conversation.denied_tools?.has(toolName)) {
      logger.info(
        { event: 'approval_reask_required', toolName },
        'Previously denied tool requires approval again'
      )
      return this.reask(toolName, params, toolCallId, 'denied')
    }

    if (
      this.honorDenials &&
      (this.conversation.denied_tools?.size ?? 0) > 0 &&
      startsOtherTools(toolName, params)
    ) {
      logger.info(
        { event: 'approval_reask_required', toolName, reason: 'chat_has_denials' },
        'A tool that can start other tools requires approval while a tool denial is active'
      )
      return this.reask(toolName, params, toolCallId, 'denials_active')
    }

    // An exact-name allowlist never waives a forced gate (stateless cron
    // create/enable); only a one-shot grant for this exact call does.
    if (
      this.conversation.auto_approved_tools.has(toolName) &&
      this.delegate.isForcedApproval?.(toolName, params) !== true
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
   * proceed, a re-ask card is built here. A re-ask never offers Always approve.
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
    return { type: 'suspend', approval: { ...approval, reask, alwaysApproveAllowed: false } }
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

  isForcedApproval(toolName: string, params: Record<string, unknown>): boolean {
    return this.delegate.isForcedApproval?.(toolName, params) === true
  }

  onExhaustion(iteration: number): string {
    return this.delegate.onExhaustion(iteration)
  }

  async refreshTools(currentTools: ToolDefinition[]): Promise<ToolDefinition[]> {
    return this.delegate.refreshTools(currentTools)
  }
}
