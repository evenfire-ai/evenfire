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
 * Native tools whose approval is scoped to the tool itself. A plain approval
 * stores the name in `task_approved_tools`, so the tool runs without a new card
 * for the rest of the current task, including after resumes; the next user
 * message starts a new task and asks again. An "always" approval stores it in
 * `auto_approved_tools`, which covers later tasks while the conversation stays
 * in memory. Neither survives a cold resume. These approvals never add the
 * turn-wide `'*'`, and a `'*'` granted by any other approval does not cover
 * these tools: each one needs its own approval.
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

/**
 * Decorator that checks auto_approved_tools before delegating to base controller.
 */
export class ApprovalController implements LoopController {
  private readonly conversation: Conversation
  private readonly delegate: LoopController
  private readonly liveApprovalTools: ReadonlySet<string>
  private readonly forcedApprovalGate: ForcedApprovalGate | undefined

  constructor(
    conversation: Conversation,
    delegate: LoopController,
    liveApprovalTools?: ReadonlySet<string>,
    forcedApprovalGate?: ForcedApprovalGate
  ) {
    this.conversation = conversation
    this.delegate = delegate
    this.liveApprovalTools = liveApprovalTools ?? new Set<string>()
    this.forcedApprovalGate = forcedApprovalGate
  }

  shouldAccept(content: string, iteration: number): boolean {
    return this.delegate.shouldAccept(content, iteration)
  }

  onTextRejected(content: string, iteration: number): ChatMessage | null {
    return this.delegate.onTextRejected(content, iteration)
  }

  /**
   * A forced approval (cron×stateless create/enable) is checked first and
   * always suspends, before any stored approval is consulted.
   *
   * Live-approval tools always consult the delegate. Other tools retain the
   * auto_approved_tools and matching pending_approval one-shot behavior;
   * `'*'` does not apply to SESSION_SCOPED_APPROVAL_TOOLS.
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
    // Forced approvals ask on every call: no '*', per-task, "always" or server
    // prefix approval covers them, and their exact scope keeps an approved card
    // from adding any of those.
    const forced = this.forcedApprovalGate?.forcedApproval(toolName, params)
    if (forced) return forced

    // The approved frozen call executes directly in resumeAfterApproval.
    // Every model-generated live call needs a new delegate decision; retained
    // snapshot data and persistent approvals cannot authorize another invocation.
    if (this.liveApprovalTools.has(toolName)) {
      const decision = this.delegate.beforeTool(toolName, params)
      return typeof decision === 'object'
        ? {
            ...decision,
            approval: {
              ...decision.approval,
              authorization_scope: 'exact_invocation',
            },
          }
        : decision
    }

    // "Approve once, run all" — user approved any tool in this turn, auto-approve
    // the rest, except session-scoped tools, which need their own approval.
    if (
      this.conversation.auto_approved_tools.has('*') &&
      !SESSION_SCOPED_APPROVAL_TOOLS.has(toolName)
    ) {
      return 'proceed'
    }

    // Check individual tool name: "always" grants, then this task's plain
    // session-scoped approvals.
    if (
      this.conversation.auto_approved_tools.has(toolName) ||
      this.conversation.task_approved_tools?.has(toolName) === true
    ) {
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
