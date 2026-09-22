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
      const decision = this.delegate.beforeTool(toolName, params, toolCallId)
      if (decision !== 'proceed') return decision
      return { type: 'suspend', approval: this.reapproval(toolName, params) }
    }

    if (
      this.honorDenials &&
      toolName === 'workflow_trigger' &&
      (this.conversation.denied_tools?.size ?? 0) > 0
    ) {
      logger.info(
        { event: 'approval_reask_required', toolName, reason: 'chat_has_denials' },
        'Workflow trigger requires approval while a tool denial is active'
      )
      return { type: 'suspend', approval: this.reapproval(toolName, params) }
    }

    if (this.conversation.auto_approved_tools.has(toolName)) {
      return 'proceed'
    }

    const pending = this.conversation.pending_approval
    if (pending && oneShotMatches(pending, toolName, params, toolCallId)) {
      this.conversation.pending_approval = undefined
      return 'proceed'
    }

    return this.delegate.beforeTool(toolName, params, toolCallId)
  }

  private reapproval(toolName: string, params: Record<string, unknown>): PendingApproval {
    const tool = this.toolRegistry?.get(toolName) ?? null
    const trace = tool?.traceDescriptor?.(params)
    return {
      request_id: randomUUID(),
      tool_name: toolName,
      ...(trace ? { tool_kind: trace.kind, tool_source_ref: trace.sourceRef } : {}),
      parameters: params,
      description: `Tool "${toolName}" was denied and must be approved again`,
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
