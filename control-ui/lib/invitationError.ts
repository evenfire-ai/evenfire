import type { ApiRequestError } from './api.types'

const MEMBER_EMAIL_RETIRED_MESSAGE =
  "This email belongs to a removed member and can't be invited again."

/**
 * Message for a failed invitation request. The invitation guard answers 409
 * `member_email_retired` for a removed member's address; `formatApiError`
 * prefixes every status error with "409 Conflict - ", which reads as noise for
 * this refusal. Keyed on the machine-readable code, not the message text.
 * Returns undefined for any other error, so each screen keeps its own handling.
 */
export function describeRetiredMemberInvitationError(error: unknown): string | undefined {
  if (error instanceof Error && (error as ApiRequestError).code === 'member_email_retired') {
    return MEMBER_EMAIL_RETIRED_MESSAGE
  }
  return undefined
}
