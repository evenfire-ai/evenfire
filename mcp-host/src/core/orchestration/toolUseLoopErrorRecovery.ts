import type { ChatMessage, ToolResult } from '../types'
import {
  isEmptyResponseAfterToolResults,
  isRetryableLlmError,
  shouldRecoverWorkflowTriggerTextResponse,
} from './toolUseLoopIntentRecovery'
import { buildWorkflowToolSuccessFallbackResponse } from './toolUseLoopWorkflowFallbacks'

interface LoopErrorRecoveryInput {
  error: Error
  continuingFromToolResults: boolean
  emptyResponseAfterToolResultsRecovered: boolean
  emptyInitialResponseRecovered: boolean
  workflowTriggerTextResponseRecovered: boolean
  lastCompletedToolResultsForFallback: ToolResult[] | null
  messages: ChatMessage[]
  iteration: number
  userRequestText: string
}

type LoopErrorRecoveryResult =
  | {
      type: 'continue'
      messages: ChatMessage[]
      emptyResponseAfterToolResultsRecovered?: boolean
      emptyInitialResponseRecovered?: boolean
      workflowTriggerTextResponseRecovered?: boolean
    }
  | {
      type: 'response'
      content: string
      logMessage: string
    }
  | { type: 'error' }

export function handleLoopErrorRecovery(input: LoopErrorRecoveryInput): LoopErrorRecoveryResult {
  const {
    error,
    continuingFromToolResults,
    emptyResponseAfterToolResultsRecovered,
    emptyInitialResponseRecovered,
    workflowTriggerTextResponseRecovered,
    lastCompletedToolResultsForFallback,
    messages,
    iteration,
    userRequestText,
  } = input

  if (isEmptyResponseAfterToolResults(error)) {
    if (continuingFromToolResults && !emptyResponseAfterToolResultsRecovered) {
      const recoverWorkflowTriggerAfterToolResults =
        !workflowTriggerTextResponseRecovered &&
        !hasWorkflowTriggerResultForCurrentUserTurn(messages) &&
        shouldRecoverWorkflowTriggerTextResponse(userRequestText, '') &&
        lastCompletedToolResultsForFallback?.some(result => result.name === 'workflow_list') ===
          true

      return {
        type: 'continue',
        messages: [
          ...messages,
          {
            role: 'user',
            content: recoverWorkflowTriggerAfterToolResults
              ? 'The previous tool result listed workflows but did not trigger the requested workflow. The user asked to run a named workflow recipe. Use workflow_trigger for that recipe and authenticated target when it is available, or use workflow tools to prove it is not available. Do not only summarize workflow_list.'
              : 'The previous assistant turn after the tool result was empty. Reply to the user using only the tool results above. Do not infer results that were not returned.',
          },
        ],
        emptyResponseAfterToolResultsRecovered: true,
        workflowTriggerTextResponseRecovered: recoverWorkflowTriggerAfterToolResults || undefined,
      }
    }

    if (
      !continuingFromToolResults &&
      !emptyInitialResponseRecovered &&
      !lastCompletedToolResultsForFallback &&
      !messages.some(message => message.role === 'tool')
    ) {
      return {
        type: 'continue',
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'The previous assistant turn was empty. Continue the user request now. Use the available tools when needed, and do not invent workflow names, workflow results, approvals, runs, or artifacts.',
          },
        ],
        emptyInitialResponseRecovered: true,
      }
    }

    const workflowFallback = buildWorkflowToolSuccessFallbackResponse(
      lastCompletedToolResultsForFallback
    )
    if (workflowFallback) {
      return {
        type: 'response',
        content: workflowFallback,
        logMessage: `[NewCore:Loop] EXIT → workflow fallback after empty response, iterations=${iteration + 1}`,
      }
    }
  }

  if (continuingFromToolResults && isRetryableLlmError(error)) {
    const workflowFallback = buildWorkflowToolSuccessFallbackResponse(
      lastCompletedToolResultsForFallback
    )
    if (workflowFallback) {
      return {
        type: 'response',
        content: workflowFallback,
        logMessage: `[NewCore:Loop] EXIT → workflow fallback after retryable LLM error, iterations=${iteration + 1}`,
      }
    }
  }

  return { type: 'error' }
}

export function hasWorkflowTriggerResultForCurrentUserTurn(messages: ChatMessage[]): boolean {
  return hasWorkflowToolResultForCurrentUserTurn(messages, 'workflow_trigger')
}

export function hasWorkflowListResultForCurrentUserTurn(messages: ChatMessage[]): boolean {
  return hasWorkflowToolResultForCurrentUserTurn(messages, 'workflow_list')
}

export function hasToolResultForCurrentUserTurn(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'tool') return true
    if (message.role === 'user') return false
  }
  return false
}

function hasWorkflowToolResultForCurrentUserTurn(
  messages: ChatMessage[],
  toolName: string
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'tool' && message.name === toolName) return true
    if (message.role === 'user') return false
  }
  return false
}
