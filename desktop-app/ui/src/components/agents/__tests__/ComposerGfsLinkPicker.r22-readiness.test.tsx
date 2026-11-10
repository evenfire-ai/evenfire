// @vitest-environment jsdom
// Planning artifact. Copy beside the actual component in a disposable exact-source archive.
import { useRef } from 'react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import fc from 'fast-check'
import { writeFileSync } from 'node:fs'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  childView,
  gfsRouteFailureMessage,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../../src/gfs/delegation.js'
import { ComposerGfsLinkPicker } from '../ComposerGfsLinkPicker'
import { type Event, type Page, expected, violations } from '../test-support/composer-reference'

const auth = {
  isAuthenticated: true,
  sessionGeneration: 1,
  me: { id: 'user-1', teamId: 'team-1' },
  runtimeConfigState: { envKey: 'test' },
} as unknown as AuthContextValue
const folder = accessibleResource('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Folder A', 'directory')
const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', folder.resourceId, 'main', 1)
const mode = process.env.R22_MODE ?? 'baseline'
const seed = Number(process.env.R22_SEED ?? 12932201)
const runs = Number(process.env.R22_RUNS ?? 40)
const totals = {
  histories: 0,
  commands: 0,
  checks: 0,
  pairs: 0,
  retirements: 0,
  full: 0,
  forward: 0,
  failures: 0,
  permissions: 0,
  schedulerTasks: 0,
  queryRemovals: 0,
}
const receipts: unknown[] = []
const clients: QueryClient[] = []
type Insert = ComponentProps<typeof ComposerGfsLinkPicker>['onInsert']
function R22Picker({ inserted }: { inserted: Insert }) {
  const controller = useGfsBrowserController({ pickerAuthorityManaged: true })
  const rootAnchorRef = useRef<HTMLElement | null>(null)
  return (
    <ComposerGfsLinkPicker
      controller={controller}
      rootAnchorRef={rootAnchorRef}
      sessionId={22}
      onInsert={inserted}
      onSessionScope={() => {}}
      onEscapeRoot={() => {}}
    />
  )
}
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(c => c.clear())
  delete (window as Partial<Window>).clerum
})
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 80; i++) {
    await flush()
    if (predicate()) return
  }
  throw new Error(`Finite liveness deadline: ${label}`)
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject, done: false }
}
type Model = { history: Event[]; nextId: number }
async function fixture(s: any, requiredRole = false) {
  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  clients.push(client)
  const calls: Array<ReturnType<typeof deferred<any>> & { cursor: string | null }> = []
  const permission: Array<ReturnType<typeof deferred<any>> & { rid: string }> = []
  const names = new Map<string, string>(),
    entered: string[] = [],
    tasks: Promise<unknown>[] = []
  const inserted = vi.fn<Insert>(),
    promises: Promise<unknown>[] = []
  const m: Model = {
    history: [{ type: 'bind', owner: 'Composer-22', query: 'session1/A/Q0' }],
    nextId: 0,
  }
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        listAccessible: () => listAccessiblePage([folder]),
        listChildren: (_rid: string, _drive: string, cursor?: string) => {
          const d = { ...deferred<any>(), cursor: cursor ?? null }
          calls.push(d)
          return d.promise
        },
        affordances: (rid: string) => {
          const d = { ...deferred<any>(), rid }
          permission.push(d)
          return d.promise
        },
      },
    },
  })
  const view = render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <R22Picker inserted={inserted} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
  const schedule = (label: string, effect: () => void | Promise<void>) => {
    totals.schedulerTasks++
    const p = s.schedule(Promise.resolve(), label).then(async () => {
      entered.push(label)
      await effect()
    })
    tasks.push(p)
    return p
  }
  const r = {
    removed: false,
    queryObject: null as unknown,
    s,
    client,
    calls,
    permission,
    names,
    tasks,
    entered,
    inserted,
    promises,
    view,
    schedule,
    lane: (mode === 'implemented'
      ? requiredRole
        ? 'pre-role'
        : 'implemented'
      : 'common-baseline') as 'implemented' | 'pre-role' | 'common-baseline',
  }
  await until(() => permission.length > 0, 'root exact allow starts')
  await permissions(m, r)
  await until(
    () => !!screen.queryByRole('menuitem', { name: 'Insert folder Folder A' }),
    'real root row'
  )
  begin(m, 'full', 'bind')
  act(() => fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Insert folder Folder A' })))
  await until(() => calls.length === 1, 'actual child initial read')
  r.queryObject = client.getQueryCache().find({ queryKey: key, exact: true })
  expect(r.queryObject).toBeTruthy()
  await release(m, r, false, false, false)
  await permissions(m, r)
  await start(m, r, 'forward')
  await release(m, r, false, false, false)
  await permissions(m, r)
  // Two real boundary promises must be concurrently scheduled in every history.
  // Older exact-allowed rows keep Load more reachable while new P3 permission is held.
  await start(m, r, 'forward')
  await release(m, r, false, false, false)
  await start(m, r, 'forward')
  await release(m, r, false, false, true)
  await permissions(m, r)
  await compare(m, r)
  return { m, r }
}
type Real = Awaited<ReturnType<typeof fixture>>['r']
function begin(m: Model, kind: 'full' | 'forward', reason: 'bind' | 'independent' | 'user') {
  const e = expected(m.history)
  m.history.push({
    type: 'begin',
    id: m.nextId++,
    kind,
    target: kind === 'full' ? Math.max(1, e.accepted.length) : 1,
    cursor: kind === 'full' ? null : e.next,
    query: e.query,
    reason,
  })
  totals[kind]++
}
async function permissions(m: Model, r: Real) {
  // Drain physical boundary reads, including obsolete ones, without reading private hook state.
  for (let turn = 0; turn < 12; turn++) {
    await flush()
    const pending = r.permission.filter(p => !p.done)
    if (!pending.length) return
    const ps = pending.map(p =>
      r.schedule(`allow:${p.rid}`, () => {
        p.done = true
        totals.permissions++
        const name = r.names.get(p.rid)
        if (name) m.history.push({ type: 'allow', name, allowed: true })
        p.resolve(delegationAffordances(new Set(['read']), false))
      })
    )
    await act(async () => {
      await r.s.waitFor(Promise.all(ps))
    })
  }
  throw new Error('Permission queue did not settle')
}
async function compare(m: Model, r: Real, quiescent = false) {
  await flush()
  if (r.removed)
    expect(r.client.getQueryCache().find({ queryKey: key, exact: true })).toBeUndefined()
  else expect(r.client.getQueryCache().find({ queryKey: key, exact: true })).toBe(r.queryObject)
  // This oracle models the active child Query. The root folder remains visible as a
  // selectable insertion row in the cascading-menu design, so exclude ancestor panels.
  const activeList = Array.from(document.querySelectorAll('.composer-gfs-picker-list')).at(-1)
  const observed = {
    names: Array.from(activeList?.querySelectorAll('.composer-gfs-picker-insert') ?? []).map(el =>
      el.getAttribute('aria-label')!.replace(/^(Insert link to|Insert folder) /, '')
    ),
    error:
      !!r.view.container.querySelector('.composer-gfs-picker-error')?.textContent ||
      !!screen.queryByText('Could not load your files'),
    retry: !!screen.queryByRole('button', { name: 'Retry file listing' }),
    retryBusy: !!(
      screen.queryByRole('button', { name: 'Retry file listing' }) as HTMLButtonElement | null
    )?.disabled,
    forwardDisabled: !!(
      r.view.container.querySelector('.composer-gfs-picker-more') as HTMLButtonElement | null
    )?.disabled,
    calls: r.calls.map(c => c.cursor),
    inserted: r.inserted.mock.calls.length,
    menu: !!screen.queryByRole('menu', { name: 'EvenDrive links' }),
  }
  expect(violations(m.history, observed, r.lane, quiescent)).toEqual([])
  totals.checks++
}
async function start(m: Model, r: Real, kind: 'full' | 'forward') {
  begin(m, kind, 'independent')
  act(() => {
    if (kind === 'full') r.promises.push(r.client.invalidateQueries({ queryKey: key, exact: true }))
    else fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  })
  await until(
    () => r.calls.length === expected(m.history).calls.length,
    'expected network admission'
  )
  await compare(m, r)
}
async function release(
  m: Model,
  r: Real,
  fail: boolean,
  early: boolean,
  pair: boolean,
  retireAlongside = false
) {
  const before = expected(m.history),
    op = (before.active ?? before.reads.find(read => !read.done))!
  const call = r.calls.find(c => !c.done)
  expect(call, 'model expects one active physical listing call').toBeTruthy()
  const suffix = `${op.id}-${op.pages.length + 1}`
  const page: Page = { names: [`Read ${suffix}.md`], next: early ? null : `cursor-${suffix}` }
  const rid = (op.id * 10 + op.pages.length + 11).toString(16).padStart(32, '0')
  r.names.set(rid, page.names[0]!)
  const value = await listChildrenPage(
    [childView(rid, page.names[0]!, 'file', { parentResourceId: folder.resourceId })],
    page.next
  )
  const message = fail
    ? await gfsRouteFailureMessage(
        client =>
          client.listChildren(folder.resourceId, 'fixture-session-token', { drive: 'main' }),
        500,
        { code: 'internal_error', message: `ordinary full ${suffix}` }
      )
    : ''
  if (fail) {
    expect(message).toContain('httpStatus=500')
    totals.failures++
  }
  const p = r.schedule(`listing:${suffix}:${fail ? '500' : 'ok'}`, () => {
    call!.done = true
    m.history.push(fail ? { type: 'fail', id: op.id, message } : { type: 'page', id: op.id, page })
    // A waiting user obligation independently predicts one native full after forward.
    // This is not a production dispatch/status observation.
    if (mode === 'implemented' && expected(m.history).owesFull) begin(m, 'full', 'user')
    if (fail) call!.reject(new Error(message))
    else call!.resolve(value)
  })
  const list = [p]
  if (pair) {
    const permission = r.permission.find(p => !p.done)
    if (permission) {
      totals.pairs++
      list.push(
        r.schedule(`paired-allow:${permission.rid}`, () => {
          permission.done = true
          totals.permissions++
          const name = r.names.get(permission.rid)
          if (name) m.history.push({ type: 'allow', name, allowed: true })
          permission.resolve(delegationAffordances(new Set(['read']), false))
        })
      )
    }
  }
  if (retireAlongside) {
    totals.pairs++
    list.push(
      r.schedule('paired-owner-retirement', () => {
        m.history.push({ type: 'retire', subject: 'owner' })
        totals.retirements++
        r.view.unmount()
      })
    )
  }
  await act(async () => {
    await r.s.waitFor(Promise.all(list))
  })
  await until(
    () => r.calls.length === expected(m.history).calls.length,
    'sequential native page entry'
  )
  await flush()
  // A completed read may enqueue new exact-allow work. Kept held for generated pair commands.
}
async function retire(m: Model, r: Real) {
  m.history.push({ type: 'retire', subject: 'owner' })
  totals.retirements++
  act(() => r.view.unmount())
  await flush()
  await compare(m, r)
}
async function removeQuery(m: Model, r: Real) {
  const e = expected(m.history)
  expect(e.live).toBe(false) // current-source removal control retires its real observer first
  m.history.push({ type: 'retire', subject: 'query' })
  if (e.active) m.history.push({ type: 'cancel', id: e.active.id })
  r.removed = true
  totals.queryRemovals++
  act(() => r.client.removeQueries({ queryKey: key, exact: true }))
  await flush()
  await compare(m, r)
}
async function retry(m: Model, r: Real, pair: boolean) {
  const before = expected(m.history)
  m.history.push({ type: 'retry' })
  if (!before.active) begin(m, 'full', 'user')
  const button = screen.getByRole('button', { name: 'Retry file listing' })
  act(() => {
    fireEvent.click(button)
    if (pair) {
      m.history.push({ type: 'retry' })
      fireEvent.click(button)
    }
  })
  await until(() => r.calls.length === expected(m.history).calls.length, 'Retry starts or joins')
  await compare(m, r)
}
class Command {
  constructor(
    readonly kind: string,
    readonly fail = false,
    readonly early = false
  ) {}
  check(m: Model) {
    const e = expected(m.history)
    if (this.kind === 'resolve' || this.kind === 'pair') return !!e.active
    if (this.kind === 'race-retire') return e.live && !!e.active && !e.intent
    if (this.kind === 'retire') return e.live
    if (this.kind === 'full')
      return e.live && !e.active && !e.intent && e.visible.length === e.names.length
    if (this.kind === 'forward')
      return e.live && !e.active && e.next !== null && !e.forwardBlocked && e.visible.length > 0
    if (this.kind === 'remove-query')
      return !e.live && !m.history.some(x => x.type === 'retire' && x.subject === 'query')
    if (this.kind === 'retry')
      return mode === 'implemented' && e.live && e.retryRequired && !e.paused
    return true
  }
  async run(m: Model, r: Real) {
    totals.commands++
    if (this.kind === 'resolve' || this.kind === 'pair')
      await release(m, r, this.fail, this.early, this.kind === 'pair')
    else if (this.kind === 'race-retire') await release(m, r, this.fail, this.early, true, true)
    else if (this.kind === 'full' || this.kind === 'forward') await start(m, r, this.kind)
    else if (this.kind === 'retire') await retire(m, r)
    else if (this.kind === 'remove-query') await removeQuery(m, r)
    else if (this.kind === 'retry') await retry(m, r, true)
    else if (this.kind === 'allow') await permissions(m, r)
    else {
      m.history.push({ type: 'flush' })
      await flush()
    }
    await compare(m, r)
  }
  toString() {
    return `${this.kind}(fail=${this.fail},early=${this.early})`
  }
}
const command = fc.oneof(
  fc.boolean().chain(f => fc.boolean().map(e => new Command('resolve', f, e))),
  fc.boolean().chain(f => fc.boolean().map(e => new Command('pair', f, e))),
  ...['full', 'forward', 'allow', 'flush', 'retire', 'race-retire', 'remove-query', 'retry'].map(
    k => fc.constant(new Command(k))
  )
)
async function finish(m: Model, r: Real) {
  if (!expected(m.history).live && !r.removed) await removeQuery(m, r)
  for (let i = 0; i < 64 && expected(m.history).physicalPending; i++)
    await release(m, r, false, false, true)
  await permissions(m, r)
  await r.s.waitAll()
  await Promise.all(r.tasks)
  await Promise.all(r.promises)
  await flush()
  expect(r.calls.every(c => c.done)).toBe(true)
  expect(r.permission.every(c => c.done)).toBe(true)
  expect(r.s.count()).toBe(0)
  expect(r.client.isFetching()).toBe(0)
  await compare(m, r, true)
}
async function dispose(r: Real) {
  act(() => r.view.unmount())
  r.client.clear()
  await flush()
}
function receipt(m: Model, r: Real) {
  receipts.push({
    history: m.history,
    cursors: r.calls.map(c => c.cursor),
    completionOrder: r.entered,
    schedule: r.s.report(),
    allPhysicalSettled: r.calls.every(c => c.done) && r.permission.every(c => c.done),
    schedulerPending: r.s.count(),
  })
}
function save(lane: string) {
  console.log('R22-RESULT', JSON.stringify({ lane, seed, runs, ...totals }))
  if (process.env.R22_JOURNAL)
    writeFileSync(
      process.env.R22_JOURNAL,
      JSON.stringify({ lane, seed, runs, totals, receipts }, null, 2) + '\n'
    )
}
describe('R22 generated mounted Composer readiness', () => {
  it('common baseline: generated user/network/owner histories against pure product model', async () => {
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.commands([command], { maxCommands: 18 }),
          fc.scheduler(),
          async (commands, s) => {
            const { m, r } = await fixture(s)
            try {
              await fc.asyncModelRun(() => ({ model: m, real: r }), commands)
              await finish(m, r)
              receipt(m, r)
              totals.histories++
            } finally {
              await dispose(r)
            }
          }
        ),
        { seed, numRuns: runs, endOnFailure: true }
      )
    } finally {
      save('common-baseline')
    }
  }, 120_000)

  it.skipIf(mode === 'controls')(
    'required Retry: generated retained-full-error history (EXPECTED BASELINE MISSING ROLE)',
    async () => {
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.commands(
              [
                fc.oneof(
                  ...['full', 'forward', 'allow', 'flush'].map(k => fc.constant(new Command(k))),
                  fc.boolean().map(f => new Command('resolve', f)),
                  fc.boolean().map(f => new Command('pair', f))
                ),
              ],
              { maxCommands: 10 }
            ),
            fc.scheduler(),
            async (commands, s) => {
              const { m, r } = await fixture(s, true)
              try {
                // Commands before the mandatory R87 suffix explore real completions/permissions.
                // Retiring owner is excluded here by taking a valid command subset, not by reading DOM.
                await fc.asyncModelRun(() => ({ model: m, real: r }), commands)
                await finish(m, r)
                if (expected(m.history).error !== null) {
                  // A separate explicit full is a real public boundary for baseline fixture preparation.
                  await start(m, r, 'full')
                  await finish(m, r)
                }
                // Establish two pages even if a generated earlier producer ended at page one.
                if (expected(m.history).accepted.length < 2) {
                  await start(m, r, 'forward')
                  await finish(m, r)
                }
                if (expected(m.history).accepted.length > 2) {
                  await start(m, r, 'full')
                  await release(m, r, false, false, true)
                  await release(m, r, false, true, true)
                  await finish(m, r)
                }
                await start(m, r, 'full')
                await release(m, r, false, false, true)
                await compare(m, r) // meaningful held-final-page withholding check
                await release(m, r, true, false, true)
                await finish(m, r)
                const e = expected(m.history)
                expect(e.accepted.length).toBe(2)
                expect(e.retryRequired).toBe(true)
                expect(e.physicalPending).toBe(0)
                expect(screen.getByText('Folder A')).toBeTruthy()
                expect(
                  screen.queryByRole('button', { name: 'Retry resource permission checks' })
                ).toBeNull()
                receipt(m, r)
                totals.histories++
                save('required-retry-precondition')
                // First spec-only assertion in the baseline lane. Do not invert, catch or expect-fail it.
                if (mode === 'implemented') {
                  const more = r.view.container.querySelector(
                    '.composer-gfs-picker-more'
                  ) as HTMLButtonElement | null
                  if (e.next !== null) expect(more?.disabled).toBe(true)
                  else expect(more).toBeNull()
                }
                const button = screen.getByRole('button', { name: 'Retry file listing' })
                expect((button as HTMLButtonElement).disabled).toBe(false)
                if (mode === 'implemented') {
                  r.lane = 'implemented'
                  await retry(m, r, true)
                  await finish(m, r)
                }
              } finally {
                await dispose(r)
              }
            }
          ),
          { seed, numRuns: 1, endOnFailure: true }
        )
      } finally {
        save('required-retry')
      }
    },
    120_000
  )
})
