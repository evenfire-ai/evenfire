// @vitest-environment jsdom
/**
 * `useLoginMethods`: the login screen's model, read from main over IPC (E12) and ordered by the
 * renderer's request epoch, then by main's generation, then by the order the reads were sent
 * (D15; S5, L6, L7).
 *
 * Every model the fake main answers with is built by main's own `buildLoginMethodsModel` from
 * the edge's recorded answers (T1, design §10.1), and every rejection is fed in the form Electron
 * gives the renderer (M5).
 */
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest'
import { type RenderHookResult, act, cleanup, renderHook } from '@testing-library/react'
import fc, { type Scheduler } from 'fast-check'
import { buildLoginMethodsModel } from '../../../../../src/browserSignInModel'
import { canonicalizeDesktopRestEndpoint } from '../../../../../src/desktopEnvironmentUrl'
import type { LoginMethodsAnswer, LoginMethodsModel } from '../../../../../src/types'
import { LOGIN_SCREEN_ROWS } from '../../../../../testSupport/edgeContractRecords'
import type { LoginScreenModel, UseLoginMethodsParams, UseLoginMethodsResult } from '../types'
import { useLoginMethods } from '../useLoginMethods'
import { wrapLikeElectronIpc } from './__fixtures__/ipcErrors'

const LOADING: LoginScreenModel = { kind: 'loading' }
const UNREACHABLE: LoginScreenModel = { kind: 'unreachable' }

/** The model main builds for a row of design §10.1's table, with links available. */
function modelOf(label: string): LoginMethodsModel {
  const row = LOGIN_SCREEN_ROWS.find(([rowLabel]) => rowLabel === label)
  if (!row) throw new Error(`LOGIN_SCREEN_ROWS has no row "${label}"`)
  return buildLoginMethodsModel(row[1], { linksAvailable: true })
}

/** Every model main can build from the recorded answers, in table order. */
const ALL_MODELS: readonly LoginMethodsModel[] = LOGIN_SCREEN_ROWS.map(([, answer]) =>
  buildLoginMethodsModel(answer, { linksAvailable: true })
)

/** What the add form's save of `ftp://api.example.test` rejects with (G2-15d producer). */
const FAILED_SAVE = wrapLikeElectronIpc(
  'auth:saveRuntimeConfig',
  new Error('externalRestApiBaseUrl must be a valid http(s) URL')
)

/**
 * What main's `getLoginMethods` rejects with when the active REST URL is not http(s): the error
 * `canonicalizeDesktopRestEndpoint` throws when the read captures the binding
 * (`appService.ts` `captureAuthEnvironmentBinding`). Taken from running that function. Main can
 * reach it: a stored profile file is loaded without a protocol check (`config.ts`
 * `normalizeRuntimeConfig`), and `applyRuntimeConfig` makes its URL the active one.
 */
