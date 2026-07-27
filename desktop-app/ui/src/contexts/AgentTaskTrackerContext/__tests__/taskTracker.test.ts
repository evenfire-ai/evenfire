// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTracker } from '../taskTracker'
import { type TaskKey, type TaskState, makeTaskKey } from '../types'

type Handler = (event: unknown) => void | Promise<void>

interface RpcHarness {
  subscribeTaskProgress: ReturnType<typeof vi.fn>
  getTaskResult: ReturnType<typeof vi.fn>
  cancelTask: ReturnType<typeof vi.fn>
  unsub: ReturnType<typeof vi.fn>
  emit: (event: unknown) => Promise<void>
  hasHandler: () => boolean
}

function installRpc(): RpcHarness {
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
    getTaskResult,
    cancelTask,
    unsub,
    emit: async (event: unknown) => {
      if (!handler) throw new Error('no progress handler registered')
      await handler(event)
    },
    hasHandler: () => handler !== null,
  }
}

const KEY: TaskKey = makeTaskKey('agent-x', 'chat-1')

let rpc: RpcHarness
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

/** Let the openSse microtask settle so `unsubs` is populated. */
const flush = () => Promise.resolve().then(() => Promise.resolve())

describe('TaskTracker', () => {
  it('start() seeds connecting state, opens the SSE and emits to subscribers', () => {
    const seen: TaskState[] = []
    tracker.subscribe(KEY, s => seen.push(s))
    tracker.start(KEY, 'task-1', 'um-1')

    expect(rpc.subscribeTaskProgress).toHaveBeenCalledWith(
      'agent-x',
      'task-1',
      expect.any(Function)
    )
    expect(rpc.hasHandler()).toBe(true)
    const state = tracker.get(KEY)
    expect(state?.status).toBe('connecting')
    expect(state?.taskId).toBe('task-1')
    expect(state?.userMessageId).toBe('um-1')
    // emit fired at least once with connecting
    expect(seen.at(-1)?.status).toBe('connecting')
  })

  it('start() is idempotent for the same already-tracked task', () => {
    tracker.start(KEY, 'task-1', 'um-1')
    tracker.start(KEY, 'task-1', 'um-1')
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(1)
    expect(tracker.get(KEY)?.taskId).toBe('task-1')
  })

  it('start() replaces stale state when a fresh task is accepted for the same chat', () => {
    tracker.start(KEY, 'task-1', 'um-1')
    tracker.start(KEY, 'task-2', 'um-2')

    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(2)
    expect(tracker.get(KEY)?.taskId).toBe('task-2')
    expect(tracker.get(KEY)?.userMessageId).toBe('um-2')
  })

  it('rejoinIfRunning() starts a fresh subscription only when none exists', () => {
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(1)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(1)
  })

  it('open event clears connecting → streaming', async () => {
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    expect(tracker.get(KEY)?.status).toBe('streaming')
  })

  it('terminal completed fetches the result and fires onTerminal with a reply', async () => {
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    await rpc.emit({ type: 'terminal', data: { taskId: 'task-1', status: 'completed' } })

    expect(rpc.getTaskResult).toHaveBeenCalledWith('agent-x', 'task-1', ['agent-x'])
    expect(onTerminal).toHaveBeenCalledTimes(1)
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.status).toBe('completed')
    expect(state.terminalResult).toEqual({ kind: 'reply', content: 'done!' })
  })

  it('terminal failed surfaces an error terminal with code/provider', async () => {
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({
      type: 'terminal',
      data: {
        taskId: 'task-1',
        status: 'failed',
        error: { message: 'LLM down', code: 'provider_error', provider: 'anthropic' },
      },
    })

    expect(rpc.getTaskResult).not.toHaveBeenCalled()
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.terminalResult).toEqual({
      kind: 'error',
      source: 'failed',
      message: 'LLM down',
      code: 'provider_error',
      provider: 'anthropic',
    })
  })

  it('terminal cancelled does not fetch a result', async () => {
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({
      type: 'terminal',
      data: { taskId: 'task-1', status: 'cancelled', reason: 'user_cancelled' },
    })

    expect(rpc.getTaskResult).not.toHaveBeenCalled()
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.status).toBe('cancelled')
    expect(state.terminalResult).toEqual({ kind: 'cancelled', reason: 'user_cancelled' })
  })

  it('result-fetch failure becomes an error terminal (source result_fetch)', async () => {
    rpc.getTaskResult.mockRejectedValueOnce(new Error('boom'))
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'terminal', data: { taskId: 'task-1', status: 'completed' } })

    const [, state] = onTerminal.mock.calls[0]!
    expect(state.status).toBe('failed')
    expect(state.terminalResult).toMatchObject({ kind: 'error', source: 'result_fetch' })
  })

  it('terminal completed does NOT corrupt a task that replaced it during the result fetch (H2)', async () => {
    const onTerminal = vi.fn(async () => undefined)
    tracker.setCallbacks({ onTerminal })
    // Defer the FIRST getTaskResult so we can interleave a fresh send while it's
    // in flight (the second send's task must not run getTaskResult).
    let resolveResult: (v: unknown) => void = () => undefined
    rpc.getTaskResult.mockImplementationOnce(
      () => new Promise<unknown>(res => (resolveResult = res))
    )
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    // Terminal for task-1 starts; its getTaskResult is pending (do NOT await yet).
    const terminalPromise = rpc.emit({
      type: 'terminal',
      data: { taskId: 'task-1', status: 'completed' },
    })
    // A fresh send replaces the key's task while the old result fetch is in flight.
    tracker.start(KEY, 'task-2', 'um-2')
    expect(tracker.get(KEY)?.taskId).toBe('task-2')
    // Now resolve the STALE fetch and let the terminal handler resume.
    resolveResult({ response: 'old reply' })
    await terminalPromise
    // task-2 must be intact: not overwritten to completed, not terminal-fired.
    const s = tracker.get(KEY)
    expect(s?.taskId).toBe('task-2')
    expect(s?.status).not.toBe('completed')
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('a throwing onTerminal callback tears the entry + SSE down (no zombie leak) (M9)', async () => {
    const onTerminal = vi.fn(async () => {
      throw new Error('consumer boom')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await flush() // let openSse register the unsub
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    await rpc.emit({ type: 'terminal', data: { taskId: 'task-1', status: 'completed' } })

    expect(onTerminal).toHaveBeenCalledTimes(1)
    // Defensive teardown ran despite the throw: entry gone, SSE released.
    expect(tracker.get(KEY)).toBeUndefined()
    expect(rpc.unsub).toHaveBeenCalled()
  })

  it('suspended sets pendingApproval and fires onSuspended', async () => {
    const onSuspended = vi.fn()
    tracker.setCallbacks({ onTerminal: vi.fn(), onSuspended })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({
      type: 'suspended',
      data: {
        taskId: 'task-1',
        requestId: 'req-1',
        displayName: 'Shell Execute',
        reason: 'approval',
      },
    })

    const state = tracker.get(KEY)
    expect(state?.status).toBe('suspended')
    expect(state?.pendingApproval?.requestId).toBe('req-1')
    expect(state?.pausedAt).toBeTypeOf('number')
    expect(onSuspended).toHaveBeenCalledTimes(1)
  })

  it('a replayed suspended (already suspended) does NOT re-stamp pausedAt (§AC3)', async () => {
    // Advance the clock WITHOUT fake timers: the 5s connect timeout and 30s idle
    // watchdog are irrelevant to this invariant and would just fail the task.
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    tracker.setCallbacks({ onTerminal: vi.fn(), onSuspended: vi.fn() })
    tracker.start(KEY, 'task-1', 'um-1')
    const suspend = () =>
      rpc.emit({
        type: 'suspended',
        data: {
          taskId: 'task-1',
          requestId: 'req-1',
          displayName: 'Shell Execute',
          reason: 'approval',
        },
      })
    await suspend()
    const firstPausedAt = tracker.get(KEY)?.pausedAt
    expect(firstPausedAt).toBeTypeOf('number')

    // The bridge reconnects (the 300s RPC token lapsed) and mcp-host replays its
    // sticky `suspended` to the new subscriber. The freeze must survive it —
    // otherwise the frozen age becomes full wall-clock and D.5b escalates the
    // nudges to T3/T4/T5 while the task just sits at the approval gate.
    clock += 600_000
    await suspend()
    clock += 600_000
    await suspend()

    expect(tracker.get(KEY)?.pausedAt).toBe(firstPausedAt)
    expect(tracker.get(KEY)?.status).toBe('suspended')
    expect(tracker.get(KEY)?.pendingApproval?.requestId).toBe('req-1')
  })

  it('a genuine re-suspension after a resume DOES re-stamp pausedAt', async () => {
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    tracker.setCallbacks({ onTerminal: vi.fn(), onSuspended: vi.fn() })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({
      type: 'suspended',
      data: { taskId: 'task-1', requestId: 'req-1', displayName: 'Shell', reason: 'approval' },
    })
    const firstPausedAt = tracker.get(KEY)?.pausedAt
    expect(firstPausedAt).toBeTypeOf('number')

    // Approval decided → execution resumes (status back to 'streaming').
    clock += 60_000
    await rpc.emit({
      type: 'tool_start',
      data: { taskId: 'task-1', toolCallId: 'tc-1', toolName: 'shell', iteration: 2 },
    })
    expect(tracker.get(KEY)?.status).toBe('streaming')
    expect(tracker.get(KEY)?.pendingApproval).toBeUndefined()

    // A SECOND tool needs approval → real transition, so the freeze point moves.
    clock += 60_000
    await rpc.emit({
      type: 'suspended',
      data: { taskId: 'task-1', requestId: 'req-2', displayName: 'Shell', reason: 'approval' },
    })

    expect(tracker.get(KEY)?.pausedAt).toBe(firstPausedAt! + 120_000)
    expect(tracker.get(KEY)?.pendingApproval?.requestId).toBe('req-2')
  })

  it('subscribe returns an unsubscribe that stops further notifications', async () => {
    const fn = vi.fn()
    const unsubscribe = tracker.subscribe(KEY, fn)
    tracker.start(KEY, 'task-1', 'um-1')
    const callsAfterStart = fn.mock.calls.length
    expect(callsAfterStart).toBeGreaterThan(0)
    unsubscribe()
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    expect(fn.mock.calls.length).toBe(callsAfterStart)
  })

  it('ack clears state and tears down the SSE subscription', async () => {
    tracker.start(KEY, 'task-1', 'um-1')
    await flush()
    tracker.ack(KEY)
    expect(tracker.get(KEY)).toBeUndefined()
    expect(rpc.unsub).toHaveBeenCalledTimes(1)
  })

  it('cancel() calls rpc.cancelTask without mutating state', async () => {
    tracker.start(KEY, 'task-1', 'um-1')
    await tracker.cancel(KEY)
    expect(rpc.cancelTask).toHaveBeenCalledWith('agent-x', 'task-1')
    // state untouched — waits for the SSE terminal
    expect(tracker.get(KEY)?.status).toBe('connecting')
  })

  it('connection timeout (no open within 5s) fails the task', async () => {
    vi.useFakeTimers()
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await vi.advanceTimersByTimeAsync(5_000)

    const [, state] = onTerminal.mock.calls[0]!
    expect(state.status).toBe('failed')
    expect(state.terminalResult).toMatchObject({ kind: 'error', source: 'stream' })
  })

  it('connection timeout does NOT fire once a genuine terminal is awaiting a slow getTaskResult', async () => {
    vi.useFakeTimers()
    // getTaskResult (durable fetch) resolves AFTER the 5s connect-timeout would
    // otherwise fire — the timer must not overwrite the genuine reply.
    let resolveResult: ((value: unknown) => void) | undefined
    rpc.getTaskResult.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveResult = resolve
        })
    )
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    // Genuine terminal(completed) arrives before `open`; its branch sets
    // terminalReceived and awaits getTaskResult (still pending here).
    const terminalSettled = rpc.emit({
      type: 'terminal',
      data: { taskId: 'task-1', status: 'completed' },
    })
    // Push past the 5s connect-timeout while getTaskResult is still in flight.
    await vi.advanceTimersByTimeAsync(6_000)
    // The connect-timeout must NOT have fired a spurious stream-loss terminal.
    expect(onTerminal).not.toHaveBeenCalled()
    expect(tracker.get(KEY)?.status).not.toBe('failed')

    // The slow result finally resolves → the genuine reply is delivered.
    resolveResult?.({ response: 'done!' })
    await terminalSettled
    expect(onTerminal).toHaveBeenCalledTimes(1)
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.status).toBe('completed')
    expect(state.terminalResult).toEqual({ kind: 'reply', content: 'done!' })
  })

  it('idle watchdog does NOT fire once a genuine terminal is awaiting a slow getTaskResult', async () => {
    vi.useFakeTimers()
    // getTaskResult stalls past the 30s idle window — the watchdog must not
    // pre-empt the genuine terminal with a spurious stream-loss.
    let resolveResult: ((value: unknown) => void) | undefined
    rpc.getTaskResult.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveResult = resolve
        })
    )
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    const terminalSettled = rpc.emit({
      type: 'terminal',
      data: { taskId: 'task-1', status: 'completed' },
    })
    // Advance well past the 30s idle watchdog while the fetch is still pending.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(onTerminal).not.toHaveBeenCalled()
    expect(tracker.get(KEY)?.status).not.toBe('failed')

    resolveResult?.({ response: 'done!' })
    await terminalSettled
    expect(onTerminal).toHaveBeenCalledTimes(1)
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.status).toBe('completed')
    expect(state.terminalResult).toEqual({ kind: 'reply', content: 'done!' })
  })

  it('idle watchdog trips after 30s of silence following open', async () => {
    vi.useFakeTimers()
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    await vi.advanceTimersByTimeAsync(40_000)

    expect(onTerminal).toHaveBeenCalledTimes(1)
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.terminalResult).toMatchObject({ kind: 'error', source: 'stream' })
  })

  it('heartbeat events keep the watchdog from tripping during a long silent tool', async () => {
    vi.useFakeTimers()
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    // mcp-host keepalives arrive every 15s (< the 30s idle watchdog). Emit a
    // few across 60s of otherwise-silent execution; each must reset lastEventAt.
    for (let elapsed = 15_000; elapsed <= 60_000; elapsed += 15_000) {
      await vi.advanceTimersByTimeAsync(15_000)
      await rpc.emit({ type: 'heartbeat', data: { taskId: 'task-1', iteration: 0, elapsedMs: 0 } })
    }
    expect(onTerminal).not.toHaveBeenCalled()
    expect(tracker.get(KEY)?.status).not.toBe('failed')
  })

  it("an 'error' event fires a stream terminal immediately (no 30s watchdog wait)", async () => {
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    await rpc.emit({ type: 'error', message: 'Progress stream disconnected' })

    expect(onTerminal).toHaveBeenCalledTimes(1)
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.status).toBe('failed')
    expect(state.terminalResult).toMatchObject({ kind: 'error', source: 'stream' })
  })

  it('open does not clobber a replayed suspended approval (rejoin sticky replay, V2)', async () => {
    // §8-R2 / V2: `seedSuspended` is gone. On a rejoin the server replays the
    // sticky `suspended` BEFORE `open`, so the tracker holds the approval and the
    // subsequent `open` must preserve it rather than flip status to 'streaming'.
    tracker.setCallbacks({ onTerminal: vi.fn(), onSuspended: vi.fn() })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({
      type: 'suspended',
      data: { taskId: 'task-1', requestId: 'req-1', displayName: 'Run shell' },
    })
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })

    const state = tracker.get(KEY)
    expect(state?.status).toBe('suspended')
    expect(state?.pendingApproval).toEqual({ requestId: 'req-1', displayName: 'Run shell' })
  })

  it('does not double-fire onTerminal when two terminal events arrive', async () => {
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'terminal', data: { taskId: 'task-1', status: 'completed' } })
    await rpc.emit({ type: 'terminal', data: { taskId: 'task-1', status: 'completed' } })
    expect(onTerminal).toHaveBeenCalledTimes(1)
  })

  // ── P1-B: bounded re-rejoin + relaxed connect-timeout on rejoin ──

  it('rejoinIfRunning does NOT arm the 5s connect-timeout (relies on the 30s watchdog)', async () => {
    vi.useFakeTimers()
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    // A rejoin under network stress legitimately needs longer than 5s to re-open;
    // the hard connect-timeout would fire a false stream-loss terminal.
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onTerminal).not.toHaveBeenCalled()
    expect(tracker.get(KEY)?.status).toBe('connecting')
    // The 30s watchdog is still the real liveness guard (next 5s tick past 30s).
    await vi.advanceTimersByTimeAsync(31_000)
    expect(onTerminal).toHaveBeenCalledTimes(1)
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.terminalResult).toMatchObject({ kind: 'error', source: 'stream' })
  })

  it('start() still arms the 5s connect-timeout for a fresh send', async () => {
    vi.useFakeTimers()
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onTerminal).toHaveBeenCalledTimes(1)
  })

  it('caps re-rejoins per key and stops re-rejoining after the bound (no loop)', () => {
    // Simulate the stream-loss reconcile loop: each cycle acks (the controller
    // does this before re-rejoining) then re-rejoins the still-`processing` task.
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 1
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(1)
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 2
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(2)
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 3
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(3)
    tracker.ack(KEY)
    // Cap reached → settles instead of re-rejoining (no entry created).
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(3)
    expect(tracker.get(KEY)).toBeUndefined()
  })

  it('rejoinIfRunning returns true on a real rejoin and false once capped (P1-stall)', () => {
    // The controller reads this boolean to flip the active chat to offlineMode
    // when the cap is hit, instead of leaving a frozen `processing` stepper.
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(true) // attempt 1
    tracker.ack(KEY)
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(true) // attempt 2
    tracker.ack(KEY)
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(true) // attempt 3
    tracker.ack(KEY)
    // Capped → no-op, returns false so the controller can surface the affordance.
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(false)
    // Still capped on a repeat call (no real `open`/reset has happened yet).
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(false) // still capped
    tracker.resetRejoinAttempts(KEY)
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(true)
    expect(tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')).toBe(true) // already following
  })

  it('a real open resets the re-rejoin counter so a future drop gets a full quota', async () => {
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 1
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1') // attempt 2
    // A genuine reconnect lands an `open`.
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    tracker.ack(KEY)
    // Counter reset → three more re-rejoins are allowed.
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    expect(tracker.get(KEY)).toBeDefined()
    tracker.ack(KEY)
    // 4th post-reset re-rejoin is capped.
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    expect(tracker.get(KEY)).toBeUndefined()
  })

  it('resetRejoinAttempts() restores the quota for a deliberate user re-open', () => {
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    // Cap hit.
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    expect(tracker.get(KEY)).toBeUndefined()
    // A user-initiated reconcile clears the counter → rejoin works again.
    tracker.resetRejoinAttempts(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    expect(tracker.get(KEY)).toBeDefined()
  })

  it('start() resets the re-rejoin counter for a brand-new send', () => {
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    // A fresh send (new task) on the same key resets the quota.
    tracker.start(KEY, 'task-2', 'um-2')
    tracker.ack(KEY)
    tracker.rejoinIfRunning(KEY, 'task-2', 'um-2')
    expect(tracker.get(KEY)).toBeDefined()
  })

  // ── Runtime-verified fixes (spec refactor-useAgentChatController, Anexo C) ──

  it('B1: ack() keeps subscribers registered — the next task on the same key still emits', () => {
    const seen: TaskState[] = []
    tracker.subscribe(KEY, s => seen.push(s))
    tracker.start(KEY, 'task-1', 'um-1')
    tracker.ack(KEY)
    // Same key, new task, NO chat/agent switch in between (the mirror effect
    // only re-subscribes on a switch) — the surviving listener must hear it.
    tracker.start(KEY, 'task-2', 'um-2')
    expect(seen.at(-1)?.taskId).toBe('task-2')
    expect(seen.at(-1)?.status).toBe('connecting')
  })

  it('C-race: a `closed` racing the terminal-completed result fetch keeps the reply', async () => {
    let resolveResult: ((value: unknown) => void) | undefined
    rpc.getTaskResult.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveResult = resolve
        })
    )
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    // Replay-then-close: the bridge emits `closed` right behind `terminal`,
    // while the completed branch is still awaiting getTaskResult.
    const terminalSettled = rpc.emit({
      type: 'terminal',
      data: { taskId: 'task-1', status: 'completed' },
    })
    await rpc.emit({ type: 'closed' })
    // The closed handler must NOT fire a spurious stream-loss terminal.
    expect(onTerminal).not.toHaveBeenCalled()
    resolveResult?.({ response: 'done!' })
    await terminalSettled

    expect(onTerminal).toHaveBeenCalledTimes(1)
    const [, state] = onTerminal.mock.calls[0]!
    expect(state.status).toBe('completed')
    expect(state.terminalResult).toEqual({ kind: 'reply', content: 'done!' })
  })

  it('C-race: an `error` event after a received terminal is ignored too', async () => {
    let resolveResult: ((value: unknown) => void) | undefined
    rpc.getTaskResult.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveResult = resolve
        })
    )
    const onTerminal = vi.fn()
    tracker.setCallbacks({ onTerminal })
    tracker.start(KEY, 'task-1', 'um-1')
    const terminalSettled = rpc.emit({
      type: 'terminal',
      data: { taskId: 'task-1', status: 'completed' },
    })
    await rpc.emit({ type: 'error', message: 'stream dropped' })
    expect(onTerminal).not.toHaveBeenCalled()
    resolveResult?.({ response: 'done!' })
    await terminalSettled

    const [, state] = onTerminal.mock.calls[0]!
    expect(state.terminalResult).toEqual({ kind: 'reply', content: 'done!' })
  })

  it('resume: tool_start after a live suspension clears the approval and fires onResumed', async () => {
    const onResumed = vi.fn()
    tracker.setCallbacks({ onTerminal: vi.fn(), onSuspended: vi.fn(), onResumed })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    await rpc.emit({
      type: 'suspended',
      data: { taskId: 'task-1', requestId: 'req-1', displayName: 'Shell', reason: 'approval' },
    })
    expect(tracker.get(KEY)?.status).toBe('suspended')
    await rpc.emit({
      type: 'tool_start',
      data: {
        toolCallId: 'tc-9',
        toolName: 'shell',
        displayName: 'Shell',
        iteration: 1,
        stepIndex: 0,
        totalSteps: 1,
      },
    })

    const state = tracker.get(KEY)
    expect(state?.status).toBe('streaming')
    expect(state?.pendingApproval).toBeUndefined()
    expect(onResumed).toHaveBeenCalledTimes(1)
    expect(onResumed.mock.calls[0]![0]).toBe(KEY)
  })

  it('resume: llm_in_progress after a replayed suspension also resumes', async () => {
    const onResumed = vi.fn()
    tracker.setCallbacks({ onTerminal: vi.fn(), onResumed })
    tracker.rejoinIfRunning(KEY, 'task-1', 'um-1')
    await rpc.emit({
      type: 'suspended',
      data: { taskId: 'task-1', requestId: 'req-1', displayName: 'Shell' },
    })
    await rpc.emit({
      type: 'llm_in_progress',
      data: { taskId: 'task-1', elapsedMs: 10, iteration: 2 },
    })

    expect(tracker.get(KEY)?.status).toBe('streaming')
    expect(tracker.get(KEY)?.pendingApproval).toBeUndefined()
    expect(onResumed).toHaveBeenCalledTimes(1)
  })

  it('resume: ordinary streaming transitions do not fire onResumed', async () => {
    const onResumed = vi.fn()
    tracker.setCallbacks({ onTerminal: vi.fn(), onResumed })
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    await rpc.emit({
      type: 'tool_start',
      data: {
        toolCallId: 'tc-1',
        toolName: 't',
        displayName: 'T',
        iteration: 0,
        stepIndex: 0,
        totalSteps: 1,
      },
    })
    expect(onResumed).not.toHaveBeenCalled()
  })
})

