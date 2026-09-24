import { describe, expect, it } from 'vitest'
import { formatApiError } from '../api'

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
