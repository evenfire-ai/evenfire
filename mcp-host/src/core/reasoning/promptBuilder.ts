import { createHash } from 'node:crypto'
import { PromptBuilder } from '../interfaces'
import { ChatMessage, ToolDefinition } from '../types'
import type { BuilderInput, SystemPromptParts } from './systemPrompt'

/**
 * Guidance block emitted into the system prompt when memory_* tools are
 * registered. Teaches the model what belongs in MEMORY.md, what doesn't,
 * and how to react when a write is rejected by the workspace scanner
 * (see workspace/scanner.ts).
 *
 * Exported so tests and (future) tier-`stable` cache builders can verify
 * the exact text. When T2.2 lands, this constant moves into the cached
 * tier of the prompt; the string itself does not change.
 */
export const MEMORY_GUIDANCE_TEXT =
  'Durable memory has two scopes. **Collective** memory (memory_write ' +
  "target:'memory') is the team's shared notebook: facts about the project, the " +
  'domain, decisions, conventions — things that should apply across every human ' +
  'conversing with this Host. **Private** memory (memory_write ' +
  "target:'memory_private') is about the specific person you're talking to — their " +
  'preferences, their details — and is never shared with other users. ' +
  'When in doubt, prefer private: putting a personal fact in collective memory leaks ' +
  'it to everyone, while a collective fact stored privately is merely suboptimal. ' +
  'Do not store ephemeral task progress, PR numbers, commit SHAs, or time-bounded ' +
  'state in either scope — use the conversation for that. Recall memory with ' +
  'memory_search (it covers both scopes) or memory_read.\n\n' +
  'Memory writes are scanned and may be rejected. If a write is rejected, paraphrase ' +
  'the content without raw paths to secrets, exfiltration command shapes, invisible ' +
  'Unicode, or system-prompt markers, then try again. Consolidate existing entries when ' +
  'a memory file approaches its size cap (8 KB) instead of appending unbounded.'

/**
 * Capability discovery contract. Emitted into the prompt whenever
 * `clerum__get_capabilities` is registered. Tells the model to query
 * capabilities by name and never echo raw credential values. Exported so the
 * T2.2 tier-`stable` builder (`taskExecutor.maybeGetOrBuildParts`) and the
 * legacy `buildSystemPrompt` consume the same source of truth.
 */
export const CAPABILITY_CONTRACT_TEXT =
  'Integrations may be configured via environment variables (for example $GITHUB_TOKEN). ' +
  'Call `clerum__get_capabilities` to see what is configured and how to use it. ' +
  'Never ask the user for credential values. ' +
  'Never include raw credential strings in your messages or tool arguments — ' +
  'always reference them by name and let the shell expand them.'

/**
 * Desktop environment hint. Emitted when `desktop_*` or `browser_*` tools are
 * registered. Same single-source-of-truth invariant as `CAPABILITY_CONTRACT_TEXT`.
 */
export const DESKTOP_ENVIRONMENT_HINT =
  'DESKTOP ENVIRONMENT: You are running inside a Linux desktop (XFCE) with a graphical display. ' +
  'You can see and interact with the desktop using your desktop_* tools (screenshot, click, type, key, ' +
  'mouse_move, drag) and browser_* tools (open, screenshot, click, type, navigate, get_content). ' +
  'When the user asks you to open applications, click on things, interact with the GUI, or perform ' +
  'browser-based tasks (including OAuth flows), USE THESE TOOLS. You have full computer-use capabilities. ' +
  "Take screenshots to see what's on screen, then use click/type/key to interact."

/**
 * Workflow-recipe behavioral contract. Emitted whenever any `workflow_*` tool
 * is registered. Governs the `workflow_trigger`/`workflow_status`/`workflow_result`
 * protocol AND the non-leakage rules (never reveal namespaces, run IDs, target
 * IDs, approval IDs, internal record IDs, raw JSON, tool-call ordering).
 *
 * Exported as the single source of truth so the legacy `buildSystemPrompt`
 * path and the T2.2 tiered `buildParts` cache path emit byte-identical text.
 * Lives in the `context` tier (session-stable, tool-presence gated).
 */
