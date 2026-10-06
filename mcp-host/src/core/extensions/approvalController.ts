/**
 * ApprovalController - LoopController decorator for tool approval.
 *
 * Phase 6: Wraps a delegate LoopController (UnifiedApprovalGateController)
 * and intercepts beforeTool() to check the conversation's auto_approved_tools
 * set BEFORE the delegate's approval check fires.
 *
 * There is a SINGLE approval gate in the code (SPEC-UNIFIED §21):
 *   loopController.beforeTool() in toolUseLoop.ts
 *
 * The decorator chain:
 *   ApprovalController (live tools → delegate; other tools → auto_approved_tools + one-shot)
 *     └─ UnifiedApprovalGateController (MCP tool? → suspend. Native requiresApproval? → suspend. Else → "proceed")
 *
 * Gate 2 (tool.requiresApproval() inside toolUseLoop) was REMOVED as part of
 * the BUG-11 fix. All approval decisions now flow through this single gate.
 */
import { LoopController } from '../interfaces'
import { ChatMessage, PendingApproval, ToolDefinition } from '../types'
import type { Conversation } from '../types'
import { getMcpServerPrefix } from './mcpApprovalGateController'

/**
 * Decorator that checks auto_approved_tools before delegating to base controller.
 */
export class ApprovalController implements LoopController {
  private readonly conversation: Conversation
  private readonly delegate: LoopController
  private readonly liveApprovalTools: ReadonlySet<string>

  constructor(
    conversation: Conversation,
    delegate: LoopController,
    liveApprovalTools?: ReadonlySet<string>
  ) {
    this.conversation = conversation
    this.delegate = delegate
    this.liveApprovalTools = liveApprovalTools ?? new Set<string>()
  }

  shouldAccept(content: string, iteration: number): boolean {
    return this.delegate.shouldAccept(content, iteration)
  }

  onTextRejected(content: string, iteration: number): ChatMessage | null {
    return this.delegate.onTextRejected(content, iteration)
  }

  /**
   * Live-approval tools always consult the delegate. Other tools retain the
   * auto_approved_tools and matching pending_approval one-shot behavior.
   *
   * Non-live one-shot approval: if the conversation has a pending_approval whose
   * tool_name matches, this means the user approved the tool for this
   * specific call (alwaysApprove=false). Clear pending_approval and proceed.
   * This prevents the infinite re-suspension loop where resumeAfterApproval
   * re-runs the loop, the LLM calls the same tool, and the gate blocks it again.
   */
  beforeTool(
    toolName: string,
    params: Record<string, unknown>
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval } {
    // The approved frozen call executes directly in resumeAfterApproval.
    // Every model-generated live call needs a new delegate decision; retained
    // snapshot data and persistent approvals cannot authorize another invocation.
    if (this.liveApprovalTools.has(toolName)) {
      return this.delegate.beforeTool(toolName, params)
    }

    // "Approve once, run all" — user approved any tool in this turn, auto-approve rest
    if (this.conversation.auto_approved_tools.has('*')) {
      return 'proceed'
    }

    // Check individual tool name
    if (this.conversation.auto_approved_tools.has(toolName)) {
      return 'proceed'
    }

    // Check MCP server-level approval (e.g., "airtable-server" approves all airtable-server__* tools)
    const serverPrefix = getMcpServerPrefix(toolName)
    if (serverPrefix && this.conversation.auto_approved_tools.has(serverPrefix)) {
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
