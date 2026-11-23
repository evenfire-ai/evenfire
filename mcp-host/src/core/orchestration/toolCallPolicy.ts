import { randomUUID } from 'node:crypto'
import { logger } from '../../logger'
import { APPROVAL_INPUT_PREVIEW_BYTES } from '../../progress/approvalInputPreview'
import { effectiveApprovalMode } from '../approval/approvalMode'
import type { ApprovalMode } from '../approval/approvalMode'
import { type ModeDecision, decideApproval } from '../approval/decideApproval'
import type { GateCause } from '../approval/gateCause'
import { GIT_REDIRECT_TEXT, matchTypedGitRead } from '../approval/gitRedirect'
import { approvalLogId, syncEffectiveMode } from '../approval/grantMemory'
import { nativeApprovalCause } from '../approval/nativeApprovalCause'
import { shellCardDescriptor } from '../approval/shellCard'
import type { ShellVerdict } from '../approval/shellClassifier'
import { isDenied } from '../conversation/denialPolicy'
import { oneShotMatches } from '../extensions/approvalMatch'
import {
  type ToolGuardrailDecision,
  type ToolIdentity,
  atLeastAsStrict,
  recordAndCheck,
  recordDecision,
  resolveToolIdentityFromRegistry,
} from '../guardrails'
import type { RequestImageUsage } from '../interfaces'
import { gitReadReturnsContent } from '../tools/gitRead/definition'
import type { PendingApproval, ToolCall, ToolResult } from '../types'
import type { LoopConfig } from './loopConfig'
import { executeSingleTool } from './toolUseLoopSingleTool'

const CANCELLED_TEXT = 'Not executed: the task was cancelled.'
const GIT_READ = 'git_read'

export type ToolCallAdmission =
  /** `report`: emit tool start and complete progress for this result (the git redirect). */
  | { kind: 'result'; toolResult: ToolResult; stopBatch?: boolean; report?: true }
  | { kind: 'suspend'; approval: PendingApproval; cause?: GateCause }
  | { kind: 'execute'; call: ToolCall; toolIdentity?: ToolIdentity; cause?: GateCause }

/**
 * A guardrail `ask` card authorizes only the call it shows. For a tool the
 * user denied it is also a denial re-ask, so it never offers Always approve.
 */
function guardrailSuspension(
  call: ToolCall,
  config: LoopConfig,
  reasonCode: string,
  denied: boolean
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
      ...(denied ? { reask: 'denied' as const } : {}),
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
    noteEffectiveMode(config)
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
  let gate: 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval; cause?: GateCause }
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
      noteEffectiveMode(config)
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

    let decision = await config.guardrails.decide(toolIdentity, call.arguments)
    decision = withDerivedFileReads(config, call.name, toolIdentity, decision)
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
      noteEffectiveMode(config)
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
      // Resume-safe one-shot: only an exact approve-once grant for this very
      // call (name, call id and arguments) satisfies the ask, and never for a
      // tool the user denied. Allowlists do not.
      const pending = config.conversation.pending_approval
      const denied = isDenied(config.conversation, call.name)
      if (!denied && pending && oneShotMatches(pending, call.name, call.arguments, call.id)) {
        config.conversation.pending_approval = undefined
        recordDecision('tool', 'ask', decision.source, 'executed', decision.reasonCode, mode)
        noteEffectiveMode(config)
        return { kind: 'execute', call, toolIdentity, cause: 'none' }
      } else if (mode === 'unattended') {
        recordDecision('tool', 'deny', decision.source, 'denied', 'approval_unavailable', mode)
        noteEffectiveMode(config)
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
        gate = {
          ...guardrailSuspension(call, config, decision.reasonCode, denied),
          cause: 'guardrail_ask',
        }
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
      gate = config.loopController.beforeTool(call.name, call.arguments, call.id)
    }
  } else {
    gate = config.loopController.beforeTool(call.name, call.arguments, call.id)
  }

  if (!config.approvalMode) {
    if (gate === 'skip') return skipped(call)
    if (typeof gate === 'object' && gate.type === 'suspend') {
      return {
        kind: 'suspend',
        approval: gate.approval,
        ...(gate.cause !== undefined ? { cause: gate.cause } : {}),
      }
    }
    return { kind: 'execute', call, toolIdentity }
  }
  return applyApprovalMode(call, config, gate, toolIdentity)
}

/**
 * Applies the Host's `file_read` rules to the files a native tool call reads
 * (`Tool.fileReads`), so reading a file through another tool is never looser
 * than `file_read` itself. Only a strictly stricter result replaces the call's
 * own decision; the deny and ask branches then act on it as usual.
 */
function withDerivedFileReads(
  config: LoopConfig,
  name: string,
  identity: ToolIdentity,
  own: ToolGuardrailDecision
): ToolGuardrailDecision {
  if (identity.provenance !== 'native') return own
  const reads = config.toolRegistry.get(name)?.fileReads?.(own.effectiveInput)
  if (reads === undefined) return own
  const derived = config.guardrails?.derivedFileReadDecision?.(reads)
  if (derived === undefined) return own
  if (derived.decision === own.decision || !atLeastAsStrict(derived.decision, own.decision)) {
    return own
  }
  return { ...own, decision: derived.decision, reasonCode: derived.reasonCode, source: 'host_rule' }
}

