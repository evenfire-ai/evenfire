import { randomUUID } from 'crypto'
import { extractToolIntent, getDisplayName } from '../../progress/intentExtraction.js'
import {
  type ToolIdentity,
  recordAndCheck,
  recordDecision,
  resolveToolIdentityFromRegistry,
} from '../guardrails'
import type { ChatMessage, PendingApproval, TokenUsage, ToolCall, ToolResult } from '../types'
import type { LoopConfig } from './loopConfig'
import { executeSingleTool, reportToolComplete, reportToolStart } from './toolUseLoopSingleTool'
import { isWorkflowTriggerNotFoundToolResult } from './toolUseLoopWorkflowTriggerFallbacks'

/**
 * Build a guardrail-originated approval suspension (spec §6.3), shaped like the
 * existing approval gate so the batch loop's suspend path handles it unchanged.
 */
function buildGuardrailSuspension(
  call: ToolCall,
  config: LoopConfig,
  reasonCode: string
): { type: 'suspend'; approval: PendingApproval } {
  const descriptor = config.toolRegistry.get(call.name)?.traceDescriptor?.(call.arguments) ?? {
    kind: 'internal_tool' as const,
    sourceRef: 'mcp-host',
  }
  const approval: PendingApproval = {
    request_id: randomUUID(),
    tool_name: call.name,
    tool_kind: descriptor.kind,
    tool_source_ref: descriptor.sourceRef,
    parameters: call.arguments,
    description: `Guardrail requires approval (${reasonCode})`,
    tool_call_id: '', // filled below from call.id
    context_snapshot: [],
  }
  return { type: 'suspend', approval }
}

/** The 3 dynamic-tool-loading bridge tools. They are native and must never be
 * the TARGET of `clerum__tool_call` (LOCKED #11 — no recursion). */
