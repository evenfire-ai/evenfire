import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import fc from 'fast-check'
import {
  SANDBOX_UI_COOKIE_TTL_MS,
  SANDBOX_UI_RATE_LIMIT_MS,
  SANDBOX_UI_REFRESH_INTERVAL_MS,
  _isPinnedForTests,
  _resetSandboxUiRefreshForTests,
  cancelSandboxUiRefresh,
  handleEmbedRefreshRequest,
  handleSandboxUiUnauthorizedNavigation,
  notifySandboxUiHostResumed,
  startSandboxUiRefresh,
} from '../sandboxUiSessionRefresh.js'
import type {
  SandboxUiInstallCookieFn,
  SandboxUiRefreshFn,
  StartSandboxUiRefreshArgs,
} from '../sandboxUiSessionRefresh.js'

type Listener = () => void

class FakeBrowserWindow {
  destroyed = false
  visible = true
  minimized = false
  private listeners = new Map<string, Set<Listener>>()
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  isMinimized(): boolean {
    return this.minimized
  }
  on(event: string, handler: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
    return this
  }
  removeListener(event: string, handler: Listener): this {
    this.listeners.get(event)?.delete(handler)
    return this
  }
  emit(event: string): void {
    for (const h of this.listeners.get(event) ?? []) h()
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

// Two independent clocks: the wall clock the module reads through `now()`, and
// the fake timers that drive `setTimeout`. Awake, the wall clock follows the
// timer clock (`advance`, firing each timer at its own instant); asleep, only
// the wall clock moves (`sleep`) — the case a timer-only design gets wrong.
// `performance` is faked only so the test can read the timer clock; the module
// never touches it, and Date stays real.
let sleptMs = 0
const wallNow = (): number => 1_800_000_000_000 + performance.now() + sleptMs

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function sleep(ms: number): void {
  sleptMs += ms
}

/** Lets already-started promise chains (mint → install → reschedule) settle. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  // Date is deliberately left real: the module must take its wall clock from
  // the injected `now()`, never from whatever the timer clock says.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  sleptMs = 0
  _resetSandboxUiRefreshForTests()
})

afterEach(() => {
  _resetSandboxUiRefreshForTests()
  vi.useRealTimers()
})

function makeArgs(
  overrides: {
    refresh?: SandboxUiRefreshFn
    installCookie?: SandboxUiInstallCookieFn
    onError?: (error: Error) => void
    onRecovered?: () => void
    reload?: () => void
    parentWindow?: FakeBrowserWindow
    webContentsId?: number
  } = {}
): StartSandboxUiRefreshArgs {
  const parentWindow = overrides.parentWindow ?? new FakeBrowserWindow()
  return {
    recipeNs: 'sandbox-recipes',
    recipeName: 'r1',
    webContentsId: overrides.webContentsId ?? 42,
    // Cast through unknown — the consumer only calls a small subset of
    // BrowserWindow's interface and we don't depend on Electron's
    // internals in the test.
    parentWindow: parentWindow as unknown as Parameters<
      typeof startSandboxUiRefresh
    >[0]['parentWindow'],
    refresh:
      overrides.refresh ??
      vi.fn<SandboxUiRefreshFn>(async () => ({ setCookie: 'clerum_sandbox_ui_session=NEW' })),
    installCookie:
      overrides.installCookie ?? vi.fn<SandboxUiInstallCookieFn>(async () => undefined),
    onError: overrides.onError ?? vi.fn(),
    onRecovered: overrides.onRecovered ?? vi.fn(),
    reload: overrides.reload ?? vi.fn(),
    now: wallNow,
  }
}

const mintOk = (): Promise<{ setCookie: string }> =>
  Promise.resolve({ setCookie: 'clerum_sandbox_ui_session=X' })
const mintDown = (): Promise<never> => Promise.reject(new Error('control-api 503'))

describe('startSandboxUiRefresh', () => {
  it('pins the sender and arms the visibility-driven timer', () => {
    const args = makeArgs()
    startSandboxUiRefresh(args)
    expect(_isPinnedForTests(args.webContentsId)).toBe(true)
  })

  it('replaces an earlier active refresh when a new view mounts', () => {
    const a = makeArgs({ webContentsId: 1 })
    const b = makeArgs({ webContentsId: 2 })
    startSandboxUiRefresh(a)
    startSandboxUiRefresh(b)
    expect(_isPinnedForTests(1)).toBe(false)
    expect(_isPinnedForTests(2)).toBe(true)
  })

  it('does NOT arm the timer when the parent window is hidden at mount', async () => {
    const window = new FakeBrowserWindow()
    window.visible = false
    const refresh = vi.fn<SandboxUiRefreshFn>(async () => ({
      setCookie: 'clerum_sandbox_ui_session=X',
    }))
    const args = makeArgs({ parentWindow: window, refresh })
    startSandboxUiRefresh(args)
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1000)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('refresh timer', () => {
  it('fires at SANDBOX_UI_REFRESH_INTERVAL_MS and reschedules itself', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(async () => ({
      setCookie: 'clerum_sandbox_ui_session=X',
    }))
    const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => undefined)
    const args = makeArgs({ refresh, installCookie })
    startSandboxUiRefresh(args)

    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS - 1)
    expect(refresh).not.toHaveBeenCalled()

    await advance(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(installCookie).toHaveBeenCalledWith('clerum_sandbox_ui_session=X')

    // After the first refresh, the next tick is 270 s later.
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('cancels on hide and refreshes at once on a restore after the cookie expired', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    const args = makeArgs({ parentWindow: window, refresh })
    startSandboxUiRefresh(args)

    // Halfway to the next refresh, the user minimizes — timer should be
    // cleared and no refresh should fire even if we wait the full interval.
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS / 2)
    window.minimized = true
    window.emit('minimize')
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS * 2)
    expect(refresh).not.toHaveBeenCalled()

    // The cookie died while minimized: restoring re-mints immediately.
    window.minimized = false
    window.emit('restore')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS - 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await advance(2)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})

describe('cancelSandboxUiRefresh', () => {
  it('unpins the sender, clears the timer, and removes parent listeners', () => {
    const window = new FakeBrowserWindow()
    const args = makeArgs({ parentWindow: window })
    startSandboxUiRefresh(args)

    expect(_isPinnedForTests(args.webContentsId)).toBe(true)
    expect(window.listenerCount('hide')).toBe(1)
    expect(window.listenerCount('show')).toBe(1)

    cancelSandboxUiRefresh()

    expect(_isPinnedForTests(args.webContentsId)).toBe(false)
    expect(window.listenerCount('hide')).toBe(0)
    expect(window.listenerCount('show')).toBe(0)
    expect(window.listenerCount('minimize')).toBe(0)
    expect(window.listenerCount('restore')).toBe(0)
    expect(window.listenerCount('focus')).toBe(0)
  })

  it('stays terminal: no retry, return, embed request or 401 revives a cancelled loop', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const reload = vi.fn()
    const args = makeArgs({ parentWindow: window, refresh, reload })
    startSandboxUiRefresh(args)
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Cancelled mid-backoff, with a retry already scheduled.
    cancelSandboxUiRefresh()
    sleep(SANDBOX_UI_COOKIE_TTL_MS)
    window.emit('show')
    notifySandboxUiHostResumed()
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await expect(handleEmbedRefreshRequest(args.webContentsId)).rejects.toThrow(/unpinned sender/)
    await advance(SANDBOX_UI_COOKIE_TTL_MS * 2)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    expect(_isPinnedForTests(args.webContentsId)).toBe(false)
  })
})

describe('handleEmbedRefreshRequest (Decision 11 — IPC pinning)', () => {
  it('rejects refresh requests from senders not in the pinning map', async () => {
    await expect(handleEmbedRefreshRequest(999)).rejects.toThrow(/unpinned sender/)
  })

  it('rejects refresh requests within the 30 s rate-limit window', async () => {
    const args = makeArgs()
    startSandboxUiRefresh(args)
    // Mint counts as t=0 — an immediate IPC must be rate-limited.
    await expect(handleEmbedRefreshRequest(args.webContentsId)).rejects.toThrow(/rate-limited/)
  })

  it('allows IPC refresh once the rate-limit window has passed', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(async () => ({
      setCookie: 'clerum_sandbox_ui_session=NEW',
    }))
    const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => undefined)
    const args = makeArgs({ refresh, installCookie })
    startSandboxUiRefresh(args)

    // Advance past the rate limit but well before the scheduled timer.
    await advance(SANDBOX_UI_RATE_LIMIT_MS + 100)
    await handleEmbedRefreshRequest(args.webContentsId)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(installCookie).toHaveBeenCalledWith('clerum_sandbox_ui_session=NEW')
  })

  it('counts an accepted request against the rate limit even when its mint fails', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const args = makeArgs({ refresh })
    startSandboxUiRefresh(args)
    await advance(SANDBOX_UI_RATE_LIMIT_MS + 100)

    await handleEmbedRefreshRequest(args.webContentsId)
    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(handleEmbedRefreshRequest(args.webContentsId)).rejects.toThrow(/rate-limited/)
    // The first request's mint failed, yet the second is still rate-limited and mints nothing.
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('session expiry by wall clock', () => {
  it('a show after the cookie expired while the timers were frozen refreshes at once', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh }))

    // Machine asleep for 10 min: the wall clock moves, the timer does not.
    sleep(10 * 60 * 1000)
    window.emit('show')
    await flush()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a host resume after the cookie expired while asleep refreshes at once', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    startSandboxUiRefresh(makeArgs({ refresh }))

    sleep(10 * 60 * 1000)
    notifySandboxUiHostResumed()
    await flush()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a restore before expiry re-arms the timer to the remaining time, not a full interval', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh }))

    await advance(100_000)
    window.minimized = true
    window.emit('minimize')
    await advance(50_000)
    window.minimized = false
    window.emit('restore')
    await flush()
    expect(refresh).not.toHaveBeenCalled()

    const remaining = SANDBOX_UI_REFRESH_INTERVAL_MS - 150_000
    await advance(remaining - 1)
    expect(refresh).not.toHaveBeenCalled()
    await advance(2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a focus after the timer clock lagged behind the wall clock re-arms to the wall-clock remainder', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh }))

    await advance(100_000)
    sleep(100_000)
    window.emit('focus')
    await flush()
    expect(refresh).not.toHaveBeenCalled()

    // 70 s of wall time remain; the timer armed at mount still had 170 s.
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS - 200_000 + 1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('mint failure backoff', () => {
  it('retries a failed mint instead of stopping, keeping the sender pinned', async () => {
    const refresh = vi
      .fn<SandboxUiRefreshFn>()
      .mockImplementationOnce(mintDown)
      .mockImplementationOnce(mintDown)
      .mockImplementation(mintOk)
    const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => undefined)
    const onError = vi.fn()
    const args = makeArgs({ refresh, installCookie, onError })
    startSandboxUiRefresh(args)

    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(_isPinnedForTests(args.webContentsId)).toBe(true)

    await advance(1_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    await advance(2_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(installCookie).toHaveBeenCalledWith('clerum_sandbox_ui_session=X')
    expect(onError).not.toHaveBeenCalled()

    // Back on the regular schedule, counted from the mint that succeeded
    // (requested 1 ms before the clock now reads).
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS - 2)
    expect(refresh).toHaveBeenCalledTimes(3)
    await advance(2)
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('reports once the cookie has been dead for the grace period, and stays pinned', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const onError = vi.fn()
    const args = makeArgs({ refresh, onError })
    startSandboxUiRefresh(args)

    // First failure at 270 s; the cookie expires at 300 s, retries continue
    // to 360 s: attempts at 271, 273, 278, 293, 323, 353 — the next (383)
    // would land past the deadline.
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await advance(100_000)
    expect(refresh).toHaveBeenCalledTimes(7)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0].message).toContain('503')
    expect(_isPinnedForTests(args.webContentsId)).toBe(true)

    await advance(SANDBOX_UI_COOKIE_TTL_MS * 2)
    expect(refresh).toHaveBeenCalledTimes(7)
  })

  it('gives a mint that fails right after waking a full retry window', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const onError = vi.fn()
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh, onError }))

    sleep(60 * 60 * 1000)
    window.emit('show')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    await advance(1_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('an embed request after the retries ran out resumes the loop', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => undefined)
    const onError = vi.fn()
    const args = makeArgs({ refresh, installCookie, onError })
    startSandboxUiRefresh(args)
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await advance(100_000)
    expect(onError).toHaveBeenCalledTimes(1)
    const callsWhenExhausted = refresh.mock.calls.length

    refresh.mockImplementation(mintOk)
    await handleEmbedRefreshRequest(args.webContentsId)
    expect(refresh).toHaveBeenCalledTimes(callsWhenExhausted + 1)
    expect(installCookie).toHaveBeenCalledWith('clerum_sandbox_ui_session=X')
    // The 30 s rate limit still applies to the resumed loop.
    await expect(handleEmbedRefreshRequest(args.webContentsId)).rejects.toThrow(/rate-limited/)

    // And the timer is back.
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(callsWhenExhausted + 2)
  })
})

describe('top-level 401 recovery', () => {
  it('re-mints and reloads exactly once per mint', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => undefined)
    const reload = vi.fn()
    const args = makeArgs({ refresh, installCookie, reload })
    startSandboxUiRefresh(args)

    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(installCookie).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)

    // The reload under the recovery mint 401s again: no loop.
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)

    // A later scheduled mint earns a fresh recovery.
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('reloads only once the recovery mint succeeds, after backoff', async () => {
    const refresh = vi
      .fn<SandboxUiRefreshFn>()
      .mockImplementationOnce(mintDown)
      .mockImplementation(mintOk)
    const reload = vi.fn()
    const args = makeArgs({ refresh, reload })
    startSandboxUiRefresh(args)

    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    // Further 401s while the recovery is pending add no mints.
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)

    await advance(1_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ignores a 401 from a webContents that is not the pinned embed', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    const reload = vi.fn()
    startSandboxUiRefresh(makeArgs({ refresh, reload, webContentsId: 42 }))

    handleSandboxUiUnauthorizedNavigation(7)
    await flush()

    expect(refresh).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('recovery after retries ran out or went stale', () => {
  it('a 401 after its recovery mint exhausted its retries reopens them and reloads on success', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const reload = vi.fn()
    const onError = vi.fn()
    const args = makeArgs({ refresh, reload, onError })
    startSandboxUiRefresh(args)

    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await advance(400_000)
    expect(onError).toHaveBeenCalledTimes(1)
    const callsWhenExhausted = refresh.mock.calls.length

    // rpc-proxy is back; the user reloads and the page 401s again.
    refresh.mockImplementation(mintOk)
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()

    expect(refresh).toHaveBeenCalledTimes(callsWhenExhausted + 1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a 401 once the recovery cookie expired is recovered, even while the timer mint is retrying', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    const reload = vi.fn()
    const args = makeArgs({ refresh, reload })
    startSandboxUiRefresh(args)
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)

    // The timer mint fails and keeps retrying; the recovery cookie dies.
    refresh.mockImplementation(mintDown)
    await advance(SANDBOX_UI_COOKIE_TTL_MS + 5_000)
    // The user navigates: the dead cookie 401s. Its own mint fails too, but
    // the retry that lands must still reload the dead page.
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    refresh.mockImplementation(mintOk)
    await advance(30_000)

    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('a 401 once the recovery cookie expired reopens retries that ran out', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    const reload = vi.fn()
    const onError = vi.fn()
    const args = makeArgs({ refresh, reload, onError })
    startSandboxUiRefresh(args)
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)

    refresh.mockImplementation(mintDown)
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 100_000)
    expect(onError).toHaveBeenCalledTimes(1)
    const callsWhenExhausted = refresh.mock.calls.length

    refresh.mockImplementation(mintOk)
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()

    expect(refresh).toHaveBeenCalledTimes(callsWhenExhausted + 1)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('a restore after sleeping through a failure gets a fresh retry window instead of reporting', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const onError = vi.fn()
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh, onError }))

    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    window.minimized = true
    window.emit('minimize')
    sleep(10 * 60 * 1000)
    window.minimized = false
    window.emit('restore')
    await flush()

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
    await advance(1_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(onError).not.toHaveBeenCalled()
  })

  it('a host resume after the retries ran out re-mints the session', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => undefined)
    const onError = vi.fn()
    startSandboxUiRefresh(makeArgs({ refresh, installCookie, onError }))
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await advance(100_000)
    expect(onError).toHaveBeenCalledTimes(1)
    const callsWhenExhausted = refresh.mock.calls.length

    // The machine sleeps; it wakes with a healthy network.
    sleep(10 * 60 * 1000)
    refresh.mockImplementation(mintOk)
    notifySandboxUiHostResumed()
    await flush()

    expect(refresh).toHaveBeenCalledTimes(callsWhenExhausted + 1)
    expect(installCookie).toHaveBeenCalledWith('clerum_sandbox_ui_session=X')
  })

  it('a focus burst on an exhausted loop resumes it once per rate-limit window', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh }))
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await advance(100_000)
    const callsWhenExhausted = refresh.mock.calls.length

    for (let i = 0; i < 5; i += 1) window.emit('focus')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(callsWhenExhausted + 1)

    // Once that resumed episode runs out too, the next burst (well past the
    // window) resumes once more — and only once.
    await advance(120_000)
    const callsWhenExhaustedAgain = refresh.mock.calls.length
    for (let i = 0; i < 5; i += 1) window.emit('focus')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(callsWhenExhaustedAgain + 1)
  })
})

describe('concurrent triggers share one mint', () => {
  function heldMint(): { refresh: ReturnType<typeof vi.fn<SandboxUiRefreshFn>>; land: () => void } {
    let land: () => void = () => undefined
    const refresh = vi.fn<SandboxUiRefreshFn>(
      () =>
        new Promise(resolve => {
          land = () => resolve({ setCookie: 'clerum_sandbox_ui_session=X' })
        })
    )
    return { refresh, land: () => land() }
  }

  it('an embed request during a timer mint joins it instead of minting again', async () => {
    const { refresh, land } = heldMint()
    const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => undefined)
    const args = makeArgs({ refresh, installCookie })
    startSandboxUiRefresh(args)
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(1)

    const request = handleEmbedRefreshRequest(args.webContentsId)
    land()
    await request

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(installCookie).toHaveBeenCalledTimes(1)
  })

  it('a 401 during a timer mint reloads once that mint lands, without minting again', async () => {
    const { refresh, land } = heldMint()
    const reload = vi.fn()
    const args = makeArgs({ refresh, reload })
    startSandboxUiRefresh(args)
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)

    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(reload).not.toHaveBeenCalled()

    land()
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a 401 during the mint of a restore after the recovery cookie expired reloads once it lands', async () => {
    const window = new FakeBrowserWindow()
    const { refresh, land } = heldMint()
    const reload = vi.fn()
    const args = makeArgs({ parentWindow: window, refresh, reload })
    startSandboxUiRefresh(args)
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    land()
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)

    window.minimized = true
    window.emit('minimize')
    await advance(SANDBOX_UI_COOKIE_TTL_MS + 60_000)
    window.minimized = false
    window.emit('restore')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(2)

    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    land()
    await flush()
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('a 401 under the recovery cookie while a newer mint is in flight reloads once it lands', async () => {
    const { refresh, land } = heldMint()
    const reload = vi.fn()
    const args = makeArgs({ refresh, reload })
    startSandboxUiRefresh(args)
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    land()
    await flush()
    expect(reload).toHaveBeenCalledTimes(1)

    // The timer mint starts while the recovery cookie is still valid.
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(2)

    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    land()
    await flush()
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('a focus burst neither duplicates nor advances the mint', async () => {
    const window = new FakeBrowserWindow()
    const { refresh, land } = heldMint()
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh }))

    await advance(100_000)
    for (let i = 0; i < 10; i += 1) window.emit('focus')
    await flush()
    expect(refresh).not.toHaveBeenCalled()

    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS - 100_000 - 1)
    expect(refresh).not.toHaveBeenCalled()
    await advance(2)
    expect(refresh).toHaveBeenCalledTimes(1)

    // While that mint is in flight, more focus adds nothing.
    for (let i = 0; i < 10; i += 1) window.emit('focus')
    await flush()
    land()
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('recovery signal after retries ran out', () => {
  /** From mount to the point where the loop gives up on a mint that keeps failing. */
  async function runOutOfRetries(): Promise<void> {
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await advance(100_000)
  }

  it('is never signalled for mints that succeed, nor for a failure retried within the grace period', async () => {
    const refresh = vi.fn<SandboxUiRefreshFn>(mintOk)
    const onError = vi.fn()
    const onRecovered = vi.fn()
    startSandboxUiRefresh(makeArgs({ refresh, onError, onRecovered }))

    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(1)

    refresh.mockImplementationOnce(mintDown)
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    await advance(1_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(onError).not.toHaveBeenCalled()
    expect(onRecovered).not.toHaveBeenCalled()
  })

  it('is signalled once, after the cookie is installed, when a return resumes the loop and the mint succeeds', async () => {
    const window = new FakeBrowserWindow()
    const log: string[] = []
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => {
      log.push('installCookie')
    })
    const onError = vi.fn(() => log.push('onError'))
    const onRecovered = vi.fn(() => log.push('onRecovered'))
    startSandboxUiRefresh(
      makeArgs({ parentWindow: window, refresh, installCookie, onError, onRecovered })
    )
    await runOutOfRetries()
    expect(log).toEqual(['onError'])

    refresh.mockImplementation(mintOk)
    window.emit('focus')
    await flush()
    expect(log).toEqual(['onError', 'installCookie', 'onRecovered'])

    // The next timer mint has nothing left to recover from.
    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(log).toEqual(['onError', 'installCookie', 'onRecovered', 'installCookie'])
  })

  it.each([
    ['a parent window focus', (window: FakeBrowserWindow) => window.emit('focus')],
    ['a host resume', () => notifySandboxUiHostResumed()],
    [
      'an embed refresh request',
      (_window: FakeBrowserWindow, webContentsId: number) =>
        void handleEmbedRefreshRequest(webContentsId),
    ],
  ])('is signalled when %s resumes the loop and the mint succeeds', async (_name, resume) => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const onRecovered = vi.fn()
    const args = makeArgs({ parentWindow: window, refresh, onRecovered })
    startSandboxUiRefresh(args)
    await runOutOfRetries()
    const callsWhenExhausted = refresh.mock.calls.length

    refresh.mockImplementation(mintOk)
    resume(window, args.webContentsId)
    await flush()
    expect(refresh).toHaveBeenCalledTimes(callsWhenExhausted + 1)
    expect(onRecovered).toHaveBeenCalledTimes(1)
  })

