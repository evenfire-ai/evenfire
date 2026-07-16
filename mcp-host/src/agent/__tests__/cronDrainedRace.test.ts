/**
 * FIX 2 (cron×stateless drained-gauge race) — the in-flight cron marker.
 *
 * A one-shot cron task flips `conversation.activeTaskId = undefined`
 * (completeTurn) BEFORE its responseCallback populates `pendingCronResults`, so
 * there is a bounded window where BOTH `activeTask` and the store-backed
 * `pendingResults` read false. A heartbeat tick landing in that window would
 * report `drained` -> HCC suspends -> the not-yet-stored one-shot result is
 * lost.
 *
 * `wireCronDispatch` arms an in-flight marker (`cronResultsInFlight`) at trigger
 * time (before the flip); it ORs into the heartbeat `pendingResults` condition
 * and is cleared on the task's terminal lifecycle transition. This suite forces
 * the interleaving and asserts the drained gauge stays pinned through the
 * window. Reverting FIX 2 (dropping the marker term) makes the mid-window check
 * report drained -> the first test fails.
 */
import { describe, expect, it, vi } from 'vitest'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { isTerminal } from '../../lifecycle/types'
import { MessageQueue } from '../../queue/messageQueue'
import type { Task, TaskResponsePayload } from '../../queue/types'
import { type PendingCronResult, wireCronDispatch } from '../cronDispatch'
import { CronScheduler } from '../cronScheduler'

const origin = {
  channelType: 'telegram' as const,
  channelId: '-5130716657',
  sender: '516801777',
}

/**
 * Mirrors the real main.ts getConditions().pendingResults composition:
 * store-backed undelivered results OR the in-flight marker.
 */
function pendingResults(
  store: Map<string, PendingCronResult>,
  inFlight: Set<string>,
  withMarker: boolean
): boolean {
  const storePending = [...store.values()].some(e => e.deliveredAt === undefined)
  return storePending || (withMarker && inFlight.size > 0)
}

describe('cron×stateless drained-gauge race — in-flight marker (FIX 2)', () => {
  function setup() {
    const lifecycle = new TaskLifecycle()
    const queue = new MessageQueue()
    queue.setLifecycle(lifecycle)
    const scheduler = new CronScheduler(queue)
    const store = new Map<string, PendingCronResult>()
    const cronResultsInFlight = new Set<string>()

    wireCronDispatch(scheduler, {
      sessionProcessor: null,
      pendingCronResults: store,
      sanitizeAttachments: a => a,
      cronResultsInFlight,
    })

    // Same terminal-clear wiring main.ts installs.
    lifecycle.on('transition', (event: { taskId: string; to: any }) => {
      if (isTerminal(event.to)) cronResultsInFlight.delete(event.taskId)
    })

    return { lifecycle, scheduler, store, cronResultsInFlight }
  }

  it('keeps pendingResults pinned in the window between the activeTaskId flip and the cron-result store', () => {
    const { scheduler, store, cronResultsInFlight } = setup()

    const job = scheduler.createJob('OneShot', '0 * * * *', 'do it', undefined, origin)
    const task = scheduler.triggerJob(job!.id)!

    // Trigger armed the marker synchronously (before the task ever runs).
    expect(cronResultsInFlight.has(task.id)).toBe(true)

    // Emulate the race window: the flip happened (activeTask=false) but the
    // responseCallback has NOT fired yet (store empty).
    expect(store.size).toBe(0)

    // WITH the marker (FIX 2): the gauge stays pinned -> NOT drained.
    expect(pendingResults(store, cronResultsInFlight, true)).toBe(true)

    // Revert-catcher: WITHOUT the marker term, the same window reads
    // pendingResults=false -> the gauge would report drained and the result
    // would be lost.
    expect(pendingResults(store, cronResultsInFlight, false)).toBe(false)
  })

  it('stays pinned by the store after the result lands, then the terminal transition clears the marker', async () => {
    const { lifecycle, scheduler, store, cronResultsInFlight } = setup()

    const job = scheduler.createJob('OneShot2', '0 * * * *', 'do it', undefined, origin)
    const task = scheduler.triggerJob(job!.id)!
    expect(cronResultsInFlight.has(task.id)).toBe(true)

    // Fire the cron responseCallback (populates the store) — the real flow does
    // this right after completeTurn on success.
    const payload: TaskResponsePayload = { response: 'result-body' }
    await task.responseCallback!(payload)
    expect(store.size).toBe(1)
    // Still pinned — now by the genuinely-undelivered store entry.
    expect(pendingResults(store, cronResultsInFlight, true)).toBe(true)

    // Terminal lifecycle transition clears the marker (fires AFTER the store
    // write on success). The task was already registered as 'pending' by
    // queue.enqueue during triggerJob. The store entry keeps pinning until
    // delivered/TTL.
    lifecycle.transition(task.id, 'processing', 'dispatched')
    const outcome = lifecycle.transition(task.id, 'completed', 'natural')
    expect(outcome.kind).toBe('applied')
    expect(cronResultsInFlight.has(task.id)).toBe(false)
    expect(pendingResults(store, cronResultsInFlight, true)).toBe(true)
  })

  it('clears the marker on a terminal FAILURE where no result is produced (no leak, correctly unpinned)', () => {
    const { lifecycle, scheduler, store, cronResultsInFlight } = setup()

    const job = scheduler.createJob('OneShot3', '0 * * * *', 'do it', undefined, origin)
    const task = scheduler.triggerJob(job!.id)!
    expect(cronResultsInFlight.has(task.id)).toBe(true)

    // Failure path: responseCallback never fires, store stays empty. The task
    // was already registered as 'pending' by queue.enqueue during triggerJob.
    lifecycle.transition(task.id, 'processing', 'dispatched')
    lifecycle.transition(task.id, 'failed', 'error:agent_failed')

    expect(store.size).toBe(0)
    expect(cronResultsInFlight.has(task.id)).toBe(false)
    // Nothing to lose -> correctly NOT pinned.
    expect(pendingResults(store, cronResultsInFlight, true)).toBe(false)
  })
})
