import { BRIDGE_TOOL_NAMES } from '../../capabilities/toolCatalogTools'
import { extractToolIntent, getDisplayName } from '../../progress/intentExtraction.js'
import {
  buildConnectRequiredApproval,
  extractConnectRequiredMarker,
} from '../extensions/mcpApprovalGateController'
import type {
  Attachment,
  ChatMessage,
  PendingApproval,
  TokenUsage,
  ToolCall,
  ToolResult,
} from '../types'
import type { LoopConfig } from './loopConfig'
import { admitToolCall, executeAdmittedTool } from './toolCallPolicy'
import { collectToolAttachments } from './toolUseLoopMessages'
import { reportToolComplete, reportToolStart } from './toolUseLoopSingleTool'
import { isWorkflowTriggerNotFoundToolResult } from './toolUseLoopWorkflowTriggerFallbacks'

function bridgeError(call: ToolCall, message: string): ToolResult {
  // Preserve the original `call.id`/name so the provider pairs the result with
  // the model's `clerum__tool_call` tool_use block (LOCKED #9).
  return {
    tool_call_id: call.id,
    name: call.name,
    content: message,
    is_error: true,
  }
}

/**
 * F3.2 — Resolve a tool call against the dynamic-tools bridge BEFORE the
 * approval/validation gate (LOCKED #8). Two cases:
 *
 *  1. `clerum__tool_call` envelope → parse `{ name, arguments }`, reject
 *     recursion (LOCKED #11) and out-of-catalog targets (scope gate, LOCKED #7),
 *     then rewrite to a synthetic `{ id: call.id, name, arguments }` so the
 *     normal gate runs against the REAL tool (Critical #12 validates inner args
 *     against the real schema; LOCKED #10 keys approval on the real name).
 *     With `bridge.nativeTargets` (native `auto`, #1003) a native target is
 *     also rewritten, whether or not it is currently advertised; without it,
 *     native targets are rejected as before. Recursion is rejected in both.
 *
 *  2. Direct call to a deferred MCP tool (Critical #9, auto-recover) — a
 *     non-bridge call naming an MCP tool that is currently un-advertised. It is
 *     routed through the SAME scope gate so direct calls cannot bypass it.
 *     Truly nonexistent names fall through untouched to the normal
 *     `Tool not found` path. Stateless: no set is grown.
 *
 * Returns:
 *  - `'handled'` — an error was pushed to `toolResults`; caller must `continue`.
 *  - a `ToolCall` — proceed with this (possibly rewritten) call.
 */
