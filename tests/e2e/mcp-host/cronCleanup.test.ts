import { describe, expect, it } from 'vitest'
import { type CronJobRef, withJobCleanup } from './cronCleanup.js'

const CLEANUP_PREFIX =
  'Cron job cleanup failed; these jobs stay in memory until chatllm restarts ' +
  '(kubectl -n mcp-host rollout restart deploy/chatllm):'

/** A deleteJob stub that records every call and fails for the listed job ids. */
function recordingDelete(failFor: string[] = []) {
  const calls: CronJobRef[] = []
  const deleteJob = async (jobId: string, userId: string) => {
    calls.push([jobId, userId])
    if (failFor.includes(jobId)) throw new Error(`delete of ${jobId} timed out`)
  }
  return { calls, deleteJob }
}

describe('withJobCleanup', () => {
  it('U1: returns the body value and deletes every job in push order', async () => {
    const { calls, deleteJob } = recordingDelete()
    const value = await withJobCleanup(async jobs => {
      jobs.push(['job-a', 'user-a'])
      jobs.push(['job-b', 'user-b'])
      return 'body-value'
    }, deleteJob)

    expect(value).toBe('body-value')
    expect(calls).toEqual([
      ['job-a', 'user-a'],
      ['job-b', 'user-b'],
    ])
  })

  it('U2: a failed delete still lets the next one run, then fails with every delete error', async () => {
    const { calls, deleteJob } = recordingDelete(['job-a'])
    const run = withJobCleanup(async jobs => {
      jobs.push(['job-a', 'user-a'])
      jobs.push(['job-b', 'user-b'])
      return 'body-value'
    }, deleteJob)

    await expect(run).rejects.toThrow(`${CLEANUP_PREFIX}\njob-a: delete of job-a timed out`)
    await expect(run).rejects.not.toBeInstanceOf(AggregateError)
    expect(calls).toEqual([
      ['job-a', 'user-a'],
      ['job-b', 'user-b'],
    ])
  })

  it('U3: a body failure is rethrown unchanged after the cleanup ran', async () => {
    const { calls, deleteJob } = recordingDelete()
    const bodyError = new Error('expected 2 fires, got 1')
    const run = withJobCleanup(async jobs => {
      jobs.push(['job-a', 'user-a'])
      throw bodyError
    }, deleteJob)

    await expect(run).rejects.toBe(bodyError)
    expect(calls).toEqual([['job-a', 'user-a']])
  })

  it('U4: when the body and the cleanup both fail, the body error comes first and is the cause', async () => {
    const { calls, deleteJob } = recordingDelete(['job-a'])
    const bodyError = new Error('expected 2 fires, got 1')
    const caught = await withJobCleanup(async jobs => {
      jobs.push(['job-a', 'user-a'])
      throw bodyError
    }, deleteJob).then(
      () => undefined,
      (err: unknown) => err
    )

    expect(calls).toEqual([['job-a', 'user-a']])
    expect(caught).toBeInstanceOf(AggregateError)
    const aggregate = caught as AggregateError
    expect(aggregate.errors[0]).toBe(bodyError)
    expect(aggregate.cause).toBe(bodyError)
    expect(aggregate.errors).toHaveLength(2)
    expect((aggregate.errors[1] as Error).message).toContain(
      `${CLEANUP_PREFIX}\njob-a: delete of job-a timed out`
    )
    expect(aggregate.message.startsWith('expected 2 fires, got 1\n\n')).toBe(true)
  })

  it('U5: a body that fails before its second create still deletes the first job', async () => {
    const { calls, deleteJob } = recordingDelete()
    const createError = new Error('the agent did not run cron_manage create')
    const run = withJobCleanup(async jobs => {
      jobs.push(['target', 'user-a'])
      throw createError
    }, deleteJob)

    await expect(run).rejects.toBe(createError)
    expect(calls).toEqual([['target', 'user-a']])
  })
})
