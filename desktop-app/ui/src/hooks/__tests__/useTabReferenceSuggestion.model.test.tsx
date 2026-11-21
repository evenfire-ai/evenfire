// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { TAB_REFERENCE_RETRY_DELAYS_MS } from '@constants/tabReferenceSuggestion'
import type { ResolvedGfsResource } from '../../../../src/gfs/uriHandler'
import {
  type NavigationResolution,
  gfscResourceView,
  resolvedNavigation,
  supersededNavigation,
  unavailableNavigation,
} from '../../gfs/__fixtures__/navigationResolutionFixtures'
import { gfsWatchKey, parseGfsWatchKey } from '../../lib/gfsWatchKeys'
import {
  activeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  openFilesTab,
  openPreviewTab,
  openSettingsTab,
  refreshPreviewTab,
} from '../../lib/workspaceTabs'
import type { WorkspaceTabsState } from '../../lib/workspaceTabs.types'
import { useTabReferenceSuggestion } from '../useTabReferenceSuggestion'
import type { TabReferenceSuggestionInput } from '../useTabReferenceSuggestion.types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Model-based oracle for the tab reference prefetch.
 *
 * Generated sequences run against the real hook, rendered in StrictMode:
 * tab switches (including back to a cached file), drawer toggles, session
 * changes, a preview going unavailable and back, watched and unwatched file
 * changes, server outcomes and timer advances. Only `resolveForNavigation` is
 * mocked. Its answers come from gfs-controller's `toView` through `AppService`,
 * and `fc.scheduler()` decides when each one lands, so answers cross tab
 * switches, drawer toggles, session changes and each other.
 *
 * A reference model replays the same events: one cached entry, the live
 * request, the count of consecutive failures per key and the pending retry. It
 * predicts every request before the hook makes it:
 *
 * - each request the hook makes must be the next predicted one, for the same
 *   file; an unpredicted, missing or extra request fails, so StrictMode
 *   duplicates, a missing dedupe or a retry at the wrong time are caught in the
 *   step where they happen;
 * - the backoffs the hook passes to `setTimeout` are, in order, the ones the
 *   reference expects (2 s after the first failure in a row, 8 s after the
 *   second);
 * - after every step the hook has a pending retry timer exactly when the
 *   reference has one.
 *
 * At rest (scheduler and timers drained) it asserts:
 *
 * - the chip equals the model's prediction: nothing without a visible target,
 *   otherwise the cached candidate if it is the same file, the same scope and,
 *   for a preview, not older than the version on screen; that covers the
 *   stale-while-revalidate answer shown while a revalidation retries, and its
 *   loss once the revalidation gives up;
 * - independently of the model, whatever is shown is the current file, resolved
 *   under the current scope and not older than the preview (S4), and nothing is
 *   shown without a visible target (L3);
 * - from the call log: every request of a visit but the first follows an
 *   applied transient answer for the same key that was not yet the third in a
 *   row, and no visit makes more than three requests (K1). A request without a
 *   visible target is never predicted, so it fails as unpredicted;
 * - if the last applied answer for the current key was transient, it was the
 *   third in a row; if it was usable, the chip is exactly that answer (L1, S6).
 *
 * Left to the scenario tests:
 *
 * - unmounting, so the guard against a retry set after unmount;
 * - that a success resets the failure count of its key. The reference does
 *   reset it, but a disagreement needs a failure, a success, the cache moving
 *   to another key and a failure on return, in that order, and random
 *   sequences of this length do not reach it reliably.
 */

const IDS = {
  a: '0b9f3c1e-7a42-4d4e-9c1a-5f6e7d8c9b0a',
  b: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
} as const
type FileName = keyof typeof IDS
const FILES: FileName[] = ['a', 'b']
const SCOPES = ['dev:true:user-1:', 'dev:true:user-1:team-2'] as const
const MAX_VERSION = 6
type Mode = 'usable' | 'stale' | 'directory' | 'otherFile' | 'superseded' | 'unavailable' | 'reject'
const MODES: Mode[] = [
  'usable',
  'stale',
  'directory',
  'otherFile',
  'superseded',
  'unavailable',
  'reject',
]
type Tab = 'previewA' | 'filesA' | 'filesB' | 'settings'

