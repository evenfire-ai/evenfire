import { describe, expect, it } from 'vitest'
import { signInContextFromClaimRow } from '../src/oidc/attemptSignInContextStore.js'

const CHALLENGE = 'C'.repeat(43)
const INVITATION_ID = '7f4e3a1c-2b5d-4e6f-8a9b-0c1d2e3f4a5b'
const INVITED_EMAIL = 'invitee@fixture.test'

describe('signInContextFromClaimRow', () => {
  it('maps absent or null context columns to a plain attempt', () => {
    expect(signInContextFromClaimRow({})).toBeNull()
    expect(
      signInContextFromClaimRow({
        ctx_kind: null,
        ctx_code_challenge: null,
        ctx_invitation_id: null,
        ctx_invited_email: null,
      })
    ).toBeNull()
  })

  it('maps a Desktop row and an invitation row to frozen contexts', () => {
    const desktop = signInContextFromClaimRow({
      ctx_kind: 'desktop_sign_in',
      ctx_code_challenge: CHALLENGE,
      ctx_invitation_id: null,
      ctx_invited_email: null,
    })
    expect(desktop).toEqual({ kind: 'desktop_sign_in', codeChallenge: CHALLENGE })
    expect(Object.isFrozen(desktop)).toBe(true)

    const invitation = signInContextFromClaimRow({
      ctx_kind: 'invitation',
      ctx_code_challenge: null,
      ctx_invitation_id: INVITATION_ID,
      ctx_invited_email: INVITED_EMAIL,
    })
    expect(invitation).toEqual({
      kind: 'invitation',
      invitationId: INVITATION_ID,
      invitedEmail: INVITED_EMAIL,
    })
    expect(Object.isFrozen(invitation)).toBe(true)
  })

  it.each([
    ['an unknown kind', { ctx_kind: 'password_reset', ctx_code_challenge: CHALLENGE }],
    ['a Desktop row without its challenge', { ctx_kind: 'desktop_sign_in' }],
    [
      'an invitation row without its email',
      { ctx_kind: 'invitation', ctx_invitation_id: INVITATION_ID, ctx_invited_email: null },
    ],
    [
      'an invitation row without its id',
      { ctx_kind: 'invitation', ctx_invitation_id: null, ctx_invited_email: INVITED_EMAIL },
    ],
  ])('refuses %s instead of reading it as a plain attempt', (_label, row) => {
    let thrown: unknown
    try {
      signInContextFromClaimRow(row)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toBe('OIDC attempt sign-in context is malformed')
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(message).not.toContain(value)
    }
  })
})
