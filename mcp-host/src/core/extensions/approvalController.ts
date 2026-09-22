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
 *     then one-shot pending_approval.tool_name → "proceed")
 *     └─ UnifiedApprovalGateController (MCP tool? → suspend. Native requiresApproval? → suspend. Else → "proceed")
 *
 * A "*" entry or an MCP server prefix in auto_approved_tools does not
 * short-circuit this gate. Gate 2 (tool.requiresApproval() inside toolUseLoop)
 * was REMOVED as part of the BUG-11 fix. All approval decisions now flow
 * through this single gate.
 */
import { randomUUID } from 'node:crypto'
import { LoopController } from '../interfaces'
import { ChatMessage, PendingApproval, ToolDefinition } from '../types'
import type { Conversation } from '../types'

/**
 * Decorator that honors a denial, then an exact allowlisted name, then a
 * one-shot pending approval, before delegating.
 */
export class ApprovalController implements LoopController {
  private readonly conversation: Conversation
  private readonly delegate: LoopController

  constructor(conversation: Conversation, delegate: LoopController) {
    this.conversation = conversation
    this.delegate = delegate
  }

  shouldAccept(content: string, iteration: number): boolean {
    return this.delegate.shouldAccept(content, iteration)
  }

  onTextRejected(content: string, iteration: number): ChatMessage | null {
    return this.delegate.onTextRejected(content, iteration)
  }

  /**
   * Order: denial suspend, exact auto_approved_tools name, one-shot
   * pending_approval.tool_name, otherwise the delegate.
   *
   * A denied tool is not allowed through an exact name. If the delegate
   * would proceed, suspend so the tool must be approved again. An exact
   * allowlisted name returns "proceed" without consulting the delegate.
   *
   * One-shot approval: if the conversation has a pending_approval whose
   * tool_name matches, this means the user approved the tool for this
   * specific call (alwaysApprove=false). Clear pending_approval and proceed.
   * This prevents the infinite re-suspension loop where resumeAfterApproval
   * re-runs the loop, the LLM calls the same tool, and the gate blocks it again.
   */
  beforeTool(
    toolName: string,
    params: Record<string, unknown>
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval } {
    if (this.conversation.denied_tools?.has(toolName)) {
      const decision = this.delegate.beforeTool(toolName, params)
      if (decision !== 'proceed') return decision
      return {
        type: 'suspend',
        approval: {
          request_id: randomUUID(),
          tool_name: toolName,
          parameters: params,
          description: `Tool "${toolName}" was denied and must be approved again`,
          tool_call_id: '',
          context_snapshot: [],
        },
      }
    }

    if (this.conversation.auto_approved_tools.has(toolName)) {
      return 'proceed'
    }

    // One-shot: pending_approval was granted but not yet consumed
    if (
      this.conversation.pending_approval &&
      this.conversation.pending_approval.tool_name === toolName
    ) {
      this.conversation.pending_approval = undefined
      return 'proceed'
    }

    return this.delegate.beforeTool(toolName, params)
  }

  onExhaustion(iteration: number): string {
    return this.delegate.onExhaustion(iteration)
  }

  async refreshTools(currentTools: ToolDefinition[]): Promise<ToolDefinition[]> {
    return this.delegate.refreshTools(currentTools)
  }
}
