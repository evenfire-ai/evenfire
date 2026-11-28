// @vitest-environment jsdom
/**
 * `useAuthController` and the browser sign-in:
 * - each of the six binding-changing calls goes through the login model's one helper (D15;
 *   A3-56, A3-64, A3-65; G2-15c, G2-15d);
 * - the auth gates treat a redeeming browser sign-in as an action in progress, and a waiting one
 *   as nothing (D14; A3-15, A3-19, A3-55, A3-68; G2-14a, G2-14b, G2-14e; decision 9), and two
 *   quick activations of the page's start send one start (Review Focus 5).
 *
 * Main is the browser sign-in harness's real `AppService` (state model §7.3): its runtime-config
 * answers, generations, refusals, login models and browser sign-in snapshots reach the controller
 * as Electron carries them, every rejection wrapped (M5) and every push sent to the listener the
 * controller subscribed. Every methods answer is the edge's recorded one (T1).
 *
 * The D15 tests use only interfaces the controller had before D15: its handlers, its setters and
 * `window.clerum.auth`; the shown model is read from the controller's result. The D14 tests render
 * `AuthPage` inside an `AuthContext.Provider` fed by the real controller, and read the dock, the
 * provider button and the password form from the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { AuthPage } from '@pages/AuthPage'
import {
  buildDesktopLoginCodeLink,
  buildLoginMethodsModel,
  parseDesktopLoginPageUrl,
} from '../../../../../src/browserSignInModel'
import type {
  BrowserSignInSnapshot,
  DesktopRuntimeConfig,
  LoginMethodsAnswer,
} from '../../../../../src/types'
import {
  type BrowserSignInHarness,
  cleanupBrowserSignInHarness,
  createBrowserSignInHarness,
} from '../../../../../testSupport/browserSignInHarness'
import {
  LOGIN_SCREEN_ROWS,
  deriveEdgeRecord,
  edgeResponse,
  readEdgeRecord,
} from '../../../../../testSupport/edgeContractRecords'
import { useAuthController } from '../useAuthController'
import { wrapLikeElectronIpc } from './__fixtures__/ipcErrors'

const BOTH_METHODS = 'GET /api/v1/auth/methods password-and-oidc'
const PASSWORD_METHOD = 'GET /api/v1/auth/methods password'
const LOADING = { kind: 'loading' }

function modelOf(label: string) {
  const row = LOGIN_SCREEN_ROWS.find(([rowLabel]) => rowLabel === label)
  if (!row) throw new Error(`LOGIN_SCREEN_ROWS has no row "${label}"`)
  return buildLoginMethodsModel(row[1], { linksAvailable: true })
}

/** Environment A's form: the model the screen must never show once A is left. */
const PASSWORD_FORM = modelOf('password')
const OIDC_ONLY = modelOf('oidc-only')

/** `password-and-oidc` without `'password'` (the PR4 shape), as `LOGIN_SCREEN_ROWS` derives it. */
function oidcOnlyRecord() {
  return deriveEdgeRecord(BOTH_METHODS, 'oidc-only', recorded => {
    const body = recorded as { methods: unknown[] }
    return { ...body, methods: body.methods.filter(method => method !== 'password') }
  })
}

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

type Controller = ReturnType<typeof useAuthController>

type DesktopEnvironmentLink = { externalRestApiBaseUrl: string; appName?: string }
type DesktopEnvironmentListener = (payload: DesktopEnvironmentLink) => void | Promise<void>
type BrowserSignInListener = (snapshot: BrowserSignInSnapshot) => void

/** A call of one preload function that a gate holds before main: `skip` calls pass first. */
type Gate = Deferred & { skip: number }

/**
 * `window.clerum.auth` over the harness's service, as `preload.ts` and `ipc.ts` carry it: a
 * rejection reaches the renderer wrapped, and `push` hands main's snapshot to the listener the
 * renderer subscribed, as `auth:browserSignInResult` does. `gate(name, skip)` lets `skip` calls of
 * `name` through, then keeps the next one from reaching main until it is opened, so that call is
 * in flight.
 */
