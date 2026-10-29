import { vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type FakeWebContents,
  electronMocks,
} from '../../../../src/__tests__/__fixtures__/sandboxUiElectronFakes'
import {
  type RealMain,
  mintOk,
  resetRealMain,
  sandboxUiMintFetch,
  startRealMain,
} from '../../../../src/__tests__/__fixtures__/sandboxUiRealMain'
import { getActiveSandboxUi, getActiveSandboxUiLocation } from '../../../../src/sandboxUiDriver'
import {
  SANDBOX_UI_COOKIE_TTL_MS,
  SANDBOX_UI_RATE_LIMIT_MS,
  SANDBOX_UI_REFRESH_INTERVAL_MS,
  SANDBOX_UI_RETRY_GRACE_MS,
} from '../../../../src/sandboxUiSessionRefresh'
import type { SandboxUiReleasedEvent } from '../../../../src/types'

/**
 * The trusted renderer's `window.clerum.sandboxUi` lifecycle bridge, backed by
 * the REAL main process: AppService's lifecycle queue, the sandbox-ui driver,
 * the session refresh loop and the `sandboxUi:open` / `sandboxUi:close` /
 * `sandboxUi:reload` handlers of ipc.ts, on the Electron fakes. Nothing here
 * decides what main reports: every `released`, every open outcome and every
 * location comes from that code. The helpers only act on the world (rpc-proxy's answer to a mint,
 * the embed's renderer crashing, the user navigating the app, time passing).
 *
 * The wire is two FIFO lanes, as IPC is: a call reaches main one macrotask
 * after the renderer sent it, and main's replies and events reach the renderer
 * in the order main produced them, each one macrotask after the previous.
 *
 * A suite that uses it must mock the main-process modules it stands on (see
 * `sandboxUiRealMain.ts`) and await `dispose()` after each test.
 */
export type SandboxUiOpenCall = {
  launchId: string
  recipeNs: string
  recipeName: string
  title?: string
  defaultPath?: string
  routePath?: string
  bounds: { x: number; y: number; width: number; height: number; dpr?: number }
}

type HeldOpen = { resolve: () => void; reject: (error: Error) => void }

type MintDecision = { kind: 'fail'; error: Error } | { kind: 'hold'; handle: HeldMint }

type HeldMint = {
  decided: 'ok' | Error | null
  answer: ((response: Response) => void) | null
  fail: ((error: Error) => void) | null
  recipe: { name: string; ns: string } | null
}

// Captured before any test fakes timers: the wire runs on real macrotasks, so a
// suite that fakes timers for its own clock does not freeze IPC.
const realSetImmediate = globalThis.setImmediate.bind(globalThis)
const macrotask = () => new Promise<void>(resolve => realSetImmediate(resolve))
const realDateNow = Date.now.bind(Date)