  it('is signalled once for a streak of failures reported twice', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const onError = vi.fn()
    const onRecovered = vi.fn()
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh, onError, onRecovered }))
    await runOutOfRetries()

    // The resumed episode fails all the way through as well.
    window.emit('focus')
    await advance(120_000)
    expect(onError).toHaveBeenCalledTimes(2)

    refresh.mockImplementation(mintOk)
    window.emit('focus')
    await flush()
    expect(onRecovered).toHaveBeenCalledTimes(1)
  })

  it('is signalled again for a failure reported after an earlier recovery', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const onError = vi.fn()
    const onRecovered = vi.fn()
    startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh, onError, onRecovered }))
    await runOutOfRetries()
    refresh.mockImplementation(mintOk)
    window.emit('focus')
    await flush()
    expect(onRecovered).toHaveBeenCalledTimes(1)

    refresh.mockImplementation(mintDown)
    await runOutOfRetries()
    expect(onError).toHaveBeenCalledTimes(2)

    refresh.mockImplementation(mintOk)
    window.emit('focus')
    await flush()
    expect(onRecovered).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['the mint', 'refresh'],
    ['the cookie install', 'installCookie'],
  ] as const)(
    'is not signalled when the loop is cancelled during %s that would recover',
    async (_name, held) => {
      const window = new FakeBrowserWindow()
      let land: () => void = () => undefined
      const hold = <T>(value: T): Promise<T> =>
        new Promise(resolve => {
          land = () => resolve(value)
        })
      const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
      const installCookie = vi.fn<SandboxUiInstallCookieFn>(async () => undefined)
      const onRecovered = vi.fn()
      startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh, installCookie, onRecovered }))
      await runOutOfRetries()

      if (held === 'refresh') {
        refresh.mockImplementation(() => hold({ setCookie: 'clerum_sandbox_ui_session=X' }))
      } else {
        refresh.mockImplementation(mintOk)
        installCookie.mockImplementation(() => hold(undefined))
      }
      window.emit('focus')
      await flush()
      cancelSandboxUiRefresh()
      land()
      await flush()
      expect(onRecovered).not.toHaveBeenCalled()
    }
  )

  it('a top-level 401 after the retries ran out reloads and then signals the recovery once', async () => {
    const log: string[] = []
    const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
    const reload = vi.fn(() => log.push('reload'))
    const onRecovered = vi.fn(() => log.push('onRecovered'))
    const args = makeArgs({ refresh, reload, onRecovered })
    startSandboxUiRefresh(args)
    await runOutOfRetries()

    refresh.mockImplementation(mintOk)
    handleSandboxUiUnauthorizedNavigation(args.webContentsId)
    await flush()
    expect(log).toEqual(['reload', 'onRecovered'])

    await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(onRecovered).toHaveBeenCalledTimes(1)
  })

  it('a recovery listener that throws leaves the loop armed and rejects nothing', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const window = new FakeBrowserWindow()
      const refresh = vi.fn<SandboxUiRefreshFn>(mintDown)
      const onRecovered = vi.fn(() => {
        throw new Error('renderer gone')
      })
      startSandboxUiRefresh(makeArgs({ parentWindow: window, refresh, onRecovered }))
      await runOutOfRetries()
      refresh.mockImplementation(mintOk)
      window.emit('focus')
      await flush()
      expect(onRecovered).toHaveBeenCalledTimes(1)
      const callsAfterRecovery = refresh.mock.calls.length

      await advance(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
      expect(refresh).toHaveBeenCalledTimes(callsAfterRecovery + 1)
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      consoleError.mockRestore()
    }
  })
})

