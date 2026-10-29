// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import fc from 'fast-check'
import { DRAG_COLD_CHECK_BUDGET, DRAG_COLD_CHECK_DEBOUNCE_MS } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { affordancesResult, heldAffordances } from '../__fixtures__/gfsProducerFixtures'
import { useGfsDragAdjudication } from '../dragAdjudication'
import { GfsDragSessionProvider, GfsDragSessionStore, useGfsDragSession } from '../dragSession'
import type { GfsDropTargetFact, GfsHoverCheckLease } from '../dragSession.types'

const scope = 'test:user-1:team-1'
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({
    isAuthenticated: true,
    me: { id: 'user-1', teamId: 'team-1' },
    runtimeConfigState: { envKey: 'test' },
  }),
}))
function source(id = 'source') {
  return {
    resourceId: id,
    gfsUri: `gfs://main/${id}`,
    drive: 'main',
    kind: 'file' as const,
    name: id,
    parentKnown: true,
    parentResourceId: 'parent',
    knownAncestorIds: ['parent'],
    origin: 'sidebar' as const,
    scope,
  }
}
function target(id: string): GfsDropTargetFact {
  return { resourceId: id, name: id, kind: 'directory', ancestorIds: ['parent', null] }
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function setup(provider = true) {
  const bits = await affordancesResult(heldAffordances(['read', 'write', 'delete']))
  const gates = new Map<string, Promise<void>>()
  const release = new Map<string, () => void>()
  const affordances = vi.fn(async (id: string) => {
    await gates.get(id)
    return bits
  })
  Object.defineProperty(window, 'clerum', { configurable: true, value: { gfs: { affordances } } })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {provider ? <GfsDragSessionProvider>{children}</GfsDragSessionProvider> : children}
    </QueryClientProvider>
  )
  const hook = renderHook(
    () => {
      const session = useGfsDragSession()
      const first = useGfsDragAdjudication({ scope, resolve: vi.fn() })
      const second = useGfsDragAdjudication({ scope, resolve: vi.fn() })
      return { session, first, second }
    },
    { wrapper }
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const begin = (id = 'source', instance: 'first' | 'second' = 'first') => {
    hook.result.current.session?.beginDrag(source(id))
    hook.result.current[instance].beginDragSession()
  }
  begin()
  const dwell = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAG_COLD_CHECK_DEBOUNCE_MS)
    })
  }
  const block = (id: string) => {
    gates.set(
      id,
      new Promise<void>(resolve => {
        release.set(id, resolve)
      })
    )
  }
  const complete = async (id: string) => {
    await act(async () => {
      release.get(id)?.()
    })
  }
  return { ...hook, begin, dwell, affordances, queryClient, bits, block, complete }
}

