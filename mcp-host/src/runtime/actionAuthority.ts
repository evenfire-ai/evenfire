import type {
  ActionOperationId,
  AuthorityBindingV2,
  TrustedEdgeActionContextV2,
} from '@clerum/action-context-contracts'
import type {
  ContextManageOptions,
  ContextManager,
  LlmPort,
  ReasoningPort,
} from '../core/interfaces'
import type { TokenCounter } from '../core/tokenizer/tokenCounter'
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  Conversation,
  ReasoningContext,
  RespondResult,
  ToolCompletionRequest,
  ToolCompletionResponse,
  ToolResult,
} from '../core/types'

export type RuntimeActionCheckpoint = (
  binding: AuthorityBindingV2
) => Promise<'allowed' | 'denied' | 'unavailable'>

export class RuntimeActionAuthorityError extends Error {
  constructor(readonly code: 'authority_unavailable' | 'access_path_stale' | 'operation_mismatch') {
    super(code)
    this.name = 'RuntimeActionAuthorityError'
  }
}

export function authorityBindingFromTrustedEdge(
  context: TrustedEdgeActionContextV2
): AuthorityBindingV2 {
  return Object.freeze({
    version: 2,
    userId: context.userId,
    sid: context.sid,
    sessionVersion: context.sessionVersion,
    delegationJti: context.delegationJti,
    operationId: context.operationId,
    resource: context.resource,
    target: context.target,
    targetHash: context.targetHash,
    accessPathId: context.accessPathId,
    authorizationRevision: context.authorizationRevision,
    pathKind: context.pathKind,
    effectiveTeamId: context.effectiveTeamId,
    behaviorBindingHash: context.behaviorBindingHash,
  })
}

export function assertRuntimeActionCurrent(
  context: TrustedEdgeActionContextV2,
  operationId: ActionOperationId,
  now = Date.now()
): void {
  if (context.operationId !== operationId) {
    throw new RuntimeActionAuthorityError('operation_mismatch')
  }
  if (!Number.isFinite(Date.parse(context.expiresAt))) {
    throw new RuntimeActionAuthorityError('authority_unavailable')
  }
  if (Date.parse(context.expiresAt) <= now) {
    throw new RuntimeActionAuthorityError('access_path_stale')
  }
}

export async function executeRuntimeEffect<T>(input: {
  context: TrustedEdgeActionContextV2
  operationId: ActionOperationId
  checkpoint: (binding: AuthorityBindingV2) => Promise<'allowed' | 'denied' | 'unavailable'>
  effect: () => Promise<T>
  now?: number
}): Promise<T> {
  assertRuntimeActionCurrent(input.context, input.operationId, input.now)
  return executeAuthorityBoundEffect({
    binding: authorityBindingFromTrustedEdge(input.context),
    operationId: input.operationId,
    checkpoint: input.checkpoint,
    effect: input.effect,
  })
}

export async function executeAuthorityBoundEffect<T>(input: {
  binding: AuthorityBindingV2
  operationId: ActionOperationId
  checkpoint: RuntimeActionCheckpoint
  effect: () => Promise<T>
}): Promise<T> {
  if (input.binding.operationId !== input.operationId) {
    throw new RuntimeActionAuthorityError('operation_mismatch')
  }
  let decision: 'allowed' | 'denied' | 'unavailable'
  try {
    decision = await input.checkpoint(input.binding)
  } catch {
    throw new RuntimeActionAuthorityError('authority_unavailable')
  }
  if (decision === 'unavailable') throw new RuntimeActionAuthorityError('authority_unavailable')
  if (decision === 'denied') throw new RuntimeActionAuthorityError('access_path_stale')
  return input.effect()
}

export function withRuntimeActionAuthority(
  reasoning: ReasoningPort,
  binding: AuthorityBindingV2,
  checkpoint: RuntimeActionCheckpoint
): ReasoningPort {
  const execute = <T>(effect: () => Promise<T>) =>
    executeAuthorityBoundEffect({
      binding,
      operationId: 'chat.message.invoke',
      checkpoint,
      effect,
    })
  return {
    respondWithTools: (context: ReasoningContext): Promise<RespondResult> =>
      execute(() => reasoning.respondWithTools(context)),
    continueWithToolResults: (
      context: ReasoningContext,
      results: ToolResult[]
    ): Promise<RespondResult> => execute(() => reasoning.continueWithToolResults(context, results)),
  }
}

export function withRuntimeActionAuthorityForLlmPort(
  llmPort: LlmPort,
  binding: AuthorityBindingV2,
  checkpoint: RuntimeActionCheckpoint
): LlmPort {
  const execute = <T>(effect: () => Promise<T>) =>
    executeAuthorityBoundEffect({
      binding,
      operationId: 'chat.message.invoke',
      checkpoint,
      effect,
    })
  return {
    complete: (request: CompletionRequest): Promise<CompletionResponse> =>
      execute(() => llmPort.complete(request)),
    completeWithTools: (request: ToolCompletionRequest): Promise<ToolCompletionResponse> =>
      execute(() => llmPort.completeWithTools(request)),
    modelName: () => llmPort.modelName(),
    getTokenCounter: (): TokenCounter => {
      const counter = llmPort.getTokenCounter?.()
      if (!counter) {
        throw new Error('[RuntimeActionAuthorityLlmPort] delegate has no token counter')
      }
      return counter
    },
  }
}

export function withRuntimeActionAuthorityForContextManager(
  contextManager: ContextManager,
  binding: AuthorityBindingV2,
  checkpoint: RuntimeActionCheckpoint
): ContextManager {
  return {
    manage: (
      messages: ChatMessage[],
      conversation: Conversation,
      options?: ContextManageOptions
    ): Promise<ChatMessage[]> =>
      executeAuthorityBoundEffect({
        binding,
        operationId: 'chat.message.invoke',
        checkpoint,
        effect: async () => contextManager.manage(messages, conversation, options),
      }),
  }
}