/**
 * Model-based check of the error/recovery signals against the real loop. Mints
 * and cookie installs are released by a scheduler, so an event can land while
 * either one is in flight. At rest, the renderer's banner (whether the last
 * signal was an error) must match the last mint that either gave up or
 * succeeded; failures that still had retries left say nothing about it.
 */
describe('recovery signal model', () => {
  type MintResult = 'gaveUp' | 'succeeded'

  type Scheduler = {
    schedule<T>(task: Promise<T>, label: string): Promise<T>
    count(): number
    waitOne(): Promise<void>
  }

  type Harness = {
    window: FakeBrowserWindow
    mintMode: 'ok' | 'fail'
    mints: number
    signals: Array<'error' | 'recovered'>
    results: MintResult[]
    cancelledAtSignal: number | null
    cancelled: boolean
  }

  type Model = Record<string, never>

  abstract class Step implements fc.AsyncCommand<Model, Harness> {
    check(): boolean {
      return true
    }
    abstract run(model: Model, harness: Harness): Promise<void>
    abstract toString(): string
  }

  class MintMode extends Step {
    constructor(readonly mode: 'ok' | 'fail') {
      super()
    }
    async run(_m: Model, h: Harness): Promise<void> {
      h.mintMode = this.mode
    }
    toString(): string {
      return `MintMode(${this.mode})`
    }
  }
  class Advance extends Step {
    constructor(readonly ms: number) {
      super()
    }
    async run(): Promise<void> {
      await advance(this.ms)
    }
    toString(): string {
      return `Advance(${this.ms})`
    }
  }
  /** Time passes with the network answering promptly: every mint lands within a second. */
  class Elapse extends Step {
    constructor(
      readonly ms: number,
      private readonly scheduler: () => Scheduler
    ) {
      super()
    }
    async run(): Promise<void> {
      for (let elapsed = 0; elapsed < this.ms; elapsed += 1_000) {
        await advance(1_000)
        await settle(this.scheduler())
      }
    }
    toString(): string {
      return `Elapse(${this.ms})`
    }
  }
  class Focus extends Step {
    async run(_m: Model, h: Harness): Promise<void> {
      h.window.emit('focus')
      await flush()
    }
    toString(): string {
      return 'Focus'
    }
  }
  class HostResumed extends Step {
    async run(): Promise<void> {
      notifySandboxUiHostResumed()
      await flush()
    }
    toString(): string {
      return 'HostResumed'
    }
  }
  class EmbedRequest extends Step {
    async run(): Promise<void> {
      void handleEmbedRefreshRequest(MODEL_SENDER).catch(() => undefined)
      await flush()
    }
    toString(): string {
      return 'EmbedRequest'
    }
  }
  class Unauthorized extends Step {
    async run(): Promise<void> {
      handleSandboxUiUnauthorizedNavigation(MODEL_SENDER)
      await flush()
    }
    toString(): string {
      return 'Unauthorized'
    }
  }
  class Cancel extends Step {
    async run(_m: Model, h: Harness): Promise<void> {
      if (!h.cancelled) h.cancelledAtSignal = h.signals.length
      h.cancelled = true
      cancelSandboxUiRefresh()
    }
    toString(): string {
      return 'Cancel'
    }
  }
  class Release extends Step {
    constructor(private readonly scheduler: () => Scheduler) {
      super()
    }
    async run(): Promise<void> {
      if (this.scheduler().count() === 0) return
      await this.scheduler().waitOne()
      await flush()
    }
    toString(): string {
      return 'Release'
    }
  }

  const MODEL_SENDER = 77

  /** `observeRecovery: false` wires a no-op `onRecovered`, as if nobody listened. */
  function startHarness(scheduler: Scheduler, observeRecovery: boolean): Harness {
    _resetSandboxUiRefreshForTests()
    const harness: Harness = {
      window: new FakeBrowserWindow(),
      // Starts failing: recoveries only exist after the loop gave up once.
      mintMode: 'fail',
      mints: 0,
      signals: [],
      results: [],
      cancelledAtSignal: null,
      cancelled: false,
    }
    let installs = 0
    startSandboxUiRefresh(
      makeArgs({
        parentWindow: harness.window,
        webContentsId: MODEL_SENDER,
        refresh: () => {
          const label = `mint#${harness.mints}`
          harness.mints += 1
          const fails = harness.mintMode === 'fail'
          return scheduler.schedule(Promise.resolve(), label).then(() => {
            if (fails) throw new Error('control-api 503')
            return { setCookie: 'clerum_sandbox_ui_session=X' }
          })
        },
        installCookie: () => {
          const label = `install#${installs}`
          installs += 1
          return scheduler.schedule(Promise.resolve(), label).then(() => {
            // A cancelled loop stops before acting on the install.
            if (!harness.cancelled) harness.results.push('succeeded')
          })
        },
        onError: () => {
          harness.signals.push('error')
          harness.results.push('gaveUp')
        },
        onRecovered: observeRecovery ? () => void harness.signals.push('recovered') : () => {},
      })
    )
    return harness
  }

  async function settle(scheduler: Scheduler): Promise<void> {
    while (scheduler.count() > 0) {
      await scheduler.waitOne()
      await flush()
    }
  }

  /** Releases scheduled tasks in the order a previous run released them. */
  function replayScheduler(order: readonly string[]): Scheduler {
    const pending = new Map<string, () => void>()
    let next = 0
    return {
      schedule: <T>(task: Promise<T>, label: string) =>
        new Promise<T>((resolve, reject) => {
          pending.set(label, () => void task.then(resolve, reject))
        }),
      count: () => pending.size,
      async waitOne() {
        const label = order[next]
        next += 1
        const release = label === undefined ? undefined : pending.get(label)
        if (!release) throw new Error(`replay diverged at release #${next - 1} (${label})`)
        pending.delete(label!)
        release()
      },
    }
  }

  function recordingScheduler(s: fc.Scheduler, order: string[]): Scheduler {
    return {
      schedule: <T>(task: Promise<T>, label: string) =>
        s.schedule(task, label).then(
          value => {
            order.push(label)
            return value
          },
          error => {
            order.push(label)
            throw error
          }
        ),
      count: () => s.count(),
      waitOne: () => s.waitOne(),
    }
  }

  it('keeps the banner in step with the last mint that gave up or succeeded', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    onTestFinished(() => consoleError.mockRestore())
    let current: Scheduler | null = null
    const currentScheduler = (): Scheduler => current!
    const mode = fc.constantFrom('ok', 'fail').map(m => new MintMode(m as 'ok' | 'fail'))
    // Weighted so that runs regularly give up (a failing streak needs several
    // minutes of mints) and then come back, which is where the signals live.
    const step = fc.oneof(
      { weight: 3, arbitrary: mode },
      {
        weight: 2,
        arbitrary: fc
          .constantFrom(1_000, 5_000, 30_000, 100_000, SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
          .map(ms => new Advance(ms)),
      },
      {
        weight: 4,
        arbitrary: fc
          .constantFrom(30_000, 100_000, SANDBOX_UI_REFRESH_INTERVAL_MS + 1_000)
          .map(ms => new Elapse(ms, currentScheduler)),
      },
      { weight: 2, arbitrary: fc.constant(new Focus()) },
      { weight: 1, arbitrary: fc.constant(new HostResumed()) },
      { weight: 1, arbitrary: fc.constant(new EmbedRequest()) },
      { weight: 1, arbitrary: fc.constant(new Unauthorized()) },
      { weight: 1, arbitrary: fc.constant(new Cancel()) },
      { weight: 3, arbitrary: fc.constant(new Release(currentScheduler)) }
    )

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands([step], { maxCommands: 50, size: '+1' }),
        async (s, cmds) => {
          const order: string[] = []
          const executed: Step[] = []
          current = recordingScheduler(s, order)
          const scheduler = current
          const harness = startHarness(scheduler, true)
          await fc.asyncModelRun(
            () => ({ model: {}, real: harness }),
            [...cmds].map(cmd => {
              const step = cmd as Step
              return {
                check: () => true,
                run: async (m: Model, h: Harness) => {
                  executed.push(step)
                  await step.run(m, h)
                },
                toString: () => step.toString(),
              }
            })
          )
          await settle(scheduler)

          const banner = harness.signals.at(-1) === 'error'
          const lastDecisive = harness.results.at(-1)
          // V1 / S1: the banner shows exactly when the last decisive mint gave up.
          expect(banner).toBe(lastDecisive === 'gaveUp')
          // C1 (per loop): never more recoveries than reported failures.
          const errors = harness.signals.filter(signal => signal === 'error').length
          const recoveries = harness.signals.filter(signal => signal === 'recovered').length
          expect(recoveries).toBeLessThanOrEqual(errors)
          // S2: nothing is signalled once the loop was cancelled.
          if (harness.cancelledAtSignal !== null) {
            expect(harness.signals.length).toBe(harness.cancelledAtSignal)
          }

          // C1: the signal itself never changes how many mints the loop makes.
          current = replayScheduler(order)
          const replay = startHarness(current, false)
          for (const step of executed) await step.run({}, replay)
          await settle(current)
          expect(replay.mints).toBe(harness.mints)
        }
      ),
      { numRuns: 300 }
    )
  })
})