function installBridge(harness: BrowserSignInHarness) {
  const { service } = harness
  const gates = new Map<string, Gate>()
  const entered = new Set<string>()
  const loginAnswers: LoginMethodsAnswer[] = []
  const browserSignInListeners = new Set<BrowserSignInListener>()
  let desktopEnvironmentListener: DesktopEnvironmentListener | null = null

  function ipc<Args extends unknown[], Result>(
    name: string,
    call: (...args: Args) => Result | Promise<Result>
  ) {
    return vi.fn(async (...args: Args): Promise<Result> => {
      entered.add(name)
      const gate = gates.get(name)
      if (gate && gate.skip > 0) gate.skip -= 1
      else if (gate) {
        gates.delete(name)
        await gate.promise
      }
      try {
        return await call(...args)
      } catch (error) {
        throw wrapLikeElectronIpc(
          `auth:${name}`,
          error instanceof Error ? error : new Error(String(error))
        )
      }
    })
  }

  const auth = {
    getRuntimeConfigState: ipc('getRuntimeConfigState', () => service.getRuntimeConfigState()),
    getSessionGeneration: ipc('getSessionGeneration', () => service.getSessionGeneration()),
    completeDesktopSetup: ipc('completeDesktopSetup', (email: string, token: string) =>
      service.completeDesktopSetup(email, token)
    ),
    saveRuntimeConfig: ipc(
      'saveRuntimeConfig',
      (config: DesktopRuntimeConfig, expectedSessionGeneration?: number) =>
        expectedSessionGeneration === undefined
          ? service.saveRuntimeConfig(config)
          : service.saveRuntimeConfig(config, expectedSessionGeneration)
    ),
    deleteRuntimeConfig: ipc('deleteRuntimeConfig', (optionId: string) =>
      service.deleteRuntimeConfig(optionId)
    ),
    selectRuntimeConfig: ipc('selectRuntimeConfig', (optionId: string) =>
      service.selectRuntimeConfig(optionId)
    ),
    selectRuntimeConfigForHandoff: ipc(
      'selectRuntimeConfigForHandoff',
      (optionId: string, expectedSessionGeneration: number) =>
        service.selectRuntimeConfigForHandoff(optionId, expectedSessionGeneration)
    ),
    clearRuntimeConfigSelection: ipc('clearRuntimeConfigSelection', () =>
      service.clearRuntimeConfigSelection()
    ),
    passwordLogin: ipc('passwordLogin', (email: string, password: string) =>
      service.passwordLogin(email, password)
    ),
    getLoginMethods: ipc('getLoginMethods', async () => {
      const answer = await service.getLoginMethods()
      loginAnswers.push(answer)
      return answer
    }),
    getBrowserSignInState: ipc('getBrowserSignInState', () => service.getBrowserSignInState()),
    startBrowserSignIn: ipc('startBrowserSignIn', () => service.startBrowserSignIn()),
    cancelBrowserSignIn: ipc('cancelBrowserSignIn', () => service.cancelBrowserSignIn()),
    acknowledgeBrowserSignInResult: ipc('acknowledgeBrowserSignInResult', (attemptId: number) =>
      service.acknowledgeBrowserSignInResult(attemptId)
    ),
    onBrowserSignInChanged: vi.fn((listener: BrowserSignInListener) => {
      browserSignInListeners.add(listener)
      return () => {
        browserSignInListeners.delete(listener)
      }
    }),
    onDesktopSetupToken: vi.fn(() => () => undefined),
    onDesktopEnvironmentSetup: vi.fn((listener: DesktopEnvironmentListener) => {
      desktopEnvironmentListener = listener
      return () => {
        if (desktopEnvironmentListener === listener) desktopEnvironmentListener = null
      }
    }),
    onExternalLogout: vi.fn(() => () => undefined),
    onSessionCleared: vi.fn(() => () => undefined),
  }
  window.clerum = { ...window.clerum, auth: { ...window.clerum?.auth, ...auth } } as never

  return {
    auth,
    loginAnswers,
    /**
     * Lets `skip` calls of `name` through, then holds the next one before main; the returned
     * function lets it go on.
     */
    gate(name: string, skip = 0) {
      const gate = { ...deferred(), skip }
      gates.set(name, gate)
      return gate.resolve
    },
    entered: (name: string) => entered.has(name),
    /** Sends main's snapshot to the renderer's listeners, as the push event does. */
    push(snapshot: BrowserSignInSnapshot) {
      for (const listener of [...browserSignInListeners]) listener(snapshot)
    },
    /** A desktop-environment link reaching the renderer (`auth:desktopEnvironmentSetup`). */
    openDesktopEnvironmentLink(payload: DesktopEnvironmentLink): Promise<void> {
      if (!desktopEnvironmentListener) throw new Error('the renderer subscribed no link listener')
      return Promise.resolve(desktopEnvironmentListener(payload))
    },
  }
}

type Bridge = ReturnType<typeof installBridge>

/** Main for one test: A active and signed out, the methods route answering per environment. */
async function createMain() {
  const harness = await createBrowserSignInHarness({ linksAvailable: true })
  const restA = new URL(harness.envs.A.restBaseUrl).origin
  harness.routes['GET /api/v1/auth/methods'] = request =>
    edgeResponse(
      new URL(request.url).origin === restA ? readEdgeRecord(PASSWORD_METHOD) : oidcOnlyRecord()
    )
  return { harness, bridge: installBridge(harness) }
}

async function mountController(bridge: Bridge) {
  const setStatus = vi.fn()
  let setBooting: ((next: boolean) => void) | null = null
  // A signed-out load ends booting, as the app's session load does.
  const onSessionNeedsLoad = vi.fn(async () => {
    setBooting?.(false)
  })
  const shown: unknown[] = []
  const hook = renderHook(() => {
    const controller = useAuthController({
      setStatus,
      onSessionNeedsLoad,
      onSessionEnded: vi.fn(),
      logoutForEnvironmentMismatch: vi.fn(async () => null),
    })
    setBooting = controller.setBooting
    shown.push(controller.loginScreen)
    return controller
  })
  await waitFor(() => expect(onSessionNeedsLoad).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(bridge.auth.getRuntimeConfigState).toHaveBeenCalledTimes(1))
  return { hook, setStatus, shown }
}

/** Lets settled IPC replies reach the controller. */
async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

type BindingCallRow = Readonly<{
  /** The preload function the call reaches main through. */
  call: string
  /** An earlier binding change through another call: its re-read is A's read in flight. */
  prior: (controller: Controller, harness: BrowserSignInHarness) => Promise<unknown>
  /** Sets the screen's fields the call reads, if any; they commit before `start`. */
  fill?: (controller: Controller, harness: BrowserSignInHarness) => void
  /** Starts the call the way its screen does. */
  start: (controller: Controller, harness: BrowserSignInHarness) => Promise<unknown>
  /** What the re-read after the call shows: the new binding's model, or onboarding's loading. */
  after: typeof OIDC_ONLY | typeof LOADING
}>

const selectA = (controller: Controller, harness: BrowserSignInHarness) =>
  controller.handleSelectRuntimeConfig(harness.envs.A.optionId)

/** A3-56's six calls (`useAuthController.ts`), the add-form save among them (A3-64). */
const SIX_BINDING_CALLS: readonly BindingCallRow[] = [
  {
    call: 'completeDesktopSetup',
    prior: selectA,
    fill: controller => {
      controller.setEmail('user-b@example.test')
      controller.setDesktopSetupAuthorizationToken('fake-setup-authorization-token')
    },
    start: controller => controller.handleCompleteDesktopSetup(),
    after: OIDC_ONLY,
  },
  {
    call: 'saveRuntimeConfig',
    prior: selectA,
    // The add-environment form (`AuthPage`'s `handleRuntimeSetupSubmit`).
    fill: controller => {
      controller.setRuntimeConfigSetupName('Environment D')
      controller.setRuntimeConfigSetupExternalRestApiBaseUrl('https://api-d.example.test')
      controller.setRuntimeConfigSetupRpcProxyBaseUrl('https://rpc-d.example.test')
    },
    start: controller => controller.handleSaveRuntimeConfig(),
    after: OIDC_ONLY,
  },
  {
    call: 'deleteRuntimeConfig',
    prior: selectA,
    // Deleting the active environment falls back to another saved one.
    start: (controller, harness) => controller.handleDeleteRuntimeConfig(harness.envs.A.optionId),
    after: OIDC_ONLY,
  },
  {
    call: 'selectRuntimeConfig',
    // Not a select: a mutant of the call under test must not also remove A's read.
    prior: (controller, harness) => controller.handleDeleteRuntimeConfig(harness.envs.C.optionId),
    start: (controller, harness) => controller.handleSelectRuntimeConfig(harness.envs.B.optionId),
    after: OIDC_ONLY,
  },
  {
    call: 'selectRuntimeConfigForHandoff',
    prior: selectA,
    // A profile link for the saved environment B, confirmed on the link's dialog.
    fill: (controller, harness) => {
      controller.setPendingDesktopEnvironmentSetup({
        appName: 'Environment B',
        externalRestApiBaseUrl: harness.envs.B.restBaseUrl,
        rpcProxyBaseUrl: '',
      })
    },
    start: controller => controller.handleConfirmDesktopEnvironmentSetup(),
    after: OIDC_ONLY,
  },
  {
    call: 'clearRuntimeConfigSelection',
    prior: selectA,
    start: controller => controller.handleClearRuntimeConfigSelection(),
    // No environment is left: main refuses the re-read and onboarding shows (E12, N1).
    after: LOADING,
  },
]