const BRIDGE_TOOL_NAMES = new Set([
  'clerum__tool_search',
  'clerum__tool_describe',
  'clerum__tool_call',
])

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

    // Reject recursion / native targets (LOCKED #11): the bridge targets
    // DEFERRABLE MCP tools only.
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
    // REAL tool name, NOT `clerum__tool_call`. Provider pairing is by
    // `tool_call_id` ONLY, so preserving `call.id` is what matters — do NOT
    // re-mint the id (a fresh id would orphan the model's tool_use block).
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
  // (and non-MCP names) pass through untouched — they are always advertised and
  // resolved by the native registry. Stateless: nothing is recorded.
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

    const validation = config.toolOutputProcessor.beforeExecution(call.name, call.arguments)
    if (!validation.is_valid) {
      events.emit({
        type: 'safety:input_blocked',
        data: {
          toolName: call.name,
          errors: validation.errors,
          iteration,
        },
        timestamp: new Date(),
      })
      toolResults.push({
        tool_call_id: call.id,
        name: call.name,
        content: `Parameter validation failed: ${validation.errors.join(', ')}`,
        is_error: true,
      })
      continue
    }

    // Guardrail gate (spec §6) — behind config.guardrails; absent = today.
    let gate: 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval }
    // Resolved once when the guardrail runs; reused for PostToolUse redaction below.
    let toolIdentity: ToolIdentity | undefined
    if (config.guardrails) {
      const identity = resolveToolIdentityFromRegistry(
        call.name,
        config.toolRegistry,
        call.arguments
      )
      toolIdentity = identity

      // Doom-loop guard (spec §6.4): deny 3 consecutive identical (tool, input)
      // calls within a task. Best-effort runaway/cost guard, not a security
      // control (alternation evades it, §12.4/N12). Cross-turn state lives on the
      // conversation (ephemeral; resets on resume).
      const dlKey = `${identity.provenance}:${identity.server ?? ''}:${identity.name}:${JSON.stringify(call.arguments)}`
      const dl = recordAndCheck(config.conversation.guardrail_doom_loop ?? { count: 0 }, dlKey)
      config.conversation.guardrail_doom_loop = dl.state
      if (dl.tripped) {
        recordDecision('tool', 'deny', 'current', 'denied', 'repeated_identical_call')
        events.emit({
          type: 'guardrail:decision',
          data: {
            toolName: call.name,
            decision: 'deny',
            reasonCode: 'repeated_identical_call',
            source: 'current',
            iteration,
          },
          timestamp: new Date(),
        })
        toolResults.push({
          tool_call_id: call.id,
          name: call.name,
          content: 'Blocked: repeated identical tool call (doom-loop guard).',
          is_error: true,
        })
        continue
      }

      const gd = await config.guardrails.decide(identity, call.arguments)
      events.emit({
        type: 'guardrail:decision',
        data: {
          toolName: call.name,
          decision: gd.decision,
          reasonCode: gd.reasonCode,
          source: gd.source,
          iteration,
        },
        timestamp: new Date(),
      })

      const mode = config.executionMode ?? 'interactive'

      if (gd.decision === 'deny') {
        recordDecision('tool', 'deny', gd.source, 'denied', gd.reasonCode, mode)
        toolResults.push({
          tool_call_id: call.id,
          name: call.name,
          content: `Blocked by guardrail policy (${gd.reasonCode}).`,
          is_error: true,
        })
        continue
      }

      // Apply any honored rewrite (Phase 1 rules never rewrite; forward-compatible).
      if (gd.effectiveInput !== call.arguments) {
        call = { ...call, arguments: gd.effectiveInput }
      }

      if (gd.decision === 'ask') {
        // Resume-safe one-shot: an exact approve-once grant satisfies the ask
        // (spec §6.3). Broad `auto_approved_tools` do NOT — an explicit guardrail
        // ask needs an exact approval, so we only consume the pending_approval.
        const pending = config.conversation.pending_approval
        if (pending && pending.tool_name === call.name) {
          config.conversation.pending_approval = undefined
          recordDecision('tool', 'ask', gd.source, 'executed', gd.reasonCode, mode)
          gate = 'proceed'
        } else if (mode === 'unattended') {
          // §6.3: an `ask` with no human to answer it fails safe to deny.
          recordDecision('tool', 'deny', gd.source, 'denied', 'approval_unavailable', mode)
          toolResults.push({
            tool_call_id: call.id,
            name: call.name,
            content:
              'Blocked: approval required but no approver is available in an autonomous run.',
            is_error: true,
          })
          continue
        } else {
          recordDecision('tool', 'ask', gd.source, 'ask', gd.reasonCode, mode)
          gate = buildGuardrailSuspension(call, config, gd.reasonCode)
        }
      } else {
        // allow / no_decision → the existing approval path. Phase 1: guardrail
        // `allow` does NOT bypass existing approvals (separating containment from
        // approval is deferred — the safe direction).
        recordDecision('tool', gd.decision, gd.source, 'executed', gd.reasonCode, mode)
        gate = loopController.beforeTool(call.name, call.arguments)
      }
    } else {
      gate = loopController.beforeTool(call.name, call.arguments)
    }

    if (gate === 'skip') {
      toolResults.push({
        tool_call_id: call.id,
        name: call.name,
        content: 'Tool execution skipped',
        is_error: false,
      })
      continue
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
    let toolResult = await executeSingleTool(call, config, iteration)

    // PostToolUse redaction (spec §6.2 / §10 #3): installed `post_tool_use` hooks
    // may redact the model-visible result `content` (never `is_error`). Only the
    // LLM-message `content` is touched — `rawContent` (UI preview) is left intact.
    if (config.guardrails?.transformResult && toolIdentity) {
      const view = await config.guardrails.transformResult(toolIdentity, call.arguments, {
        content: toolResult.content,
        isError: toolResult.is_error,
      })
      if (view.content !== toolResult.content) {
        toolResult = { ...toolResult, content: view.content }
      }
    }
    toolResults.push(toolResult)

    if (config.abortSignal?.aborted) {
      return { toolResults, cancelled: true }
    }

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
