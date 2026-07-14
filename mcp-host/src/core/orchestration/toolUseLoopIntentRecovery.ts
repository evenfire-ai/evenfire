import { LlmErrorCode } from '../errors'
import type { ChatMessage } from '../types'

export function isEmptyResponseAfterToolResults(error: Error): boolean {
  return (
    'code' in error &&
    error.code === LlmErrorCode.InvalidResponse &&
    /empty response/i.test(error.message)
  )
}

export function isRetryableLlmError(error: Error): boolean {
  const maybeLlmError = error as { code?: unknown; retryable?: unknown }
  return (
    maybeLlmError.retryable === true &&
    typeof maybeLlmError.code === 'string' &&
    maybeLlmError.code.startsWith('LLM_')
  )
}

export function isRetryableLlmTransportError(error: Error): boolean {
  const maybeLlmError = error as { code?: unknown; retryable?: unknown }
  return maybeLlmError.retryable === true && maybeLlmError.code === LlmErrorCode.ApiCallFailed
}

export function latestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user' && typeof message.content === 'string') {
      const content = message.content.trim()
      if (content) return content
    }
  }
  return ''
}

export function isWorkflowArtifactIntent(text: string): boolean {
  const normalized = text.toLowerCase()
  const asksForArtifact = /\b(workflow\s+result|result\s+artifact|artifact|download|output)\b/.test(
    normalized
  )
  if (!asksForArtifact) return false
  return !/\b(run|start|trigger|execute|launch)\b/.test(normalized)
}

export function isWorkflowListIntent(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!/\bworkflow\s+recipes?\b/.test(normalized)) return false

  const explicitlyRunsNamedRecipe =
    /\b(run|start|trigger|execute|launch)\s+(?:the\s+)?[a-z0-9]+(?:-[a-z0-9]+)+\b/.test(
      normalized
    ) ||
    /\b(run|start|trigger|execute|launch)\s+(?:the\s+)?workflow(?:\s+recipe)?\b/.test(normalized)
  if (explicitlyRunsNamedRecipe && !/\b(can\s+i\s+run|i\s+can\s+run)\b/.test(normalized)) {
    return false
  }

  return (
    /\b(list|show|which|what|available|access)\b/.test(normalized) ||
    /\bworkflow\s+recipes?\s+(?:i\s+can\s+run|can\s+i\s+run)\b/.test(normalized) ||
    /\b(?:i\s+can\s+run|can\s+i\s+run)\s+workflow\s+recipes?\b/.test(normalized)
  )
}

export function shouldRecoverWorkflowArtifactTextResponse(userText: string): boolean {
  if (!isWorkflowArtifactIntent(userText)) return false

  const normalizedUser = userText.toLowerCase()
  const namesWorkflow = /\bworkflow\b/.test(normalizedUser)
  const includesRecipeLikeName = /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/.test(normalizedUser)
  return namesWorkflow && includesRecipeLikeName
}

export function shouldRecoverWorkflowTriggerTextResponse(
  userText: string,
  responseText: string
): boolean {
  if (isWorkflowListIntent(userText)) return false

  const normalizedUser = userText.toLowerCase()
  const asksToTrigger = /\b(run|start|trigger|execute|launch)\b/.test(normalizedUser)
  const includesRecipeLikeName = /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/.test(normalizedUser)
  const namesWorkflow = /\bworkflow\s+recipe\b/.test(normalizedUser) || includesRecipeLikeName
  if (!asksToTrigger || !namesWorkflow) return false

  const normalizedResponse = responseText.toLowerCase()
  return !/\b(workflow_trigger|approval request|approval recorded|approved and triggered|current phase)\b/.test(
    normalizedResponse
  )
}