function skipped(call: ToolCall): ToolCallAdmission {
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

function stopAdmission(call: ToolCall): ToolCallAdmission {
  return {
    kind: 'result',
    stopBatch: true,
    toolResult: {
      tool_call_id: call.id,
      name: call.name,
      content: CANCELLED_TEXT,
      is_error: true,
    },
  }
}

/** Sync the effective mode. Returns it. Logs L2 when a later value differs. */
function noteEffectiveMode(config: LoopConfig): ApprovalMode | undefined {
  const inputs = config.approvalMode
  if (!inputs) return undefined
  const stored = inputs.storedMode()
  const ceiling = inputs.ceiling()
  const cap = inputs.channelCap()
  const effective = effectiveApprovalMode(stored, ceiling, cap)
  const synced = syncEffectiveMode(config.conversation, effective)
  if (synced.changed) {
    logger.info(
      {
        event: 'L2',
        session: approvalLogId(config.conversation.id),
        storedMode: stored,
        previousEffectiveMode: synced.previous,
        effectiveApprovalMode: effective,
      },
      'Effective approval mode changed'
    )
  }
  return effective
}

function shellPreviewFlags(
  config: LoopConfig,
  toolName: string,
  parameters: Record<string, unknown>
): { truncated: boolean; redacted: boolean } {
  const command = parameters.command
  if (typeof command !== 'string') return { truncated: true, redacted: true }
  const redacted = config.safety.sanitizeOutput(toolName, command).content
  return {
    truncated: Buffer.from(redacted, 'utf8').byteLength > APPROVAL_INPUT_PREVIEW_BYTES,
    redacted: redacted !== command,
  }
}

/**
 * Read every mode getter and decide. Nothing is awaited in here.
 * Callers must not await between this and the table.
 */
function readDecision(
  config: LoopConfig,
  call: ToolCall,
  cause: GateCause | undefined,
  verdict?: ShellVerdict
): ModeDecision {
  const mode = noteEffectiveMode(config) ?? 'manual'
  const inputs = config.approvalMode!
  const command = typeof call.arguments.command === 'string' ? call.arguments.command : undefined
  return decideApproval({
    mode,
    toolName: call.name,
    cause,
    grants: {
      task: config.conversation.task_approved_tools ?? new Set<string>(),
      always: config.conversation.auto_approved_tools ?? new Set<string>(),
      autoShell: config.conversation.auto_shell_grants ?? {
        wholeTool: false,
        commands: new Set<string>(),
      },
    },
    ...(command !== undefined ? { command } : {}),
    ...(call.name === GIT_READ ? { contentRead: gitReadReturnsContent(call.arguments) } : {}),
    classifierAvailable: inputs.classifierAvailable(call.arguments),
    ...(verdict ? { verdict } : {}),
  })
}

function materialize(
  decision: ModeDecision,
  call: ToolCall,
  config: LoopConfig,
  cause: GateCause | undefined,
  approval: PendingApproval | undefined,
  toolIdentity: ToolIdentity | undefined
): ToolCallAdmission {
  if (decision.kind === 'stop' || decision.kind === 'classify') return stopAdmission(call)
  if (decision.kind === 'run') {
    if (decision.cell === 'X1') {
      logger.info(
        {
          event: 'L4',
          session: approvalLogId(config.conversation.id),
          tool: call.name,
          cause,
          mode: 'allow_all',
        },
        'Allow-all tool execution'
      )
    }
    return { kind: 'execute', call, toolIdentity, ...(cause !== undefined ? { cause } : {}) }
  }
  if (decision.cell === 'U1') {
    logger.warn(
      { event: 'U1', session: approvalLogId(config.conversation.id), tool: call.name },
      'Approval suspension had no cause'
    )
  }
  const card: PendingApproval = {
    ...(approval ?? {
      request_id: randomUUID(),
      tool_name: call.name,
      parameters: call.arguments,
      description: `Tool "${call.name}" requires approval before execution`,
      tool_call_id: call.id,
      context_snapshot: [],
      authorization_scope: 'turn_tools' as const,
    }),
  }
  if (decision.scope === 'exact_invocation') card.authorization_scope = 'exact_invocation'
  if (decision.shellCard) {
    card.shellCard = shellCardDescriptor(
      card.parameters,
      shellPreviewFlags(config, card.tool_name, card.parameters)
    )
  }
  return { kind: 'suspend', approval: card, ...(cause !== undefined ? { cause } : {}) }
}

async function applyApprovalMode(
  call: ToolCall,
  config: LoopConfig,
  gate: 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval; cause?: GateCause },
  toolIdentity: ToolIdentity | undefined
): Promise<ToolCallAdmission> {
  if (gate === 'skip') return skipped(call)
  let cause: GateCause | undefined = gate === 'proceed' ? 'none' : gate.cause
  let approval = gate === 'proceed' ? undefined : gate.approval
  let decision = readDecision(config, call, cause)
  const redirected = typedGitRedirect(config, call, cause, decision)
  if (redirected) return redirected
  if (decision.kind === 'classify') {
    const verdict = await config.approvalMode!.classify(call, approval?.description ?? '')
    if (verdict === 'CANCELLED') return stopAdmission(call)
    const fresh = config.loopController.beforeTool(call.name, call.arguments, call.id)
    if (fresh === 'skip') return skipped(call)
    if (fresh === 'proceed') {
      cause = 'none'
      approval = undefined
    } else {
      cause = fresh.cause
      approval = fresh.approval
    }
    decision = readDecision(config, call, cause, verdict)
  }
  return materialize(decision, call, config, cause, approval, toolIdentity)
}

