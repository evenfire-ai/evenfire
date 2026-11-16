import { type SlackFollowUp, channelRunErrorText, planSlackReply } from './slackText'

export interface SlackAnswerDelivery {
  taskId: string
  edit: (text: string) => Promise<void>
  post: (text: string) => Promise<void>
  uploadSnippet: (filename: string, text: string) => Promise<void>
  onApiError: (err: unknown, op: 'chat.update' | 'chat.postMessage' | 'files.upload') => void
}

export type SlackAnswerResult = 'delivered' | 'error'

/**
 * Edit the acknowledgement with the first chunk and send the rest as
 * follow-up messages or snippet files. Any Slack API failure ends in an
 * error edit (or a posted error when the acknowledgement can no longer be
 * edited) so the "Processing" message cannot stay up.
 */
export async function deliverSlackAnswer(
  delivery: SlackAnswerDelivery,
  text: string
): Promise<SlackAnswerResult> {
  const plan = planSlackReply(text)
  let reason = 'the reply could not be posted'
  let reasonSet = false
  const noteFailure = (err: unknown) => {
    if (reasonSet) return
    reason = slackFailureReason(err)
    reasonSet = true
  }
  let editedAcknowledgement = false

  try {
    await delivery.edit(plan.acknowledgement)
    editedAcknowledgement = true
  } catch (err) {
    noteFailure(err)
    delivery.onApiError(err, 'chat.update')
  }

  const pending: SlackFollowUp[] = editedAcknowledgement
    ? plan.followUps
    : [
        plan.acknowledgementIsPlaceholder
          ? null
          : ({ kind: 'message', text: plan.acknowledgement } as SlackFollowUp),
        ...plan.followUps,
      ].filter((part): part is SlackFollowUp => part !== null)

  let followUpsDelivered = true
  for (const part of pending) {
    try {
      if (part.kind === 'message') await delivery.post(part.text)
      else await delivery.uploadSnippet(part.filename, part.text)
    } catch (err) {
      noteFailure(err)
      delivery.onApiError(err, part.kind === 'message' ? 'chat.postMessage' : 'files.upload')
      followUpsDelivered = false
      break
    }
  }

  if (editedAcknowledgement && followUpsDelivered) return 'delivered'
  if (!editedAcknowledgement && followUpsDelivered && pending.length > 0) {
    try {
      await delivery.edit('The answer is in the following message.')
      return 'delivered'
    } catch (err) {
      noteFailure(err)
      delivery.onApiError(err, 'chat.update')
    }
  }

  const errorText = channelRunErrorText(reason)
  if (editedAcknowledgement) {
    // The acknowledgement already shows the first chunk. A second edit would
    // wipe it, so the error is a follow-up and the run is still terminal.
    try {
      await delivery.post(errorText)
    } catch (err) {
      delivery.onApiError(err, 'chat.postMessage')
    }
    return 'error'
  }

  try {
    await delivery.edit(errorText)
  } catch (err) {
    delivery.onApiError(err, 'chat.update')
    try {
      await delivery.post(errorText)
    } catch (postErr) {
      delivery.onApiError(postErr, 'chat.postMessage')
    }
  }
  return 'error'
}

export function slackFailureReason(err: unknown): string {
  const code = slackErrorCode(err)
  if (!code || code === 'unknown') return 'Slack rejected the reply'
  return `Slack ${code}`
}

export function slackErrorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const data = (err as { data?: { error?: unknown } }).data
    if (typeof data?.error === 'string' && data.error.trim()) return data.error.trim()
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code.trim() && code !== 'slack_webapi_platform_error') {
      return code.trim()
    }
  }
  if (err instanceof Error && err.message.trim()) return err.message.trim().slice(0, 120)
  return 'unknown'
}
