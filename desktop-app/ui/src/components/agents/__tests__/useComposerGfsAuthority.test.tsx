// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import fc, { type AsyncCommand } from 'fast-check'
import type { GfsBrowserChild } from '@hooks/domain/useGfsBrowserController'
import { rendererEntityChangeRegistry } from '@lib/entityChangeRegistry'
import { useComposerGfsAuthority } from '../useComposerGfsAuthority'

const resources = (ids: string[]): GfsBrowserChild[] =>
  ids.map(resourceId => ({
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    parentResourceId: null,
    name: resourceId,
    kind: 'file',
    path: `/${resourceId}`,
    version: 1,
    bytes: 1,
  }))

const readAffordance = {
  held: ['read'],
  canDelegate: false,
  grantableBits: [],
  canCreateShare: false,
}

type AuthorityApi = ReturnType<typeof useComposerGfsAuthority>

function Harness({
  sessionId,
  ids,
  capture,
}: {
  sessionId: number
  ids: string[]
  capture?: (authority: AuthorityApi) => void
}) {
  const itemKey = ids.join('|')
  const items = React.useMemo(() => resources(ids), [itemKey])
  const authority = useComposerGfsAuthority(items, sessionId, 'scope:user:team', 1)
  capture?.(authority)
  const [activationAllowed, setActivationAllowed] = React.useState<string>('unchecked')
  return (
    <div>
      {ids.map(id => (
        <output data-testid={`status-${id}`} key={id}>
          {authority.authorityByResourceId.get(id) ?? 'missing'}
        </output>
      ))}
      <button onClick={() => ids.forEach(id => authority.retry(id))}>retry</button>
      <button
        onClick={() => setActivationAllowed(String(authority.isCurrentlyAllowed(ids[0] ?? '')))}
      >
        check activation
      </button>
      <output data-testid="activation-allowed">{activationAllowed}</output>
    </div>
  )
}

function installDeferredAffordances() {
  const requests: Array<{
    resourceId: string
    resolve: (value: typeof readAffordance) => void
    reject: (error: Error) => void
  }> = []
  const affordances = vi.fn(
    (resourceId: string) =>
      new Promise<typeof readAffordance>((resolve, reject) => {
        requests.push({ resourceId, resolve, reject })
      })
  )
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { affordances } } as unknown as Window['clerum'],
  })
  return { affordances, requests }
}

afterEach(async () => {
  cleanup()
  await new Promise<void>(resolve => queueMicrotask(resolve))
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as Partial<typeof window>).clerum
})