describe('TaskTracker — coordinator API (spec §4.2)', () => {
  const RESEND = { content: 'hi', attachments: [], references: [] }

  it('attach() is idempotent for the same (key, taskId)', () => {
    expect(tracker.attach(KEY, 'task-1', 'um-1')).toBe(true)
    expect(tracker.attach(KEY, 'task-1', 'um-1')).toBe(true)
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(1)
    expect(tracker.get(KEY)?.taskId).toBe('task-1')
  })

  it('attach() of a fresh taskId releases the old entry first (no clobber, B6)', async () => {
    tracker.attach(KEY, 'task-1', 'um-1')
    await flush()
    tracker.attach(KEY, 'task-2', 'um-2')
    // Old subscription torn down, new one opened.
    expect(rpc.unsub).toHaveBeenCalledTimes(1)
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(2)
    expect(tracker.get(KEY)?.taskId).toBe('task-2')
  })

  it('attach() re-opens a terminal-fired zombie of the same task (B11 reopen rejoin)', async () => {
    // B11: a deferred non-visible stream-loss fires a terminal but is NOT released
    // (its Resend payload must survive the hidden window). On reopen the server
    // may still report the task LIVE → attach(same taskId) must NOT no-op on the
    // dead corpse; it must release + re-subscribe so the SSE genuinely re-attaches.
    tracker.setCallbacks({ onTerminal: vi.fn() })
    tracker.attach(KEY, 'task-1', 'um-1')
    await flush()
    // Drive a stream-loss terminal WITHOUT releasing (the B11 defer).
    await rpc.emit({ type: 'error', message: 'stream dropped' })
    expect(tracker.get(KEY)?.status).toBe('failed') // dead zombie, still tracked
    // Reopen rejoin: same taskId, but the entry's terminal already fired.
    expect(tracker.attach(KEY, 'task-1', 'um-1', { reason: 'rejoin' })).toBe(true)
    // The corpse's unsub was torn down and a fresh SSE opened (2 subscribes total).
    expect(rpc.subscribeTaskProgress).toHaveBeenCalledTimes(2)
    expect(tracker.get(KEY)?.status).toBe('connecting')
  })

  it('attach(reason:rejoin) consumes the bounded budget and returns false when capped', () => {
    expect(tracker.attach(KEY, 'task-1', 'um-1', { reason: 'rejoin' })).toBe(true)
    tracker.release(KEY)
    expect(tracker.attach(KEY, 'task-1', 'um-1', { reason: 'rejoin' })).toBe(true)
    tracker.release(KEY)
    expect(tracker.attach(KEY, 'task-1', 'um-1', { reason: 'rejoin' })).toBe(true)
    tracker.release(KEY)
    // 4th consecutive rejoin with no real open → capped.
    expect(tracker.attach(KEY, 'task-1', 'um-1', { reason: 'rejoin' })).toBe(false)
    expect(tracker.get(KEY)).toBeUndefined()
  })

  it('attach(reason:reconcile) always gets a full budget (never capped)', () => {
    for (let i = 0; i < 5; i++) {
      expect(tracker.attach(KEY, 'task-1', 'um-1', { reason: 'reconcile' })).toBe(true)
      tracker.release(KEY)
    }
  })

  it('release() tears down the entry, timers and SSE subscription (alias of ack)', async () => {
    tracker.start(KEY, 'task-1', 'um-1')
    await flush()
    tracker.release(KEY)
    expect(tracker.get(KEY)).toBeUndefined()
    expect(rpc.unsub).toHaveBeenCalledTimes(1)
  })

  it('setResend / getResend round-trip and release clears the payload (B15)', async () => {
    tracker.start(KEY, 'task-1', 'um-1')
    tracker.setResend('task-1', RESEND)
    expect(tracker.getResend('task-1')).toEqual(RESEND)
    await flush()
    tracker.release(KEY)
    expect(tracker.getResend('task-1')).toBeUndefined()
  })

  it('releaseAll() tears down every key and clears all resend payloads (R-F13)', async () => {
    const KEY2 = makeTaskKey('agent-y', 'chat-2')
    tracker.start(KEY, 'task-1', 'um-1')
    tracker.start(KEY2, 'task-2', 'um-2')
    tracker.setResend('task-1', RESEND)
    tracker.setResend('task-2', RESEND)
    await flush()
    tracker.releaseAll()
    expect(tracker.get(KEY)).toBeUndefined()
    expect(tracker.get(KEY2)).toBeUndefined()
    expect(tracker.getResend('task-1')).toBeUndefined()
    expect(tracker.getResend('task-2')).toBeUndefined()
    expect(rpc.unsub).toHaveBeenCalledTimes(2)
  })

  it('B7: a subscription that resolves AFTER a fresh task replaced the entry is torn down', async () => {
    // Deferred subscribe: the first attach cannot store its unsub until we release
    // the deferred promise, by which point a fresh taskId has replaced the entry.
    const firstUnsub = vi.fn(async () => undefined)
    const secondUnsub = vi.fn(async () => undefined)
    let resolveFirst: (v: () => Promise<void>) => void = () => {}
    let call = 0
    const subscribe = vi.fn((_h: string, _t: string, _cb: Handler) => {
      call += 1
      if (call === 1) return new Promise(resolve => (resolveFirst = resolve))
      return Promise.resolve(secondUnsub)
    })
    ;(window as { clerum: { rpc: Record<string, unknown> } }).clerum.rpc.subscribeTaskProgress =
      subscribe

    tracker.attach(KEY, 'task-1', 'um-1') // openSse awaits the deferred promise
    tracker.attach(KEY, 'task-2', 'um-2') // replaces the entry with task-2
    await flush()
    // Now resolve task-1's subscription — its entry is gone (task-2 owns the key),
    // so the stale unsub must be torn down, not stored.
    resolveFirst(firstUnsub)
    await flush()
    expect(firstUnsub).toHaveBeenCalledTimes(1)
    expect(tracker.get(KEY)?.taskId).toBe('task-2')
    // Releasing the key tears down ONLY task-2's live unsub.
    tracker.release(KEY)
    expect(secondUnsub).toHaveBeenCalledTimes(1)
  })
})