describe('gesture-owned hover budget (R1-M2)', () => {
  it.each([true, false])(
    'canceled dwells are free and the last hovered target is checked (provider=%s)',
    async provider => {
      const h = await setup(provider)
      const done = vi.fn()
      for (let i = 0; i < 20; i++)
        h.result.current.first.scheduleColdCheck(target(`canceled-${i}`), 'main', null, done)
      await h.dwell()
      expect(h.affordances.mock.calls.map(call => call[0])).toEqual(['canceled-19'])
      for (let i = 1; i < DRAG_COLD_CHECK_BUDGET; i++) {
        h.result.current.first.scheduleColdCheck(target(`next-${i}`), 'main', null, done)
        await h.dwell()
      }
      h.result.current.first.scheduleColdCheck(target('over-budget'), 'main', null, done)
      await h.dwell()
      expect(h.affordances).toHaveBeenCalledTimes(DRAG_COLD_CHECK_BUDGET)
      expect(done).toHaveBeenCalledTimes(DRAG_COLD_CHECK_BUDGET)
    }
  )

  it('shares eight dispatched checks across the two hook instances', async () => {
    const h = await setup()
    const done = vi.fn()
    for (let i = 0; i <= DRAG_COLD_CHECK_BUDGET; i++) {
      h.result.current[i % 2 ? 'second' : 'first'].scheduleColdCheck(
        target(`target-${i}`),
        'main',
        null,
        done
      )
      await h.dwell()
    }
    expect(h.affordances).toHaveBeenCalledTimes(DRAG_COLD_CHECK_BUDGET)
    expect(done).toHaveBeenCalledTimes(DRAG_COLD_CHECK_BUDGET)
    // Cached verdicts consume no budget even after all cold leases are spent.
    h.result.current.second.scheduleColdCheck(target('target-0'), 'main', null, done)
    await h.dwell()
    expect(done).toHaveBeenCalledTimes(DRAG_COLD_CHECK_BUDGET + 1)
    expect(h.affordances).toHaveBeenCalledTimes(DRAG_COLD_CHECK_BUDGET)
    const decision = await h.result.current.second.adjudicateDrop(
      { ...source(), generation: 1 },
      target('priority-drop')
    )
    expect(decision.allowed).toBe(true)
  })

  it('bounds concurrent probe chains across surfaces and reuses a completed slot', async () => {
    const h = await setup()
    h.block('a')
    h.block('b')
    h.result.current.first.scheduleColdCheck(target('a'), 'main', null, vi.fn())
    await h.dwell()
    h.result.current.second.scheduleColdCheck(target('b'), 'main', null, vi.fn())
    await h.dwell()
    h.result.current.first.scheduleColdCheck(target('c'), 'main', null, vi.fn())
    await h.dwell()
    expect(h.affordances.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
    await h.complete('a')
    h.result.current.first.scheduleColdCheck(target('c'), 'main', null, vi.fn())
    await h.dwell()
    expect(h.affordances.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'c'])
    await h.complete('b')
  })

  it.each([true, false])(
    'refuses an old timer without charging or painting the new gesture (warm=%s)',
    async warm => {
      const h = await setup()
      const stale = vi.fn()
      if (warm)
        h.queryClient.setQueryData(desktopQueryKeys.gfsAffordances(scope, 'old', 'main'), h.bits)
      h.result.current.first.scheduleColdCheck(target('old'), 'main', null, stale)
      h.begin('new', 'second')
      await h.dwell()
      expect(h.affordances).not.toHaveBeenCalled()
      expect(stale).not.toHaveBeenCalled()
      for (let i = 0; i < DRAG_COLD_CHECK_BUDGET; i++) {
        h.result.current.second.scheduleColdCheck(target(`new-${i}`), 'main', null, vi.fn())
        await h.dwell()
      }
      expect(h.affordances).toHaveBeenCalledTimes(DRAG_COLD_CHECK_BUDGET)
    }
  )

  it.each([true, false])('never paints or fetches after native end (warm=%s)', async warm => {
    const h = await setup()
    if (warm)
      h.queryClient.setQueryData(desktopQueryKeys.gfsAffordances(scope, 'ended', 'main'), h.bits)
    const done = vi.fn()
    h.result.current.second.scheduleColdCheck(target('ended'), 'main', null, done)
    h.result.current.session!.endDrag()
    await h.dwell()
    expect(h.affordances).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })

  it('rejects stale completion before a sequential parent probe or hover paint', async () => {
    const h = await setup()
    h.block('a')
    const done = vi.fn()
    h.result.current.first.scheduleColdCheck(target('a'), 'main', 'parent', done)
    await h.dwell()
    expect(h.affordances).toHaveBeenCalledTimes(1)
    h.begin('b', 'second')
    await h.complete('a')
    expect(h.affordances.mock.calls.map(call => call[0])).toEqual(['a'])
    expect(done).not.toHaveBeenCalled()
    // Late A completion cannot reduce/inflate B's in-flight ledger.
    h.block('b1')
    h.block('b2')
    h.result.current.first.scheduleColdCheck(target('b1'), 'main', null, vi.fn())
    await h.dwell()
    h.result.current.second.scheduleColdCheck(target('b2'), 'main', null, vi.fn())
    await h.dwell()
    h.result.current.first.scheduleColdCheck(target('b3'), 'main', null, vi.fn())
    await h.dwell()
    expect(h.affordances.mock.calls.map(call => call[0])).toEqual(['a', 'b1', 'b2'])
    await h.complete('b1')
    await h.complete('b2')
  })

  it('does not paint a dispatched hover after native end, while drop admission stays usable', async () => {
    const h = await setup()
    h.block('a')
    const done = vi.fn()
    h.result.current.second.scheduleColdCheck(target('a'), 'main', 'parent', done)
    await h.dwell()
    h.result.current.session!.endDrag()
    await h.complete('a')
    expect(h.affordances.mock.calls.map(call => call[0])).toEqual(['a'])
    expect(done).not.toHaveBeenCalled()
    const decision = await h.result.current.second.adjudicateDrop(
      { ...source(), generation: 1 },
      target('dest')
    )
    expect(decision.allowed).toBe(true)
  })

  it('does not let one erroring destination burn the cold-check budget (RP-022)', async () => {
    // A destination that answers nothing stays cold, so every hover over it
    // dispatched another probe and every probe spent one slot of the shared
    // budget: ONE failing destination could burn all eight and leave every
    // other target stuck on "checking".
    const h = await setup()
    h.affordances.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('503 upstream unavailable httpStatus=503')
      return h.bits
    })
    const done = vi.fn()
    for (let i = 0; i < DRAG_COLD_CHECK_BUDGET; i++) {
      h.result.current.first.scheduleColdCheck(target('bad'), 'main', null, done)
      await h.dwell()
    }
    // The failing target was probed once; the budget still has room for the
    // targets that answer.
    expect(h.affordances.mock.calls.map(call => call[0])).toEqual(['bad'])

    h.result.current.first.scheduleColdCheck(target('good'), 'main', null, done)
    await h.dwell()
    expect(h.affordances.mock.calls.map(call => call[0])).toContain('good')
  })

  it('cancels a pending dwell when its hook unmounts', async () => {
    const h = await setup()
    const done = vi.fn()
    h.result.current.first.scheduleColdCheck(target('unmounted'), 'main', null, done)
    h.unmount()
    await h.dwell()
    expect(h.affordances).not.toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })
})

