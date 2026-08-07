/**
 * NudgeController - LoopController decorator for tool-use nudging.
 *
 * Phase 6: If the LLM responds with text before using any tools,
 * the NudgeController injects a system message encouraging tool use.
 *
 * This handles the common case where the LLM "forgets" it has tools
 * and gives a text response without trying the available tools first.
 *
 * Behavior:
 * - Tracks whether any tools have been executed in the current loop
 * - If text is returned AND no tools used AND nudgeCount < maxNudges:
 *   reject the text, increment nudge counter, inject a nudge message
 * - After maxNudges: accept whatever text the LLM returns (safety valve)
 * - After any tool is called: accept text responses (nudge served its purpose)
 */
import { LoopController } from '../interfaces'
import { ChatMessage, PendingApproval, ToolDefinition } from '../types'

export class NudgeController implements LoopController {
  private readonly delegate: LoopController
  private readonly maxNudges: number

  private toolsExecutedInLoop: boolean = false
  private nudgeCount: number = 0

  constructor(delegate: LoopController, maxNudges: number = 3) {
    this.delegate = delegate
    this.maxNudges = maxNudges
  }

  /**
   * Accept text if tools have been used or max nudges reached.
   * Otherwise reject to trigger a nudge.
   */
  shouldAccept(content: string, iteration: number): boolean {
    // If tools were used, accept whatever the LLM says
    if (this.toolsExecutedInLoop) {
      return this.delegate.shouldAccept(content, iteration)
    }

    // Safety valve: if we've nudged enough, accept the text
    if (this.nudgeCount >= this.maxNudges) {
      return this.delegate.shouldAccept(content, iteration)
    }

    // No tools used and under max nudges -> reject
    return false
  }

  /**
   * When text is rejected, inject a nudge message.
   */
  onTextRejected(content: string, iteration: number): ChatMessage | null {
    this.nudgeCount++

    return {
      role: 'user',
      content:
        'You have tools available. Please use the appropriate tool(s) to answer the question ' +
        'rather than responding from memory alone. Check the available tools and try again.',
    }
  }

  /**
   * Track tool calls and delegate.
   */
  beforeTool(
    toolName: string,
    params: Record<string, unknown>
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval } {
    this.toolsExecutedInLoop = true
    return this.delegate.beforeTool(toolName, params)
  }

  onExhaustion(iteration: number): string {
    return this.delegate.onExhaustion(iteration)
  }

  async refreshTools(currentTools: ToolDefinition[]): Promise<ToolDefinition[]> {
    return this.delegate.refreshTools(currentTools)
  }

  /** Test helper: get current nudge count */
  getNudgeCount(): number {
    return this.nudgeCount
  }

  /** Test helper: check if tools have been executed */
  hasToolsExecuted(): boolean {
    return this.toolsExecutedInLoop
  }
}