describe('TaskTracker — tool_complete token narrowing', () => {
  /** Seed a running step so tool_complete has a target to mutate. */
  async function startWithStep(toolCallId = 'tc-1'): Promise<void> {
    tracker.start(KEY, 'task-1', 'um-1')
    await rpc.emit({ type: 'open', taskId: 'task-1', hostRef: 'agent-x' })
    await rpc.emit({
      type: 'tool_start',
      data: {
        toolCallId,
        toolName: 'mongodb__find',
        displayName: 'MongoDB',
        iteration: 0,
        stepIndex: 0,
        totalSteps: 1,
      },
    })
  }

  async function completeWith(tokens: unknown): Promise<void> {
    const data: Record<string, unknown> = { toolCallId: 'tc-1', durationMs: 1500 }
    if (tokens !== undefined) data.tokens = tokens
    await rpc.emit({ type: 'tool_complete', data })
  }

  it('copies valid tokens (no cache) onto the completed step', async () => {
    await startWithStep()
    await completeWith({ input: 1200, output: 340 })

    const step = tracker.get(KEY)?.steps[0]
    expect(step?.state).toBe('completed')
    expect(step?.durationMs).toBe(1500)
    expect(step?.tokens).toEqual({ input: 1200, output: 340 })
  })

  it('copies valid tokens including cacheRead/cacheWrite when present', async () => {
    await startWithStep()
    await completeWith({ input: 1200, output: 340, cacheRead: 9000, cacheWrite: 100 })

    expect(tracker.get(KEY)?.steps[0]?.tokens).toEqual({
      input: 1200,
      output: 340,
      cacheRead: 9000,
      cacheWrite: 100,
    })
  })

  it('drops malformed tokens — non-object string payload', async () => {
    await startWithStep()
    await completeWith('12.3k')

    const step = tracker.get(KEY)?.steps[0]
    expect(step?.state).toBe('completed')
    expect(step?.tokens).toBeUndefined()
  })

  it('drops malformed tokens — partial object missing output', async () => {
    await startWithStep()
    await completeWith({ input: 1200 })

    expect(tracker.get(KEY)?.steps[0]?.tokens).toBeUndefined()
  })

  it('drops malformed tokens — non-numeric cacheRead', async () => {
    await startWithStep()
    await completeWith({ input: 1200, output: 340, cacheRead: '9000' })

    expect(tracker.get(KEY)?.steps[0]?.tokens).toBeUndefined()
  })

  it('leaves tokens undefined when the event carries none', async () => {
    await startWithStep()
    await completeWith(undefined)

    const step = tracker.get(KEY)?.steps[0]
    expect(step?.state).toBe('completed')
    expect(step?.durationMs).toBe(1500)
    expect(step?.tokens).toBeUndefined()
  })
})