function resolveBridgeCall(
  call: ToolCall,
  config: LoopConfig,
  toolResults: ToolResult[],
  // Computed ONCE per batch by `executeToolCalls` and passed in, so we don't
  // re-derive the (potentially 290-entry) deferrable catalog Set on every call.
  // `undefined` when the bridge is inactive (flag OFF) — no work to do.
  deferrableCatalogNames: Set<string> | undefined
): ToolCall | 'handled' {
  const bridge = config.bridge
  if (!bridge || !deferrableCatalogNames) return call

  if (call.name === 'clerum__tool_call') {
    const args = call.arguments as Record<string, unknown> | undefined
    const name = args && typeof args.name === 'string' ? args.name : undefined
    const innerArgs = args?.arguments
    if (!name) {
      toolResults.push(
        bridgeError(
          call,
          'clerum__tool_call requires a string `name` field naming the target tool.'
        )
      )
      return 'handled'
    }
    if (
      innerArgs !== undefined &&
      (typeof innerArgs !== 'object' || innerArgs === null || Array.isArray(innerArgs))
    ) {
      toolResults.push(
        bridgeError(call, 'clerum__tool_call `arguments` must be an object when provided.')
      )
      return 'handled'
    }

    // Native `auto`: reject recursion (LOCKED #11) before accepting natives.
    if (bridge.nativeTargets && BRIDGE_TOOL_NAMES.has(name)) {
      toolResults.push(
        bridgeError(
          call,
          `clerum__tool_call cannot target "${name}": bridge tools cannot invoke one another.`
        )
      )
      return 'handled'
    }

    // #1003 — native `auto`: a native target is valid. Its scope gate is
    // membership in the native registry (deferred natives are not in the MCP
    // catalog). The rewrite keeps `call.id` and the normal gate below then
    // validates and approves the REAL native, exactly like a direct call, so
    // the bridge never widens what the model could call directly.
    if (bridge.nativeTargets && bridge.nativeNames.has(name)) {
      return {
        id: call.id,
        name,
        arguments: (innerArgs as Record<string, unknown>) ?? {},
      }
    }

    // Native `direct`: reject recursion / native targets (LOCKED #11): the
    // bridge targets DEFERRABLE MCP tools only.
    if (BRIDGE_TOOL_NAMES.has(name) || bridge.nativeNames.has(name)) {
      toolResults.push(
        bridgeError(
          call,
          `clerum__tool_call cannot target "${name}": native and bridge tools are called directly, not through the bridge.`
        )
      )
      return 'handled'
    }

    // Scope gate (LOCKED #7, Critical #7): the target must exist in the session's
    // deferrable catalog. This rejects nonexistent/out-of-catalog names; it is
    // NOT a per-tool authz boundary (Clerum has no per-tool RBAC).
    if (!deferrableCatalogNames.has(name)) {
      toolResults.push(
        bridgeError(
          call,
          `Tool not available: "${name}" is not in the current tool catalog. Use clerum__tool_search to find the correct name.`
        )
      )
      return 'handled'
    }

    // Rewrite to a synthetic call against the REAL tool, PRESERVING the original
    // `call.id` (LOCKED #9). The loop then runs the normal gate against the real
    // name. `executeSingleTool` returns a ToolResult whose `tool_call_id` is the
    // preserved id, so the provider pairs it with the model's tool_call block.
    //
    // The synthetic call (and its eventual ToolResult) intentionally carries the
    // REAL tool name, NOT `clerum__tool_call`. Providers pair the result by
    // `tool_call_id`; drivers whose wire pairs by name (Gemini) resolve the
    // name from that id against the preceding assistant turn. Preserving
    // `call.id` is what matters — do NOT re-mint the id (a fresh id would
    // orphan the model's tool_use block).
    return {
      id: call.id,
      name,
      arguments: (innerArgs as Record<string, unknown>) ?? {},
    }
  }

  // Direct call to a deferred MCP tool: auto-recover (Critical #9). The model
  // named an MCP-prefixed tool directly even though it is no longer advertised.
  // We allow it ONLY through the SAME scope gate as `clerum__tool_call` (LOCKED
  // #7 / Critical #7): if the name is in the deferrable catalog, proceed
  // normally (gate/validation/execution); if it is NOT, reject here with the
  // standard "Tool not found" shape rather than `return call`. Today the
  // catalog == the full MCP universe, so this matches the registry's own
  // `Tool not found` — but enforcing the gate explicitly here means a future
  // per-host catalog subset cannot be bypassed by a direct call. Native names
  // (and non-MCP names) pass through untouched — the native registry resolves
  // them whether or not native `auto` removed them from `tools[]`. Stateless:
  // nothing is recorded.
  //
  // The `__` heuristic is safe because of the `serverName__toolName` naming
  // invariant (double underscore, see CLAUDE.md): natives are excluded first via
  // `!nativeNames.has(...)`, so only MCP-namespaced names reach the catalog
  // gate. A hallucinated name WITHOUT `__` falls through untouched to the
  // registry's own "Tool not found" path, so nothing is mis-routed.
  if (!bridge.nativeNames.has(call.name) && call.name.includes('__')) {
    if (!deferrableCatalogNames.has(call.name)) {
      toolResults.push(bridgeError(call, `Tool not found: ${call.name}`))
      return 'handled'
    }
  }
  return call
}