function failedRead(): Error {
  try {
    canonicalizeDesktopRestEndpoint('ftp://api.example.test')
  } catch (error) {
    return wrapLikeElectronIpc('auth:getLoginMethods', error as Error)
  }
  throw new Error('canonicalizeDesktopRestEndpoint accepted an ftp URL')
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Main's `getLoginMethods`: each read waits until the test answers it. */
function installMain() {
  const reads: Deferred<LoginMethodsAnswer>[] = []
  const getLoginMethods = vi.fn((): Promise<LoginMethodsAnswer> => {
    const read = deferred<LoginMethodsAnswer>()
    reads.push(read)
    return read.promise
  })
  window.clerum = {
    ...window.clerum,
    auth: { ...window.clerum?.auth, getLoginMethods },
  } as never
  /** The `index`th read the hook sent; it must exist. */
  const read = (index: number) => {
    const found = reads[index]
    if (!found) throw new Error(`the hook sent no read #${index}`)
    return found
  }
  return { reads, read, getLoginMethods }
}

function mountHook() {
  const refreshRuntimeConfigState: Mock<UseLoginMethodsParams['refreshRuntimeConfigState']> = vi.fn(
    async () => undefined
  )
  const shown: LoginScreenModel[] = []
  const hook = renderHook(() => {
    const result = useLoginMethods({ refreshRuntimeConfigState })
    shown.push(result.model)
    return result
  })
  return { hook, refreshRuntimeConfigState, shown }
}

/** Lets settled reads and calls reach the hook. */
async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useLoginMethods: scenarios', () => {
  it('starts loading and reads nothing until the screen asks', async () => {
    const main = installMain()
    const { hook } = mountHook()
    await flush()

    // The login screen's show reads the model (E12); the hook does not read on its own.
    expect(hook.result.current.model).toEqual(LOADING)
    expect(main.getLoginMethods).not.toHaveBeenCalled()

    act(() => hook.result.current.refresh())
    expect(main.getLoginMethods).toHaveBeenCalledTimes(1)
    await act(async () => main.read(0).resolve({ model: modelOf('password'), generation: 4 }))
    expect(hook.result.current.model).toEqual(modelOf('password'))
  })

  it('G2-15a keeps a newer model when an older answer arrives late', async () => {
    const main = installMain()
    const { hook, shown } = mountHook()
    const oidcOnly = modelOf('oidc-only')
    const password = modelOf('password')

    act(() => hook.result.current.refresh())
    act(() => hook.result.current.refresh())
    // The second read was dispatched after a bump (a failed password login, A3-57).
    await act(async () => main.read(1).resolve({ model: oidcOnly, generation: 5 }))
    expect(hook.result.current.model).toEqual(oidcOnly)
    await act(async () => main.read(0).resolve({ model: password, generation: 4 }))

    expect(hook.result.current.model, 'the older answer is dropped').toEqual(oidcOnly)
    expect(shown).not.toContainEqual(password)
  })

  it('applies a later-sent answer of the same generation that arrives later', async () => {
    const main = installMain()
    const { hook } = mountHook()

    act(() => hook.result.current.refresh())
    act(() => hook.result.current.refresh())
    await act(async () => main.read(0).resolve({ model: modelOf('password'), generation: 4 }))
    // No bump between the reads, and the second read was sent after the first: its answer is the
    // server's newer word, so it applies (S5 refined).
    await act(async () => main.read(1).resolve({ model: modelOf('oidc-only'), generation: 4 }))

    expect(hook.result.current.model).toEqual(modelOf('oidc-only'))
  })

  it("keeps a newer model when an earlier read's answer of the same generation arrives late (round-3 review minor 2)", async () => {
    const main = installMain()
    const { hook, shown } = mountHook()
    const oidcOnly = modelOf('oidc-only')
    // Main resolves a network failure, a timeout or a 5xx as this answer, not as a rejection.
    const unreachable = modelOf('unreachable')
    expect(unreachable, "main's model for a failed fetch").toEqual(UNREACHABLE)

    // The first read hangs; Retry sends a second one, with no bump between them.
    act(() => hook.result.current.refresh())
    act(() => hook.result.current.refresh())
    await act(async () => main.read(1).resolve({ model: oidcOnly, generation: 4 }))
    expect(hook.result.current.model, "the later read's answer applies").toEqual(oidcOnly)
    await act(async () => main.read(0).resolve({ model: unreachable, generation: 4 }))

    expect(hook.result.current.model, "the earlier read's late answer is dropped").toEqual(oidcOnly)
    expect(shown).not.toContainEqual(UNREACHABLE)

    // Positive control: the same answer applies when its read was sent after the applied one.
    act(() => hook.result.current.refresh())
    await act(async () => main.read(2).resolve({ model: unreachable, generation: 4 }))
    expect(hook.result.current.model, "a later read's answer applies").toEqual(UNREACHABLE)
  })

  it('orders answers of one generation by the read applied last, not the latest-sent read applied (delta review DR-2)', async () => {
    const main = installMain()
    const { hook } = mountHook()
    const password = modelOf('password')
    const oidcOnly = modelOf('oidc-only')
    const both = modelOf('password-and-oidc')

    // Three reads in one epoch. Main's FIFO owner queue never answers an earlier read with a
    // higher generation, but the hook's order does not rely on it (the property's domain).
    act(() => hook.result.current.refresh())
    act(() => hook.result.current.refresh())
    act(() => hook.result.current.refresh())
    await act(async () => main.read(2).resolve({ model: password, generation: 4 }))
    expect(hook.result.current.model, 'the third read applies first').toEqual(password)
    await act(async () => main.read(0).resolve({ model: oidcOnly, generation: 5 }))
    expect(hook.result.current.model, 'a higher generation applies').toEqual(oidcOnly)
    await act(async () => main.read(1).resolve({ model: both, generation: 5 }))

    // Same generation as the applied answer, and sent after it: it applies, although a read
    // sent later (the third) applied an answer before.
    expect(hook.result.current.model, 'the later-sent read of generation 5 applies').toEqual(both)
  })

  it("G2-15b never shows env A's form after a binding change", async () => {
    const main = installMain()
    const { hook, shown } = mountHook()
    const password = modelOf('password')
    const oidcOnly = modelOf('oidc-only')
    const change = deferred<string>()

    act(() => hook.result.current.refresh())
    let settled: Promise<string> = Promise.resolve('')
    act(() => {
      settled = hook.result.current.runBindingChange(() => change.promise)
    })
    expect(hook.result.current.model).toEqual(LOADING)
    // A's answer lands while the switch to B is in flight: nothing newer is applied yet.
    await act(async () => main.read(0).resolve({ model: password, generation: 4 }))
    expect(hook.result.current.model, "A's answer is dropped").toEqual(LOADING)

    await act(async () => change.resolve('switched'))
    await expect(settled).resolves.toBe('switched')
    expect(main.getLoginMethods).toHaveBeenCalledTimes(2)
    await act(async () => main.read(1).resolve({ model: oidcOnly, generation: 6 }))

    expect(hook.result.current.model, "B's answer shows").toEqual(oidcOnly)
    expect(shown).not.toContainEqual(password)
  })

  it('drops a rejection of a read that began before a binding change', async () => {
    const main = installMain()
    const { hook } = mountHook()
    const change = deferred<string>()

    act(() => hook.result.current.refresh())
    act(() => {
      void hook.result.current.runBindingChange(() => change.promise)
    })
    await act(async () => main.read(0).reject(failedRead()))

    expect(hook.result.current.model).toEqual(LOADING)
  })

  it('keeps a newer model when an older read fails late (Task 13 review M1)', async () => {
    const main = installMain()
    const { hook, shown } = mountHook()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const oidcOnly = modelOf('oidc-only')

    // Two reads of one epoch: no binding change between them.
    act(() => hook.result.current.refresh())
    act(() => hook.result.current.refresh())
    await act(async () => main.read(1).resolve({ model: oidcOnly, generation: 5 }))
    expect(hook.result.current.model, "the later read's answer applies").toEqual(oidcOnly)
    await act(async () => main.read(0).reject(failedRead()))

    expect(hook.result.current.model, "the older read's failure is dropped").toEqual(oidcOnly)
    expect(shown).not.toContainEqual(UNREACHABLE)
    expect(warn).not.toHaveBeenCalled()
  })

  it('shows the unreachable state when the later read fails after an older answer', async () => {
    const main = installMain()
    const { hook } = mountHook()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    act(() => hook.result.current.refresh())
    act(() => hook.result.current.refresh())
    await act(async () => main.read(0).resolve({ model: modelOf('password'), generation: 5 }))
    await act(async () => main.read(1).reject(failedRead()))

    // Nothing sent after the failed read has applied, so its failure is the newest word (L7).
    expect(hook.result.current.model, "the later read's failure shows").toEqual(UNREACHABLE)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps the model when main refuses with desktop_setup_required', async () => {
    const main = installMain()
    const { hook } = mountHook()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    act(() => hook.result.current.refresh())
    await act(async () => main.read(0).resolve({ model: modelOf('password'), generation: 2 }))
    act(() => hook.result.current.refresh())
    await act(async () =>
      main
        .read(1)
        .reject(wrapLikeElectronIpc('auth:getLoginMethods', new Error('desktop_setup_required')))
    )

    // No environment is configured: onboarding shows, so the model is left as it was (E12).
    expect(hook.result.current.model).toEqual(modelOf('password'))
    expect(warn).not.toHaveBeenCalled()
  })

  it('shows the unreachable state when a read fails otherwise, and logs only its class', async () => {
    const main = installMain()
    const { hook } = mountHook()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Synthetic, adversarial input (plan, Fixtures): the throws traced in main's getLoginMethods
    // (`desktop_setup_required` and `canonicalizeDesktopRestEndpoint`'s fixed messages, as in
    // `failedRead()`) name no URL, so this message carries one as a canary that proves the log
    // line keeps only the error's class (D18).
    const failure = wrapLikeElectronIpc(
      'auth:getLoginMethods',
      new Error('stale_runtime_environment https://api.example.test')
    )

    act(() => hook.result.current.refresh())
    await act(async () => main.read(0).reject(failure))

    // L7: the §10.1 error state with Retry, never loading.
    expect(hook.result.current.model).toEqual(UNREACHABLE)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual([expect.stringMatching(/^\[useLoginMethods\] /), 'Error'])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('example.test')
  })

  it('shows the unreachable state when the read cannot be sent', async () => {
    window.clerum = {
      ...window.clerum,
      auth: {
        ...window.clerum?.auth,
        getLoginMethods: () => {
          throw new TypeError('window.clerum.auth.getLoginMethods is not a function')
        },
      },
    } as never
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { hook } = mountHook()

    // A preload older than the renderer (Vite hot reload): refresh never throws to its caller.
    expect(() => act(() => hook.result.current.refresh())).not.toThrow()
    await flush()
    expect(hook.result.current.model).toEqual(UNREACHABLE)

    // In a binding change's `finally`, the call's own outcome stands.
    let settled: Promise<string> = Promise.resolve('')
    act(() => {
      settled = hook.result.current.runBindingChange(async () => 'switched')
    })
    await expect(settled).resolves.toBe('switched')
    await flush()
    expect(hook.result.current.model).toEqual(UNREACHABLE)
  })

  it("re-reads after a binding change and returns the call's value", async () => {
    const main = installMain()
    const { hook, refreshRuntimeConfigState } = mountHook()
    const call = vi.fn(async () => 'state')

    let settled: Promise<string> = Promise.resolve('')
    act(() => {
      settled = hook.result.current.runBindingChange(call)
    })
    // The epoch moves before the call is made, in the same turn (D15).
    expect(call).toHaveBeenCalledTimes(1)
    expect(hook.result.current.model).toEqual(LOADING)
    await expect(settled).resolves.toBe('state')
    await flush()

    expect(main.getLoginMethods).toHaveBeenCalledTimes(1)
    expect(refreshRuntimeConfigState).not.toHaveBeenCalled()
    await act(async () => main.read(0).resolve({ model: modelOf('oidc-only'), generation: 0 }))
    expect(hook.result.current.model).toEqual(modelOf('oidc-only'))
  })

  it('re-reads after a failed change and refreshes the runtime config state', async () => {
    const main = installMain()
    const { hook, refreshRuntimeConfigState } = mountHook()

    act(() => hook.result.current.refresh())
    await act(async () => main.read(0).resolve({ model: modelOf('password'), generation: 3 }))
    let settled: Promise<unknown> = Promise.resolve()
    act(() => {
      settled = hook.result.current.runBindingChange(() => Promise.reject(FAILED_SAVE))
    })

    // The call's own error reaches the caller.
    await expect(settled).rejects.toBe(FAILED_SAVE)
    await flush()
    expect(refreshRuntimeConfigState).toHaveBeenCalledTimes(1)
    expect(main.getLoginMethods, 'a fresh read runs').toHaveBeenCalledTimes(2)
    // The failed change bumped (A3-65): A's model comes back at the next generation.
    await act(async () => main.read(1).resolve({ model: modelOf('password'), generation: 4 }))
    expect(hook.result.current.model, 'never stays loading').toEqual(modelOf('password'))
  })

  it('logs a failed runtime-config refresh and still rethrows the call', async () => {
    installMain()
    const { hook, refreshRuntimeConfigState } = mountHook()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Synthetic, adversarial input (plan, Fixtures): the URL is a canary that proves the log line
    // keeps only the error's class (D18).
    refreshRuntimeConfigState.mockRejectedValueOnce(
      wrapLikeElectronIpc('auth:getRuntimeConfigState', new Error('https://api.example.test'))
    )

    let settled: Promise<unknown> = Promise.resolve()
    act(() => {
      settled = hook.result.current.runBindingChange(() => Promise.reject(FAILED_SAVE))
    })

    await expect(settled).rejects.toBe(FAILED_SAVE)
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual([expect.stringMatching(/^\[useLoginMethods\] /), 'Error'])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('example.test')
  })

  it('keeps refresh and runBindingChange stable across renders', async () => {
    const main = installMain()
    const { hook } = mountHook()
    const first = hook.result.current

    act(() => hook.result.current.refresh())
    await act(async () => main.read(0).resolve({ model: modelOf('password'), generation: 1 }))

    // Effects and child props take these as dependencies (P42).
    expect(hook.result.current.refresh).toBe(first.refresh)
    expect(hook.result.current.runBindingChange).toBe(first.runBindingChange)
  })
})

