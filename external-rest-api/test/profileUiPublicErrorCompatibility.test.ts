import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiSend } from '../../profile-ui/lib/api.js'
import { ControlApiError } from '../src/controlApiClient.js'
import { sanitizeControlApiPublicError } from '../src/http/publicApiError.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Profile UI public error compatibility', () => {
  it('renders the safe typed External REST message without object stringification', async () => {
    const publicError = sanitizeControlApiPublicError(
      new ControlApiError('private upstream failure', 503, {
        error: { code: 'authority_unavailable', message: 'private upstream failure' },
      }),
      new Set([503])
    )
    expect(publicError).not.toBeNull()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify(publicError!.body), {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'content-type': 'application/json' },
          })
      )
    )

    await expect(apiSend('POST', '/api/v1/members/invite', {})).rejects.toThrow(
      '503 Service Unavailable - Authorization is temporarily unavailable.'
    )
    await expect(apiSend('POST', '/api/v1/members/invite', {})).rejects.not.toThrow(
      /\[object Object\]|private upstream failure/
    )
  })
})
