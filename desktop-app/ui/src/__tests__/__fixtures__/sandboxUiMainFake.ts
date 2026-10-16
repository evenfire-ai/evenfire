import { vi } from 'vitest'
import type { SandboxUiReleaseReason, SandboxUiReleasedEvent } from '../../../../src/types'

/**
 * The lifecycle half of main's sandbox-ui contract, reduced to what App's
 * wiring tests need: one live view at a time, `open` resolves once it mounted,
 * `close({ launchId })` only closes that launch's view, and every view that
 * dies reports `released` once, with the route it stood for (the requested one
 * until the test navigates it, none for a crash) before the call that killed it
 * resolves.
 *
 * The ownership properties themselves are checked against the real main process
 * (`src/__tests__/embedOwnership.property.test.ts`); this only has to deliver
 * the events, so App-level suites can run in jsdom.
 */
export type SandboxUiOpenCall = {
  launchId: string
  recipeNs: string
  recipeName: string
  title?: string
  defaultPath?: string
  routePath?: string
}

type HeldOpen = { resolve: () => void; reject: (error: Error) => void }

export function createSandboxUiMainFake() {
  const releasedListeners = new Set<(event: SandboxUiReleasedEvent) => void>()
  const titleListeners = new Set<
    (event: { appRef: string; launchId: string; title: string }) => void
  >()
  const refreshErrorListeners = new Set<
    (event: { appRef: string; launchId: string; message: string }) => void
  >()
  let live: { launchId: string; appRef: string; routePath?: string } | null = null
  const held: HeldOpen[] = []
  let holdNext = 0
  const failures: Error[] = []

  function release(reason: SandboxUiReleaseReason, crashed = false): void {
    if (!live) return
    const view = live
    live = null
    const event: SandboxUiReleasedEvent = {
      launchId: view.launchId,
      reason,
      location: crashed ? null : view.routePath ? { routePath: view.routePath } : {},
    }
    for (const listener of [...releasedListeners]) listener(event)
  }

  const open = vi.fn(async (request: SandboxUiOpenCall) => {
    const appRef = `${request.recipeNs}/${request.recipeName}`
    if (live) release('replaced')
    const failure = failures.shift()
    if (failure) throw failure
    live = {
      launchId: request.launchId,
      appRef,
      ...(request.routePath ? { routePath: request.routePath } : {}),
    }
    if (holdNext > 0) {
      holdNext -= 1
      await new Promise<void>((resolve, reject) => held.push({ resolve, reject }))
    }
  })

  // Main's events reach the renderer in a later task than the call that
  // caused them.
  const close = vi.fn(async (request?: { launchId: string }) => {
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!live || (request && request.launchId !== live.launchId)) return
    release('closed')
  })

  return {
    bridge: {
      open,
      close,
      onReleased: vi.fn((listener: (event: SandboxUiReleasedEvent) => void) => {
        releasedListeners.add(listener)
        return () => releasedListeners.delete(listener)
      }),
      onTitleChanged: vi.fn(
        (listener: (event: { appRef: string; launchId: string; title: string }) => void) => {
          titleListeners.add(listener)
          return () => titleListeners.delete(listener)
        }
      ),
      onRefreshError: vi.fn(
        (listener: (event: { appRef: string; launchId: string; message: string }) => void) => {
          refreshErrorListeners.add(listener)
          return () => refreshErrorListeners.delete(listener)
        }
      ),
    },
    /** The open request of the `index`-th open call. */
    openCall(index: number): SandboxUiOpenCall {
      const call = open.mock.calls[index]
      if (!call) throw new Error(`no open call #${index}`)
      return call[0]
    },
    live: () => live,
    /** The next open stays in flight until the returned handle settles it. */
    holdNextOpen(): () => HeldOpen {
      holdNext += 1
      const index = held.length
      return () => {
        const handle = held[index]
        if (!handle) throw new Error('the held open has not been sent yet')
        return handle
      }
    },
    failNextOpen(error: Error): void {
      failures.push(error)
    },
    /** The user navigated the live view. */
    navigate(routePath: string): void {
      if (live) live = { ...live, routePath }
    },
    crash(): void {
      release('crashed', true)
    },
    endSession(): void {
      release('session')
    },
    retitle(title: string, launchId = live?.launchId): void {
      if (!launchId) return
      for (const listener of [...titleListeners]) {
        listener({ appRef: live?.appRef ?? '', launchId, title })
      }
    },
    refreshFailed(message: string, launchId = live?.launchId): void {
      if (!launchId) return
      for (const listener of [...refreshErrorListeners]) {
        listener({ appRef: live?.appRef ?? '', launchId, message })
      }
    },
  }
}

export type SandboxUiMainFake = ReturnType<typeof createSandboxUiMainFake>