// --- S5, L6 and L7 under generated answers and binding changes (M3f; state model §7.5) ---

type PropertyRead = {
  id: number
  /** The reference epoch when the hook sent the read: binding changes started before it. */
  epoch: number
  deferred: Deferred<LoginMethodsAnswer>
  answered: boolean
}

type Delivery = Readonly<{ read: PropertyRead; generation: number; model: LoginMethodsModel }>

type PropertyModel = { unanswered: number }

type PropertyWorld = {
  scheduler: Scheduler
  hook: RenderHookResult<UseLoginMethodsResult, unknown>
  refreshRuntimeConfigState: Mock<UseLoginMethodsParams['refreshRuntimeConfigState']>
  /** Binding changes started so far: the hook's epoch, as the test counts it. */
  epoch: number
  reads: PropertyRead[]
  deliveries: Delivery[]
  /** Each answer object, with the epoch of the read it answers. */
  epochOfModel: Map<LoginMethodsModel, number>
  failedChangesSettled: number
  violations: string[]
}

/** Each order must occur across the runs, or the property proves nothing about it. */
const coverage = {
  staleEpochDeliveries: 0,
  olderGenerationDeliveries: 0,
  earlierSentSameGenerationDeliveries: 0,
}

function unansweredReads(world: PropertyWorld): PropertyRead[] {
  return world.reads.filter(read => !read.answered)
}

