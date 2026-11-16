import { hostAdmissionRetryAfter } from './hostAdmission.js'
import type { McpHostDecisionResult } from './mcpHostClient.js'

/**
 * What the reader says after a Slack or Teams decision was submitted in the
 * background. `shared` rewrites the approval message everyone sees (and removes
 * its buttons); `notice` is a new message about one user's click.
 *
 * Rules: the approval message changes only when the decision is recorded or
 * the approval is no longer pending. Every other result is a notice, and the
 * approval message keeps its buttons. A decision is submitted once; the
 * reader does not send it again.
 */
export type DecisionFeedbackPlan =
  | { shared: { action: 'update_success' | 'update_stale'; text: string }; notice: null }
  | { shared: null; notice: { action: 'send_failure'; text: string } }

export type DecisionFeedbackMedium = 'slack' | 'teams'

export type DecisionFeedbackInput = {
  medium: DecisionFeedbackMedium
  decision: 'approve' | 'deny'
  result: McpHostDecisionResult
}

export const DECISION_STALE_TEXT = 'This workflow approval is no longer pending.'

export function decisionRecordedText(decision: 'approve' | 'deny'): string {
  return `${decision === 'deny' ? 'Denied' : 'Approved'}. Workflow approval recorded.`
}

export function assistantBusyText(retryAfterSeconds: number): string {
  return `The assistant is busy. Try again in ${retryAfterSeconds} seconds.`
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
  if (isStaleDecisionResult(result)) {
    return { shared: { action: 'update_stale', text: DECISION_STALE_TEXT }, notice: null }
  }
  return {
    shared: null,
    notice: {
      action: 'send_failure',
      text: decisionFailureText(input.medium, input.decision, result),
    },
  }
}
