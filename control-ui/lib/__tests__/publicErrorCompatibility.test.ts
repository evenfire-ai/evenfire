import { describe, expect, it } from 'vitest'
import { formatApiError } from '../api'

describe('typed public error compatibility', () => {
  it('extracts safe nested public code and message', () => {
    const response = new Response(null, {
      status: 503,
      statusText: 'Service Unavailable',
    })
    const error = formatApiError(
      response,
      JSON.stringify({
        error: {
          code: 'authority_unavailable',
          message: 'Authorization is temporarily unavailable.',
          retryable: true,
        },
      })
    ) as Error & { code?: string }

    expect(error.message).toBe(
      '503 Service Unavailable - Authorization is temporarily unavailable.'
    )
    expect(error.code).toBe('authority_unavailable')
    expect(error.message).not.toContain('[object Object]')
  })
})
