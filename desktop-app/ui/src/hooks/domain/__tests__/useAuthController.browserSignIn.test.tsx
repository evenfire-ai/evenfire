// @vitest-environment jsdom
/**
 * Each of the six binding-changing calls in `useAuthController` goes through the login model's
 * one helper (D15; A3-56, A3-64, A3-65; G2-15c, G2-15d).
 *
 * Main is the browser sign-in harness's real `AppService` (state model §7.3): its runtime-config
 * answers, generations, refusals and login models reach the controller as Electron carries them,
 * every rejection wrapped (M5). Every methods answer is the edge's recorded one (T1): environment
 * A answers `password`, every other environment the `oidc-only` derivation.
 *
 * Only interfaces the controller had before D15 drive these tests: its handlers, its setters and
 * `window.clerum.auth`. The shown model is read from the controller's result.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { buildLoginMethodsModel } from '../../../../../src/browserSignInModel'
import type { DesktopRuntimeConfig, LoginMethodsAnswer } from '../../../../../src/types'
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

/**
 * `window.clerum.auth` over the harness's service, as `preload.ts` and `ipc.ts` carry it: a
 * rejection reaches the renderer wrapped. `gate(name)` keeps the next call of `name` from
 * reaching main until it is opened, so the call is in flight.
 */
function installBridge(harness: BrowserSignInHarness) {
  const { service } = harness
  const gates = new Map<string, Deferred>()
  const entered = new Set<string>()
  const loginAnswers: LoginMethodsAnswer[] = []

  function ipc<Args extends unknown[], Result>(
    name: string,
    call: (...args: Args) => Result | Promise<Result>
  ) {
    return vi.fn(async (...args: Args): Promise<Result> => {
      entered.add(name)
      const gate = gates.get(name)
      gates.delete(name)
      if (gate) await gate.promise
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
    // The harness's service pushes to the harness; nothing in these tests subscribes.
    onBrowserSignInChanged: vi.fn(() => () => undefined),
    onDesktopSetupToken: vi.fn(() => () => undefined),
    onDesktopEnvironmentSetup: vi.fn(() => () => undefined),
    onExternalLogout: vi.fn(() => () => undefined),
    onSessionCleared: vi.fn(() => () => undefined),
  }
  window.clerum = { ...window.clerum, auth: { ...window.clerum?.auth, ...auth } } as never

  return {
    auth,
    loginAnswers,
    /** Holds the next call of `name` before main; the returned function lets it go on. */
    gate(name: string) {
      const gate = deferred()
      gates.set(name, gate)
      return gate.resolve
    },
    entered: (name: string) => entered.has(name),
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
    shown.push(controller.loginModel)
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
    // The add-environment form (`AuthPage/index.tsx:63-69`).
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
      expect(hook.result.current.loginModel, "A's late answer is dropped").toEqual(LOADING)

      // The call reaches main and settles; the model is read again for the binding it left.
      openCall()
      await act(async () => {
        await started
      })
      await waitFor(() => expect(bridge.auth.getLoginMethods).toHaveBeenCalledTimes(2))
      await flush()
      await waitFor(() => expect(hook.result.current.loginModel).toEqual(row.after))
      expect(shown, "A's form never shows").not.toContainEqual(PASSWORD_FORM)
    }
  )

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
    await waitFor(() => expect(hook.result.current.loginModel).toEqual(PASSWORD_FORM))
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
      expect(hook.result.current.loginModel, 'never stays loading').toEqual(PASSWORD_FORM)
    )
    expect(bridge.loginAnswers.at(-1)?.generation).toBe(harness.service.getSessionGeneration())
  })
})
