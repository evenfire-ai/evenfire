import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { PasswordAdmissionError as LeafError } from '../src/services/auth/passwordAdmissionError.js'
import { PasswordAdmissionError } from '../src/services/auth/passwordCredentialVerification.js'
import {
  type PasswordMutationLease,
  acquirePasswordWork,
  runPasswordMutation,
  withPasswordWorkLease,
} from '../src/services/auth/passwordWorkOwnership.js'
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

  it.each([
    ['TypeError', () => new TypeError('private callback details')],
    ['Error', () => new Error('private callback details')],
    ['non-Error', () => 'private callback details'],
  ])(
    'retains an unexpected %s callback failure as a non-enumerable cause',
    async (_name, makeError) => {
      const cause = makeError()
      const error = await withPasswordWorkLease(lease =>
        lease.commitWith(
          async () => {
            throw cause
          },
          { mode: 'one_use_recovery' }
        )
      ).catch(failure => failure)

      expect(error).toMatchObject({
        name: 'PasswordMutationInternalError',
        code: 'internal_error',
        message: 'internal_error',
      })
      const causeDescriptor = Object.getOwnPropertyDescriptor(error, 'cause')
      expect(causeDescriptor?.value).toBe(cause)
      expect(causeDescriptor?.enumerable).toBe(false)
      expect(JSON.stringify(error)).not.toContain('private callback details')
      expect(query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM'))).toHaveLength(1)
    }
  )

  it('keeps a TypeError from the transaction query boundary as authority unavailable', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT synthetic driver failure') {
        throw new TypeError('private driver diagnostic')
      }
      if (sql.includes('INSERT INTO password_verification_work')) {
        return { rows: [{ singleton: true }] }
      }
      if (sql.includes('DELETE FROM password_verification_work')) {
        return { rows: [{ singleton: true }] }
      }
      return { rows: [] }
    })

    await expect(
      runPasswordMutation(
        async db => {
          await db.query('SELECT synthetic driver failure')
          return 'unreachable'
        },
        { mode: 'standard' }
      )
    ).rejects.toMatchObject({
      status: 503,
      publicError: 'authority_unavailable',
      message: 'authority_unavailable',
    })
  })

  it('classifies a distinct callback failure after a caught query error as internal', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT synthetic driver failure') {
        throw new TypeError('private driver diagnostic')
      }
      if (sql.includes('INSERT INTO password_verification_work')) {
        return { rows: [{ singleton: true }] }
      }
      if (sql.includes('DELETE FROM password_verification_work')) {
        return { rows: [{ singleton: true }] }
      }
      return { rows: [] }
    })

    await expect(
      runPasswordMutation(
        async db => {
          await db.query('SELECT synthetic driver failure').catch(() => undefined)
          throw new TypeError('private callback defect')
        },
        { mode: 'standard' }
      )
    ).rejects.toMatchObject({
      name: 'PasswordMutationInternalError',
      code: 'internal_error',
    })
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

  it('retains the exact error constructor identity at the compatibility export', () => {
    expect(LeafError).toBe(PasswordAdmissionError)
  })

  it('retains an acknowledged result despite connection cleanup failure', async () => {
    state.commit = 'ack_cleanup'
    const value = { committed: true }
    expect(await runPasswordMutation(async () => value, { mode: 'one_use_recovery' })).toBe(value)
    expect(query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM'))).toHaveLength(1)
  })

  it.each(['standard', 'one_use_recovery'] as const)(
    'preserves %s unknown outcome above fallback release failure without outer replay',
    async mode => {
      state.commit = 'unknown'
      const work = vi.fn(async () => ({ committed: true }))
      await expect(
        withPasswordWorkLease(lease => lease.commitWith(work, { mode }))
      ).rejects.toMatchObject({
        status: 503,
        publicError:
          mode === 'one_use_recovery' ? 'recovery_outcome_unknown' : 'authority_unavailable',
      })
      expect(work).toHaveBeenCalledTimes(1)
      expect(query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM'))).toHaveLength(2)
    }
  )

  it('maps a definitive transaction rejection to the existing authority contract', async () => {
    state.commit = 'reject'
    await expect(
      runPasswordMutation(async () => 'result', { mode: 'one_use_recovery' })
    ).rejects.toMatchObject({ status: 503, publicError: 'authority_unavailable' })
  })

  it('rejects concurrent, recursive and terminal reuse before another callback runs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 16 }), async count => {
        await withPasswordWorkLease(async lease => {
          let calls = 0
          const outcomes = await Promise.allSettled(
            Array.from({ length: count }, () =>
              lease.commitWith(
                async () => {
                  calls++
                  await expect(
                    lease.commitWith(
                      async () => {
                        calls++
                      },
                      { mode: 'standard' }
                    )
                  ).rejects.toBeInstanceOf(PasswordAdmissionError)
                  return 'committed'
                },
                { mode: 'standard' }
              )
            )
          )
          expect(calls).toBe(1)
          expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
          await expect(
            lease.commitWith(
              async () => {
                calls++
              },
              { mode: 'standard' }
            )
          ).rejects.toBeInstanceOf(PasswordAdmissionError)
          expect(calls).toBe(1)
        })
      }),
      { numRuns: 30 }
    )
  })

  it('rejects a foreign lease without acquiring or executing work', async () => {
    const work = vi.fn()
    await expect(
      runPasswordMutation(work, {
        mode: 'standard',
        lease: { commitWith: vi.fn() },
      })
    ).rejects.toBeInstanceOf(PasswordAdmissionError)
    expect(work).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects a raw verifier lease at the mutation provenance boundary', async () => {
    const raw = await acquirePasswordWork()
    const work = vi.fn()
    await expect(
      runPasswordMutation(work, {
        mode: 'standard',
        lease: raw as unknown as PasswordMutationLease,
      })
    ).rejects.toBeInstanceOf(PasswordAdmissionError)
    expect(work).not.toHaveBeenCalled()
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO'))).toHaveLength(1)
    expect(query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM'))).toHaveLength(0)
    await raw!.release()
    expect(query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM'))).toHaveLength(1)
  })

  it('keeps raw verifier release separate from mutation reservation', async () => {
    const raw = await acquirePasswordWork()
    expect(raw).not.toHaveProperty('commitWith')
    await raw!.release()
    const work = vi.fn()
    await expect(
      runPasswordMutation(work, {
        mode: 'standard',
        lease: raw as unknown as PasswordMutationLease,
      })
    ).rejects.toBeInstanceOf(PasswordAdmissionError)
    expect(work).not.toHaveBeenCalled()
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO'))).toHaveLength(1)
  })
})
