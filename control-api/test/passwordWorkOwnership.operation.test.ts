import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { PasswordAdmissionError } from '../src/services/auth/passwordCredentialVerification.js'
import { acquirePasswordWork } from '../src/services/auth/passwordWorkOwnership.js'
import { withMemberPasswordWorkLease } from '../src/services/directory/membership.js'

// Own-service lifecycle seam. Real PostgreSQL and wire faults are verified separately.
const state = vi.hoisted(() => ({
  busy: false,
  failAcquire: false,
  failRelease: false,
  commit: 'ok' as 'ok' | 'ack_cleanup' | 'unknown' | 'reject',
}))
const query = vi.hoisted(() => vi.fn())
vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  return {
    ...real,
    withTransaction: async (
      work: (db: unknown) => Promise<unknown>,
      _pool: unknown,
      options?: { onCommitAcknowledged?: () => void; onCommitOutcomeUnknown?: () => void }
    ) => {
      const value = await work({ query })
      if (options && state.commit === 'unknown') {
        options.onCommitOutcomeUnknown?.()
        state.failRelease = true
        throw new Error('private unknown commit detail')
      }
      if (options && state.commit === 'reject') throw new Error('private definite rejection')
      options?.onCommitAcknowledged?.()
      if (options && state.commit === 'ack_cleanup') throw new Error('private cleanup detail')
      return value
    },
  }
})

describe('password-work reservation preservation', () => {
  beforeEach(() => {
    state.busy = state.failAcquire = state.failRelease = false
    state.commit = 'ok'
    query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO password_verification_work')) {
        if (state.failAcquire) throw new Error('private acquisition failure')
        return { rows: state.busy ? [] : [{ singleton: true }] }
      }
      if (sql.includes('DELETE FROM password_verification_work')) {
        if (state.failRelease) throw new Error('private release failure')
        return { rows: [{ singleton: true }] }
      }
      return { rows: [] }
    })
  })

  it('preserves the original outer result and releases the unused reservation once', async () => {
    const value = { retained: true }
    expect(await withMemberPasswordWorkLease(async () => value)).toBe(value)
    expect(query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM'))).toHaveLength(1)
  })

  it('preserves the original work exception after successful release', async () => {
    const failure = new Error('original work')
    await expect(
      withMemberPasswordWorkLease(async () => {
        throw failure
      })
    ).rejects.toBe(failure)
  })

  it.each([false, true])('release failure wins over outer work failure=%s safely', async fails => {
    state.failRelease = true
    const outcome = withMemberPasswordWorkLease(async () => {
      if (fails) throw new Error('private work failure')
      return 'result'
    })
    await expect(outcome).rejects.toMatchObject({
      status: 503,
      publicError: 'authority_unavailable',
    })
    await expect(outcome).rejects.toBeInstanceOf(PasswordAdmissionError)
  })

  it('denies a busy owner without executing the caller', async () => {
    state.busy = true
    const work = vi.fn()
    await expect(withMemberPasswordWorkLease(work)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 8,
      reason: 'verification_busy',
    })
    expect(work).not.toHaveBeenCalled()
  })

  it('sanitizes acquisition failure before executing the caller', async () => {
    state.failAcquire = true
    const work = vi.fn()
    await expect(withMemberPasswordWorkLease(work)).rejects.toMatchObject({
      message: 'authority_unavailable',
      status: 503,
      retryAfterSeconds: 2,
    })
    expect(work).not.toHaveBeenCalled()
  })

  it('caches raw verifier release including an unconfirmed failure', async () => {
    const lease = await acquirePasswordWork()
    state.failRelease = true
    const first = lease!.release()
    expect(lease!.release()).toBe(first)
    await expect(first).rejects.toThrow('private release failure')
    expect(query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM'))).toHaveLength(1)
  })
})