export const WORKFLOW_RECIPES_TEXT =
  'WORKFLOW RECIPES: Use `workflow_list` to discover the workflow recipes this user is allowed to trigger and their business inputContract fields. ' +
  'When the user asks to run, trigger, execute, or start a named workflow recipe and has provided every required business input from that inputContract, call `workflow_trigger`; do not only describe how to run it. ' +
  'If workflow_list or workflow_trigger reports multiple human target labels for the same workflow, ask the user to choose one label and pass only that human label as targetLabel. ' +
  'For a run/start/trigger/execute request, never call `workflow_result` before `workflow_trigger` has succeeded in the same conversation. ' +
  'The authenticated Desktop conversation supplies the approval target, user, team, idempotency, approval timeout, run lookup, artifact selection, and runtime authorization behind the scenes. ' +
  'The WorkflowRecipe namespace is also derived by the runtime; pass only the workflow recipe name exposed by `workflow_list`. ' +
  'Never ask for or include namespace, run IDs, artifact filenames, targetUserId, targetTeamId, approval request IDs, bearer tokens, idempotency keys, timeoutSeconds, intermediateParameters, or outputOverrides in chat tool arguments. ' +
  'Ask the user only for missing required business inputs from the inputContract. For recipes with no required business inputs, call `workflow_trigger` with no inputs. ' +
  'After `workflow_trigger`, use `workflow_status` or `workflow_health` for started, pending, running, completed, progress, status, or health questions. Do not use `workflow_result` to confirm that a workflow started, to monitor progress, or to check whether it completed. ' +
  'Use `workflow_result` with the same workflow recipe name as the `name` argument only when the user asks for the workflow result artifact, wants to download or summarize that artifact, or explicitly needs an artifact value that is not already present in the conversation. ' +
  'After `workflow_list`, `workflow_status`, `workflow_health`, or `workflow_result`, answer directly in chat text; do not call dashboard, document, image, shell, browser, or other formatting/generation tools just to present workflow data unless the user explicitly asks for that separate output. ' +
  'Do not call `workflow_result` just because a record was created by a workflow. When the user asks to verify data in a connected MCP-backed system such as MongoDB, a database, CRM, ticketing system, storage tool, or another connected data tool, use the relevant read-only MCP tool directly whenever the conversation already contains a lookup value such as the workflow recipe name, company, marker, public record reference, or another business key. ' +
  'Use `workflow_result` for MCP-backed record verification only when the user asks for an artifact/result/download or no conversation-known business lookup can identify the record. The MCP read tool is the source of truth for existence and current state; do not answer record verification questions from `workflow_result` alone. ' +
  'Final answers about workflow results or workflow-created records must summarize the user-facing business outcome only. If the user asks for specific fields only, provide only those fields and no extra diagnostics. Do not reveal workflow namespaces, full run IDs, target IDs, approval IDs, database names, collection names, MCP server IDs, internal record/object IDs, raw JSON, or tool-call ordering unless the user explicitly asks for diagnostic internals.'

/**
 * MCP server-selection contract. Emitted whenever any namespaced MCP tool
 * (`<server>__<tool>`) is registered. Governs server disambiguation, read-only
 * vs mutating tool selection, and data minimization.
 *
 * Same single-source-of-truth invariant as `WORKFLOW_RECIPES_TEXT`: shared by
 * the legacy and tiered paths, lives in the `context` tier.
 */
export const MCP_SERVER_SELECTION_TEXT =
  'MCP SERVER SELECTION: MCP tools are named `<server>__<tool>`. ' +
  'When the user names a specific MCP server, use only tools whose server prefix before `__` exactly matches that MCP server name. ' +
  'Do not substitute a different MCP server just because it has the same kind of tool. ' +
  'If the named MCP server is not available, say it is unavailable instead of using another server. ' +
  'When the user asks to inspect, verify, check, or summarize existing data in a named or implied connected MCP server, use read-only tools such as find, list, get, or count. ' +
  'If the request names MongoDB or another connected data system, prefer that MCP server read tool over workflow artifact tools unless the user explicitly asks for workflow artifacts or results. ' +
  'When the user provides a lookup value such as a record reference, marker, workflow recipe name, company, or business key, include that value in the read-only query/filter whenever the tool supports filters; prefer targeted reads over broad collection scans. ' +
  'If a data tool requires a database, collection, table, bucket, or similar location and the exact location is not already known from the conversation, discover it first with read-only list or metadata tools; do not pass wildcard values such as `*` as a guessed location. ' +
  'After a read-only discovery tool returns the location needed to answer, continue with the next read-only tool needed to answer instead of asking the user for separate permission; tool approval is handled by the approval UI. ' +
  'Do not call mutating tools such as create, insert, update, delete, remove, or write unless the user explicitly asks to change data. ' +
  'When answering from MCP data, return only the business fields requested by the user; do not add database names, collection names, MCP server IDs, internal record/object IDs, raw documents, or other implementation details unless the user explicitly asks for diagnostic internals.'

