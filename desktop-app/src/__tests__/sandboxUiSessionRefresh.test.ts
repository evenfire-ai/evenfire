import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SANDBOX_UI_RATE_LIMIT_MS,
  SANDBOX_UI_REFRESH_INTERVAL_MS,
  _isPinnedForTests,
  _resetSandboxUiRefreshForTests,
  cancelSandboxUiRefresh,
  handleEmbedRefreshRequest,
  startSandboxUiRefresh,
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

beforeEach(() => {
  vi.useFakeTimers()
  _resetSandboxUiRefreshForTests()
})

afterEach(() => {
  _resetSandboxUiRefreshForTests()
  vi.useRealTimers()
})

function makeArgs(
  overrides: {
    refresh?: ReturnType<typeof vi.fn>
    installCookie?: ReturnType<typeof vi.fn>
    onError?: ReturnType<typeof vi.fn>
    parentWindow?: FakeBrowserWindow
    webContentsId?: number
  } = {}
) {
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
      overrides.refresh ?? vi.fn(async () => ({ setCookie: 'clerum_sandbox_ui_session=NEW' })),
    installCookie: overrides.installCookie ?? vi.fn(async () => undefined),
    onError: overrides.onError ?? vi.fn(),
  }
}

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
    const refresh = vi.fn(async () => ({ setCookie: 'clerum_sandbox_ui_session=X' }))
    const args = makeArgs({ parentWindow: window, refresh })
    startSandboxUiRefresh(args)
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1000)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('refresh timer', () => {
  it('fires at SANDBOX_UI_REFRESH_INTERVAL_MS and reschedules itself', async () => {
    const refresh = vi.fn(async () => ({ setCookie: 'clerum_sandbox_ui_session=X' }))
    const installCookie = vi.fn(async () => undefined)
    const args = makeArgs({ refresh, installCookie })
    startSandboxUiRefresh(args)

    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS - 1)
    expect(refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(installCookie).toHaveBeenCalledWith('clerum_sandbox_ui_session=X')

    // After the first refresh, the next tick is 270 s later.
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('cancels the timer and surfaces the error when refresh throws', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('rpc-proxy 410: recipe deleted')
    })
    const onError = vi.fn()
    const args = makeArgs({ refresh, onError })
    startSandboxUiRefresh(args)

    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0].message).toContain('410')

    // After error: no further refresh fires, even after another full interval.
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS * 2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('cancels on hide and reschedules on show', async () => {
    const window = new FakeBrowserWindow()
    const refresh = vi.fn(async () => ({ setCookie: 'clerum_sandbox_ui_session=X' }))
    const args = makeArgs({ parentWindow: window, refresh })
    startSandboxUiRefresh(args)

    // Halfway to the next refresh, the user minimizes — timer should be
    // cleared and no refresh should fire even if we wait the full interval.
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS / 2)
    window.minimized = true
    window.emit('minimize')
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS * 2)
    expect(refresh).not.toHaveBeenCalled()

    // Restoring re-arms the timer; full interval should produce one refresh.
    window.minimized = false
    window.emit('restore')
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    expect(refresh).toHaveBeenCalledTimes(1)
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
    const refresh = vi.fn(async () => ({ setCookie: 'clerum_sandbox_ui_session=NEW' }))
    const installCookie = vi.fn(async () => undefined)
    const args = makeArgs({ refresh, installCookie })
    startSandboxUiRefresh(args)

    // Advance past the rate limit but well before the scheduled timer.
    await vi.advanceTimersByTimeAsync(SANDBOX_UI_RATE_LIMIT_MS + 100)
    await handleEmbedRefreshRequest(args.webContentsId)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(installCookie).toHaveBeenCalledWith('clerum_sandbox_ui_session=NEW')
  })

  it('rejects IPC refresh after a fatal error has stopped the driver', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('rpc-proxy 403: ACL revoked')
    })
    const args = makeArgs({ refresh })
    startSandboxUiRefresh(args)

    await vi.advanceTimersByTimeAsync(SANDBOX_UI_REFRESH_INTERVAL_MS + 1)
    // Driver is now stopped; the sender is also unpinned.
    await expect(handleEmbedRefreshRequest(args.webContentsId)).rejects.toThrow(/unpinned sender/)
  })
})
