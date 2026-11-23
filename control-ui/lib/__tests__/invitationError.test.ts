import { describe, expect, it } from 'vitest'
import { formatApiError } from '../api'
import { describeRetiredMemberInvitationError } from '../invitationError'

// The body is the invitation guard's real 409 answer (control-api
// routes/admin/teamInvitations.ts sendExistingMemberConflict).
function retiredRefusal(): Error {
  const body = JSON.stringify({
    error: 'member_email_retired',
    message: "This email belongs to a removed member and can't be invited again.",
    email: 'removed@example.com',
  })
  return formatApiError(new Response(body, { status: 409, statusText: 'Conflict' }), body)
}

describe('describeRetiredMemberInvitationError', () => {
  it('shows the removed-member refusal without the status prefix', () => {
    const error = retiredRefusal()
    // Positive: the raw error does carry the prefix the helper must drop.
    expect(error.message).toBe(
      "409 Conflict - This email belongs to a removed member and can't be invited again."
    )
    expect(describeRetiredMemberInvitationError(error)).toBe(
      "This email belongs to a removed member and can't be invited again."
    )
  })

  it('leaves every other error to the caller', () => {
    const body = JSON.stringify({ error: 'member_exists', message: 'A member with this email' })
    const other = formatApiError(new Response(body, { status: 409, statusText: 'Conflict' }), body)
    expect(describeRetiredMemberInvitationError(other)).toBeUndefined()
    expect(describeRetiredMemberInvitationError('boom')).toBeUndefined()
  })
})