function syncModel(model: PropertyModel, world: PropertyWorld) {
  model.unanswered = unansweredReads(world).length
}

/** Releases everything scheduled, in the scheduler's order, until nothing is left. */
async function quiesce(world: PropertyWorld) {
  for (let round = 0; round < 100; round += 1) {
    await flush()
    if (world.scheduler.count() === 0) return
    await act(async () => {
      await world.scheduler.waitAll()
    })
  }
  throw new Error('the hook did not come to rest')
}

/** S5, L6 and L7 at quiescence (state model §4.2, §4.3). */
function checkPredicates(world: PropertyWorld, label: string) {
  const shown = world.hook.result.current.model
  const current = world.deliveries.filter(delivery => delivery.read.epoch === world.epoch)
  expect(world.violations, `${label}: L6 at every render`).toEqual([])
  const shownEpoch = world.epochOfModel.get(shown as LoginMethodsModel)
  expect(
    shownEpoch === undefined || shownEpoch === world.epoch,
    `${label}: L6, the shown model was read before the last binding change`
  ).toBe(true)
  if (current.length === 0) {
    expect(shown, `${label}: S5, loading while no answer of this epoch arrived`).toEqual(LOADING)
    const inFlight = unansweredReads(world).some(read => read.epoch === world.epoch)
    expect(inFlight, `${label}: L7, loading with no read in flight`).toBe(true)
    return
  }
  const highest = Math.max(...current.map(delivery => delivery.generation))
  // Of the answers at the highest generation, the one whose read was sent last (round-3 review
  // minor 2): read ids are numbered in send order.
  const reference = current
    .filter(delivery => delivery.generation === highest)
    .sort((a, b) => a.read.id - b.read.id)
    .at(-1)
  expect(shown, `${label}: S5, the newest model at the highest generation`).toBe(reference?.model)
}

