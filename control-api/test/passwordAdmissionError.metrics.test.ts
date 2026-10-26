import { describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { sendPasswordAdmissionError } from '../src/middleware/passwordLoginAdmission.js'
import { passwordAdmissionDenialsTotal } from '../src/observability/metrics.js'
import { PasswordAdmissionError } from '../src/services/auth/passwordAdmissionError.js'

async function denialCount(reason: string): Promise<number> {
  const metric = await passwordAdmissionDenialsTotal.get()
  return metric.values.find(value => value.labels.reason === reason)?.value ?? 0
}

describe('password admission denial metric', () => {
  it('counts when the typed public denial is emitted, not when it is constructed', async () => {
    const reason = 'source_rate'
    const before = await denialCount(reason)
    const error = new PasswordAdmissionError(429, 9, reason)
    expect(await denialCount(reason)).toBe(before)

    const response = {
      removeHeader: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response

    expect(sendPasswordAdmissionError(error, response)).toBe(true)
    expect(response.status).toHaveBeenCalledWith(429)
    expect(response.json).toHaveBeenCalledWith({ error: 'rate_limited', retryAfterSeconds: 9 })
    expect(await denialCount(reason)).toBe(before + 1)
  })

  it('does not count an error that is not emitted by the admission response helper', async () => {
    const before = await denialCount('source_rate')
    expect(sendPasswordAdmissionError(new Error('unrelated'), {} as Response)).toBe(false)
    expect(await denialCount('source_rate')).toBe(before)
  })
})