/** Every answer the server can give, produced once by the real producers. */
type Answers = {
  resolved: Record<FileName, Record<string, ResolvedGfsResource[]>>
  envelopes: Map<ResolvedGfsResource, NavigationResolution>
  directory: Record<FileName, NavigationResolution>
  unavailable: NavigationResolution
  superseded: NavigationResolution
}
let answers: Answers
let URI: Record<FileName, string>

beforeAll(async () => {
  const resolved = { a: {}, b: {} } as Answers['resolved']
  const envelopes = new Map<ResolvedGfsResource, NavigationResolution>()
  for (const file of FILES) {
    for (const scope of SCOPES) {
      const views: ResolvedGfsResource[] = []
      for (let version = 0; version <= MAX_VERSION; version += 1) {
        // The name records the scope the answer was produced under, so a
        // candidate from another session is visible in the oracle.
        const view = await gfscResourceView({
          resourceId: IDS[file],
          name: `${file}@${scope}.md`,
          version,
          bytes: 10 + version,
        })
        views.push(view)
        envelopes.set(view, await resolvedNavigation(view))
      }
      resolved[file][scope] = views
    }
  }
  URI = { a: resolved.a[SCOPES[0]]![1]!.gfsUri, b: resolved.b[SCOPES[0]]![1]!.gfsUri }
  const directory = {} as Answers['directory']
  for (const file of FILES) {
    directory[file] = await resolvedNavigation(
      await gfscResourceView({
        resourceId: IDS[file],
        name: file,
        version: 1,
        bytes: 0,
        kind: 'directory',
      })
    )
  }
  answers = {
    resolved,
    envelopes,
    directory,
    unavailable: await unavailableNavigation(URI.a),
    superseded: await supersededNavigation(URI.a),
  }
})

const DELAYS = TAB_REFERENCE_RETRY_DELAYS_MS
const MAX_ATTEMPTS = DELAYS.length + 1

interface Model {
  tab: Tab
  drawer: boolean
  scope: (typeof SCOPES)[number]
  /** Mirrors the hook's observed-change counter of the current target. */
  revision: number
  serverVersion: Record<FileName, number>
  mode: Record<FileName, Mode>
  preview: WorkspaceTabsState
}

type Verdict = { usable: ResolvedGfsResource } | 'unusable' | 'transient'

type Call = {
  id: number
  requestKey: string
  uri: string
  scope: string
  floor: number | undefined
  visit: number
  answer: NavigationResolution | 'reject'
  /** Whether the answer reached the cache, or was dropped as stale. */
  applied?: boolean
  verdict?: Verdict
  /** For a transient answer that was applied: its place in the run of failures. */
  failureRun?: number
}

/** What the hook should hold, replayed from the same events. */
interface Reference {
  cache: {
    requestKey: string
    uri: string
    scope: string
    result: { status: 'ready'; view: ResolvedGfsResource } | { status: 'none' }
  } | null
  live: number | null
  failures: { requestKey: string; n: number } | null
  timer: { requestKey: string; due: number } | null
  lastKey: string | null | undefined
}

interface Real {
  hook: ReturnType<
    typeof renderHook<ReturnType<typeof useTabReferenceSuggestion>, TabReferenceSuggestionInput>
  >
  scheduler: Scheduler
  model: Model
  ref: Reference
  calls: Call[]
  /** Predicted requests the hook has not made yet. */
  expected: number[]
  violations: string[]
  /** Backoffs the reference expects, and the ones the hook really scheduled, in order. */
  expectedDelays: number[]
  scheduledDelays: number[]
  visit: number
  visitKey: string | null
}

function previewTab(model: Model) {
  return activeWorkspaceTab(model.preview)!
}

function targetOf(model: Model): { file: FileName; key: string; floor: number | undefined } | null {
  if (model.tab === 'settings') return null
  if (model.tab === 'previewA') {
    const preview = previewTab(model).preview!
    if (preview.unavailable) return null
    return {
      file: 'a',
      key: `${URI.a}#${preview.reloadVersion ?? 0}#${preview.resourceVersion ?? ''}`,
      floor: preview.resourceVersion,
    }
  }
  const file: FileName = model.tab === 'filesA' ? 'a' : 'b'
  return { file, key: `${URI[file]}#r${model.revision}`, floor: undefined }
}