class RefreshCommand implements fc.AsyncCommand<PropertyModel, PropertyWorld> {
  check = () => true
  async run(model: PropertyModel, world: PropertyWorld) {
    act(() => world.hook.result.current.refresh())
    syncModel(model, world)
  }
  toString = () => 'Refresh'
}

class AnswerCommand implements fc.AsyncCommand<PropertyModel, PropertyWorld> {
  constructor(
    private readonly pick: number,
    private readonly generation: number,
    private readonly modelIndex: number
  ) {}
  check = (model: Readonly<PropertyModel>) => model.unanswered > 0
  async run(model: PropertyModel, world: PropertyWorld) {
    const pending = unansweredReads(world)
    const read = pending[this.pick % pending.length]
    if (!read) throw new Error('Answer ran with no read in flight')
    read.answered = true
    // A fresh object per answer, so the checks can tell which answer is shown.
    const answer: LoginMethodsAnswer = {
      model: JSON.parse(
        JSON.stringify(ALL_MODELS[this.modelIndex % ALL_MODELS.length])
      ) as LoginMethodsModel,
      generation: this.generation,
    }
    world.epochOfModel.set(answer.model, read.epoch)
    read.deferred.resolve(
      world.scheduler
        .schedule(Promise.resolve(answer), `answer read #${read.id}`)
        .then(delivered => {
          // Recorded before the hook's own continuation runs.
          if (read.epoch < world.epoch) coverage.staleEpochDeliveries += 1
          const sameEpoch = world.deliveries.filter(item => item.read.epoch === read.epoch)
          if (sameEpoch.some(item => item.generation > delivered.generation)) {
            coverage.olderGenerationDeliveries += 1
          }
          if (
            sameEpoch.some(
              item => item.generation === delivered.generation && item.read.id > read.id
            )
          ) {
            coverage.earlierSentSameGenerationDeliveries += 1
          }
          world.deliveries.push({ read, generation: delivered.generation, model: delivered.model })
          return delivered
        })
    )
    syncModel(model, world)
  }
  toString = () =>
    `Answer(read ${this.pick}, generation ${this.generation}, model ${this.modelIndex})`
}