afterEach(async () => {
  cleanup()
  await cleanupBrowserSignInHarness()
})

describe('useAuthController: binding changes and the login model', () => {
  it.each(SIX_BINDING_CALLS.map(row => [row.call, row] as const))(
    "G2-15c drops env A's late answer across %s",
    async (_call, row) => {
      const { harness, bridge } = await createMain()
      const { hook, shown } = await mountController(bridge)

      // A's read: the re-read after an earlier binding change, held at the edge.
      const readA = harness.hold('methods')
      await act(async () => {
        await row.prior(hook.result.current, harness)
      })
      await waitFor(() =>
        expect(
          bridge.auth.getLoginMethods,
          'a binding change re-reads the model'
        ).toHaveBeenCalledTimes(1)
      )
      await waitFor(() => expect(readA.reached).toBe(true))

      // The call under test starts, and stays in flight before main.
      const openCall = bridge.gate(row.call)
      if (row.fill) act(() => row.fill?.(hook.result.current, harness))
      let started: Promise<unknown> = Promise.resolve()
      act(() => {
        started = row.start(hook.result.current, harness)
      })
      await waitFor(() => expect(bridge.entered(row.call)).toBe(true))

      // A's password-only answer lands.
      readA.release(edgeResponse(readEdgeRecord(PASSWORD_METHOD)))
      await waitFor(() => expect(bridge.loginAnswers).toHaveLength(1))
      expect(bridge.loginAnswers[0]?.model).toEqual(PASSWORD_FORM)
      await flush()
      expect(hook.result.current.loginScreen, "A's late answer is dropped").toEqual(LOADING)

      // The call reaches main and settles; the model is read again for the binding it left.
      openCall()
      await act(async () => {
        await started
      })
      await waitFor(() => expect(bridge.auth.getLoginMethods).toHaveBeenCalledTimes(2))
      await flush()
      await waitFor(() => expect(hook.result.current.loginScreen).toEqual(row.after))
      expect(shown, "A's form never shows").not.toContainEqual(PASSWORD_FORM)
    }
  )

  // G-8 (Task 14a review M5): the screen after setup may offer only browser sign-in, so the
  // status names no password.
  it('reports a completed desktop setup without naming a password (G-8)', async () => {
    const { bridge } = await createMain()
    const { hook, setStatus } = await mountController(bridge)
    act(() => {
      hook.result.current.setEmail('user-b@example.test')
      hook.result.current.setDesktopSetupAuthorizationToken('fake-setup-authorization-token')
    })

    await act(async () => {
      await hook.result.current.handleCompleteDesktopSetup()
    })

    expect(bridge.auth.completeDesktopSetup, 'setup reached main').toHaveBeenCalledTimes(1)
    expect(setStatus, 'the setup status names no sign-in method').toHaveBeenCalledWith(
      'Desktop setup complete. Sign in to continue.',
      'success'
    )
  })

  it('G2-15d re-reads after a failed save and never stays loading', async () => {
    const { harness, bridge } = await createMain()
    const { hook, setStatus } = await mountController(bridge)

    // A's form is on screen, read after selecting A.
    await act(async () => {
      await selectA(hook.result.current, harness)
    })
    await waitFor(() =>
      expect(
        bridge.auth.getLoginMethods,
        'a binding change re-reads the model'
      ).toHaveBeenCalledTimes(1)
    )
    await waitFor(() => expect(hook.result.current.loginScreen).toEqual(PASSWORD_FORM))
    const stateReads = bridge.auth.getRuntimeConfigState.mock.calls.length
    const logged = harness.bumpLog.length

    // The add form takes `ftp://` (`type="url"`); main bumps, then refuses it (A3-65).
    act(() => {
      hook.result.current.setRuntimeConfigSetupName('Environment FTP')
      hook.result.current.setRuntimeConfigSetupExternalRestApiBaseUrl('ftp://api.example.test')
      hook.result.current.setRuntimeConfigSetupRpcProxyBaseUrl('')
    })
    let saved: unknown = 'not settled'
    await act(async () => {
      saved = await hook.result.current.handleSaveRuntimeConfig()
    })

    expect(saved).toBeNull()
    expect(harness.bumpLog.length, 'main bumped before refusing').toBe(logged + 1)
    expect(setStatus).toHaveBeenCalledWith(
      "Environment setup failed: Error invoking remote method 'auth:saveRuntimeConfig': Error: externalRestApiBaseUrl must be a valid http(s) URL",
      'error'
    )
    await waitFor(() =>
      expect(bridge.auth.getLoginMethods, 'a fresh read runs').toHaveBeenCalledTimes(2)
    )
    expect(
      bridge.auth.getRuntimeConfigState.mock.calls.length,
      'the runtime config state was refreshed'
    ).toBe(stateReads + 1)
    await flush()
    await waitFor(() =>
      expect(hook.result.current.loginScreen, 'never stays loading').toEqual(PASSWORD_FORM)
    )
    expect(bridge.loginAnswers.at(-1)?.generation).toBe(harness.service.getSessionGeneration())
  })
})

// --- D14: the auth gates and a browser sign-in ---

/** The status every auth gate shows when another action is in progress. */
const FINISH_CURRENT_ACTION =
  'Finish the current authentication action, then reopen this desktop link.'

/**
 * Main for the D14 tests. Every environment answers the edge's recorded `password-and-oidc`
 * (the harness's route), so start opens the browser. Each snapshot main pushes reaches the
 * renderer's listener, unless `relay.muted` is set: a muted push is still in `harness.pushes`, and
 * is lost, as with no live page.
 */