function requestKeyOf(model: Model): string | null {
  const target = targetOf(model)
  return target && model.drawer ? `${model.scope}|${target.key}` : null
}

function inputOf(model: Model): TabReferenceSuggestionInput {
  const base = { authorityScope: model.scope, drawerVisible: model.drawer }
  switch (model.tab) {
    case 'previewA':
      return {
        ...base,
        activeTab: previewTab(model),
        navItem: DESKTOP_ROUTES.preview,
        filesResolvedLocation: null,
      }
    case 'filesA':
    case 'filesB': {
      const uri = URI[model.tab === 'filesA' ? 'a' : 'b']
      return {
        ...base,
        activeTab: activeWorkspaceTab(
          openFilesTab(createEmptyWorkspaceTabsState(), { id: 'files-1', path: uri })
        ),
        navItem: DESKTOP_ROUTES.files,
        filesResolvedLocation: { gfsUri: uri, kind: 'file' },
      }
    }
    case 'settings':
      return {
        ...base,
        activeTab: activeWorkspaceTab(
          openSettingsTab(createEmptyWorkspaceTabsState(), {
            id: 'settings-1',
            section: 'settings',
          })
        ),
        navItem: DESKTOP_ROUTES.settings,
        filesResolvedLocation: null,
      }
  }
}

function answerFor(model: Model, file: FileName): NavigationResolution | 'reject' {
  const version = model.serverVersion[file]
  switch (model.mode[file]) {
    case 'usable':
      return answers.envelopes.get(answers.resolved[file][model.scope]![version]!)!
    case 'stale':
      return answers.envelopes.get(answers.resolved[file][model.scope]![version - 1]!)!
    case 'directory':
      return answers.directory[file]
    // Hardening: the producer resolves a URI to the resource it names, so an
    // answer for another file only stands for a server bug.
    case 'otherFile':
      return answers.envelopes.get(answers.resolved[file === 'a' ? 'b' : 'a'][model.scope]![1]!)!
    case 'superseded':
      return answers.superseded
    case 'unavailable':
      return answers.unavailable
    case 'reject':
      return 'reject'
  }
}

/** The reference's own reading of an answer: usable, final, or worth retrying. */
function verdict(
  answer: NavigationResolution | 'reject',
  uri: string,
  floor: number | undefined
): Verdict {
  if (answer === 'reject' || answer.status !== 'resolved') return 'transient'
  const resource = answer.resource
  if (resource.kind !== 'file' || resource.gfsUri !== uri) return 'unusable'
  if (floor !== undefined && resource.version < floor) return 'transient'
  return { usable: resource }
}

function shownFrom(
  cache: Reference['cache'],
  uri: string,
  scope: string,
  floor: number | undefined
): ResolvedGfsResource | null {
  if (!cache || cache.result.status !== 'ready') return null
  if (cache.uri !== uri || cache.scope !== scope) return null
  if (floor !== undefined && cache.result.view.version < floor) return null
  return cache.result.view
}

/** The visit the hook is in: a new one starts whenever the request key changes. */
function currentVisit(real: Real): number {
  const key = requestKeyOf(real.model)
  if (key !== real.visitKey) {
    real.visit += 1
    real.visitKey = key
  }
  return real.visit
}

function predictRequest(real: Real, requestKey: string) {
  const target = targetOf(real.model)!
  const call: Call = {
    id: real.calls.length,
    requestKey,
    uri: URI[target.file],
    scope: real.model.scope,
    floor: target.floor,
    visit: currentVisit(real),
    answer: answerFor(real.model, target.file),
  }
  real.calls.push(call)
  real.expected.push(call.id)
  real.ref.live = call.id
}