describe('useComposerGfsAuthority', () => {
  it('uses scheduled real-adapter settlement and admits at most four physical requests', async () => {
    const { requests, affordances } = installDeferredAffordances()
    render(<Harness sessionId={1} ids={['A', 'B', 'C', 'D', 'E', 'F']} />)

    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(4))
    expect(affordances.mock.calls.map(([id]) => id)).toEqual(['A', 'B', 'C', 'D'])
    for (let index = 0; index < 6; index += 1) {
      await act(async () => requests[index]!.resolve(readAffordance))
      await waitFor(() => expect(requests.length).toBe(Math.min(index + 5, 6)))
    }
    await waitFor(() => expect(screen.getByTestId('status-F').textContent).toBe('allowed'))
    expect(
      ['A', 'B', 'C', 'D', 'E', 'F'].every(
        id => screen.getByTestId(`status-${id}`).textContent === 'allowed'
      )
    ).toBe(true)
  })

  it('keeps a physical slot reserved after navigation removes its observer', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const view = render(<Harness sessionId={41} ids={['A', 'B', 'C', 'D']} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(4))

    view.rerender(<Harness sessionId={41} ids={['E']} />)
    await act(async () => Promise.resolve())
    expect(affordances).toHaveBeenCalledTimes(4)
    expect(requests.map(request => request.resourceId)).toEqual(['A', 'B', 'C', 'D'])

    await act(async () => requests[0]!.resolve(readAffordance))
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(5))
    expect(requests[4]!.resourceId).toBe('E')

    for (const request of requests.slice(1)) {
      await act(async () => request.resolve(readAffordance))
    }
    await waitFor(() => expect(screen.getByTestId('status-E').textContent).toBe('allowed'))
    expect(affordances).toHaveBeenCalledTimes(5)
  })

  it('keeps the authority owner live through React StrictMode effect replay', async () => {
    const { requests, affordances } = installDeferredAffordances()
    render(
      <React.StrictMode>
        <Harness sessionId={11} ids={['resource']} />
      </React.StrictMode>
    )

    await waitFor(() => expect(affordances).toHaveBeenCalledOnce())
    await act(async () => requests[0]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
  })

  it('publishes a real IPC result only after fast-check releases its scheduled Promise', async () => {
    const scheduler = fc.sample(fc.scheduler(), { seed: 12931110, numRuns: 1 })[0]!
    const affordances = vi.fn(() =>
      scheduler.schedule(Promise.resolve(readAffordance), 'resource-allow')
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { affordances } } as unknown as Window['clerum'],
    })
    render(<Harness sessionId={6} ids={['resource']} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledOnce())
    expect(screen.getByTestId('status-resource').textContent).toBe('checking')
    await act(async () => scheduler.waitNext(1))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
  })

  it('does not let a terminal old-owner allow authorize a replacement picker', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const view = render(<Harness sessionId={1} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    view.rerender(<Harness sessionId={2} ids={['resource']} />)
    await act(async () => Promise.resolve())
    expect(affordances).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(2)

    await act(async () => {
      requests[0]!.resolve(readAffordance)
      // Wait through the hook's result publication and physical-settlement
      // continuations; resolving the IPC fixture alone is not quiescence.
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(screen.getByTestId('status-resource').textContent).toBe('checking')
    act(() => screen.getByRole('button', { name: 'check activation' }).click())
    expect(screen.getByTestId('activation-allowed').textContent).toBe('false')
    expect(affordances).toHaveBeenCalledTimes(2)

    await act(async () => requests[1]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
    act(() => screen.getByRole('button', { name: 'check activation' }).click())
    expect(screen.getByTestId('activation-allowed').textContent).toBe('true')
  })

  it('generates mounted owner, invalidation, and physical-completion schedules', async () => {
    type Model = {
      owner: number
      eventVersion: number
      settled: number[]
    }
    type Request = {
      owner: number
      eventVersion: number
      resolve: (value: typeof readAffordance) => void
      settled: boolean
      scheduled: boolean
    }
    type Real = {
      view: ReturnType<typeof render>
      scheduler: ReturnType<typeof fc.scheduler>
      requests: Request[]
      currentOwner: number
      eventVersion: number
      completionOrder: number[]
      commandOrder: string[]
      authority: AuthorityApi | null
    }

    class ReplaceOwner implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.owner === 1
      }
      async run(model: Model, real: Real) {
        model.owner = 2
        model.eventVersion = 0
        real.currentOwner = 2
        real.eventVersion = 0
        real.view.rerender(
          <Harness
            sessionId={2}
            ids={['resource']}
            capture={authority => (real.authority = authority)}
          />
        )
        real.commandOrder.push('replace-owner')
        await waitFor(() => expect(real.requests.some(request => request.owner === 2)).toBe(true))
        assertEffective(model, real)
      }
      toString() {
        return 'replace-picker-owner'
      }
    }

    class Invalidate implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>) {
        return model.eventVersion === 0
      }
      async run(model: Model, real: Real) {
        model.eventVersion += 1
        real.eventVersion += 1
        act(() =>
          rendererEntityChangeRegistry.dispatch({
            type: 'scope.invalidated',
            schemaVersion: 1,
            cursor: `generated-owner-event-${real.commandOrder.length}`,
            scopes: ['gfs', 'authorization'],
          })
        )
        real.commandOrder.push('received-event')
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        assertEffective(model, real)
      }
      toString() {
        return 'receive-authorization-invalidation'
      }
    }

    class ScheduleCompletion implements AsyncCommand<Model, Real> {
      constructor(private readonly index: number) {}
      check() {
        return true
      }
      async run(model: Model, real: Real) {
        const request = real.requests[this.index]
        if (!request || request.settled || request.scheduled) return
        request.scheduled = true
        const scheduled = real.scheduler
          .schedule(Promise.resolve(), `physical-${this.index}`)
          .then(() => {
            // The controlled IPC result settles only after fast-check releases this boundary.
            request.resolve(readAffordance)
            request.settled = true
            model.settled.push(this.index)
            real.completionOrder.push(this.index)
          })
        void scheduled
        real.commandOrder.push(`schedule-${this.index}`)
      }
      toString() {
        return `schedule-physical-completion-${this.index}`
      }
    }

    class ReleaseCompletion implements AsyncCommand<Model, Real> {
      check() {
        return true
      }
      async run(model: Model, real: Real) {
        if (real.scheduler.count() === 0) return
        const prior = real.completionOrder.length
        await act(async () => {
          await real.scheduler.waitNext(1)
          await Promise.resolve()
          await Promise.resolve()
        })
        await waitFor(() => expect(real.completionOrder.length).toBeGreaterThan(prior))
        real.commandOrder.push('release-physical-completion')
        await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
        assertEffective(model, real)
      }
      toString() {
        return 'release-scheduler-selected-physical-completion'
      }
    }

    function assertEffective(model: Model, real: Real) {
      const expected = real.requests.some(
        request =>
          request.owner === model.owner &&
          request.eventVersion === model.eventVersion &&
          request.settled
      )
      expect(real.authority?.isCurrentlyAllowed('resource')).toBe(expected)
      expect(real.authority?.authorityByResourceId.get('resource') === 'allowed').toBe(expected)
    }

    const meaningfulSchedules = new Set<string>()
    const completionOrders = new Set<string>()
    const observedTraces = new Set<string>()
    let skippedSequences = 0
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(
          [
            fc.constant(new ReplaceOwner()),
            fc.constant(new Invalidate()),
            fc.constantFrom(0, 1, 2, 3).map(index => new ScheduleCompletion(index)),
            fc.constant(new ReleaseCompletion()),
          ],
          { maxCommands: 7, size: '+1' }
        ),
        async (scheduler, commands) => {
          cleanup()
          vi.restoreAllMocks()
          const requests: Request[] = []
          const affordances = vi.fn(
            () =>
              new Promise<typeof readAffordance>(resolve => {
                requests.push({
                  owner: real.currentOwner,
                  eventVersion: real.eventVersion,
                  resolve,
                  settled: false,
                  scheduled: false,
                })
              })
          )
          Object.defineProperty(window, 'clerum', {
            configurable: true,
            value: { gfs: { affordances } } as unknown as Window['clerum'],
          })
          const model: Model = { owner: 1, eventVersion: 0, settled: [] }
          const real: Real = {
            view: null as never,
            scheduler,
            requests,
            currentOwner: 1,
            eventVersion: 0,
            completionOrder: [],
            commandOrder: [],
            authority: null,
          }
          real.view = render(
            <Harness
              sessionId={1}
              ids={['resource']}
              capture={authority => (real.authority = authority)}
            />
          )
          await waitFor(() => expect(requests).toHaveLength(1))

          await fc.asyncModelRun(() => ({ model, real }), commands)
          for (let guard = 0; guard < 12; guard += 1) {
            requests.forEach((request, index) => {
              if (request.settled || request.scheduled) return
              request.scheduled = true
              void scheduler.schedule(Promise.resolve(), `drain-${index}`).then(() => {
                // The mounted IPC result changes only after scheduler release.
                request.resolve(readAffordance)
                request.settled = true
                model.settled.push(index)
                real.completionOrder.push(index)
              })
            })
            if (scheduler.count() === 0) break
            await act(async () => {
              await scheduler.waitNext(1)
              await Promise.resolve()
              await Promise.resolve()
            })
            await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
            assertEffective(model, real)
          }
          const generatedTrace = [...real.commandOrder]
          observedTraces.add(generatedTrace.join('>'))
          if (
            generatedTrace.some(event => event === 'replace-owner' || event === 'received-event') &&
            real.completionOrder.length > 0
          ) {
            meaningfulSchedules.add(`${generatedTrace.join('>')}|${real.completionOrder.join('>')}`)
            completionOrders.add(real.completionOrder.join('>'))
          } else {
            skippedSequences += 1
          }
          expect(scheduler.count()).toBe(0)
          expect(requests.every(request => request.settled)).toBe(true)
          await waitFor(() => expect(real.authority?.isCurrentlyAllowed('resource')).toBe(true))
          expect(real.authority?.authorityByResourceId.get('resource')).toBe('allowed')
          real.view.unmount()
          await act(async () => Promise.resolve())
          delete (window as Partial<typeof window>).clerum
        }
      ),
      { numRuns: 24, seed: 12931131 }
    )
    process.stdout.write(
      `A6-J3 seed=12931131 runs=24 meaningful=${meaningfulSchedules.size} ` +
        `completionOrders=${completionOrders.size} skipped=${skippedSequences} ` +
        `traces=${JSON.stringify([...observedTraces])} ` +
        `schedules=${JSON.stringify([...meaningfulSchedules])} ` +
        `completions=${JSON.stringify([...completionOrders])}\n`
    )
    expect(meaningfulSchedules.size).toBeGreaterThan(1)
    expect(completionOrders.size).toBeGreaterThan(1)
  }, 120_000)

  it('applies received authorization events to the replacement owner', async () => {
    const { requests } = installDeferredAffordances()
    const view = render(<Harness sessionId={21} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => requests[0]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))

    view.rerender(<Harness sessionId={22} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))

    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'replacement-owner-event',
        scopes: ['gfs', 'authorization'],
      })
    )
    expect(screen.getByTestId('status-resource').textContent).not.toBe('allowed')
    await act(async () => Promise.resolve())
    expect(requests).toHaveLength(3)
    await waitFor(() => expect(requests).toHaveLength(3))
    await act(async () => requests[2]!.resolve({ ...readAffordance, held: [] }))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('denied'))
  })

  it('keeps an old same-owner allow fenced until the current trailing request settles', async () => {
    const { requests, affordances } = installDeferredAffordances()
    let authority: AuthorityApi | null = null
    render(<Harness sessionId={27} ids={['resource']} capture={current => (authority = current)} />)
    await waitFor(() => expect(requests).toHaveLength(1))

    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'old-same-owner-result',
        scopes: ['gfs', 'authorization'],
      })
    )
    expect(authority?.isCurrentlyAllowed('resource')).toBe(false)

    await act(async () => {
      requests[0]!.resolve(readAffordance)
      // Observe the public synchronous predicate after the successful response reaction,
      // before its later finally cleanup can enqueue the current trailing request.
      await Promise.resolve()
      await Promise.resolve()
      expect(authority?.isCurrentlyAllowed('resource')).toBe(false)
    })
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
    expect(affordances).toHaveBeenCalledTimes(2)
    expect(authority?.isCurrentlyAllowed('resource')).toBe(false)
    expect(screen.getByTestId('status-resource').textContent).not.toBe('allowed')

    await act(async () => requests[1]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
    expect(authority?.isCurrentlyAllowed('resource')).toBe(true)
  })

  it('rechecks a cached resource when navigation returns after a received event', async () => {
    const { requests } = installDeferredAffordances()
    const view = render(<Harness sessionId={23} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => requests[0]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))

    view.rerender(<Harness sessionId={23} ids={[]} />)
    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'inactive-resource-event',
        scopes: ['gfs', 'authorization'],
      })
    )
    view.rerender(<Harness sessionId={23} ids={['resource']} />)
    expect(screen.getByTestId('status-resource').textContent).toBe('checking')
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.resolve({ ...readAffordance, held: [] }))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('denied'))
  })

  it('requeues a no-longer-visible queued key after navigation returns', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const initial = ['A', 'B', 'C', 'D', 'E']
    const view = render(<Harness sessionId={24} ids={initial} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(4))

    view.rerender(<Harness sessionId={24} ids={initial.slice(0, 4)} />)
    await act(async () => requests[0]!.resolve(readAffordance))
    expect(affordances).toHaveBeenCalledTimes(4)

    view.rerender(<Harness sessionId={24} ids={initial} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(5))
    expect(affordances.mock.calls[4]![0]).toBe('E')
  })

  it('applies a 429 pause after the requesting row leaves and resumes only explicitly', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const view = render(<Harness sessionId={25} ids={['A', 'B', 'C', 'D', 'E']} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(4))

    view.rerender(<Harness sessionId={25} ids={['B', 'C', 'D', 'E']} />)
    await act(async () => requests[0]!.reject(new Error('httpStatus=429 retryAfterSeconds=60')))
    expect(affordances).toHaveBeenCalledTimes(4)

    now.mockReturnValue(1_060_000)
    view.rerender(<Harness sessionId={25} ids={['A', 'E']} />)
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(5))
    expect(affordances.mock.calls[4]![0]).toBe('E')
  })

  it('keeps an invalidated in-flight 429 retryable without automatic resume', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    render(<Harness sessionId={26} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'in-flight-429-event',
        scopes: ['gfs', 'authorization'],
      })
    )
    expect(screen.getByTestId('status-resource').textContent).toBe('invalidated')

    await act(async () => requests[0]!.reject(new Error('httpStatus=429 retryAfterSeconds=60')))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('paused'))
    expect(affordances).toHaveBeenCalledOnce()

    now.mockReturnValue(2_060_000)
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
  })

  it('rejects an invalidated response and retains one same-key trailing refresh', async () => {
    const { requests } = installDeferredAffordances()
    render(<Harness sessionId={7} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'targeted-a6-event',
        scopes: ['gfs', 'authorization'],
      })
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(requests).toHaveLength(1)
    expect(screen.getByTestId('status-resource').textContent).toBe('invalidated')
    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'targeted-a6-event-repeat',
        scopes: ['gfs', 'authorization'],
      })
    )
    expect(requests).toHaveLength(1)

    await act(async () => {
      requests[0]!.resolve(readAffordance)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(requests).toHaveLength(2)
    expect(screen.getByTestId('status-resource').textContent).toBe('checking')
    await act(async () => requests[1]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
  })

  it('keeps public authority fenced between an old success and cleanup reactions', async () => {
    const { requests } = installDeferredAffordances()
    let authority: AuthorityApi | undefined
    const capture = (value: AuthorityApi) => {
      authority = value
    }
    const view = render(<Harness sessionId={28} ids={['resource']} capture={capture} />)
    await waitFor(() => expect(requests).toHaveLength(1))

    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'r7-old-success-fence',
        scopes: ['gfs', 'authorization'],
      })
    )
    expect(screen.getByTestId('status-resource').textContent).toBe('invalidated')

    let predicateAtBoundary: boolean | undefined
    let projectionAtBoundary: string | undefined
    await act(async () => {
      requests[0]!.resolve(readAffordance)
      await new Promise<void>(resolve => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            predicateAtBoundary = authority!.isCurrentlyAllowed('resource')
            projectionAtBoundary = authority!.authorityByResourceId.get('resource')
            resolve()
          })
        )
      })
    })

    expect(predicateAtBoundary).toBe(false)
    expect(projectionAtBoundary).not.toBe('allowed')
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
    view.unmount()
  })

  it('admits a queued resource after its explicit retry advances the queue epoch', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000_000)
    const view = render(<Harness sessionId={29} ids={['A', 'B', 'C', 'D', 'E']} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(4))

    await act(async () => requests[0]!.reject(new Error('httpStatus=429 retryAfterSeconds=60')))
    view.rerender(<Harness sessionId={29} ids={['E']} />)
    now.mockReturnValue(4_060_000)
    act(() => screen.getByRole('button', { name: 'retry' }).click())

    await act(async () => {
      for (const request of requests.slice(1)) request.resolve(readAffordance)
    })
    const retryRequest = requests.find(request => request.resourceId === 'E')
    if (retryRequest) await act(async () => retryRequest.resolve(readAffordance))
    const retryAdmissions = affordances.mock.calls.length

    expect(retryAdmissions).toBe(5)
    expect(retryRequest).toBeDefined()
    expect(screen.getByTestId('status-E').textContent).toBe('allowed')
    view.unmount()
  })

  it('requires explicit resume after a 429 deadline despite ordinary settlement', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
    const view = render(<Harness sessionId={30} ids={['A', 'B', 'C', 'D', 'E']} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(4))

    await act(async () => requests[0]!.reject(new Error('httpStatus=429 retryAfterSeconds=60')))
    now.mockReturnValue(5_060_000)
    await act(async () => requests[1]!.resolve(readAffordance))
    const admissionsBeforeExplicitResume = affordances.mock.calls.length

    view.rerender(<Harness sessionId={30} ids={['E']} />)
    if (admissionsBeforeExplicitResume === 4) {
      act(() => screen.getByRole('button', { name: 'retry' }).click())
    }
    await act(async () => {
      for (const request of requests) {
        if (request.resourceId !== 'A' && request.resourceId !== 'E')
          request.resolve(readAffordance)
      }
    })
    const admissionsAfterExplicitResume = affordances.mock.calls.length
    const eRequest = requests.find(request => request.resourceId === 'E')
    if (eRequest) await act(async () => eRequest.resolve(readAffordance))

    expect(admissionsBeforeExplicitResume).toBe(4)
    expect(admissionsAfterExplicitResume).toBe(5)
    expect(eRequest).toBeDefined()
    expect(screen.getByTestId('status-E').textContent).toBe('allowed')
    view.unmount()
  })

  it('keeps the longest overlapping 429 deadline and requires one explicit resume', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const now = vi.spyOn(Date, 'now').mockReturnValue(6_000_000)
    const view = render(<Harness sessionId={31} ids={['A', 'B', 'C', 'D', 'E']} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(4))

    await act(async () => requests[0]!.reject(new Error('httpStatus=429 retryAfterSeconds=60')))
    now.mockReturnValue(6_010_000)
    await act(async () => requests[1]!.reject(new Error('httpStatus=429 retryAfterSeconds=30')))
    now.mockReturnValue(6_050_000)
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    const beforeLongestDeadline = affordances.mock.calls.length

    now.mockReturnValue(6_060_000)
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await act(async () => {
      for (const request of requests.slice(2)) request.resolve(readAffordance)
    })
    const resumed = requests.find(request => request.resourceId === 'E')
    if (resumed) await act(async () => resumed.resolve(readAffordance))

    expect(beforeLongestDeadline).toBe(4)
    expect(resumed).toBeDefined()
    expect(screen.getByTestId('status-E').textContent).toBe('allowed')
    view.unmount()
  })

  it('does not let dirty trailing cleanup resume a 429-paused owner', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const now = vi.spyOn(Date, 'now').mockReturnValue(7_000_000)
    const view = render(<Harness sessionId={34} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'r7-dirty-429-pause',
        scopes: ['gfs', 'authorization'],
      })
    )
    now.mockReturnValue(7_060_000)
    await act(async () => requests[0]!.reject(new Error('httpStatus=429 retryAfterSeconds=0')))
    expect(affordances).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('status-resource').textContent).toBe('paused')

    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
    view.unmount()
  })

  it('does not transfer an old-owner 429 pause or queued work to its replacement', async () => {
    const { requests, affordances } = installDeferredAffordances()
    const view = render(<Harness sessionId={32} ids={['A', 'B', 'C', 'D', 'E']} />)
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(4))
    view.rerender(<Harness sessionId={33} ids={['A']} />)
    expect(affordances).toHaveBeenCalledTimes(4)

    await act(async () => requests[0]!.reject(new Error('httpStatus=429 retryAfterSeconds=60')))
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(5))
    expect(requests[4]!.resourceId).toBe('A')
    expect(screen.getByTestId('status-A').textContent).toBe('checking')

    await act(async () => {
      requests[1]!.resolve(readAffordance)
      requests[2]!.resolve(readAffordance)
      requests[3]!.resolve(readAffordance)
      requests[4]!.resolve(readAffordance)
    })
    await waitFor(() => expect(screen.getByTestId('status-A').textContent).toBe('allowed'))
    expect(affordances.mock.calls.map(([resourceId]) => resourceId)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'A',
    ])
    view.unmount()
  })

  it('does not activate a cached allow while a same-owner 429 retry is paused', async () => {
    const { requests } = installDeferredAffordances()
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000_000)
    render(<Harness sessionId={27} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => requests[0]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))

    act(() =>
      rendererEntityChangeRegistry.dispatch({
        type: 'scope.invalidated',
        schemaVersion: 1,
        cursor: 'cached-allow-then-429',
        scopes: ['gfs', 'authorization'],
      })
    )
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.reject(new Error('httpStatus=429 retryAfterSeconds=60')))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('paused'))
    act(() => screen.getByRole('button', { name: 'check activation' }).click())
    expect(screen.getByTestId('activation-allowed').textContent).toBe('false')
    expect(requests).toHaveLength(2)

    now.mockReturnValue(3_060_000)
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await waitFor(() => expect(requests).toHaveLength(3))
    await act(async () => requests[2]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
    act(() => screen.getByRole('button', { name: 'check activation' }).click())
    expect(screen.getByTestId('activation-allowed').textContent).toBe('true')
  })

  it('keeps a received 429 pause until the explicit retry and then recovers', async () => {
    const { requests } = installDeferredAffordances()
    render(<Harness sessionId={8} ids={['resource']} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => requests[0]!.reject(new Error('httpStatus=429 retryAfterSeconds=0')))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('paused'))
    expect(requests).toHaveLength(1)
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => requests[1]!.resolve(readAffordance))
    await waitFor(() => expect(screen.getByTestId('status-resource').textContent).toBe('allowed'))
  })
})
