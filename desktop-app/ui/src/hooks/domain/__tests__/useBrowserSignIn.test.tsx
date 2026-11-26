// @vitest-environment jsdom
/**
 * `useBrowserSignIn`: the renderer's copy of main's browser sign-in snapshot (D13, C-1), its
 * reactions to a refused start (D5) and its outcome display (plan decision 5).
 *
 * Every snapshot the hook sees comes from a real `BrowserSignInAttempts` (T1). Its pushes are
 * carried as `auth:browserSignInResult` carries them: to the listener subscribed when main sends
 * one, and lost when there is none, as `webContents.send` loses it with no live page (A3-52).
 * They are never buffered. The fake IPC answers from the same store, and every refusal is fed in
 * the form Electron gives the renderer (M5).
 */
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest'
import { type RenderHookResult, act, cleanup, renderHook } from '@testing-library/react'
import fc, { type Scheduler } from 'fast-check'
import {
  BROWSER_SIGN_IN_REFUSAL_COPY,
  START_REJECTION_REREAD_CODES,
} from '@constants/browserSignIn'
import { ipcErrorCode } from '@lib/ipcErrorCode'
import {
  BROWSER_SIGN_IN_DEADLINE_MS,
  BrowserSignInAttempts,
} from '../../../../../src/browserSignIn'
import { DESKTOP_LOGIN_REFUSAL_REASONS } from '../../../../../src/browserSignInModel'
import type {
  BrowserSignInEnd,
  BrowserSignInSnapshot,
  BrowserSignInStartResult,
} from '../../../../../src/types'
import { FakeBrowserSignInClock } from '../../../../../testSupport/browserSignInClock'
import type { Tone } from '../../../uiTypes'
import type { UseBrowserSignInParams, UseBrowserSignInResult } from '../types'
import { useBrowserSignIn } from '../useBrowserSignIn'

type Listener = (snapshot: BrowserSignInSnapshot) => void

const BINDING = Object.freeze({
  environmentKey: 'fixture_env-0123456789ab',
  profileId: null,
  restBaseUrl: 'https://edge-fixture.example.test',
})

const GENERIC_FAILURE = "Sign-in through the browser didn't finish. Try again."

