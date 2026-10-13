import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  type ToolIdentity,
  recordAndCheck,
  recordDecision,
  resolveToolIdentityFromRegistry,
} from '../guardrails'
import type { PendingApproval, ToolCall, ToolResult } from '../types'
import type { LoopConfig } from './loopConfig'
import { executeSingleTool } from './toolUseLoopSingleTool'

export type ToolCallAdmission =
  | { kind: 'result'; toolResult: ToolResult }
  | { kind: 'suspend'; approval: PendingApproval }
  | { kind: 'execute'; call: ToolCall; toolIdentity?: ToolIdentity }

function guardrailSuspension(
  call: ToolCall,
  config: LoopConfig,
  reasonCode: string
): { type: 'suspend'; approval: PendingApproval } {
  const descriptor = config.toolRegistry.get(call.name)?.traceDescriptor?.(call.arguments) ?? {
    kind: 'internal_tool' as const,
    sourceRef: 'mcp-host' as const,
  }
  return {
    type: 'suspend',
    approval: {
      request_id: randomUUID(),
      authorization_scope: 'exact_invocation',
      tool_name: call.name,
      tool_kind: descriptor.kind,
      tool_source_ref: descriptor.sourceRef,
      parameters: call.arguments,
      description: `Guardrail requires approval (${reasonCode})`,
      tool_call_id: call.id,
      context_snapshot: [],
    },
  }
}

/**
 * Shared per-call admission: validation, doom-loop, tool-lane guardrails and
 * the live approval gate. Both model-generated calls and Host preparation use
 * this exact boundary; no caller may execute a tool directly after policy.
 */
export async function admitToolCall(
  inputCall: ToolCall,
  config: LoopConfig,
  iteration: number
): Promise<ToolCallAdmission> {
  let call = inputCall
  let validation = config.toolOutputProcessor.beforeExecution(call.name, call.arguments)
  if (validation.is_valid) {
    validation =
      (await config.toolRegistry.get(call.name)?.validateParams?.(call.arguments)) ?? validation
  }
  if (!validation.is_valid) {
    config.events.emit({
      type: 'safety:input_blocked',
      data: { toolName: call.name, errors: validation.errors, iteration },
      timestamp: new Date(),
    })
    return {
      kind: 'result',
      toolResult: {
        tool_call_id: call.id,
        name: call.name,
        content: `Parameter validation failed: ${validation.errors.join(', ')}`,
        is_error: true,
      },
    }
  }

  let toolIdentity: ToolIdentity | undefined
  let gate: 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval }
  if (config.guardrails) {
    toolIdentity = resolveToolIdentityFromRegistry(call.name, config.toolRegistry, call.arguments)
    const key = `${toolIdentity.provenance}:${toolIdentity.server ?? ''}:${toolIdentity.name}:${JSON.stringify(call.arguments)}`
    const doomLoop = recordAndCheck(config.conversation.guardrail_doom_loop ?? { count: 0 }, key)
    config.conversation.guardrail_doom_loop = doomLoop.state
    if (doomLoop.tripped) {
      recordDecision('tool', 'deny', 'current', 'denied', 'repeated_identical_call')
      config.events.emit({
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
      return {
        kind: 'result',
        toolResult: {
          tool_call_id: call.id,
          name: call.name,
          content: 'Blocked: repeated identical tool call (doom-loop guard).',
          is_error: true,
        },
      }
    }

    const decision = await config.guardrails.decide(toolIdentity, call.arguments)
    config.events.emit({
      type: 'guardrail:decision',
      data: {
        toolName: call.name,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        source: decision.source,
        iteration,
      },
      timestamp: new Date(),
    })
    const mode = config.executionMode ?? 'interactive'
    if (decision.decision === 'deny') {
      recordDecision('tool', 'deny', decision.source, 'denied', decision.reasonCode, mode)
      return {
        kind: 'result',
        toolResult: {
          tool_call_id: call.id,
          name: call.name,
          content: `Blocked by guardrail policy (${decision.reasonCode}).`,
          is_error: true,
        },
      }
    }
    if (decision.effectiveInput !== call.arguments) {
      call = { ...call, arguments: decision.effectiveInput }
    }
    if (decision.decision === 'ask') {
      const pending = config.conversation.pending_approval
      const exactInvocationMatches =
        pending?.authorization_scope !== 'turn_tools' &&
        pending?.tool_call_id === call.id &&
        isDeepStrictEqual(pending?.parameters, call.arguments)
      const pendingMatches =
        pending?.tool_name === call.name &&
        (pending.authorization_scope === 'turn_tools' || exactInvocationMatches)
      if (pending && pendingMatches) {
        config.conversation.pending_approval = undefined
        recordDecision('tool', 'ask', decision.source, 'executed', decision.reasonCode, mode)
        gate = 'proceed'
      } else if (mode === 'unattended') {
        recordDecision('tool', 'deny', decision.source, 'denied', 'approval_unavailable', mode)
        return {
          kind: 'result',
          toolResult: {
            tool_call_id: call.id,
            name: call.name,
            content:
              'Blocked: approval required but no approver is available in an autonomous run.',
            is_error: true,
          },
        }
      } else {
        recordDecision('tool', 'ask', decision.source, 'ask', decision.reasonCode, mode)
        gate = guardrailSuspension(call, config, decision.reasonCode)
      }
    } else {
      recordDecision(
        'tool',
        decision.decision,
        decision.source,
        'executed',
        decision.reasonCode,
        mode
      )
      gate = config.loopController.beforeTool(call.name, call.arguments)
    }
  } else {
    gate = config.loopController.beforeTool(call.name, call.arguments)
  }

  if (gate === 'skip') {
    return {
      kind: 'result',
      toolResult: {
        tool_call_id: call.id,
        name: call.name,
        content: 'Tool execution skipped',
        is_error: false,
      },
    }
  }
  if (typeof gate === 'object' && gate.type === 'suspend')
    return { kind: 'suspend', approval: gate.approval }
  return { kind: 'execute', call, toolIdentity }
}

export async function executeAdmittedTool(
  admission: Extract<ToolCallAdmission, { kind: 'execute' }>,
  config: LoopConfig,
  iteration: number
): Promise<ToolResult> {
  const { guardrails } = config
  const { toolIdentity } = admission
  // The transform runs inside executeSingleTool so a tool's finalizeResult
  // fence measures and publishes the transformed content, not the raw output.
  const transformResult =
    guardrails?.transformResult && toolIdentity
      ? async (result: ToolResult): Promise<ToolResult> => {
          const view = await guardrails.transformResult!(toolIdentity, admission.call.arguments, {
            content: result.content,
            isError: result.is_error,
          })
          return view.content === result.content ? result : { ...result, content: view.content }
        }
      : undefined
  return executeSingleTool(admission.call, config, iteration, transformResult)
}
