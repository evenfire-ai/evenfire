import { describe, expect, it } from 'vitest'
import { describeGfsGrantError } from '../gfsGrantErrors'

/**
 * Pure presentation map for GFS grant-plane server verdicts. Codes arrive
 * embedded in Electron IPC error messages, so matching is substring-based.
 */

describe('describeGfsGrantError', () => {
  it.each([
    [
      'agent_manager_forbidden',
      "Agents can't be given manage or share access.",
    ],
    [
      'managed_agent_permission_forbidden',
      'Managed agents can only be granted read and write.',
    ],
    ['foreign_agent_forbidden', 'You can only grant access to your own agents.'],
    ['escalation_rejected', 'You can only grant permissions you already hold here.'],
  ])('maps %s to its human message with error severity', (code, message) => {
    const presentation = describeGfsGrantError(
      new Error(`Error invoking remote method 'gfs:grant': Error: 403 Forbidden: ${code}`)
    )

    expect(presentation).toEqual({ code, message, severity: 'error' })
  })

  it('maps manage_acl_required to a quiet banner, never an error toast', () => {
    const presentation = describeGfsGrantError(
      new Error("Error invoking remote method 'gfs:listGrants': Error: 403 Forbidden: manage_acl_required")
    )

    expect(presentation).toEqual({
      code: 'manage_acl_required',
      message: 'Only people with manage access can view who has access here.',
      severity: 'quiet',
    })
  })

  it('maps subjects_invalid without indexes', () => {
    expect(describeGfsGrantError(new Error('400 Bad Request: subjects_invalid'))).toEqual({
      code: 'subjects_invalid',
      message: 'Some selected subjects are invalid and were rejected.',
      severity: 'error',
    })
  })

  it('appends 1-based subject positions when subjects_invalid carries invalidIndexes', () => {
    const presentation = describeGfsGrantError(
      new Error('400 Bad Request: subjects_invalid {"invalidIndexes":[0, 2]}')
    )

    expect(presentation).toEqual({
      code: 'subjects_invalid',
      message: 'Some selected subjects are invalid and were rejected. (subjects 1, 3)',
      severity: 'error',
    })
  })

  it('maps 429 with retryAfterSeconds into the retry message', () => {
    const presentation = describeGfsGrantError(
      new Error('429 Too Many Requests: {"error":"rate_limited","retryAfterSeconds":42}')
    )

    expect(presentation).toEqual({
      code: 'rate_limited',
      message: 'Too many permission changes — try again in 42s.',
      severity: 'error',
    })
  })

  it('maps 429 without a parseable retryAfterSeconds to the generic retry message', () => {
    const presentation = describeGfsGrantError(new Error('429 Too Many Requests'))

    expect(presentation).toEqual({
      code: 'rate_limited',
      message: 'Too many permission changes — try again shortly.',
      severity: 'error',
    })
  })

  it('does not treat an id containing 429 as a rate limit', () => {
    const presentation = describeGfsGrantError(new Error('resource res-4290 not found'))

    expect(presentation).toEqual({
      code: null,
      message: 'resource res-4290 not found',
      severity: 'error',
    })
  })

  it('passes unknown errors through verbatim — fail loud, never swallow', () => {
    expect(describeGfsGrantError(new Error('total surprise'))).toEqual({
      code: null,
      message: 'total surprise',
      severity: 'error',
    })
    expect(describeGfsGrantError('string failure')).toEqual({
      code: null,
      message: 'string failure',
      severity: 'error',
    })
  })
})