async function createSignInMain() {
  const relay = {
    muted: false,
    deliver: (_snapshot: BrowserSignInSnapshot): void => undefined,
  }
  const harness = await createBrowserSignInHarness({
    linksAvailable: true,
    onBrowserSignInChanged: snapshot => {
      if (!relay.muted) relay.deliver(snapshot)
    },
  })
  const bridge = installBridge(harness)
  relay.deliver = snapshot => bridge.push(snapshot)
  return { harness, bridge, relay }
}

/** Environment B, saved in main, as a desktop-environment link names it. */
function environmentB(harness: BrowserSignInHarness): DesktopRuntimeConfig {
  return {
    appName: 'Environment B',
    externalRestApiBaseUrl: harness.envs.B.restBaseUrl,
    rpcProxyBaseUrl: '',
  }
}

type PageMount = Awaited<ReturnType<typeof mountAuthPage>>

/**
 * The existing `AuthPage` inside an `AuthContext.Provider` fed by the real controller, as `App`
 * feeds it. `probe.renders` records what each render showed, so a test can tell whether React
 * has committed. With `boot: false` the session load leaves `booting` set.
 */
async function mountAuthPage(bridge: Bridge, { boot = true }: { boot?: boolean } = {}) {
  const setStatus = vi.fn()
  const handleLogout = vi.fn(async () => undefined)
  const onSessionEnded = vi.fn()
  const logoutForEnvironmentMismatch = vi.fn(async () => null)
  const probe: {
    current: Controller | null
    renders: Array<Readonly<{ authTransitioning: boolean; busy: boolean }>>
  } = { current: null, renders: [] }
  // A signed-out load ends booting, as the app's session load does.
  const onSessionNeedsLoad = vi.fn(async () => {
    if (boot) probe.current?.setBooting(false)
  })

  function Page() {
    const controller = useAuthController({
      setStatus,
      onSessionNeedsLoad,
      onSessionEnded,
      logoutForEnvironmentMismatch,
    })
    probe.current = controller
    probe.renders.push({ authTransitioning: controller.authTransitioning, busy: controller.busy })
    const value: AuthContextValue = {
      ...controller,
      setStatus,
      loadSession: onSessionNeedsLoad,
      handleLogout,
    }
    return (
      <AuthContext.Provider value={value}>
        <AuthPage />
      </AuthContext.Provider>
    )
  }

  render(<Page />)
  await waitFor(() => expect(onSessionNeedsLoad).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(bridge.auth.getRuntimeConfigState).toHaveBeenCalledTimes(1))
  if (boot) await waitFor(() => expect(probe.current?.booting).toBe(false))
  await flush()
  const controller = () => {
    if (!probe.current) throw new Error('the page has not rendered')
    return probe.current
  }
  return { probe, controller, setStatus, onSessionNeedsLoad }
}

/** The environment menu's controls by accessible name; opens the menu if it is closed. */
function dockControls(): Array<Readonly<{ name: string; disabled: boolean }>> {
  if (!document.getElementById('auth-runtime-dock-panel')) {
    fireEvent.click(screen.getByRole('button', { name: 'Open environment selector' }))
  }
  const panel = document.getElementById('auth-runtime-dock-panel')
  if (!panel) throw new Error('the environment menu did not open')
  const controls = Array.from(panel.querySelectorAll('button')).map(button => ({
    name: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
    disabled: button.disabled,
  }))
  // Add, then select and delete for each of the saved environments A, B and C.
  if (controls.length !== 7) throw new Error(`the environment menu has ${controls.length} controls`)
  return controls
}

const enabledDockControls = () =>
  dockControls()
    .filter(control => !control.disabled)
    .map(control => control.name)

const disabledDockControls = () =>
  dockControls()
    .filter(control => control.disabled)
    .map(control => control.name)

/** The end states main pushed for `attemptId`, in order. */
function endStatesOf(harness: BrowserSignInHarness, attemptId: number): string[] {
  return harness.pushes.flatMap(({ value }) =>
    value.attemptId === attemptId && value.phase === 'ended' ? [value.outcome] : []
  )
}

/** A code link from PR 2's builder, as the Profile UI sends it, with the edge's recorded code. */
function codeLink(state: string, environment: string): string {
  const { code } = readEdgeRecord('POST /api/v1/oidc/profile-flow/complete desktop-code-issued')
    .body as { code: string }
  return buildDesktopLoginCodeLink({ state, code, environment })
}

/**
 * Main starts an attempt and accepts its code link, with the redeem held at the edge, so the
 * attempt stays `redeeming`. Returns the `redeeming` snapshot main pushed, and the held redeem.
 */
async function redeemInMain(harness: BrowserSignInHarness) {
  const { attemptId } = await harness.service.startBrowserSignIn()
  const opened = harness.opens.at(-1)
  const state = opened ? parseDesktopLoginPageUrl(opened.value)?.state : undefined
  if (!state) throw new Error(`attempt ${attemptId} opened no page with a state`)
  const redeem = harness.hold('redeem')
  expect(harness.service.acceptDesktopLoginLink(codeLink(state, harness.envs.A.restBaseUrl))).toBe(
    true
  )
  await waitFor(() => expect(redeem.reached).toBe(true))
  const redeeming = await waitFor(() => {
    const pushed = harness.pushes.find(
      ({ value }) => value.attemptId === attemptId && value.phase === 'redeeming'
    )
    if (!pushed) throw new Error(`main pushed no redeeming snapshot for attempt ${attemptId}`)
    return pushed.value
  })
  return { attemptId, redeeming, redeem }
}

/** Lets main finish a held redeem with the edge's recorded answer, once the page is gone. */
async function finishRedeem(harness: BrowserSignInHarness, redeem: { release(): void }) {
  cleanup()
  redeem.release()
  await harness.drain()
}

/** What main has bound: the active option and the saved options, from its own state. */
function bindingOf(harness: BrowserSignInHarness) {
  const state = harness.service.getRuntimeConfigState()
  return { activeOptionId: state.activeOptionId, optionIds: state.options.map(option => option.id) }
}

type EnvironmentChangeRow = Readonly<{
  handler: string
  /** The preload function the handler reaches main through. */
  call:
    | 'saveRuntimeConfig'
    | 'selectRuntimeConfig'
    | 'deleteRuntimeConfig'
    | 'clearRuntimeConfigSelection'
  /** Sets what the screen holds before the call, if anything; run before each attempt. */
  prepare?: (page: PageMount, harness: BrowserSignInHarness) => Promise<void>
  run: (page: PageMount, harness: BrowserSignInHarness) => Promise<unknown>
  /** What the screen still shows after a refused call, besides the unchanged binding. */
  afterRefusal?: (page: PageMount) => void
}>

