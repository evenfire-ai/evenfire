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

/**
 * A failure the loop retries once after a short pause. ControlPlaneUnavailable
 * is here because it relabels a refused connect that reached the loop as a
 * retryable ApiCallFailed before #720 (review round 2 M4); a gateway's
 * `control_plane_unavailable` reply takes the same single retry.
 */
export function isRetryableLlmTransportError(error: Error): boolean {
  const maybeLlmError = error as { code?: unknown; retryable?: unknown }
  return (
    maybeLlmError.retryable === true &&
    (maybeLlmError.code === LlmErrorCode.ApiCallFailed ||
      maybeLlmError.code === LlmErrorCode.ControlPlaneUnavailable)
  )
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

// A direct trigger is `[can you] [please] <verb> [the] <one token>` followed only
// by filler (`now`, `please`, `again`, `immediately`), trailing punctuation
// (`.`, `!`, `?`, `,`, `;`, `:`), or `with|using`
// arguments. The head regex is anchored and every quantifier is bounded or
// separated from its neighbours by a literal, so it stays linear on adversarial
// input; the tail is checked with string operations instead of a second regex.
const DIRECT_TRIGGER_HEAD =
  /^\s*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:run|execute|trigger|start|launch)\s+(?:the\s+)?(\S{1,128})(?=\s|$)/i
const DIRECT_TRIGGER_FILLER = new Set(['now', 'again', 'please', 'immediately'])
const RECIPE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)+$/i

function stripTrailingSentencePunctuation(value: string): string {
  let end = value.length
  while (end > 0 && '.!?,;:'.includes(value[end - 1])) end--
  return value.slice(0, end)
}

function isDirectTriggerTail(tail: string): boolean {
  const words = tail.trim().split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const word = stripTrailingSentencePunctuation(words[i]).toLowerCase()
    if (word === '' || DIRECT_TRIGGER_FILLER.has(word)) continue
    return (word === 'with' || word === 'using') && i + 1 < words.length
  }
  return true
}

function isDirectRecipeTrigger(userText: string): boolean {
  const head = DIRECT_TRIGGER_HEAD.exec(userText)
  if (head === null) return false
  const candidate = stripTrailingSentencePunctuation(
    head[1].replace(/[\u0060\u0022\u0027\u201C\u201D\u2018\u2019]/g, '')
  )
  if (!RECIPE_NAME.test(candidate)) return false
  return isDirectTriggerTail(userText.slice(head[0].length))
}

export function shouldRecoverWorkflowTriggerTextResponse(
  userText: string,
  responseText: string
): boolean {
  if (isWorkflowListIntent(userText)) return false

  const normalizedUser = userText.toLowerCase()
  const namesDirectRecipe = isDirectRecipeTrigger(userText)
  const asksToTrigger = /\b(run|start|trigger|execute|launch)\b/.test(normalizedUser)
  const includesRecipeLikeName = /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/.test(normalizedUser)
  const namesWorkflow =
    /\bworkflow\s+recipe\b/.test(normalizedUser) ||
    namesDirectRecipe ||
    (includesRecipeLikeName && /\b(?:workflow|recipe)\b/.test(normalizedUser))
  if (!asksToTrigger || !namesWorkflow) return false

  const normalizedResponse = responseText.toLowerCase()
  return !/\b(workflow_trigger|approval request|approval recorded|approved and triggered|current phase)\b/.test(
    normalizedResponse
  )
}