/** The hook's effect, as the reference sees it, after its request key may have moved. */
function referenceKeyChanged(real: Real) {
  const { ref } = real
  const key = requestKeyOf(real.model)
  if (key === ref.lastKey) return
  ref.lastKey = key
  currentVisit(real)
  if (ref.timer && ref.timer.requestKey !== key) ref.timer = null
  if (key === null) {
    ref.live = null
    return
  }
  if (ref.cache?.requestKey === key) {
    ref.live = null
    return
  }
  if (ref.live !== null && real.calls[ref.live]!.requestKey === key) return
  predictRequest(real, key)
}

function referenceSettled(real: Real, id: number) {
  const { ref } = real
  const call = real.calls[id]!
  call.applied = ref.live === id
  if (!call.applied) return
  ref.live = null
  const outcome = verdict(call.answer, call.uri, call.floor)
  call.verdict = outcome
  const entry = { requestKey: call.requestKey, uri: call.uri, scope: call.scope }
  if (outcome !== 'transient') {
    ref.failures = null
    ref.cache = {
      ...entry,
      result:
        outcome === 'unusable' ? { status: 'none' } : { status: 'ready', view: outcome.usable },
    }
    return
  }
  const n = ref.failures?.requestKey === call.requestKey ? ref.failures.n + 1 : 1
  ref.failures = { requestKey: call.requestKey, n }
  call.failureRun = n
  if (n >= MAX_ATTEMPTS) {
    ref.cache = { ...entry, result: { status: 'none' } }
    return
  }
  ref.timer = { requestKey: call.requestKey, due: Date.now() + DELAYS[n - 1]! }
  real.expectedDelays.push(DELAYS[n - 1]!)
}

function referenceTimerFired(real: Real) {
  const timer = real.ref.timer!
  real.ref.timer = null
  predictRequest(real, timer.requestKey)
}

function expectInStep(real: Real, label: string) {
  if (real.expected.length > 0) {
    real.violations.push(`${label}: predicted request #${real.expected[0]} was not made`)
  }
  // Only one request is live at a time, so retries are scheduled one at a time
  // and the two sequences line up.
  if (real.scheduledDelays.join() !== real.expectedDelays.join()) {
    real.violations.push(
      `${label}: retries scheduled after ${real.scheduledDelays.join()} ms, expected ${real.expectedDelays.join()} ms`
    )
  }
  expect(real.violations, 'the hook diverged from the reference').toEqual([])
}

/** Re-render with the model. */
function sync(real: Real, label: string) {
  referenceKeyChanged(real)
  act(() => {
    real.hook.rerender(inputOf(real.model))
  })
  expectInStep(real, label)
  expectTimersAgree(real, label)
}

function expectTimersAgree(real: Real, label: string) {
  expect(vi.getTimerCount(), `${label}: pending retry timers`).toBe(real.ref.timer ? 1 : 0)
}

async function drain(real: Real) {
  for (let round = 0; round < 40; round += 1) {
    await act(async () => {
      await real.scheduler.waitAll()
    })
    if (real.scheduler.count() > 0) continue
    expectTimersAgree(real, 'drain')
    if (!real.ref.timer) return
    referenceTimerFired(real)
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expectInStep(real, 'retry')
  }
  throw new Error('the hook did not come to rest')
}

function referenceOf(view: ResolvedGfsResource) {
  return {
    id: `global-file:${view.drive}:${view.resourceId}`,
    type: 'global_file',
    resourceId: view.resourceId,
    drive: view.drive,
    gfsUri: view.gfsUri,
    label: view.name,
    version: view.version,
    bytes: view.bytes,
  }
}