/**
 * The environment changes the sign-in page and the dock offer outside a desktop-environment link
 * (Task 14a review I-1). Main does not refuse them while an attempt redeems.
 */
const ENVIRONMENT_CHANGE_ROWS: readonly EnvironmentChangeRow[] = [
  {
    handler: 'handleSaveRuntimeConfig',
    call: 'saveRuntimeConfig',
    // The add-environment form (`AuthPage`'s `handleRuntimeSetupSubmit`).
    prepare: async page => {
      act(() => {
        page.controller().setRuntimeConfigSetupName('Environment D')
        page.controller().setRuntimeConfigSetupExternalRestApiBaseUrl('https://api-d.example.test')
        page.controller().setRuntimeConfigSetupRpcProxyBaseUrl('https://rpc-d.example.test')
      })
    },
    run: page => page.controller().handleSaveRuntimeConfig(),
  },
  {
    handler: 'handleSelectRuntimeConfig',
    call: 'selectRuntimeConfig',
    run: (page, harness) => page.controller().handleSelectRuntimeConfig(harness.envs.B.optionId),
  },
  {
    handler: 'handleSwitchLoginBackend',
    call: 'selectRuntimeConfig',
    // Main's own hint: Localhost answers the harness's health route, and the active environment
    // refuses the connection, as in `appService.diagnoseLoginBackend.test.ts`.
    prepare: async (page, harness) => {
      const localhost = harness.service
        .getRuntimeConfigState()
        .options.find(option => option.source === 'localhost')
      if (!localhost) throw new Error('main lists no Localhost option')
      const localhostOrigin = new URL(localhost.externalRestApiBaseUrl).origin
      const healthy = harness.routes['GET /health']
      if (!healthy) throw new Error('the harness has no health route')
      harness.routes['GET /health'] = request => {
        if (new URL(request.url).origin === localhostOrigin) return healthy(request)
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      }
      const hint = await harness.service.diagnoseLoginBackend()
      if (!hint) throw new Error('main offered no backend switch')
      act(() => page.controller().setBackendSwitchHint(hint))
    },
    run: page => page.controller().handleSwitchLoginBackend(),
    afterRefusal: page =>
      expect(page.controller().backendSwitchHint, 'the switch is still offered').not.toBeNull(),
  },
  {
    handler: 'handleDeleteRuntimeConfig',
    call: 'deleteRuntimeConfig',
    run: (page, harness) => page.controller().handleDeleteRuntimeConfig(harness.envs.C.optionId),
  },
  {
    handler: 'handleClearRuntimeConfigSelection',
    call: 'clearRuntimeConfigSelection',
    run: page => page.controller().handleClearRuntimeConfigSelection(),
  },
]

type StartGuardRow = Readonly<{
  flag: 'booting' | 'busy' | 'authTransitioning'
  /** Sets the flag through the flow that owns it; the returned function ends that flow. */
  hold: (
    page: PageMount,
    bridge: Bridge,
    harness: BrowserSignInHarness
  ) => Promise<() => Promise<void>>
}>

const START_GUARD_ROWS: readonly StartGuardRow[] = [
  {
    // The session load has not ended booting.
    flag: 'booting',
    hold: async page => async () => {
      act(() => page.controller().setBooting(false))
    },
  },
  {
    // An environment switch from the dock is in flight.
    flag: 'busy',
    hold: async (page, bridge, harness) => {
      const openSelect = bridge.gate('selectRuntimeConfig')
      let selected: Promise<unknown> = Promise.resolve()
      act(() => {
        selected = page.controller().handleSelectRuntimeConfig(harness.envs.B.optionId)
      })
      await waitFor(() => expect(bridge.entered('selectRuntimeConfig')).toBe(true))
      return async () => {
        openSelect()
        await act(async () => {
          await selected
        })
      }
    },
  },
  {
    // A desktop-environment link's confirm waits on its first session read (A3-68).
    flag: 'authTransitioning',
    hold: async (page, bridge, harness) => {
      act(() => page.controller().setPendingDesktopEnvironmentSetup(environmentB(harness)))
      const openRead = bridge.gate('getSessionGeneration')
      let confirmed: Promise<void> = Promise.resolve()
      act(() => {
        confirmed = page.controller().handleConfirmDesktopEnvironmentSetup()
      })
      await waitFor(() => expect(bridge.entered('getSessionGeneration')).toBe(true))
      return async () => {
        openRead()
        await act(async () => {
          await confirmed
        })
      }
    },
  },
]