/**
 * True when `git_read` would run with no card in auto for any arguments:
 * registered for this task, no tool-lane guardrails (its verdict would depend
 * on arguments the redirect does not have), not denied, and its CRD cause
 * (`approvalAlso` included) gives a run cell.
 */
function gitReadCardFree(config: LoopConfig): boolean {
  const tool = config.toolRegistry.get(GIT_READ)
  if (!tool) return false
  if (config.guardrails !== undefined) return false
  if (isDenied(config.conversation, GIT_READ)) return false
  const approvalTools = config.approvalMode?.approvalTools
  if (!approvalTools) return false
  const decision = decideApproval({
    mode: 'auto',
    toolName: GIT_READ,
    cause: nativeApprovalCause(tool, GIT_READ, {}, approvalTools()),
    grants: {
      task: config.conversation.task_approved_tools ?? new Set<string>(),
      always: config.conversation.auto_approved_tools ?? new Set<string>(),
      autoShell: { wholeTool: false, commands: new Set<string>() },
    },
    // The redirect points only names-only commands to git_read.
    contentRead: false,
    classifierAvailable: false,
  })
  return decision.kind === 'run'
}

/**
 * In auto, a typed read-only git shell command that would be classified or
 * carded (A3, or A5 for a denied shell) is answered with a fixed text that
 * points to `git_read`, once per command text per task. Grants, admin-forced,
 * live and guardrail causes, and every manual or allow-all cell keep today's
 * path.
 */
function typedGitRedirect(
  config: LoopConfig,
  call: ToolCall,
  cause: GateCause | undefined,
  decision: ModeDecision
): ToolCallAdmission | undefined {
  if (call.name !== 'shell_exec') return undefined
  const command = call.arguments.command
  if (typeof command !== 'string') return undefined
  const eligible =
    (decision.cell === 'A3' && (decision.kind === 'classify' || decision.kind === 'card')) ||
    (decision.kind === 'card' && decision.cell === 'A5' && cause === 'denied')
  if (!eligible) return undefined
  if (matchTypedGitRead(command) === null) return undefined
  const conversation = config.conversation
  // Whitespace variants are the same command: re-sending one is the escape.
  const key = command.trim().split(/\s+/).join(' ')
  if (conversation.task_git_redirected?.has(key) === true) return undefined
  if (!gitReadCardFree(config)) return undefined
  ;(conversation.task_git_redirected ??= new Set()).add(key)
  conversation.git_redirect_pending = true
  logger.info(
    { event: 'git_redirect', session: approvalLogId(conversation.id) },
    'Typed git command redirected to git_read'
  )
  return {
    kind: 'result',
    report: true,
    toolResult: {
      tool_call_id: call.id,
      name: call.name,
      content: GIT_REDIRECT_TEXT,
      is_error: false,
    },
  }
}

/**
 * The post_tool_use transform for one call, or undefined when no post hook is
 * installed. It runs inside executeSingleTool so a tool's finalizeResult fence
 * measures and publishes the transformed content, not the raw output.
 */
function guardrailResultTransform(
  config: LoopConfig,
  call: ToolCall,
  toolIdentity: ToolIdentity | undefined
): ((result: ToolResult) => Promise<ToolResult>) | undefined {
  const { guardrails } = config
  if (!guardrails?.transformResult || !toolIdentity) return undefined
  return async (result: ToolResult): Promise<ToolResult> => {
    const view = await guardrails.transformResult!(toolIdentity, call.arguments, {
      content: result.content,
      isError: result.is_error,
    })
    return view.content === result.content ? result : { ...result, content: view.content }
  }
}

export async function executeAdmittedTool(
  admission: Extract<ToolCallAdmission, { kind: 'execute' }>,
  config: LoopConfig,
  iteration: number,
  requestImages?: RequestImageUsage
): Promise<ToolResult> {
  const transformResult = guardrailResultTransform(config, admission.call, admission.toolIdentity)
  return executeSingleTool(admission.call, config, iteration, transformResult, requestImages)
}

/**
 * The same post_tool_use transform for a call a person approved, which the
 * resume path runs outside the loop, in every approval mode.
 */
export function approvedToolResultTransform(
  call: ToolCall,
  config: LoopConfig
): ((result: ToolResult) => Promise<ToolResult>) | undefined {
  const toolIdentity = config.guardrails
    ? resolveToolIdentityFromRegistry(call.name, config.toolRegistry, call.arguments)
    : undefined
  return guardrailResultTransform(config, call, toolIdentity)
}