async function assertAtRest(real: Real) {
  await drain(real)
  expectInStep(real, 'rest')
  const { model } = real
  const candidate = real.hook.result.current.candidate
  const target = targetOf(model)
  const uri = target ? URI[target.file] : null

  // The chip the reference predicts.
  const predicted =
    target && model.drawer ? shownFrom(real.ref.cache, uri!, model.scope, target.floor) : null
  expect(candidate, 'the chip the reference predicts').toEqual(
    predicted ? referenceOf(predicted) : null
  )

  // From the call log alone.
  const byVisit = new Map<number, Call[]>()
  for (const call of real.calls) byVisit.set(call.visit, [...(byVisit.get(call.visit) ?? []), call])
  for (const calls of byVisit.values()) {
    expect(calls.length, 'K1: more than three requests in a visit').toBeLessThanOrEqual(3)
    for (let index = 1; index < calls.length; index += 1) {
      const previous = calls[index - 1]!
      const call = calls[index]!
      expect(call.requestKey, 'a visit keeps its key').toBe(previous.requestKey)
      expect(previous.applied && previous.verdict, 'a retry follows a transient answer').toBe(
        'transient'
      )
      expect(previous.failureRun, 'a retry follows fewer than three failures').toBeLessThan(
        MAX_ATTEMPTS
      )
    }
  }

  if (!target || !model.drawer) {
    expect(candidate, 'L3').toBeNull()
    return
  }
  if (candidate) {
    expect(normalizeGfsResourceUri(candidate.gfsUri), 'S4: another file').toBe(uri)
    expect(candidate.label, 'S4: another scope').toBe(`${target.file}@${model.scope}.md`)
    if (target.floor !== undefined) {
      expect(candidate.version, 'S4: older than the preview').toBeGreaterThanOrEqual(target.floor)
    }
  }
  const requestKey = requestKeyOf(model)
  const last = real.calls.filter(call => call.requestKey === requestKey && call.applied).at(-1)
  expect(last, 'L1: no answer was applied for the current key').toBeDefined()
  const outcome = last!.verdict!
  if (outcome === 'unusable') expect(candidate).toBeNull()
  else if (outcome === 'transient') {
    expect(last!.failureRun, 'gave up after exactly three failures').toBe(MAX_ATTEMPTS)
  } else expect(candidate, 'L1/S6').toEqual(referenceOf(outcome.usable))
}

type Cmd = AsyncCommand<Model, Real>

function command(label: string, apply: (model: Model, real: Real) => void): Cmd {
  return {
    check: () => true,
    async run(_model, real) {
      apply(real.model, real)
      sync(real, label)
    },
    toString: () => label,
  }
}

function observeChange(file: FileName): Cmd {
  const label = `watched change of ${file}`
  return {
    check: () => true,
    async run(_model, real) {
      const model = real.model
      if (model.serverVersion[file] >= MAX_VERSION) return
      model.serverVersion[file] += 1
      // `invalidate` compares against the target on screen and re-keys the hook
      // at once, before the preview refresh below reaches it.
      if (targetOf(model)?.file === file) model.revision += 1
      referenceKeyChanged(real)
      // The URI the watch handler derives from the file's real watch key.
      const parts = parseGfsWatchKey(gfsWatchKey('file', URI[file])!)!
      act(() => {
        real.hook.result.current.invalidate(`gfs://${parts.drive}/${parts.rid}`)
      })
      expectInStep(real, label)
      expectTimersAgree(real, label)
      if (file === 'a') {
        model.preview = refreshPreviewTab(model.preview, URI.a, {
          status: 'available',
          title: 'a.md',
          fileKind: 'markdown',
          byteLength: 10 + model.serverVersion.a,
          resourceVersion: model.serverVersion.a,
        })
      }
      sync(real, label)
    },
    toString: () => label,
  }
}

