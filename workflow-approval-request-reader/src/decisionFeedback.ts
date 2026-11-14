import { hostAdmissionRetryAfter } from './decisionAdmissionRetry.js'
import type { McpHostDecisionResult } from './mcpHostClient.js'

/**
 * What the reader says after a Slack or Teams decision was submitted in the
 * background. `shared` rewrites the approval message everyone sees (and removes
 * its buttons); `notice` is a new message about one user's click.
 *
 * Rules: the approval message changes only when the decision is recorded, or
 * when a first attempt finds the approval no longer pending. A background retry
 * changes it only when it succeeds; every other retry result is a notice.
 */
export type DecisionFeedbackPlan = {
  shared: null | { action: 'update_success' | 'update_stale'; text: string }
  notice: null | {
    action: 'send_retry_scheduled' | 'send_failure' | 'send_retry_stale'
    text: string
  }
}

export type DecisionFeedbackMedium = 'slack' | 'teams'

export type DecisionFeedbackInput = {
  medium: DecisionFeedbackMedium
  decision: 'approve' | 'deny'
  attempt: 'first' | 'retry'
  result: McpHostDecisionResult
  /** Outcome of arming the background retry; null when no arming was attempted. */
  armed: 'scheduled' | 'held' | 'not_scheduled' | null
}

export const DECISION_STALE_TEXT = 'This workflow approval is no longer pending.'

export const DECISION_RETRY_STALE_TEXT =
  'Your earlier decision was not recorded: this workflow approval is no longer pending.'

export function decisionRecordedText(decision: 'approve' | 'deny'): string {
  return `${decision === 'deny' ? 'Denied' : 'Approved'}. Workflow approval recorded.`
}

export function assistantBusyText(retryAfterSeconds: number): string {
  return `The assistant is busy. Try again in ${retryAfterSeconds} seconds.`
}

export function decisionRetryScheduledText(retryAfterSeconds: number): string {
  return `The assistant is busy. Your decision will be sent again in ${retryAfterSeconds} seconds. If the approval message has not changed a minute from now, choose again.`
}

export function decisionAlreadySentText(): string {
  return 'Your earlier decision for this workflow approval is still being sent. Its result will appear on the approval message, or in a message here if it is not recorded.'
}

/**
 * A stale answer is keyed by the error code, whatever the status: the Host
 * relays control-api's refusal as 409, and the can-approve consult answers 403.
 */
function isStaleDecisionResult(result: McpHostDecisionResult): boolean {
  return result.error === 'approval_not_pending' || result.error === 'approval_route_not_found'
}

function decisionFailureText(
  medium: DecisionFeedbackMedium,
  decision: 'approve' | 'deny',
  result: McpHostDecisionResult
): string {
  if (result.status === 403 || result.error === 'not_authorized') {
    const conversation = medium === 'teams' ? 'Teams' : 'Slack'
    return `You are not allowed to decide this workflow approval from this ${conversation} conversation.`
  }
  const retryAfterSeconds = hostAdmissionRetryAfter(result)
  if (retryAfterSeconds !== undefined) return assistantBusyText(retryAfterSeconds)
  return `I could not ${decision} this workflow approval. Try again in a moment.`
}

export function planDecisionFeedback(input: DecisionFeedbackInput): DecisionFeedbackPlan {
  const { result } = input
  if (result.ok) {
    return {
      shared: { action: 'update_success', text: decisionRecordedText(input.decision) },
      notice: null,
    }
  }
  if (input.armed === 'held') return { shared: null, notice: null }
  if (input.armed === 'scheduled') {
    const retryAfterSeconds = hostAdmissionRetryAfter(result)
    if (retryAfterSeconds === undefined) {
      throw new Error('a scheduled decision retry needs the Host admission wait')
    }
    return {
      shared: null,
      notice: {
        action: 'send_retry_scheduled',
        text: decisionRetryScheduledText(retryAfterSeconds),
      },
    }
  }
  if (isStaleDecisionResult(result)) {
    return input.attempt === 'first'
      ? { shared: { action: 'update_stale', text: DECISION_STALE_TEXT }, notice: null }
      : { shared: null, notice: { action: 'send_retry_stale', text: DECISION_RETRY_STALE_TEXT } }
  }
  return {
    shared: null,
    notice: {
      action: 'send_failure',
      text: decisionFailureText(input.medium, input.decision, result),
    },
  }
}