/** A rejected `ipcRenderer.invoke`, as Electron hands it to the renderer (M5). */
function ipcRejection(channel: string, code: string): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${code}`)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined)
}

function strictStoreWarning(message: string, error: unknown): never {
  throw new Error(`unexpected browser sign-in store warning: ${message}`, { cause: error })
}

/** The store's attempt input. The state and verifier never reach the renderer (D18). */
function attemptInput(generation: number) {
  return {
    state: `fake-state-${generation}`,
    verifier: `fake-verifier-${generation}`,
    binding: BINDING,
    generation,
  }
}

/** Main for the scenario tests: a real store, its pushes and the five calls answered from it. */
function createMain() {
  const clock = new FakeBrowserSignInClock()
  const pushes: BrowserSignInSnapshot[] = []
  const listeners = new Set<Listener>()
  const emit = (snapshot: BrowserSignInSnapshot) => {
    for (const listener of [...listeners]) listener(snapshot)
  }
  /** While muted, main's pushes are recorded and lost, as with no live page. */
  let muted = false
  const mute = (next: boolean) => {
    muted = next
  }
  const store = new BrowserSignInAttempts({
    push: snapshot => {
      pushes.push(snapshot)
      if (!muted) emit(snapshot)
    },
    warn: strictStoreWarning,
    clock,
  })
  let generation = 0
  /** Start in main once it is allowed: D3's bump, then the record (D5). */
  const recordAttempt = () => {
    generation += 1
    store.onGenerationAdvanced()
    return store.record(attemptInput(generation))
  }
  const auth = {
    onBrowserSignInChanged: vi.fn((listener: Listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    getBrowserSignInState: vi.fn(async (): Promise<BrowserSignInSnapshot> => store.snapshot()),
    startBrowserSignIn: vi.fn(async (): Promise<BrowserSignInStartResult> => {
      if (store.current()?.phase === 'redeeming') {
        throw ipcRejection('auth:startBrowserSignIn', 'browser_sign_in_finishing')
      }
      return { attemptId: recordAttempt() }
    }),
    cancelBrowserSignIn: vi.fn(async (): Promise<BrowserSignInSnapshot> => store.cancel()),
    acknowledgeBrowserSignInResult: vi.fn(
      async (attemptId: number): Promise<BrowserSignInSnapshot> => store.acknowledge(attemptId)
    ),
  }
  window.clerum = { ...window.clerum, auth: { ...window.clerum?.auth, ...auth } } as never
  /** The snapshot main pushed for `attemptId` in `phase`. */
  const pushed = (attemptId: number, phase: BrowserSignInSnapshot['phase']) => {
    const snapshot = pushes.find(item => item.attemptId === attemptId && item.phase === phase)
    if (!snapshot) throw new Error(`main pushed no ${phase} snapshot for attempt ${attemptId}`)
    return snapshot
  }
  return { clock, store, pushes, auth, emit, mute, recordAttempt, pushed }
}

type Main = ReturnType<typeof createMain>

type ParamMocks = {
  [Key in keyof UseBrowserSignInParams]: Mock<UseBrowserSignInParams[Key]>
}

function mount(overrides: Partial<ParamMocks> = {}) {
  const params: ParamMocks = {
    setStatus: vi.fn<UseBrowserSignInParams['setStatus']>(),
    onSessionNeedsLoad: vi
      .fn<UseBrowserSignInParams['onSessionNeedsLoad']>()
      .mockResolvedValue(undefined),
    refreshLoginMethods: vi.fn<UseBrowserSignInParams['refreshLoginMethods']>(),
    ...overrides,
  }
  const hook = renderHook((props: UseBrowserSignInParams) => useBrowserSignIn(props), {
    initialProps: params,
  })
  return { hook, ...params }
}

/** Lets every pending push, reply and effect run. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useBrowserSignIn: start, cancel and start refusals (D5)', () => {
  it('G2-5e reloads the session when start finds one', async () => {
    const main = createMain()
    main.auth.startBrowserSignIn.mockRejectedValueOnce(
      ipcRejection('auth:startBrowserSignIn', 'browser_sign_in_requires_signout')
    )
    const mounted = mount()
    await settle()

    await act(() => mounted.hook.result.current.start())

    expect(mounted.onSessionNeedsLoad).toHaveBeenCalledTimes(1)
    expect(mounted.onSessionNeedsLoad).toHaveBeenCalledWith()
    expect(mounted.setStatus).not.toHaveBeenCalled()
    expect(mounted.refreshLoginMethods).not.toHaveBeenCalled()
  })

  it("shows waiting from start's reply alone, and cancels through main", async () => {
    const main = createMain()
    const mounted = mount()
    await settle()
    main.mute(true)

    await act(() => mounted.hook.result.current.start())

    const attempt = main.store.current()?.id
    expect(main.pushes).toEqual([{ attemptId: attempt, phase: 'waiting' }])
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'waiting' })
    expect(mounted.hook.result.current.isRedeeming()).toBe(false)

    main.mute(false)
    await act(() => mounted.hook.result.current.cancel())
    await settle()

    expect(main.auth.cancelBrowserSignIn).toHaveBeenCalledTimes(1)
    expect(mounted.setStatus.mock.calls).toEqual([['Browser sign-in cancelled.', 'info']])
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'idle' })
  })

  it.each([...START_REJECTION_REREAD_CODES])(
    're-reads the login model, with no message, when start is refused %s',
    async code => {
      const main = createMain()
      main.auth.startBrowserSignIn.mockRejectedValueOnce(
        ipcRejection('auth:startBrowserSignIn', code)
      )
      const mounted = mount()
      await settle()

      await act(() => mounted.hook.result.current.start())

      expect(mounted.refreshLoginMethods).toHaveBeenCalledTimes(1)
      expect(mounted.setStatus).not.toHaveBeenCalled()
      expect(mounted.onSessionNeedsLoad).not.toHaveBeenCalled()
    }
  )

  it('leaves browser_sign_in_finishing to the redeeming snapshot', async () => {
    const main = createMain()
    const attempt = main.recordAttempt()
    main.store.beginRedeem(attempt)
    const mounted = mount()
    await settle()

    await act(() => mounted.hook.result.current.start())

    await expect(main.auth.startBrowserSignIn.mock.results[0]?.value).rejects.toThrow(
      'browser_sign_in_finishing'
    )
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'redeeming' })
    expect(mounted.setStatus).not.toHaveBeenCalled()
    expect(mounted.refreshLoginMethods).not.toHaveBeenCalled()
    expect(mounted.onSessionNeedsLoad).not.toHaveBeenCalled()
  })

  it('shows a browser that did not open once, from the failed snapshot', async () => {
    const main = createMain()
    let attempt = 0
    // Main records the attempt, the open fails, the attempt ends `failed`, and start refuses
    // `browser_open_failed` (A3-66).
    main.auth.startBrowserSignIn.mockImplementationOnce(async () => {
      attempt = main.recordAttempt()
      main.store.endIfWaiting(attempt, { outcome: 'failed' })
      throw ipcRejection('auth:startBrowserSignIn', 'browser_open_failed')
    })
    const mounted = mount()
    await settle()

    await act(() => mounted.hook.result.current.start())
    await settle()

    expect(mounted.setStatus.mock.calls).toEqual([[GENERIC_FAILURE, 'error']])
    expect(main.auth.acknowledgeBrowserSignInResult.mock.calls).toEqual([[attempt]])
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'idle' })
    expect(mounted.refreshLoginMethods).not.toHaveBeenCalled()
  })

  it.each(['desktop_setup_required', '500 Internal Server Error: upstream 404'])(
    'shows the generic failure when start is refused %s',
    async message => {
      const main = createMain()
      main.auth.startBrowserSignIn.mockRejectedValueOnce(
        ipcRejection('auth:startBrowserSignIn', message)
      )
      const mounted = mount()
      await settle()

      await act(() => mounted.hook.result.current.start())

      expect(mounted.setStatus.mock.calls).toEqual([[GENERIC_FAILURE, 'error']])
      expect(mounted.refreshLoginMethods).not.toHaveBeenCalled()
      expect(mounted.onSessionNeedsLoad).not.toHaveBeenCalled()
    }
  )

  it.each(['bare', 'wrapped'] as const)('ipcErrorCode reads a %s code and nothing longer', form => {
    const refusal = (code: string) =>
      form === 'bare' ? new Error(code) : ipcRejection('auth:startBrowserSignIn', code)
    const codes = ['browser_sign_in_finishing', 'browser_open_failed'] as const

    expect(ipcErrorCode(refusal('browser_sign_in_finishing'), codes)).toBe(
      'browser_sign_in_finishing'
    )
    expect(ipcErrorCode(refusal('browser_open_failed'), codes)).toBe('browser_open_failed')
    expect(ipcErrorCode(refusal('browser_sign_in_finishing_x'), codes)).toBeNull()
    expect(ipcErrorCode(refusal('not browser_sign_in_finishing'), codes)).toBeNull()
    expect(ipcErrorCode(refusal('desktop_setup_required'), codes)).toBeNull()
  })
})

describe('useBrowserSignIn: the snapshot (D13)', () => {
  it('G2-13c recovers a redeeming attempt at boot and orders replies', async () => {
    // (a) A renderer that boots while main redeems (A3-45). The pushes before it reach no one.
    const first = createMain()
    const redeemed = first.recordAttempt()
    first.store.beginRedeem(redeemed)
    await settle()
    expect(first.pushes).toEqual([
      { attemptId: redeemed, phase: 'waiting' },
      { attemptId: redeemed, phase: 'redeeming' },
    ])
    const booted = mount()
    await settle()
    expect(booted.hook.result.current.view).toEqual({ attemptId: redeemed, phase: 'redeeming' })
    expect(booted.hook.result.current.isRedeeming()).toBe(true)
    first.store.end(redeemed, { outcome: 'signed_in' })
    await settle()
    expect(booted.onSessionNeedsLoad).toHaveBeenCalledTimes(1)
    expect(booted.onSessionNeedsLoad).toHaveBeenCalledWith({ preserveNav: true })
    booted.hook.unmount()

    // (b) The boot read's `waiting` reply lands after the `ended` push (A3-53). The
    // acknowledgement is held, so the outcome stays on screen.
    const second = createMain()
    const read = deferred<BrowserSignInSnapshot>()
    second.auth.getBrowserSignInState.mockImplementationOnce(() => read.promise)
    second.auth.acknowledgeBrowserSignInResult.mockImplementation(() => never())
    const late = mount()
    const failed = second.recordAttempt()
    const waitingReply = second.store.snapshot()
    expect(waitingReply).toEqual({ attemptId: failed, phase: 'waiting' })
    second.store.end(failed, { outcome: 'failed' })
    await settle()
    expect(late.hook.result.current.view).toEqual(second.pushed(failed, 'ended'))
    await act(async () => {
      read.resolve(waitingReply)
    })
    await settle()
    expect(late.hook.result.current.view).toEqual(second.pushed(failed, 'ended'))
    late.hook.unmount()

    // (c) Start's reply lands after the `waiting` push and a `redeeming` one.
    const third = createMain()
    const reply = deferred<BrowserSignInStartResult>()
    let started = 0
    third.auth.startBrowserSignIn.mockImplementationOnce(() => {
      started = third.recordAttempt()
      return reply.promise
    })
    const starter = mount()
    await settle()
    let starting: Promise<void> = Promise.resolve()
    act(() => {
      starting = starter.hook.result.current.start()
    })
    await settle()
    expect(starter.hook.result.current.view).toEqual({ attemptId: started, phase: 'waiting' })
    third.store.beginRedeem(started)
    await settle()
    expect(starter.hook.result.current.view).toEqual({ attemptId: started, phase: 'redeeming' })
    await act(async () => {
      reply.resolve({ attemptId: started })
      await starting
    })
    expect(starter.hook.result.current.view).toEqual({ attemptId: started, phase: 'redeeming' })
  })

  it('G2-13d does not miss a push that races the boot read', async () => {
    const main = createMain()
    const attempt = main.recordAttempt()
    await settle()
    const read = deferred<BrowserSignInSnapshot>()
    let readReply: BrowserSignInSnapshot | null = null
    main.auth.getBrowserSignInState.mockImplementationOnce(() => {
      readReply = main.store.snapshot()
      return read.promise
    })
    main.auth.acknowledgeBrowserSignInResult.mockImplementation(() => never())
    const booted = mount()
    // Main answered the read first, with `waiting`; the `ended` push is sent before the
    // renderer processes that answer.
    expect(readReply).toEqual({ attemptId: attempt, phase: 'waiting' })
    main.store.end(attempt, { outcome: 'failed' })
    await settle()
    await act(async () => {
      read.resolve(readReply as unknown as BrowserSignInSnapshot)
    })
    await settle()

    expect(booted.hook.result.current.view).toEqual(main.pushed(attempt, 'ended'))
    expect(booted.setStatus.mock.calls).toEqual([[GENERIC_FAILURE, 'error']])
  })

  it('G2-13e clears the view on idle and ignores a late ended replay', async () => {
    const main = createMain()
    const mounted = mount()
    await settle()
    const attempt = main.recordAttempt()
    main.store.cancel()
    await settle()
    expect(main.auth.acknowledgeBrowserSignInResult.mock.calls).toEqual([[attempt]])
    expect(main.pushes.at(-1)).toEqual({ attemptId: attempt, phase: 'idle' })
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'idle' })

    act(() => main.emit(main.pushed(attempt, 'ended')))
    await settle()

    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'idle' })
    expect(mounted.setStatus.mock.calls).toEqual([['Browser sign-in cancelled.', 'info']])
    expect(main.auth.acknowledgeBrowserSignInResult).toHaveBeenCalledTimes(1)
  })
})

type OutcomeRow = {
  name: string
  end: (main: Main, attemptId: number) => void
  message: string
  tone: Tone
}

const endWith =
  (end: BrowserSignInEnd) =>
  (main: Main, attemptId: number): void => {
    main.store.end(attemptId, end)
  }

const OUTCOME_ROWS: readonly OutcomeRow[] = [
  {
    name: 'signed_in',
    end: endWith({ outcome: 'signed_in' }),
    message: 'Signed in.',
    tone: 'success',
  },
  {
    name: 'cancelled',
    end: main => void main.store.cancel(),
    message: 'Browser sign-in cancelled.',
    tone: 'info',
  },
  {
    name: 'timed_out',
    end: main => main.clock.advance(BROWSER_SIGN_IN_DEADLINE_MS, 'timers'),
    message: 'Browser sign-in timed out. Try again.',
    tone: 'warn',
  },
  {
    name: 'refused(account_disabled)',
    end: endWith({ outcome: 'refused', reason: 'account_disabled' }),
    message: 'Your account has been disabled. Contact your administrator.',
    tone: 'error',
  },
  {
    name: 'failed',
    end: endWith({ outcome: 'failed' }),
    message: GENERIC_FAILURE,
    tone: 'error',
  },
  {
    name: 'failed(different_environment)',
    end: endWith({ outcome: 'failed', reason: 'different_environment' }),
    message: 'This sign-in finished for a different Evenfire environment.',
    tone: 'error',
  },
  {
    name: 'failed(unavailable)',
    end: endWith({ outcome: 'failed', reason: 'unavailable' }),
    message: "Sign-in through the browser isn't available here.",
    tone: 'error',
  },
  {
    name: 'failed(no_longer_available)',
    end: endWith({ outcome: 'failed', reason: 'no_longer_available' }),
    message: 'Sign-in through the browser is no longer available here.',
    tone: 'error',
  },
  {
    name: 'failed(environment_changed)',
    end: endWith({ outcome: 'failed', reason: 'environment_changed' }),
    message: GENERIC_FAILURE,
    tone: 'error',
  },
]

describe('useBrowserSignIn: outcomes (plan decision 5)', () => {
  it.each(OUTCOME_ROWS)('acknowledges each outcome once, after showing it: $name', async row => {
    const main = createMain()
    const mounted = mount()
    await settle()
    const attempt = main.recordAttempt()
    row.end(main, attempt)
    await settle()

    expect(mounted.setStatus.mock.calls).toEqual([[row.message, row.tone]])
    const acknowledge = main.auth.acknowledgeBrowserSignInResult
    expect(acknowledge.mock.calls).toEqual([[attempt]])
    expect(mounted.setStatus.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledge.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY
    )
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'idle' })

    // The outcome again, as a replayed push brings it: nothing more is shown or acknowledged.
    act(() => main.emit(main.pushed(attempt, 'ended')))
    await settle()
    expect(mounted.setStatus).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it('shows an outcome once when its owner re-renders with new callbacks', async () => {
    const main = createMain()
    main.auth.acknowledgeBrowserSignInResult.mockImplementation(() => never())
    const mounted = mount()
    await settle()
    const attempt = main.recordAttempt()
    main.store.end(attempt, { outcome: 'failed' })
    await settle()
    expect(mounted.hook.result.current.view).toEqual(main.pushed(attempt, 'ended'))

    const setStatus = vi.fn<UseBrowserSignInParams['setStatus']>()
    mounted.hook.rerender({
      setStatus,
      onSessionNeedsLoad: vi.fn().mockResolvedValue(undefined),
      refreshLoginMethods: vi.fn(),
    })
    await settle()

    expect(mounted.setStatus.mock.calls).toEqual([[GENERIC_FAILURE, 'error']])
    expect(setStatus).not.toHaveBeenCalled()
    expect(main.auth.acknowledgeBrowserSignInResult).toHaveBeenCalledTimes(1)
  })

  it('acknowledges signed_in only after the session load settles, even when it fails', async () => {
    const main = createMain()
    const load = deferred<void>()
    const onSessionNeedsLoad = vi
      .fn<UseBrowserSignInParams['onSessionNeedsLoad']>()
      .mockReturnValue(load.promise)
    const mounted = mount({ onSessionNeedsLoad })
    await settle()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const attempt = main.recordAttempt()
    main.store.end(attempt, { outcome: 'signed_in' })
    await settle()

    expect(mounted.setStatus.mock.calls).toEqual([['Signed in.', 'success']])
    expect(onSessionNeedsLoad.mock.calls).toEqual([[{ preserveNav: true }]])
    expect(main.auth.acknowledgeBrowserSignInResult).not.toHaveBeenCalled()

    await act(async () => {
      load.reject(new Error('fake restore failure at https://edge-fixture.example.test'))
    })
    await settle()

    expect(main.auth.acknowledgeBrowserSignInResult.mock.calls).toEqual([[attempt]])
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'idle' })
    // A fixed line and the error's class: the message may carry a URL (D18).
    expect(warn.mock.calls).toEqual([
      ['[useBrowserSignIn] The session could not be loaded after browser sign-in', 'Error'],
    ])
  })

  it('shows an error when the session fails to load after browser sign-in (I-1)', async () => {
    const main = createMain()
    const onSessionNeedsLoad = vi
      .fn<UseBrowserSignInParams['onSessionNeedsLoad']>()
      .mockRejectedValue(new Error('fake restore failure at https://edge-fixture.example.test'))
    const mounted = mount({ onSessionNeedsLoad })
    await settle()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const attempt = main.recordAttempt()
    main.store.end(attempt, { outcome: 'signed_in' })
    await settle()

    expect(onSessionNeedsLoad.mock.calls).toEqual([[{ preserveNav: true }]])
    // The error replaces "Signed in.", since the login screen is still showing.
    expect(mounted.setStatus.mock.calls).toEqual([
      ['Signed in.', 'success'],
      ['Could not load your session. Try again.', 'error'],
    ])
    const acknowledge = main.auth.acknowledgeBrowserSignInResult
    expect(acknowledge.mock.calls).toEqual([[attempt]])
    expect(mounted.setStatus.mock.invocationCallOrder[1]).toBeLessThan(
      acknowledge.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY
    )
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'idle' })
    expect(warn.mock.calls).toEqual([
      ['[useBrowserSignIn] The session could not be loaded after browser sign-in', 'Error'],
    ])
    // Neither the error's message nor its URL reaches a status or a log (D18).
    expect(JSON.stringify([mounted.setStatus.mock.calls, warn.mock.calls])).not.toMatch(
      /fake restore failure|example\.test/
    )
  })

  it('shows nothing for replaced', async () => {
    const main = createMain()
    const mounted = mount()
    await settle()
    const attempt = main.recordAttempt()
    main.store.onGenerationAdvanced()
    await settle()

    expect(main.pushed(attempt, 'ended')).toEqual({
      attemptId: attempt,
      phase: 'ended',
      outcome: 'replaced',
    })
    expect(mounted.setStatus).not.toHaveBeenCalled()
    expect(mounted.onSessionNeedsLoad).not.toHaveBeenCalled()
    // Decision 5: `replaced` is still acknowledged, with no message (K24).
    expect(main.auth.acknowledgeBrowserSignInResult.mock.calls).toEqual([[attempt]])
    expect(mounted.hook.result.current.view).toEqual({ attemptId: attempt, phase: 'idle' })
  })

  it('has refusal copy for exactly the package reasons', () => {
    expect(Object.keys(BROWSER_SIGN_IN_REFUSAL_COPY).sort()).toEqual(
      [...DESKTOP_LOGIN_REFUSAL_REASONS].sort()
    )
  })
})

// L8 (state model §4.3, §7.5): the renderer half of the A6 oracle.

type L8Op =
  | { kind: 'start' }
  | { kind: 'record' }
  | { kind: 'beginRedeem' }
  | { kind: 'end'; end: BrowserSignInEnd }
  | { kind: 'cancel' }
  | { kind: 'bump' }
  | { kind: 'deadline'; via: 'timers' | 'resume' | 'sleep' }
  | { kind: 'acknowledge'; back: number }
  | { kind: 'drop' }
  | { kind: 'remount' }
  | { kind: 'release'; count: number }

type L8Renderer = {
  index: number
  alive: boolean
  listener: Listener | null
  view: BrowserSignInSnapshot | null
  hook: RenderHookResult<UseBrowserSignInResult, UseBrowserSignInParams> | null
  shown: number[]
  acks: number[]
}

const endArb: fc.Arbitrary<BrowserSignInEnd> = fc.oneof(
  fc.constantFrom<BrowserSignInEnd>(
    { outcome: 'signed_in' },
    { outcome: 'cancelled' },
    { outcome: 'timed_out' },
    { outcome: 'replaced' },
    { outcome: 'failed' }
  ),
  fc
    .constantFrom(...DESKTOP_LOGIN_REFUSAL_REASONS)
    .map((reason): BrowserSignInEnd => ({ outcome: 'refused', reason })),
  fc
    .constantFrom(
      'different_environment',
      'unavailable',
      'no_longer_available',
      'environment_changed'
    )
    .map((reason): BrowserSignInEnd => ({ outcome: 'failed', reason }))
)

const l8OpArb: fc.Arbitrary<L8Op> = fc.oneof(
  { arbitrary: fc.constant<L8Op>({ kind: 'start' }), weight: 3 },
  { arbitrary: fc.constant<L8Op>({ kind: 'record' }), weight: 2 },
  { arbitrary: fc.constant<L8Op>({ kind: 'beginRedeem' }), weight: 2 },
  { arbitrary: endArb.map((end): L8Op => ({ kind: 'end', end })), weight: 3 },
  { arbitrary: fc.constant<L8Op>({ kind: 'cancel' }), weight: 1 },
  { arbitrary: fc.constant<L8Op>({ kind: 'bump' }), weight: 1 },
  {
    arbitrary: fc
      .constantFrom('timers', 'resume', 'sleep')
      .map((via): L8Op => ({ kind: 'deadline', via })),
    weight: 1,
  },
  {
    arbitrary: fc.integer({ min: 0, max: 2 }).map((back): L8Op => ({ kind: 'acknowledge', back })),
    weight: 1,
  },
  { arbitrary: fc.constant<L8Op>({ kind: 'drop' }), weight: 1 },
  { arbitrary: fc.constant<L8Op>({ kind: 'remount' }), weight: 2 },
  {
    arbitrary: fc.integer({ min: 1, max: 4 }).map((count): L8Op => ({ kind: 'release', count })),
    weight: 6,
  }
)

function describeSnapshot(snapshot: BrowserSignInSnapshot): string {
  return snapshot.phase === 'ended'
    ? `ended(${snapshot.attemptId}, ${snapshot.outcome})`
    : `${snapshot.phase}(${snapshot.attemptId})`
}

/**
 * The renderer world for L8. Main is a real store. Each renderer `invoke` reaches main and its
 * reply comes back, each when the scheduler says, so replies and pushes cross in any order. A
 * replaced renderer gets no reply and no push, but a call it sent still reaches main, as an IPC
 * message already sent does. A drop window loses every push until the next renderer mounts, as
 * a closed window or a reloading page does (A3-63); that renderer's boot read recovers.
 */
function createL8World(scheduler: Scheduler) {
  const clock = new FakeBrowserSignInClock()
  const pushes: BrowserSignInSnapshot[] = []
  const renderers: L8Renderer[] = []
  const violations: string[] = []
  let live: L8Renderer | null = null
  let dropping = false
  const store = new BrowserSignInAttempts({
    push: snapshot => {
      pushes.push(snapshot)
      const target = dropping ? null : live
      if (target === null) return
      void scheduler
        .schedule(Promise.resolve(), `push ${describeSnapshot(snapshot)} to #${target.index}`)
        .then(() => {
          if (target.alive) target.listener?.(snapshot)
        })
    },
    warn: strictStoreWarning,
    clock,
  })
  let generation = 0
  const recordAttempt = () => {
    generation += 1
    store.onGenerationAdvanced()
    return store.record(attemptInput(generation))
  }

  function invoke<T>(renderer: L8Renderer, label: string, atMain: () => T): Promise<T> {
    return scheduler
      .schedule(Promise.resolve(), `${label} from #${renderer.index} reaches main`)
      .then(() => {
        let answer: { ok: true; value: T } | { ok: false; error: unknown }
        try {
          answer = { ok: true, value: atMain() }
        } catch (error) {
          answer = { ok: false, error }
        }
        return scheduler.schedule(Promise.resolve(answer), `${label} reply to #${renderer.index}`)
      })
      .then(answer => {
        if (!renderer.alive) return never<T>()
        if (answer.ok) return answer.value
        throw answer.error
      })
  }

  function mountRenderer(): L8Renderer {
    const renderer: L8Renderer = {
      index: renderers.length,
      alive: true,
      listener: null,
      view: null,
      hook: null,
      shown: [],
      acks: [],
    }
    renderers.push(renderer)
    live = renderer
    dropping = false
    const auth = {
      onBrowserSignInChanged: (listener: Listener) => {
        renderer.listener = listener
        return () => {
          if (renderer.listener === listener) renderer.listener = null
        }
      },
      getBrowserSignInState: () => invoke(renderer, 'state read', () => store.snapshot()),
      startBrowserSignIn: () =>
        invoke(renderer, 'start', (): BrowserSignInStartResult => {
          if (store.current()?.phase === 'redeeming') {
            throw ipcRejection('auth:startBrowserSignIn', 'browser_sign_in_finishing')
          }
          return { attemptId: recordAttempt() }
        }),
      cancelBrowserSignIn: () => invoke(renderer, 'cancel', () => store.cancel()),
      acknowledgeBrowserSignInResult: (attemptId: number) => {
        renderer.acks.push(attemptId)
        return invoke(renderer, `acknowledge ${attemptId}`, () => store.acknowledge(attemptId))
      },
    }
    window.clerum = { ...window.clerum, auth: { ...window.clerum?.auth, ...auth } } as never
    const params: UseBrowserSignInParams = {
      setStatus: message => {
        // Outcomes are shown from the effect on the committed view, which is the last render's.
        const view = renderer.view
        if (view?.phase !== 'ended') {
          violations.push(`#${renderer.index} showed "${message}" on ${String(view?.phase)}`)
          return
        }
        renderer.shown.push(view.attemptId)
      },
      onSessionNeedsLoad: () => invoke(renderer, 'session load', () => undefined),
      refreshLoginMethods: () => {
        violations.push(`#${renderer.index} re-read the login model`)
      },
    }
    // `main.tsx` mounts the app in StrictMode, which runs the mount effect twice in development.
    renderer.hook = renderHook(
      () => {
        const result = useBrowserSignIn(params)
        renderer.view = result.view
        return result
      },
      { reactStrictMode: true }
    )
    return renderer
  }

  /** Lets every call in flight reach its next scheduled step. */
  async function flushTurn() {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }

  async function remount() {
    await flushTurn()
    const previous = live
    if (previous) {
      previous.alive = false
      previous.hook?.unmount()
    }
    mountRenderer()
    await flushTurn()
  }

  async function quiesce() {
    for (let round = 0; round < 200; round += 1) {
      await flushTurn()
      if (scheduler.count() === 0) return
      await act(async () => {
        await scheduler.waitAll()
      })
    }
    throw new Error('the renderer did not come to rest')
  }

  async function run(op: L8Op) {
    const current = store.current()
    switch (op.kind) {
      case 'start':
        act(() => {
          void live?.hook?.result.current.start()
        })
        break
      case 'record':
        // A start whose reply went to a page that is gone (A3-12): main records all the same.
        if (current?.phase !== 'redeeming') recordAttempt()
        break
      case 'beginRedeem':
        if (current) store.beginRedeem(current.id)
        break
      case 'end':
        if (current) store.end(current.id, op.end)
        break
      case 'cancel':
        act(() => {
          void live?.hook?.result.current.cancel()
        })
        break
      case 'bump':
        store.onGenerationAdvanced()
        break
      case 'deadline':
        if (op.via === 'timers') {
          clock.advance(BROWSER_SIGN_IN_DEADLINE_MS, 'timers')
        } else {
          clock.advance(BROWSER_SIGN_IN_DEADLINE_MS, 'wallOnly')
          // A resume checks the deadline (D12); a sleep leaves it to the next read (A3-67).
          if (op.via === 'resume') store.checkDeadline()
        }
        break
      case 'acknowledge':
        // An acknowledgement a replaced page sent before it went, for this attempt or an older one.
        if (current) store.acknowledge(Math.max(1, current.id - op.back))
        break
      case 'drop':
        dropping = true
        break
      case 'remount':
        await remount()
        break
      case 'release':
        for (let step = 0; step < op.count; step += 1) {
          await act(async () => {
            if (scheduler.count() > 0) await scheduler.waitOne()
          })
        }
        break
    }
  }

  /** At quiescence, the view equals main's snapshot (L8) and no renderer shows an outcome twice. */
  async function settleAndCheck() {
    await quiesce()
    if (dropping) {
      await remount()
      await quiesce()
    }
    // The read applies the deadline, which may end an attempt and push (A3-67).
    for (let round = 0; round < 3; round += 1) {
      const before = pushes.length
      store.snapshot()
      await quiesce()
      if (pushes.length === before) break
    }
    const outcomeOf = (attemptId: number) => {
      const ended = pushes.find(item => item.attemptId === attemptId && item.phase === 'ended')
      return ended?.phase === 'ended' ? ended.outcome : null
    }
    expect(live?.hook?.result.current.view).toEqual(store.snapshot())
    expect(violations).toEqual([])
    for (const renderer of renderers) {
      const label = `renderer #${renderer.index}`
      expect(new Set(renderer.shown).size, `${label} showed an outcome twice`).toBe(
        renderer.shown.length
      )
      expect(new Set(renderer.acks).size, `${label} acknowledged an outcome twice`).toBe(
        renderer.acks.length
      )
      for (const attemptId of renderer.shown) {
        expect(outcomeOf(attemptId), `${label} showed replaced ${attemptId}`).not.toBe('replaced')
      }
      for (const attemptId of renderer.acks) {
        if (outcomeOf(attemptId) === 'replaced') continue
        expect(renderer.shown, `${label} acknowledged ${attemptId} unshown`).toContain(attemptId)
      }
    }
  }

  async function dispose() {
    for (const renderer of renderers) {
      if (renderer.alive) renderer.hook?.unmount()
      renderer.alive = false
    }
    cleanup()
  }

  mountRenderer()
  return { run, settleAndCheck, dispose }
}

describe('useBrowserSignIn: convergence (L8)', () => {
  it("L8 converges to main's snapshot under dropped pushes, boot reads and reordered replies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(l8OpArb, { minLength: 1, maxLength: 30 }),
        async (scheduler, ops) => {
          const world = createL8World(scheduler)
          try {
            for (const op of ops) await world.run(op)
            await world.settleAndCheck()
          } finally {
            await world.dispose()
          }
        }
      ),
      { numRuns: 200, seed: 24112026 }
    )
  }, 60_000)
})