/**
 * Tool-discovery guidance (dynamic-tool-loading, Phase F4.1). Emitted whenever
 * the `clerum__tool_search` bridge tool is registered — i.e. when the stable
 * bridge is in play. Teaches the model the 3-step discovery flow so it knows
 * the deferred MCP catalog is reachable even though those tools are not listed
 * directly in `tools[]`.
 *
 * Single source of truth, shared by the legacy and tiered paths. It is a
 * CONSTANT (the bridge tools are always present when active), so it lives in the
 * `context` tier without breaking the stable/context cache hash.
 */
export const TOOL_DISCOVERY_TEXT =
  'You have access to a large catalog of tools that are not all listed directly. ' +
  'Use `clerum__tool_search` to find them by keyword, `clerum__tool_describe` to ' +
  "see one's schema, and `clerum__tool_call` to invoke it. Native tools are " +
  'already available directly.'

/**
 * Default prompt builder.
 *
 * Extracted from stateMachine.ts:373-409. Produces system prompts
 * with identity, tool descriptions, date/time, and channel context.
 */
export class DefaultPromptBuilder implements PromptBuilder {
  buildSystemPrompt(
    tools: ToolDefinition[],
    identity?: string,
    metadata?: Record<string, unknown>
  ): ChatMessage {
    const sections: string[] = []

    // 1. Identity / base system prompt
    if (identity) {
      sections.push(identity)
    } else {
      sections.push(
        'You are a helpful AI assistant with access to various tools. ' +
          'Use the available tools when needed to help the user.'
      )
    }

    // 2. Tool capabilities description
    if (tools.length > 0) {
      sections.push(this.buildToolsDescription(tools))
    }

    // 2a. Capability discovery contract. Always emitted when
    // clerum__get_capabilities is registered; tells the model to query
    // capabilities and never echo or request raw credential values.
    if (tools.some(t => t.name === 'clerum__get_capabilities')) {
      sections.push(CAPABILITY_CONTRACT_TEXT)
    }

    if (tools.some(t => t.name.startsWith('workflow_'))) {
      sections.push(WORKFLOW_RECIPES_TEXT)
    }

    // NOTE: this is intentionally still true when the bridge is active — the
    // `clerum__tool_search/describe/call` native/bridge tools also contain `__`,
    // so `MCP_SERVER_SELECTION_TEXT` still emits. That is fine: `TOOL_DISCOVERY_TEXT`
    // (emitted right after) clarifies the discovery flow. We do NOT tighten the
    // heuristic here — a stricter check would alter the flag-OFF default path on
    // native-only hosts and break the byte-identical guarantee. A deeper
    // suppression is deferred for that reason.
    if (tools.some(t => t.name.includes('__'))) {
      sections.push(MCP_SERVER_SELECTION_TEXT)
    }

    // Tool-discovery guidance (F4.1): emitted when the stable bridge is active,
    // detected by the presence of `clerum__tool_search`.
    if (tools.some(t => t.name === 'clerum__tool_search')) {
      sections.push(TOOL_DISCOVERY_TEXT)
    }

    // 2b. Desktop environment context
    const hasDesktopTools = tools.some(
      t => t.name.startsWith('desktop_') || t.name.startsWith('browser_')
    )
    if (hasDesktopTools) {
      sections.push(DESKTOP_ENVIRONMENT_HINT)
    }

    // 2c. Memory guidance (only emitted when memory_* tools are registered).
    // Stays a constant string so future cache-aware builders (T2.2) can keep
    // this section in the stable tier without re-hashing per session.
    if (tools.some(t => t.name.startsWith('memory_'))) {
      sections.push(MEMORY_GUIDANCE_TEXT)
    }

    // 3. Date/time context
    sections.push(`Current date and time: ${new Date().toISOString()}`)

    // 4. Channel-specific context
    if (metadata?.channelType) {
      sections.push(
        `Message received from ${metadata.channelType} channel` +
          (metadata.sender ? ` (sender: ${metadata.sender})` : '') +
          '.'
      )
    }

    // 5. Cron job context
    if (metadata?.cronJobName) {
      sections.push(
        `This is a scheduled task from cron job "${metadata.cronJobName}"` +
          (metadata.cronSchedule ? ` (schedule: ${metadata.cronSchedule})` : '') +
          '.'
      )
    }

    const content = sections.join('\n\n')
    const metaKeys = metadata ? Object.keys(metadata).filter(k => metadata[k] != null) : []
    console.log(
      `[NewCore:PromptBuilder] buildSystemPrompt → tools=${tools.length}, promptLength=${content.length}, metadata=[${metaKeys.join(',')}]`
    )
    return {
      role: 'system',
      content,
    }
  }