export function createSandboxUiMainFake() {
  const releasedListeners = new Set<(event: SandboxUiReleasedEvent) => void>()
  const titleListeners = new Set<
    (event: { appRef: string; launchId: string; title: string }) => void
  >()
  const refreshErrorListeners = new Set<
    (event: { appRef: string; launchId: string; message: string }) => void
  >()
  const refreshRecoveredListeners = new Set<(event: { appRef: string; launchId: string }) => void>()
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'clerum-sandbox-ui-main-'))
  const openMints: MintDecision[] = []
  let failNextMount: Error | null = null
  let crashNextMount = false
  let refreshFailure: Error | null = null
  let toMainLane: Promise<void> = Promise.resolve()
  let toRendererLane: Promise<void> = Promise.resolve()
  // A listener that throws must fail the test, not stall the lane behind it.
  const deliveryErrors: unknown[] = []
  let inFlight = 0
  let held = 0
  let clockOffsetMs = 0
  // The refresh loop reads its clock at mount; shifting it is how the fake
  // lets time pass for main without faking the suite's timers.
  vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + clockOffsetMs)

  function toRenderer(deliver: () => void): void {
    inFlight += 1
    toRendererLane = toRendererLane
      .then(macrotask)
      .then(deliver)
      .catch(error => {
        deliveryErrors.push(error)
      })
      .finally(() => {
        inFlight -= 1
      })
  }

  const sent: Array<{ channel: string; payload: unknown }> = []
  function reported(channel: string): unknown[] {
    return sent.filter(message => message.channel === channel).map(message => message.payload)
  }

  function fromMain(channel: string, payload: unknown): void {
    sent.push({ channel, payload })
    toRenderer(() => {
      switch (channel) {
        case 'sandboxUi:released':
          for (const listener of [...releasedListeners]) {
            listener(payload as SandboxUiReleasedEvent)
          }
          return
        case 'sandboxUi:titleChanged':
          for (const listener of [...titleListeners]) {
            listener(payload as { appRef: string; launchId: string; title: string })
          }
          return
        case 'sandboxUi:refreshError':
          for (const listener of [...refreshErrorListeners]) {
            listener(payload as { appRef: string; launchId: string; message: string })
          }
          return
        case 'sandboxUi:refreshRecovered':
          for (const listener of [...refreshRecoveredListeners]) {
            listener(payload as { appRef: string; launchId: string })
          }
      }
    })
  }

  function mint(recipeName: string, recipeNs: string): Response | Promise<Response> {
    if (refreshFailure) return Promise.reject(refreshFailure)
    const decision = openMints.shift()
    if (!decision) return mintOk(recipeName, recipeNs)
    if (decision.kind === 'fail') return Promise.reject(decision.error)
    const handle = decision.handle
    handle.recipe = { name: recipeName, ns: recipeNs }
    if (handle.decided === 'ok') return mintOk(recipeName, recipeNs)
    if (handle.decided) return Promise.reject(handle.decided)
    held += 1
    return new Promise<Response>((resolve, reject) => {
      handle.answer = response => {
        held -= 1
        resolve(response)
      }
      handle.fail = error => {
        held -= 1
        reject(error)
      }
    })
  }

  // The document a view asked for commits and loads a task later, as a real
  // page does; until then the view stands for the route it was asked to show.
  function onLoad(webContents: FakeWebContents): void {
    // A reload commits the document the view is showing again, a task later.
    webContents.reloadIgnoringCache.mockImplementation(() => {
      inFlight += 1
      void macrotask()
        .then(() => {
          if (webContents.destroyed || main.dead || !webContents.currentUrl) return
          webContents.emit('did-navigate', {}, webContents.currentUrl, 200, '')
          webContents.emit('did-finish-load')
        })
        .finally(() => {
          inFlight -= 1
        })
    })
    if (crashNextMount) {
      crashNextMount = false
      webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
      return
    }
    inFlight += 1
    void macrotask()
      .then(() => {
        if (webContents.destroyed || main.dead) return
        webContents.commitLoad()
      })
      .finally(() => {
        inFlight -= 1
      })
  }

  const main: RealMain = startRealMain({ userDataDir, mint, onSend: fromMain, onLoad })
  vi.stubGlobal('fetch', sandboxUiMintFetch)
  const attach = main.parent.contentView.addChildView.getMockImplementation() as (
    view: unknown
  ) => void
  main.parent.contentView.addChildView.mockImplementation((view: unknown) => {
    if (failNextMount) {
      const error = failNextMount
      failNextMount = null
      throw error
    }
    attach(view)
  })

  function send(channel: string, payload: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      inFlight += 1
      toMainLane = toMainLane.then(macrotask).then(() => {
        const result = main.invoke(channel, payload)
        result.then(
          value => toRenderer(() => resolve(value)),
          error => toRenderer(() => reject(error))
        )
        void result
          .catch(() => {})
          .finally(() => {
            inFlight -= 1
          })
      })
    })
  }

  const open = vi.fn((request: SandboxUiOpenCall) => send('sandboxUi:open', request))
  const close = vi.fn((request: { launchId: string }) => send('sandboxUi:close', request))
  const reload = vi.fn((request: { launchId: string }) => send('sandboxUi:reload', request))

  function liveView() {
    const active = getActiveSandboxUi()
    if (!active) return null
    const view = electronMocks.views.find(
      candidate => candidate.webContents.id === active.webContentsId
    )
    return view && !view.webContents.destroyed ? { active, view } : null
  }

  return {
    bridge: {
      open,
      close,
      reload,
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
      onRefreshRecovered: vi.fn(
        (listener: (event: { appRef: string; launchId: string }) => void) => {
          refreshRecoveredListeners.add(listener)
          return () => refreshRecoveredListeners.delete(listener)
        }
      ),
    },
    /** The open request of the `index`-th open call. */
    openCall(index: number): SandboxUiOpenCall {
      const call = open.mock.calls[index]
      if (!call) throw new Error(`no open call #${index}`)
      return call[0]
    },
    /** How many times main reloaded the document of the view it has mounted right now. */
    liveReloads(): number {
      return liveView()?.view.webContents.reloadIgnoringCache.mock.calls.length ?? 0
    },
    /** The view main has mounted right now, and the route it stands for. */
    live(): { launchId: string; appRef: string; routePath?: string } | null {
      const active = getActiveSandboxUi()
      if (!active) return null
      const routePath = getActiveSandboxUiLocation()?.path
      return {
        launchId: active.launchId,
        appRef: active.appRef,
        ...(routePath ? { routePath } : {}),
      }
    },
    /**
     * rpc-proxy holds the session mint of the next open that reaches main until
     * the returned handle settles it: resolved, the open mounts; rejected, the
     * mint fails with that error.
     */
    holdNextOpen(): () => HeldOpen {
      const handle: HeldMint = { decided: null, answer: null, fail: null, recipe: null }
      openMints.push({ kind: 'hold', handle })
      const settle: HeldOpen = {
        resolve: () => {
          if (handle.answer && handle.recipe) {
            handle.answer(mintOk(handle.recipe.name, handle.recipe.ns))
          } else handle.decided = 'ok'
        },
        reject: error => {
          if (handle.fail) handle.fail(error)
          else handle.decided = error
        },
      }
      return () => settle
    },
    /** The session mint of the next open that reaches main fails with `error`. */
    failNextOpen(error: Error): void {
      openMints.push({ kind: 'fail', error })
    },
    /**
     * The next open mints its session and mounts its view, then attaching the
     * view to the window throws `error`.
     */
    failNextOpenAfterMount(error: Error): void {
      failNextMount = error
    },
    /**
     * The next view's renderer dies as its document starts loading, inside the
     * mount: main reports the release before the open settles, as the
     * ownership property suite drives it.
     */
    crashNextMount(): void {
      crashNextMount = true
    },
    /** The user navigates the live app to `routePath` inside its document. */
    navigate(routePath: string): void {
      const live = liveView()
      if (!live) throw new Error('no live view to navigate')
      const { active, view } = live
      if (!view.webContents.currentUrl) {
        throw new Error('the live view has not loaded its document yet: settle() first')
      }
      const base = new URL(view.webContents.currentUrl)
      const prefix = `/api/v1/sandbox-ui/${active.appRef}/view`
      view.webContents.navigateInPage(`${base.origin}${prefix}${routePath}`)
    },
    /**
     * The live view's renderer process dies. Resolves once what main reported
     * about it so far has reached the renderer.
     */
    crash(): Promise<void> {
      const live = liveView()
      if (!live) throw new Error('no live view to crash')
      live.view.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
      return toRendererLane
    },
    /** The user signs out or signs in over the live session. */
    endSession(): void {
      main.invalidateSession()
    },
    /**
     * The live app changes its document title. Resolves once main's report of
     * it has reached the renderer.
     */
    retitle(title: string): Promise<void> {
      const live = liveView()
      if (!live) throw new Error('no live view to retitle')
      live.view.webContents.emit('page-title-updated', {}, title)
      return toRendererLane
    },
    /**
     * Time passes until the live view's session is due for refresh, and
     * rpc-proxy refuses every refresh with `error` until main gives up on it
     * and reports it. A failing mint settles in microtasks, so all of it
     * happens before anything already on the wire reaches main: a close the
     * renderer just sent still finds this view live.
     */
    async refreshFailed(error: Error): Promise<void> {
      const live = liveView()
      if (!live) throw new Error('no live view whose session could fail to refresh')
      const reportsBefore = reported('sandboxUi:refreshError').length
      refreshFailure = error
      try {
        // First when the refresh is due, then at the end of the retry window
        // the failure opened (the cookie's expiry plus the grace period): that
        // retry is the last one the loop makes.
        const lastRetryAt = SANDBOX_UI_COOKIE_TTL_MS + SANDBOX_UI_RETRY_GRACE_MS
        for (const step of [
          SANDBOX_UI_REFRESH_INTERVAL_MS,
          lastRetryAt - SANDBOX_UI_REFRESH_INTERVAL_MS,
        ]) {
          clockOffsetMs += step
          main.parent.emit('focus')
          for (let i = 0; i < 100; i++) await Promise.resolve()
        }
      } finally {
        refreshFailure = null
      }
      if (reported('sandboxUi:refreshError').length === reportsBefore) {
        throw new Error('main did not report the refresh failure')
      }
      return toRendererLane
    },
    /**
     * The user comes back to the window after `awayMs` and rpc-proxy accepts
     * the session mint that brings: main must be due to refresh by then, either
     * because it gave up earlier or because the session is about to expire.
     * Resolves once what main reported about it has reached the renderer.
     */
    async hostReturned(awayMs: number = SANDBOX_UI_RATE_LIMIT_MS): Promise<void> {
      if (!liveView()) throw new Error('no live view to return to')
      const mintsBefore = sandboxUiMintFetch.mock.calls.length
      // Return events reopen exhausted retries at most once per rate-limit window.
      clockOffsetMs += awayMs
      main.parent.emit('focus')
      for (let i = 0; i < 100; i++) await Promise.resolve()
      if (sandboxUiMintFetch.mock.calls.length === mintsBefore) {
        throw new Error('returning to the window did not make main mint a session')
      }
      return toRendererLane
    },
    /** What main has sent the renderer so far on `channel`, oldest first. */
    reported,
    /**
     * Waits until main and both lanes are idle: nothing in flight but the opens
     * whose mint is held.
     */
    async settle(): Promise<void> {
      for (let round = 0; round < 200; round++) {
        await macrotask()
        if (deliveryErrors.length > 0) throw deliveryErrors[0]
        if (inFlight === held) {
          await macrotask()
          if (inFlight === held) return
        }
      }
      throw new Error('main never went idle')
    },
    async dispose(): Promise<void> {
      await resetRealMain()
      rmSync(userDataDir, { recursive: true, force: true })
    },
  }
}

export type SandboxUiMainFake = ReturnType<typeof createSandboxUiMainFake>
