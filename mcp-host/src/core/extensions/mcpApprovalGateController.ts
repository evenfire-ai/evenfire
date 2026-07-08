/**
 * UnifiedApprovalGateController - LoopController that blocks tool calls
 * for approval when the approval system is enabled.
 *
 * Handles BOTH MCP tools (identified by serverName__toolName convention)
 * AND native tools with requiresApproval() == true (e.g., shell_exec, http_request).
 *
 * Used as the base delegate inside ApprovalController. The decorator chain:
 *   ApprovalController (checks auto_approved_tools → "proceed" if found)
 *     └─ UnifiedApprovalGateController (MCP tool? → suspend. Native requiresApproval? → suspend. Else → "proceed")
 *
 * This is the SINGLE approval gate (SPEC-UNIFIED §21). Gate 2 (the old
 * tool.requiresApproval() check inside toolUseLoop) has been removed.
 * All approval decisions go through this controller via LoopController.beforeTool().
 */
import { LoopController, ToolRegistry } from '../interfaces'
import { DefaultLoopController } from '../orchestration/loopConfig'
import { ChatMessage, PendingApproval, ToolDefinition } from '../types'
import type { ApprovalConfig } from './approvalTypes'

type NativeAwareRegistry = ToolRegistry & {
  getNative?: (name: string) => ReturnType<ToolRegistry['get']>
}

/**
 * Check whether a tool name follows the MCP naming convention.
 * MCP tools are prefixed as: serverName__toolName (double underscore).
 */
export function isMcpToolName(toolName: string): boolean {
  return toolName.includes('__')
}

/**
 * Extract the MCP server prefix from a tool name.
 * Returns null if the tool name is not an MCP tool.
 */
export function getMcpServerPrefix(toolName: string): string | null {
  const idx = toolName.indexOf('__')
  return idx >= 0 ? toolName.substring(0, idx) : null
}

export class UnifiedApprovalGateController implements LoopController {
  private readonly delegate = new DefaultLoopController()

  /**
   * ToolRegistry is REQUIRED (F2: Invariant 9) — ensures native tools with
   * requiresApproval() are never silently skipped.
   *
   * approvalConfig is OPTIONAL — when provided, tools[name] overrides the
   * tool's code default. Absent → fall through to tool.requiresApproval().
   */
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly approvalConfig?: ApprovalConfig,
    private readonly nativeToolRegistry?: ToolRegistry
  ) {}

  shouldAccept(content: string, iteration: number): boolean {
    return this.delegate.shouldAccept(content, iteration)
  }

  onTextRejected(content: string, iteration: number): ChatMessage | null {
    return this.delegate.onTextRejected(content, iteration)
  }

  beforeTool(
    toolName: string,
    params: Record<string, unknown>
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval } {
    const registryWithNative = this.toolRegistry as NativeAwareRegistry
    const nativeTool =
      this.nativeToolRegistry?.get(toolName) ?? registryWithNative.getNative?.(toolName) ?? null
    const tool = nativeTool ?? this.toolRegistry.get(toolName)

    // 1. MCP tools always require approval (identified by naming convention),
    // unless the composite registry resolves the name to a native Clerum tool.
    if (isMcpToolName(toolName) && !nativeTool) {
      return this.createSuspension(
        toolName,
        params,
        `MCP tool "${toolName}" requires approval before execution`
      )
    }

    // 2. Native tools: CRD override > tool's code default.
    // Use Object.hasOwn to avoid resolving prototype methods (e.g. tool name
    // "toString" would otherwise hit Object.prototype.toString and produce a
    // truthy "override").
    const tools = this.approvalConfig?.tools
    const override = tools && Object.hasOwn(tools, toolName) ? tools[toolName] : undefined
    const needsApproval = override ?? tool?.requiresApproval() ?? false

    if (needsApproval) {
      return this.createSuspension(
        toolName,
        params,
        `Tool "${toolName}" requires approval before execution`
      )
    }

    // 3. No approval needed
    return 'proceed'
  }

  onExhaustion(iteration: number): string {
    return this.delegate.onExhaustion(iteration)
  }

  async refreshTools(currentTools: ToolDefinition[]): Promise<ToolDefinition[]> {
    return this.delegate.refreshTools(currentTools)
  }

  private createSuspension(
    toolName: string,
    params: Record<string, unknown>,
    description: string
  ): { type: 'suspend'; approval: PendingApproval } {
    const approval: PendingApproval = {
      request_id: `approval-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      tool_name: toolName,
      parameters: params,
      description,
      tool_call_id: '', // Filled by toolUseLoop from call.id
      context_snapshot: [],
    }
    return { type: 'suspend', approval }
  }
}

/**
 * @deprecated Use UnifiedApprovalGateController instead.
 * Kept for backward compatibility during migration.
 */
export const McpApprovalGateController = UnifiedApprovalGateController