class BindingChangeCommand implements fc.AsyncCommand<PropertyModel, PropertyWorld> {
  constructor(private readonly succeeds: boolean) {}
  check = () => true
  async run(model: PropertyModel, world: PropertyWorld) {
    const succeeds = this.succeeds
    const call = () =>
      world.scheduler
        .schedule(Promise.resolve(), `binding change ${succeeds ? 'succeeds' : 'fails'}`)
        .then(() => {
          if (!succeeds) throw FAILED_SAVE
          return 'state'
        })
    act(() => {
      world.epoch += 1
      world.hook.result.current.runBindingChange(call).then(
        value => {
          if (value !== 'state') world.violations.push(`a change resolved ${String(value)}`)
        },
        (error: unknown) => {
          if (error !== FAILED_SAVE) world.violations.push('a change rethrew another error')
          world.failedChangesSettled += 1
        }
      )
    })
    syncModel(model, world)
  }
  toString = () => `BindingChange(${this.succeeds ? 'succeeds' : 'fails'})`
}

class SettleCommand implements fc.AsyncCommand<PropertyModel, PropertyWorld> {
  check = () => true
  async run(model: PropertyModel, world: PropertyWorld) {
    await quiesce(world)
    checkPredicates(world, 'Settle')
    syncModel(model, world)
  }
  toString = () => 'Settle'
}

