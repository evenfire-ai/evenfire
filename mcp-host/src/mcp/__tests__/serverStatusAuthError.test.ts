/**
 * U4 seam — strict auth-error detection (mini-spec 03 §5).
 *
 * isAuthError MUST read only the STRUCTURED HTTP status (401/403). It must NOT
 * consult the message regex, which would extract '320' from a JSON-RPC -32003
 * (session-lost) code and misclassify it as an auth error.
 */
import { describe, expect, it } from 'vitest'
import { extractHttpStatus, extractStructuredHttpStatus, isAuthError } from '../serverStatus'

describe('isAuthError — strict structured status only', () => {
  it('is true for a structured 401 (StreamableHTTP .code) and 403 (.status)', () => {
    expect(isAuthError({ code: 401, message: 'Unauthorized' })).toBe(true)
    expect(isAuthError({ status: 401 })).toBe(true)
    expect(isAuthError({ statusCode: 403 })).toBe(true)
    expect(isAuthError({ code: 403 })).toBe(true)
  })

  it('is FALSE for a JSON-RPC -32003 session-lost error (regex would read 320)', () => {
    // Message deliberately shaped to trigger the lenient regex ("code" + digits).
    const sessionLost = { code: -32003, message: 'JSON-RPC code -32003 session not found' }
    expect(isAuthError(sessionLost)).toBe(false)
    // The lenient extractor IS fooled by the message digits (extracts '320')...
    expect(extractHttpStatus(sessionLost, sessionLost.message)).toBe(320)
    // ...but the strict structured extractor (what isAuthError uses) is not.
    expect(extractStructuredHttpStatus(sessionLost)).toBeNull()
  })

  it('is false for -32000 and for non-auth HTTP statuses', () => {
    expect(isAuthError({ code: -32000, message: 'Server not initialized' })).toBe(false)
    expect(isAuthError({ status: 500 })).toBe(false)
    expect(isAuthError({ status: 404 })).toBe(false)
  })

  it('is false when only a message string carries "401" (no structured status)', () => {
    // No structured field — must not be treated as an auth error.
    expect(isAuthError(new Error('initialize returned 401'))).toBe(false)
  })
})