  /**
   * T2.2 — Build the two cacheable tiers (`stable`, `context`) plus content
   * hashes. The output is cache-friendly: rerunning with the same
   * `BuilderInput` produces byte-identical `stable`/`context` strings and the
   * same hashes, which is the invariant the prompt cache relies on.
   *
   * Tier ordering matches `T2.2-prompt-cache.md` §4.1:
   *   stable  = identity files + daily-log snapshot + runtime metadata
   *   context = capabilities contract + workflow-recipe guidance +
   *             MCP server-selection guidance + memory guidance
   *
   * Empty contributions are filtered out so the resulting string never carries
   * dangling separators. PR1 only exposes the builder — the call sites still
   * go through `buildSystemPrompt()` until PR2 wires the cache.
   */
  buildParts(input: BuilderInput): SystemPromptParts {
    const stable = this.assembleStable(input)
    const context = this.assembleContext(input)
    return {
      stable,
      context,
      stableHash: sha256(stable),
      contextHash: sha256(context),
    }
  }

  private assembleStable(input: BuilderInput): string {
    const parts: string[] = []
    if (input.identityFiles.identity.trim()) {
      parts.push(`## Identity\n\n${input.identityFiles.identity.trim()}`)
    }
    if (input.identityFiles.soul.trim()) {
      parts.push(`## Core Values\n\n${input.identityFiles.soul.trim()}`)
    }
    if (input.identityFiles.agents.trim()) {
      parts.push(`## Agent Instructions\n\n${input.identityFiles.agents.trim()}`)
    }
    if (input.identityFiles.user.trim()) {
      parts.push(`## User Context\n\n${input.identityFiles.user.trim()}`)
    }
    if (input.dailyLogSnapshot.trim()) {
      parts.push(`## Daily Log (frozen at session start)\n\n${input.dailyLogSnapshot.trim()}`)
    }
    parts.push(`## Runtime\n\nmodel: ${input.model}\nprovider: ${input.provider}`)
    for (const hint of input.platformHints) {
      if (hint.trim()) parts.push(hint.trim())
    }
    return parts.join('\n\n---\n\n')
  }

  private assembleContext(input: BuilderInput): string {
    const parts: string[] = []
    if (input.capabilities.trim()) parts.push(input.capabilities.trim())
    if (input.workflowGuidance.trim()) parts.push(input.workflowGuidance.trim())
    if (input.mcpServerGuidance.trim()) parts.push(input.mcpServerGuidance.trim())
    if (input.toolDiscoveryGuidance.trim()) parts.push(input.toolDiscoveryGuidance.trim())
    if (input.memoryGuidance.trim()) parts.push(input.memoryGuidance.trim())
    return parts.join('\n\n')
  }

  private buildToolsDescription(tools: ToolDefinition[]): string {
    const lines = ['Available tools:']
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description}`)
    }
    return lines.join('\n')
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}