describe('hover lease state invariants', () => {
  it('enforces shared caps, lazy generation reset and idempotent late completion across arbitrary traces', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom('begin', 'end', 'invalidate', 'acquire', 'complete'),
            value: fc.integer({ min: -1, max: 12 }),
          }),
          { minLength: 40, maxLength: 150 }
        ),
        actions => {
          const store = new GfsDragSessionStore()
          let generation = 0
          let active = false
          let dispatched = 0
          let inFlight = 0
          const leases: Array<{
            generation: number
            completed: boolean
            lease: GfsHoverCheckLease
          }> = []
          for (const action of actions) {
            if (action.kind === 'begin' || action.kind === 'invalidate') {
              if (action.kind === 'begin') expect(store.beginDrag(source())).toBe(true)
              else store.invalidate('authority')
              generation += 1
              dispatched = 0
              inFlight = 0
              active = action.kind === 'begin'
            } else if (action.kind === 'end') {
              store.endDrag()
              active = false
            } else if (action.kind === 'acquire') {
              const expected = generation + Math.sign(action.value)
              const allowed = active && expected === generation && dispatched < 8 && inFlight < 2
              const lease = store.beginHoverCheck(expected)
              expect(lease !== null).toBe(allowed)
              if (lease) {
                dispatched += 1
                inFlight += 1
                leases.push({ generation, completed: false, lease })
              }
            } else if (leases.length > 0) {
              const entry = leases[Math.abs(action.value) % leases.length]!
              entry.lease.complete()
              entry.lease.complete()
              if (!entry.completed && entry.generation === generation) inFlight -= 1
              entry.completed = true
            }
          }
        }
      ),
      { numRuns: 300 }
    )
  })
})
