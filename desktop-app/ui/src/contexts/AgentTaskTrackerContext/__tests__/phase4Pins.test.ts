// @vitest-environment jsdom
/**
 * PIN(fase-4) — UPDATED to the post-Fase-4 behavior (spec-v2 §4.5-1/§4.5-2, R6).
 *
 * BEFORE Fase 4 the main-process bridge collapsed `waiting` → `open`, and the
 * tracker treated that collapsed `open` as "the reporter is live" → it reset the
 * re-rejoin cap on mere connection-establishment (B2b). Fase 4 des-colapsa the two
 * events: the bridge now forwards `waiting` and `open` distinctly, and the tracker
 * distinguishes them:
 *   - `waiting` (connection established, reporter NOT live — a queued task) clears
 *     the 5s connect-timeout but DOES NOT reset the bounded re-rejoin cap.
 *   - a real `open` (reporter live) DOES reset the cap.
 * It also adds a structured `gone` transport give-up event that the tracker turns
 * into a definitive `source:'stream'` stream-loss terminal (→ reconcile). See
 * spec-v2 §4.5-1 (waiting/open de-collapse), §4.5-2 (`gone`), §4.2 (cap only reset
 * by semantic decisions / a real open — B2b).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTracker } from '../taskTracker'
import { type TaskKey, makeTaskKey } from '../types'

type Handler = (event: unknown) => void | Promise<void>

function installRpc() {
  let handler: Handler | null = null
  const unsub = vi.fn(async () => undefined)
  const subscribeTaskProgress = vi.fn(async (_host: string, _taskId: string, onEvent: Handler) => {
    handler = onEvent
    return unsub
  })
  const getTaskResult = vi.fn(async () => ({ response: 'done!' }))
  const cancelTask = vi.fn(async () => undefined)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: { rpc: { subscribeTaskProgress, getTaskResult, cancelTask } },
  })
  return {
    subscribeTaskProgress,
    emit: async (event: unknown) => {
      if (!handler) throw new Error('no progress handler registered')
      await handler(event)
    },
  }
}

const KEY: TaskKey = makeTaskKey('agent-x', 'chat-1')
let rpc: ReturnType<typeof installRpc>
let tracker: TaskTracker

beforeEach(() => {
  rpc = installRpc()
  tracker = new TaskTracker()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete (window as { clerum?: unknown }).clerum
})

describe('PIN(fase-4) — de-collapsed waiting/open + `gone` (spec-v2 §4.5)', () => {
  it('a `waiting` event does NOT reset the re-rejoin cap (queued task, §4.5-1/B2b)', async () => {
    // Consume the cap with re-rejoins; a `waiting` lands mid-way. Unlike the old
    // collapsed `open`, `waiting` must NOT restore the quota — the reporter is not
    // live, the task is merely queued.
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 1
    await rpc.emit({ type: 'waiting', taskId: 'task-1', hostRef: 'agent-x' })
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 2
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 3
    tracker.ack(KEY)
    // Cap reached — `waiting` did not restore the quota.
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(false)
  })

  it('a real `open` DOES reset the re-rejoin cap (§4.5-1)', async () => {
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 1
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 2
    // A genuine reporter-live `open` lands → counter resets.
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    tracker.ack(KEY)
    // Three more re-rejoins are granted before the cap trips again.
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(true)
  })

  it('`waiting` clears the connect-timeout so a queued fresh send is not failed', async () => {
    vi.useFakeTimers()
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    // Fresh send arms the 5s connect-timeout.
    tracker.start(KEY, 'task-1', 'um-1')
    // `waiting` (connection established, task queued) lands within the window.
    await rpc.emit({ type: 'waiting', taskId: 'task-1', hostRef: 'agent-x' })
    // Advance past the 5s connect window — the connect-timeout was cleared by
    // `waiting`, so no spurious stream-loss terminal fires.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(onTerminal).not.toHaveBeenCalled()
    expect(tracker.get(KEY)?.status).toBe('connecting')
  })

  it('`gone` fires a definitive source:stream stream-loss terminal (§4.5-2)', async () => {
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'gone', reason: 'reconnect_exhausted' })
    expect(onTerminal).toHaveBeenCalledTimes(1)
    const state = onTerminal.mock.calls[0]![1]
    expect(state.status).toBe('failed')
    expect(state.terminalResult).toMatchObject({ kind: 'error', source: 'stream' })
  })
})
