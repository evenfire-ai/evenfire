import { describe, expect, it, vi } from 'vitest'
import { formatApiError, handleControlUIUnauthorized, setGlobalAuthErrorHandler } from '../api'

describe('handleControlUIUnauthorized', () => {
  it('clears the legacy browser token and invokes the registered session-expiry handler', () => {
    const handler = vi.fn()
    window.localStorage.setItem('controlUiAdminToken', 'synthetic-test-token')
    setGlobalAuthErrorHandler(handler)

    handleControlUIUnauthorized()

    expect(window.localStorage.getItem('controlUiAdminToken')).toBeNull()
    expect(handler).toHaveBeenCalledOnce()
  })
})

describe('formatApiError', () => {
  it('preserves a nested structured error without rendering object Object', () => {
    const text = JSON.stringify({
      error: {
        code: 'already_exists',
        message: 'a resource with this name already exists',
      },
    })
    const error = formatApiError(
      new Response(text, { status: 409, statusText: 'Conflict' }),
      text
    ) as Error & { status?: number; code?: string; body?: Record<string, unknown> }

    expect(error.message).toBe('409 Conflict - a resource with this name already exists')
    expect(error.message).not.toContain('[object Object]')
    expect(error.status).toBe(409)
    expect(error.code).toBe('already_exists')
    expect(error.body).toEqual({
      error: {
        code: 'already_exists',
        message: 'a resource with this name already exists',
      },
    })
  })
})