export async function executeToolCalls(
  calls: ToolCall[],
  config: LoopConfig,
  iteration: number,
  priorMessages?: ChatMessage[],
  llmTextContent?: string,
  usage?: TokenUsage
): Promise<{
  toolResults: ToolResult[]
  pendingApproval?: PendingApproval
  cancelled?: boolean
}> {
  const { loopController, events } = config
  const toolResults: ToolResult[] = []
  // F3.2 — derive the deferrable catalog Set ONCE for the whole batch instead of
  // per call (it can hold ~290 names). `undefined` when the bridge is inactive
  // (flag OFF) so `resolveBridgeCall` short-circuits with no work.
  const deferrableCatalogNames = config.bridge?.getDeferrableCatalogNames()
  // Crit #2: the batch shares ONE LLM call's usage — attach it to the first
  // reportToolComplete actually emitted (NOT strictly i === 0; the validation
  // and skip `continue`s above the emit never reach reportToolComplete).
  let usageEmitted = false

  for (let i = 0; i < calls.length; i++) {
    let call = calls[i]

    // F3.2 — `clerum__tool_call` bridge intercept (LOCKED #8, Critical #6).
    // Runs at the TOP of the per-call loop, BEFORE `beforeExecution` (:29) and
    // `beforeTool` (:49), so that validation and approval run against the REAL
    // target tool, not the opaque bridge envelope. The intercept unwraps the
    // bridge call into a SYNTHETIC call against the real MCP tool, preserving
    // `call.id` (LOCKED #9) so the provider pairs the tool_result by
    // tool_use_id. Direct calls to deferred MCP tools (Critical #9) are also
    // routed through the same scope gate here. A `'handled'` return means an
    // error was already pushed — skip this call.
    const rewritten = resolveBridgeCall(call, config, toolResults, deferrableCatalogNames)
    if (rewritten === 'handled') continue
    call = rewritten

    const admission = await admitToolCall(call, config, iteration)
    if (admission.kind === 'result') {
      toolResults.push(admission.toolResult)
      continue
    }
    let gate: 'proceed' | { type: 'suspend'; approval: PendingApproval } =
      admission.kind === 'suspend' ? { type: 'suspend', approval: admission.approval } : 'proceed'
    if (admission.kind === 'execute') call = admission.call
    else if (admission.kind === 'suspend') {
      // A guardrail can rewrite input before it asks. The consent event and
      // frozen approval must show the same effective parameters.
      call = { ...call, arguments: admission.approval.parameters }
    }

    if (typeof gate === 'object' && gate.type === 'suspend') {
      gate.approval.tool_call_id = gate.approval.tool_call_id || call.id
      gate.approval.intent_summary =
        extractToolIntent(llmTextContent ?? null, call.name) ??
        `Using ${getDisplayName(call.name)}...`

      if (priorMessages) {
        gate.approval.context_snapshot = [...priorMessages]
        gate.approval.completed_results = [...toolResults]
      }

      for (let k = i + 1; k < calls.length; k++) {
        toolResults.push({
          tool_call_id: calls[k].id,
          name: calls[k].name,
          content: `Not executed — tool ${call.name} required approval. Re-request if needed.`,
          is_error: true,
        })
      }
      if (priorMessages && gate.approval.completed_results) {
        gate.approval.completed_results = [...toolResults]
      }

      events.emit({
        type: 'tool:approval_needed',
        data: {
          toolName: call.name,
          requestId: gate.approval.request_id,
          parameters: call.arguments,
          iteration,
        },
        timestamp: new Date(),
      })
      return { toolResults, pendingApproval: gate.approval }
    }

    const progressStart = reportToolStart(config, call, iteration, i, calls.length, llmTextContent)
    if (admission.kind !== 'execute') throw new Error('Admitted tool call has no execution phase')
    const toolResult = await executeAdmittedTool(admission, config, iteration)

    // Retain policy-processed output before a subsequent tool can throw.
    if (config.onAttachments && toolResult.attachments?.length) {
      const attachments: Attachment[] = []
      collectToolAttachments([toolResult], attachments)
      if (attachments.length) config.onAttachments(attachments)
    }
    if (config.abortSignal?.aborted) {
      toolResults.push(toolResult)
      return { toolResults, cancelled: true }
    }

    // U5 — reactive OAuth consent on the inline (auto-approved / cron / no-snapshot
    // resume) path: a live 401 on an oauth mcp-server surfaces a typed
    // connect_required marker. Suspend durably instead of feeding the auth error
    // to the LLM. Mirrors the approval-gate suspend block: the failed connect
    // `toolResult` is NOT pushed (the same tool re-executes fresh on resume),
    // remaining batch calls get synthetic not-executed results, and the frozen
    // context travels on the approval so resume can rebuild the history.
    const connectMarker = extractConnectRequiredMarker(toolResult.metadata)
    if (connectMarker) {
      // Close the tool card BEFORE suspending. `reportToolStart` already fired at
      // the top of this call (the tool HAD to execute to surface the 401), so
      // returning without a complete would strand the step card as "running"
      // until the suspended event lands. This matches the resume path
      // (taskExecutor emits reportToolComplete before its own connect-marker
      // check) — both connect paths emit start→complete→suspended. The
      // approval-gate suspend leaves no start only because it returns BEFORE
      // execution (a different timing, not an inconsistency).
      reportToolComplete(
        config,
        call,
        toolResult,
        progressStart,
        iteration,
        i,
        calls.length,
        usageEmitted ? undefined : usage
      )
      // NOTE: no `usageEmitted = true` here — this branch returns immediately
      // below (pendingApproval), so the write would be dead. `usage` was already
      // consumed by the reportToolComplete call above.
      const approval = buildConnectRequiredApproval(call, connectMarker)
      approval.intent_summary =
        extractToolIntent(llmTextContent ?? null, call.name) ??
        `Using ${getDisplayName(call.name)}...`
      for (let k = i + 1; k < calls.length; k++) {
        toolResults.push({
          tool_call_id: calls[k].id,
          name: calls[k].name,
          content: `Not executed — ${call.name} requires connection. Re-request if needed.`,
          is_error: true,
        })
      }
      if (priorMessages) {
        approval.context_snapshot = [...priorMessages]
        approval.completed_results = [...toolResults]
      }
      events.emit({
        type: 'tool:approval_needed',
        data: {
          toolName: call.name,
          requestId: approval.request_id,
          parameters: call.arguments,
          iteration,
        },
        timestamp: new Date(),
      })
      return { toolResults, pendingApproval: approval }
    }

    toolResults.push(toolResult)

    reportToolComplete(
      config,
      call,
      toolResult,
      progressStart,
      iteration,
      i,
      calls.length,
      usageEmitted ? undefined : usage
    )
    usageEmitted = true

    if (isWorkflowTriggerNotFoundToolResult(toolResult)) {
      for (let k = i + 1; k < calls.length; k++) {
        toolResults.push({
          tool_call_id: calls[k].id,
          name: calls[k].name,
          content:
            'Not executed — workflow_trigger returned workflow_not_found. Ask the user to retry with an exact workflow name.',
          is_error: true,
        })
      }
      break
    }
  }

  return { toolResults }
}