const commandArbs: fc.Arbitrary<fc.AsyncCommand<PropertyModel, PropertyWorld>>[] = [
  fc.constant(new RefreshCommand()),
  fc
    .record({
      pick: fc.nat({ max: 7 }),
      generation: fc.nat({ max: 3 }),
      modelIndex: fc.nat({ max: ALL_MODELS.length - 1 }),
    })
    .map(({ pick, generation, modelIndex }) => new AnswerCommand(pick, generation, modelIndex)),
  fc.boolean().map(succeeds => new BindingChangeCommand(succeeds)),
  fc.constant(new SettleCommand()),
]

describe('useLoginMethods: S5, L6 and L7', () => {
  it('holds S5, L6 and L7 under generated answers and binding changes', async () => {
    coverage.staleEpochDeliveries = 0
    coverage.olderGenerationDeliveries = 0
    coverage.earlierSentSameGenerationDeliveries = 0
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(commandArbs, { maxCommands: 24 }),
        async (scheduler, commands) => {
          const reads: PropertyRead[] = []
          const world = {
            scheduler,
            reads,
            deliveries: [],
            epochOfModel: new Map(),
            epoch: 0,
            failedChangesSettled: 0,
            violations: [],
          } as unknown as PropertyWorld
          window.clerum = {
            ...window.clerum,
            auth: {
              ...window.clerum?.auth,
              getLoginMethods: () => {
                const read: PropertyRead = {
                  id: reads.length,
                  epoch: world.epoch,
                  deferred: deferred<LoginMethodsAnswer>(),
                  answered: false,
                }
                reads.push(read)
                return read.deferred.promise
              },
            },
          } as never
          world.refreshRuntimeConfigState = vi.fn(async () => undefined)
          world.hook = renderHook(() => {
            const result = useLoginMethods({
              refreshRuntimeConfigState: world.refreshRuntimeConfigState,
            })
            // L6 at every render: an answer read before the last binding change never shows.
            const epochOfShown = world.epochOfModel.get(result.model as LoginMethodsModel)
            if (epochOfShown !== undefined && epochOfShown < world.epoch) {
              world.violations.push(`epoch ${epochOfShown} model shown in epoch ${world.epoch}`)
            }
            return result
          })
          try {
            const model: PropertyModel = { unanswered: 0 }
            // The login screen's show sends the first read (E12).
            const scenario = [new RefreshCommand(), ...commands, new SettleCommand()]
            await fc.asyncModelRun(() => ({ model, real: world }), scenario)
            // Main answers every read still in flight; then nothing is in flight (L7).
            for (let round = 0; unansweredReads(world).length > 0; round += 1) {
              if (round >= 50) throw new Error('reads kept arriving')
              await new AnswerCommand(0, 0, round).run(model, world)
              await quiesce(world)
            }
            checkPredicates(world, 'end')
            expect(world.hook.result.current.model, 'L7 at the end').not.toEqual(LOADING)
            expect(world.refreshRuntimeConfigState).toHaveBeenCalledTimes(
              world.failedChangesSettled
            )
          } finally {
            world.hook.unmount()
            cleanup()
          }
        }
      ),
      { numRuns: 200, seed: 24112026 }
    )
    expect(
      coverage.staleEpochDeliveries,
      'an answer arrived after a binding change'
    ).toBeGreaterThan(0)
    expect(
      coverage.olderGenerationDeliveries,
      'an answer arrived after a newer one of its epoch'
    ).toBeGreaterThan(0)
    expect(
      coverage.earlierSentSameGenerationDeliveries,
      'an answer arrived after one of its generation whose read was sent later'
    ).toBeGreaterThan(0)
  }, 60_000)
})
