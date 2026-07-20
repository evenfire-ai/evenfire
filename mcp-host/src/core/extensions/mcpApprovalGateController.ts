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
import { randomUUID } from 'node:crypto'
import { LoopController, Tool, ToolRegistry } from '../interfaces'
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

/**
 * Cron×stateless approval prompt (product decision): creating or enabling a
 * schedule on a stateless host keeps the pod running indefinitely (an active
 * schedule blocks D8 suspension), so it is NEVER a fast/default action. The
 * gate lives server-side at the single approval decision point — an
 * LLM-settable `confirm` tool param was explicitly rejected as not model-proof.
 */
export const STATELESS_CRON_APPROVAL_PROMPT =
  'Approve scheduled task on a stateless agent? While any schedule is active, this agent ' +
  'stays running continuously and will NOT suspend when idle (higher cost). Remove or ' +
  'disable the schedule to restore suspension.'

/** cron_manage actions that create or enable a schedule (gated on stateless hosts). */
const STATELESS_CRON_GATED_ACTIONS: ReadonlySet<string> = new Set(['create', 'enable'])

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
    private readonly nativeToolRegistry?: ToolRegistry,
    /**
     * Cron×stateless options.
     * - `statelessLifecycle` arms the cron_manage create/enable forced gate.
     * - `cronManageGateOnly` (used for cron-SOURCED tasks) narrows the gate so
     *   ONLY that forced cron_manage check can suspend; every other tool call —
     *   MCP tools and native `requiresApproval()` tools alike — auto-proceeds,
     *   preserving issue #529's autonomous-cron carve-out. Without this the
     *   whole approval gate would re-engage for a cron run that has no human to
     *   answer it.
     */
    private readonly options?: { statelessLifecycle?: boolean; cronManageGateOnly?: boolean }
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
    // Cron-SOURCED narrow gate: for a cron-fired task the only approval that may
    // fire is the cron_manage create/enable forced gate (self-propagation
    // containment — a schedule must not autonomously spawn/enable MORE
    // schedules). Every other tool call keeps issue #529's autonomy and
    // proceeds without a gate, so LIST/GET/DELETE/DISABLE/TRIGGER and all
    // non-cron_manage work run unblocked.
    if (this.options?.cronManageGateOnly === true) {
      return this.cronManageForcedApproval(toolName, params) ?? 'proceed'
    }

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
        `MCP tool "${toolName}" requires approval before execution`,
        tool
      )
    }

    // 1.5 Cron×stateless forced-approval gate: when stateless cron management
    // is explicitly allowed, cron_manage CREATE/ENABLE must still run through
    // HITL. Checked BEFORE the per-tool CRD override so
    // `approval.tools["cron_manage"]: false` cannot waive it. Default-forbid
    // hosts expose cron_manage for cleanup/observability, but the tool reports
    // requiresApproval=false and rejects CREATE/ENABLE server-side.
    const cronForced = this.cronManageForcedApproval(toolName, params)
    if (cronForced) {
      return cronForced
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
        `Tool "${toolName}" requires approval before execution`,
        tool
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

  /**
   * Cron×stateless forced-approval gate (step 1.5). Returns a suspension only
   * when stateless cron management is explicitly allowed and the registered
   * tool still requires approval. Shared by the normal beforeTool path and the
   * cron-sourced `cronManageGateOnly` path so both apply the same criterion.
   * NOT waivable by the per-tool CRD override — it is checked before that
   * override on both paths.
   */
  private cronManageForcedApproval(
    toolName: string,
    params: Record<string, unknown>
  ): { type: 'suspend'; approval: PendingApproval } | null {
    if (this.options?.statelessLifecycle === true && toolName === 'cron_manage') {
      const registryWithNative = this.toolRegistry as NativeAwareRegistry
      const tool =
        this.nativeToolRegistry?.get(toolName) ??
        registryWithNative.getNative?.(toolName) ??
        this.toolRegistry.get(toolName)
      if (tool?.requiresApproval() !== true) return null

      const action = typeof params.action === 'string' ? params.action : ''
      if (STATELESS_CRON_GATED_ACTIONS.has(action)) {
        return this.createSuspension(toolName, params, STATELESS_CRON_APPROVAL_PROMPT, tool)
      }
    }
    return null
  }

  private createSuspension(
    toolName: string,
    params: Record<string, unknown>,
    description: string,
    tool: Tool | null
  ): { type: 'suspend'; approval: PendingApproval } {
    const traceDescriptor = tool?.traceDescriptor?.(params) ?? {
      kind: 'internal_tool' as const,
      sourceRef: 'mcp-host',
    }
    const approval: PendingApproval = {
      request_id: randomUUID(),
      tool_name: toolName,
      tool_kind: traceDescriptor.kind,
      tool_source_ref: traceDescriptor.sourceRef,
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