const commandArbs: fc.Arbitrary<Cmd>[] = [
  fc
    .constantFrom<Tab>('previewA', 'filesA', 'filesB', 'settings')
    .map(tab => command(`tab ${tab}`, model => void (model.tab = tab))),
  fc.constant(command('toggle drawer', model => void (model.drawer = !model.drawer))),
  fc.constant(
    command('switch scope', model => {
      model.scope = model.scope === SCOPES[0] ? SCOPES[1] : SCOPES[0]
    })
  ),
  fc.constant(
    command('preview unavailable', model => {
      model.preview = refreshPreviewTab(model.preview, URI.a, {
        status: 'unavailable',
        shellTitle: 'File unavailable',
      })
    })
  ),
  fc.constant(
    command('preview available again', model => {
      model.preview = refreshPreviewTab(model.preview, URI.a, {
        status: 'available',
        title: 'a.md',
        fileKind: 'markdown',
        byteLength: 10 + model.serverVersion.a,
        resourceVersion: model.serverVersion.a,
      })
    })
  ),
  fc.constantFrom<FileName>('a', 'b').map(observeChange),
  fc.constantFrom<FileName>('a', 'b').map(file =>
    command(`unwatched change of ${file}`, model => {
      if (model.serverVersion[file] < MAX_VERSION) model.serverVersion[file] += 1
    })
  ),
  fc
    .tuple(fc.constantFrom<FileName>('a', 'b'), fc.constantFrom(...MODES))
    .map(([file, mode]) =>
      command(`server ${file} ${mode}`, model => void (model.mode[file] = mode))
    ),
  fc.integer({ min: 1, max: 3 }).map(
    (releases): Cmd => ({
      check: () => true,
      async run(_model, real) {
        for (let step = 0; step < releases && real.scheduler.count() > 0; step += 1) {
          await act(async () => {
            await real.scheduler.waitOne()
          })
        }
        expectInStep(real, `release ${releases}`)
        expectTimersAgree(real, `release ${releases}`)
      },
      toString: () => `release ${releases}`,
    })
  ),
  fc.constantFrom(1_000, 2_000, 8_000).map(
    (ms): Cmd => ({
      check: () => true,
      async run(_model, real) {
        const timer = real.ref.timer
        if (timer && timer.due <= Date.now() + ms) referenceTimerFired(real)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms)
        })
        expectInStep(real, `advance ${ms} ms`)
        expectTimersAgree(real, `advance ${ms} ms`)
      },
      toString: () => `advance ${ms} ms`,
    })
  ),
  fc.constant<Cmd>({
    check: () => true,
    run: async (_model, real) => assertAtRest(real),
    toString: () => 'rest',
  }),
]

function setup(scheduler: Scheduler): Real {
  const model: Model = {
    tab: 'filesA',
    drawer: true,
    scope: SCOPES[0],
    revision: 0,
    serverVersion: { a: 1, b: 1 },
    mode: { a: 'usable', b: 'usable' },
    preview: openPreviewTab(createEmptyWorkspaceTabsState(), {
      id: 'preview-1',
      title: 'a.md',
      gfsUri: URI.a,
      fileKind: 'markdown',
      byteLength: 11,
      resourceVersion: 1,
    }),
  }
  const real = {
    scheduler,
    model,
    ref: { cache: null, live: null, failures: null, timer: null, lastKey: undefined },
    calls: [],
    expected: [],
    violations: [],
    expectedDelays: [],
    scheduledDelays: [],
    visit: 0,
    visitKey: null,
  } as unknown as Real
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolveForNavigation: (uri: string) => {
          const id = real.expected.shift()
          const call = id === undefined ? undefined : real.calls[id]
          if (!call || call.uri !== uri) {
            real.violations.push(`unpredicted request for ${uri}`)
            return new Promise(() => undefined)
          }
          return scheduler.schedule(Promise.resolve(), `resolve #${call.id}`).then(() => {
            referenceSettled(real, call.id)
            if (call.answer === 'reject') throw new Error('resolve bridge failed')
            return call.answer
          })
        },
      },
    } as unknown as Window['clerum'],
  })
  // Only the hook under test schedules timers in this environment (the pending
  // count is checked against the reference throughout).
  const fakeSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    real.scheduledDelays.push(ms ?? 0)
    return fakeSetTimeout(handler, ms)
  }) as typeof setTimeout
  referenceKeyChanged(real)
  real.hook = renderHook((props: TabReferenceSuggestionInput) => useTabReferenceSuggestion(props), {
    initialProps: inputOf(model),
    reactStrictMode: true,
  })
  expectInStep(real, 'mount')
  return real
}

describe('useTabReferenceSuggestion — reference model', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('agrees with the reference model for scheduled event sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(commandArbs, { maxCommands: 40, size: 'large' }),
        async (scheduler, commands) => {
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
          const real = setup(scheduler)
          try {
            await fc.asyncModelRun(() => ({ model: real.model, real }), commands)
            await assertAtRest(real)
          } finally {
            real.hook.unmount()
            cleanup()
            vi.useRealTimers()
          }
        }
      ),
      { numRuns: 400 }
    )
  }, 240_000)
})