describe('useAuthController: the auth gates and a browser sign-in (D14)', () => {
  it('G2-14a keeps the dock and desktop-environment links usable while waiting', async () => {
    const { harness, bridge } = await createSignInMain()
    const page = await mountAuthPage(bridge)

    await act(async () => {
      await page.controller().handleStartBrowserSignIn()
    })
    const { browserSignIn } = page.controller()
    expect(browserSignIn.phase, 'main opened the browser and waits').toBe('waiting')
    expect(disabledDockControls(), 'the dock stays usable while waiting').toEqual([])

    // A link for the saved environment B (A3-19).
    await act(async () => {
      await bridge.openDesktopEnvironmentLink(environmentB(harness))
    })
    expect(page.setStatus).not.toHaveBeenCalledWith(FINISH_CURRENT_ACTION, 'info')
    expect(bridge.auth.selectRuntimeConfigForHandoff, 'the link selects B').toHaveBeenCalledTimes(1)
    // The selection's bump ends the waiting attempt `replaced` (A3-15).
    expect(endStatesOf(harness, browserSignIn.attemptId ?? 0)).toEqual(['replaced'])
    await waitFor(() => expect(page.controller().browserSignIn.phase).toBe('idle'))
  })

  // Decision 9 (Task 14a review M4): a waiting attempt sets nothing, so the password form stays
  // usable, and a password login then ends the attempt `replaced` (A3-16, D14).
  it('keeps the password form usable while waiting, and a password login replaces the attempt', async () => {
    const { harness, bridge } = await createSignInMain()
    const page = await mountAuthPage(bridge)
    await act(async () => {
      await page.controller().handleStartBrowserSignIn()
    })
    const { attemptId } = page.controller().browserSignIn
    expect(page.controller().browserSignIn.phase, 'main opened the browser and waits').toBe(
      'waiting'
    )
    await waitFor(() =>
      expect(
        screen.queryByText('Finish signing in in your browser'),
        'the page shows the waiting attempt'
      ).not.toBeNull()
    )

    const email = screen.getByLabelText('Email') as HTMLInputElement
    const password = screen.getByLabelText('Password') as HTMLInputElement
    fireEvent.change(email, { target: { value: 'member@example.test' } })
    fireEvent.change(password, { target: { value: 'fake-password' } })
    const submit = password.closest('form')?.querySelector('button[type="submit"]')
    if (!(submit instanceof HTMLButtonElement)) throw new Error('the password form has no submit')
    expect(email.disabled, 'the email input is enabled while waiting').toBe(false)
    expect(password.disabled, 'the password input is enabled while waiting').toBe(false)
    expect(submit.disabled, 'the password submit is enabled while waiting').toBe(false)

    fireEvent.click(submit)
    await waitFor(() =>
      expect(page.setStatus, 'the password login signs in').toHaveBeenCalledWith(
        'Signed in.',
        'success'
      )
    )
    expect(bridge.auth.passwordLogin, 'the login reached main').toHaveBeenCalledTimes(1)
    expect(endStatesOf(harness, attemptId ?? 0), "the login's bump replaced the attempt").toEqual([
      'replaced',
    ])
    await waitFor(() => expect(page.controller().browserSignIn.phase).toBe('idle'))
  })

  // Final review FR-C1: the page's submit reads `redeeming` from rendered state, so an Enter that
  // lands before React commits the push still calls the handler. The handler reads the ref.
  it('FR-C1 refuses a password sign-in while redeeming, and lets it reach main while waiting', async () => {
    const { harness, bridge } = await createSignInMain()
    const page = await mountAuthPage(bridge)
    // Without credentials the handler would stop before main for another reason.
    const fillCredentials = () =>
      act(() => {
        page.controller().setEmail('member@example.test')
        page.controller().setPassword('fake-password')
      })

    // Main redeems an attempt, and the renderer has its push.
    const { attemptId: redeemingId, redeem } = await redeemInMain(harness)
    await waitFor(() => expect(page.controller().browserSignIn.phase).toBe('redeeming'))
    fillCredentials()
    const bumps = harness.bumpLog.length

    await act(async () => {
      await page.controller().handlePasswordLogin()
    })
    expect(
      bridge.auth.passwordLogin,
      'the password sign-in does not reach main while redeeming'
    ).not.toHaveBeenCalled()
    expect(harness.bumpLog.length, 'the generation did not advance').toBe(bumps)
    expect(endStatesOf(harness, redeemingId), 'the attempt has not ended').toEqual([])
    expect(page.controller().browserSignIn.phase, 'the attempt still redeems').toBe('redeeming')

    // The redeem gets no answer; main ends the attempt and the renderer returns to idle.
    redeem.release(new Error('fake network failure'))
    await waitFor(() => expect(page.controller().browserSignIn.phase).toBe('idle'))

    // Positive control: a waiting attempt does not stop the same call (decision 9), and the
    // login's bump ends the attempt `replaced` (A3-16).
    await act(async () => {
      await page.controller().handleStartBrowserSignIn()
    })
    const waitingId = page.controller().browserSignIn.attemptId
    expect(page.controller().browserSignIn.phase, 'a new attempt waits').toBe('waiting')
    fillCredentials()
    await act(async () => {
      await page.controller().handlePasswordLogin()
    })
    expect(
      bridge.auth.passwordLogin,
      'the password sign-in reaches main while waiting'
    ).toHaveBeenCalledTimes(1)
    expect(page.setStatus, 'the password login signs in').toHaveBeenCalledWith(
      'Signed in.',
      'success'
    )
    expect(endStatesOf(harness, waitingId ?? 0), "the login's bump replaced the attempt").toEqual([
      'replaced',
    ])
  })

  it('G2-14b treats redeeming as in progress before React commits', async () => {
    const { harness, bridge, relay } = await createSignInMain()
    const page = await mountAuthPage(bridge)
    // A link's dialog waits for confirmation (committed).
    act(() => page.controller().setPendingDesktopEnvironmentSetup(environmentB(harness)))
    expect(disabledDockControls(), 'the dock is usable before the redeem').toEqual([])

    // Main redeems an attempt; its pushes have not reached the renderer yet.
    relay.muted = true
    const { redeeming, redeem } = await redeemInMain(harness)
    const confirm = page.controller().handleConfirmDesktopEnvironmentSetup
    const sessionReads = bridge.auth.getSessionGeneration.mock.calls.length
    const statusBefore = page.setStatus.mock.calls.length
    const rendersBefore = page.probe.renders.length
    let duringBlock: Readonly<{ status: unknown[][]; renders: number }> = {
      status: [],
      renders: -1,
    }
    let linked: Promise<void> = Promise.resolve()
    let confirmed: Promise<void> = Promise.resolve()

    // One synchronous block: the push writes the view's ref and queues its state, which React
    // commits only when the block ends (V32, A3-55).
    act(() => {
      bridge.push(redeeming)
      linked = bridge.openDesktopEnvironmentLink(environmentB(harness))
      confirmed = confirm()
      duringBlock = {
        status: page.setStatus.mock.calls.slice(statusBefore),
        renders: page.probe.renders.length,
      }
    })

    expect(duringBlock.renders, 'React had not committed during the block').toBe(rendersBefore)
    expect(
      duringBlock.status,
      'the handoff gate and the confirm report an action in progress'
    ).toEqual([
      [FINISH_CURRENT_ACTION, 'info'],
      [FINISH_CURRENT_ACTION, 'info'],
    ])
    await act(async () => {
      await Promise.all([linked, confirmed])
    })
    expect(
      bridge.auth.getSessionGeneration.mock.calls.length,
      'both stopped at their first check'
    ).toBe(sessionReads)
    expect(bridge.auth.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(page.controller().pendingDesktopEnvironmentSetup).toBeNull()

    // After the commit (decision 8).
    expect(page.controller().authTransitioning, 'redeeming reads as a transition').toBe(true)
    expect(enabledDockControls(), 'the dock is disabled while redeeming').toEqual([])

    await finishRedeem(harness, redeem)
  })

  // The check after the third read, which follows the selection, has no row: main refuses the
  // selection while an attempt redeems (`assertProfileHandoffSessionIsSignedOut`, D11), and an
  // attempt started after it bumps the generation, which the check before it reports.
  it.each([1, 2])(
    'G2-14b stops the confirm at its check after session read %i while redeeming',
    async read => {
      const { harness, bridge, relay } = await createSignInMain()
      const page = await mountAuthPage(bridge)
      act(() => page.controller().setPendingDesktopEnvironmentSetup(environmentB(harness)))
      relay.muted = true
      const { redeeming, redeem } = await redeemInMain(harness)
      const readsBefore = bridge.auth.getSessionGeneration.mock.calls.length

      // The confirm passes its first check, then waits on session read `read`. Main redeems
      // already; the renderer learns it while the read is in flight (V28).
      const openRead = bridge.gate('getSessionGeneration', read - 1)
      let confirmed: Promise<void> = Promise.resolve()
      act(() => {
        confirmed = page.controller().handleConfirmDesktopEnvironmentSetup()
      })
      await waitFor(() =>
        expect(bridge.auth.getSessionGeneration).toHaveBeenCalledTimes(readsBefore + read)
      )
      // Main's push lands while the read is in flight.
      act(() => bridge.push(redeeming))
      openRead()
      await act(async () => {
        await confirmed
      })

      expect(page.setStatus, 'the confirm reports an action in progress').toHaveBeenLastCalledWith(
        FINISH_CURRENT_ACTION,
        'info'
      )
      expect(
        bridge.auth.getSessionGeneration.mock.calls.length,
        'the confirm stopped at the check after that read'
      ).toBe(readsBefore + read)
      // Main would refuse the selection with the same text; the renderer does not ask it.
      expect(
        bridge.auth.selectRuntimeConfigForHandoff,
        'B is not selected through main'
      ).not.toHaveBeenCalled()
      expect(page.onSessionNeedsLoad, 'B is not loaded').toHaveBeenCalledTimes(1)
      expect(page.controller().pendingDesktopEnvironmentSetup).toBeNull()

      await finishRedeem(harness, redeem)
    }
  )

  // Round-3 review minor 5: FR-C1's test lets `redeeming` commit before it calls the handler, so
  // a guard that read the rendered phase would pass it. Here the push and the call land in one
  // synchronous block, before React commits, as in the G2-14b test above.
  it('G2-14b refuses a password sign-in while redeeming before React commits, and lets it reach main while waiting', async () => {
    const { harness, bridge, relay } = await createSignInMain()
    const page = await mountAuthPage(bridge)
    // Committed before the block: without credentials the handler would stop before main for
    // another reason.
    const fillCredentials = () =>
      act(() => {
        page.controller().setEmail('member@example.test')
        page.controller().setPassword('fake-password')
      })
    fillCredentials()

    // Main redeems an attempt; its pushes have not reached the renderer yet.
    relay.muted = true
    const { attemptId: redeemingId, redeeming, redeem } = await redeemInMain(harness)
    const bumps = harness.bumpLog.length
    const rendersBefore = page.probe.renders.length
    let rendersDuringBlock = -1
    let login: Promise<void> = Promise.resolve()

    // One synchronous block: the push writes the view's ref and queues its state, which React
    // commits only when the block ends (V32, A3-55).
    act(() => {
      bridge.push(redeeming)
      login = page.controller().handlePasswordLogin()
      rendersDuringBlock = page.probe.renders.length
    })
    await act(async () => {
      await login
    })

    expect(rendersDuringBlock, 'React had not committed during the block').toBe(rendersBefore)
    expect(
      bridge.auth.passwordLogin,
      'the password sign-in does not reach main while redeeming'
    ).not.toHaveBeenCalled()
    expect(harness.bumpLog.length, 'the generation did not advance').toBe(bumps)
    expect(endStatesOf(harness, redeemingId), 'the attempt has not ended').toEqual([])
    expect(page.controller().browserSignIn.phase, 'the attempt still redeems').toBe('redeeming')

    // The renderer hears main again. The redeem gets no answer; main ends the attempt and the
    // renderer returns to idle.
    relay.muted = false
    redeem.release(new Error('fake network failure'))
    await waitFor(() => expect(page.controller().browserSignIn.phase).toBe('idle'))

    // Positive control: a waiting attempt does not stop the same call (decision 9), and the
    // login's bump ends the attempt `replaced` (A3-16).
    await act(async () => {
      await page.controller().handleStartBrowserSignIn()
    })
    const waitingId = page.controller().browserSignIn.attemptId
    expect(page.controller().browserSignIn.phase, 'a new attempt waits').toBe('waiting')
    fillCredentials()
    await act(async () => {
      await page.controller().handlePasswordLogin()
    })
    expect(
      bridge.auth.passwordLogin,
      'the password sign-in reaches main while waiting'
    ).toHaveBeenCalledTimes(1)
    expect(endStatesOf(harness, waitingId ?? 0), "the login's bump replaced the attempt").toEqual([
      'replaced',
    ])
  })

  // Round-3 review minor 5: as above, for the five environment changes of the I-1 rows.
  it.each(ENVIRONMENT_CHANGE_ROWS.map(row => [row.handler, row] as const))(
    'G2-14b refuses %s while redeeming before React commits, and lets it reach main while waiting',
    async (_handler, row) => {
      const { harness, bridge, relay } = await createSignInMain()
      const page = await mountAuthPage(bridge)
      const reachesMain = bridge.auth[row.call]

      // Main redeems an attempt; its pushes have not reached the renderer yet. What the screen
      // holds is committed before the block.
      relay.muted = true
      const { attemptId: redeemingId, redeeming, redeem } = await redeemInMain(harness)
      await row.prepare?.(page, harness)
      const binding = bindingOf(harness)
      const bumps = harness.bumpLog.length
      const reads = bridge.auth.getLoginMethods.mock.calls.length
      const rendersBefore = page.probe.renders.length
      let rendersDuringBlock = -1
      let changed: Promise<unknown> = Promise.resolve()

      // One synchronous block: the push writes the view's ref and queues its state, which React
      // commits only when the block ends (V32, A3-55).
      act(() => {
        bridge.push(redeeming)
        changed = row.run(page, harness)
        rendersDuringBlock = page.probe.renders.length
      })
      await act(async () => {
        await changed
      })

      expect(rendersDuringBlock, 'React had not committed during the block').toBe(rendersBefore)
      expect(
        reachesMain,
        `${row.handler} does not reach main while redeeming`
      ).not.toHaveBeenCalled()
      expect(bindingOf(harness), 'the binding is unchanged').toEqual(binding)
      expect(harness.bumpLog.length, 'the generation did not advance').toBe(bumps)
      expect(
        bridge.auth.getLoginMethods.mock.calls.length,
        'no binding change re-read the model'
      ).toBe(reads)
      expect(endStatesOf(harness, redeemingId), 'the attempt has not ended').toEqual([])
      expect(page.controller().browserSignIn.phase, 'the attempt still redeems').toBe('redeeming')
      row.afterRefusal?.(page)

      // The renderer hears main again. The redeem gets no answer; main ends the attempt and the
      // renderer returns to idle.
      relay.muted = false
      redeem.release(new Error('fake network failure'))
      await waitFor(() => expect(page.controller().browserSignIn.phase).toBe('idle'))

      // Positive control: a waiting attempt does not stop the same call (D14, decision 9).
      await act(async () => {
        await page.controller().handleStartBrowserSignIn()
      })
      expect(page.controller().browserSignIn.phase, 'a new attempt waits').toBe('waiting')
      await row.prepare?.(page, harness)
      await act(async () => {
        await row.run(page, harness)
      })
      expect(reachesMain, `${row.handler} reaches main while waiting`).toHaveBeenCalledTimes(1)
    }
  )

  it('G2-14e disables the dock while a start call is held', async () => {
    const { bridge } = await createSignInMain()
    const page = await mountAuthPage(bridge)
    expect(disabledDockControls(), 'the dock is usable before start').toEqual([])

    const openStart = bridge.gate('startBrowserSignIn')
    let started: Promise<void> = Promise.resolve()
    act(() => {
      started = page.controller().handleStartBrowserSignIn()
    })
    await waitFor(() => expect(bridge.entered('startBrowserSignIn')).toBe(true))
    expect(enabledDockControls(), 'the dock is disabled while start is held').toEqual([])

    openStart()
    await act(async () => {
      await started
    })
    expect(page.controller().browserSignIn.phase, 'main opened the browser and waits').toBe(
      'waiting'
    )
    expect(disabledDockControls(), 'the dock is usable again once start returns').toEqual([])
  })

  // Review Focus 5: the page's button commits `disabled` only after React renders, so two quick
  // activations both reach the handler; its `busy` ref lets only the first through.
  it('sends one start for a double activation', async () => {
    const { bridge } = await createSignInMain()
    const page = await mountAuthPage(bridge)
    // The harness's methods route answers the edge's recorded `password-and-oidc`.
    const both = modelOf('password-and-oidc')
    if (both.kind !== 'methods' || !both.provider) throw new Error('the record offers no provider')
    const name = `Continue with ${both.provider.label}`
    const button = await waitFor(() => {
      const found = screen.queryByRole('button', { name })
      expect(found, 'the sign-in page offers the provider').not.toBeNull()
      return found as HTMLButtonElement
    })
    expect(button.disabled, 'Continue is usable before the activations').toBe(false)
    const rendersBefore = page.probe.renders.length
    let between: Readonly<{ disabled: boolean; renders: number }> = {
      disabled: true,
      renders: -1,
    }

    // Two activations in one synchronous block: React commits the first one's `busy` only when
    // the block ends, so the second meets a button that is still enabled.
    act(() => {
      button.click()
      between = { disabled: button.disabled, renders: page.probe.renders.length }
      button.click()
    })

    expect(between.renders, 'React had not committed between the activations').toBe(rendersBefore)
    expect(between.disabled, 'the second activation met an enabled button').toBe(false)
    expect(bridge.auth.startBrowserSignIn, 'one start reaches main').toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(page.controller().browserSignIn.phase, 'main opened the browser and waits').toBe(
        'waiting'
      )
    )
  })

  it.each(START_GUARD_ROWS.map(row => [row.flag, row] as const))(
    'ignores a start while %s is set',
    async (_flag, row) => {
      const { harness, bridge } = await createSignInMain()
      const page = await mountAuthPage(bridge, { boot: row.flag !== 'booting' })
      const release = await row.hold(page, bridge, harness)
      expect(page.controller()[row.flag], `${row.flag} is set`).toBe(true)

      await act(async () => {
        await page.controller().handleStartBrowserSignIn()
      })
      expect(bridge.auth.startBrowserSignIn, 'start returns at once').not.toHaveBeenCalled()

      await release()
      await act(async () => {
        await page.controller().handleStartBrowserSignIn()
      })
      expect(bridge.auth.startBrowserSignIn, 'start reaches main afterwards').toHaveBeenCalledTimes(
        1
      )
    }
  )

  it.each(ENVIRONMENT_CHANGE_ROWS.map(row => [row.handler, row] as const))(
    'I-1 refuses %s while redeeming, and lets it reach main while waiting',
    async (_handler, row) => {
      const { harness, bridge } = await createSignInMain()
      const page = await mountAuthPage(bridge)
      const reachesMain = bridge.auth[row.call]

      // Main redeems an attempt, and the renderer has its push.
      const { redeem } = await redeemInMain(harness)
      await waitFor(() => expect(page.controller().browserSignIn.phase).toBe('redeeming'))
      await row.prepare?.(page, harness)
      const binding = bindingOf(harness)
      const bumps = harness.bumpLog.length
      const reads = bridge.auth.getLoginMethods.mock.calls.length

      await act(async () => {
        await row.run(page, harness)
      })
      expect(
        reachesMain,
        `${row.handler} does not reach main while redeeming`
      ).not.toHaveBeenCalled()
      expect(bindingOf(harness), 'the binding is unchanged').toEqual(binding)
      expect(harness.bumpLog.length, 'the generation did not advance').toBe(bumps)
      expect(
        bridge.auth.getLoginMethods.mock.calls.length,
        'no binding change re-read the model'
      ).toBe(reads)
      expect(page.controller().browserSignIn.phase, 'the attempt still redeems').toBe('redeeming')
      row.afterRefusal?.(page)

      // The redeem gets no answer; main ends the attempt and the renderer returns to idle.
      redeem.release(new Error('fake network failure'))
      await waitFor(() => expect(page.controller().browserSignIn.phase).toBe('idle'))

      // Positive control: a waiting attempt does not stop the same call (D14, decision 9).
      await act(async () => {
        await page.controller().handleStartBrowserSignIn()
      })
      expect(page.controller().browserSignIn.phase, 'a new attempt waits').toBe('waiting')
      await row.prepare?.(page, harness)
      await act(async () => {
        await row.run(page, harness)
      })
      expect(reachesMain, `${row.handler} reaches main while waiting`).toHaveBeenCalledTimes(1)
    }
  )
})
