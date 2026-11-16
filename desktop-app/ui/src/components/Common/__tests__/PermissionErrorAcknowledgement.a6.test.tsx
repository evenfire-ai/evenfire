// R73 real-code A6: the Common owner and production dialog run against a real QueryClient.
// @vitest-environment jsdom
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Query, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fc, { type AsyncCommand } from 'fast-check'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { PermissionErrorDialog } from '../PermissionErrorDialog'
import type { PermissionErrorItem } from '../PermissionErrorDialog/types'
import {
  commitPermissionErrorDescriptors,
  commitPermissionQueryBinding,
  deactivatePermissionQueryBinding,
  getPermissionErrorsForOwner,
  installPermissionErrorTracking,
  usePermissionErrorAcknowledgementSnapshot,
} from '../permissionErrorAcknowledgement'

type Outcome = 'success' | 'failure'

type Model = {
  hasFailure: boolean
  acknowledged: boolean
  retryFailureCount: number
}

type Real = {
  client: QueryClient
  query: Query
  owner: string
  key: readonly unknown[]
  setOutcome: (outcome: Outcome) => void
  runQuery: () => Promise<void>
  getProducerCalls: () => number
  getRetryFailureCount: () => number
  remount: () => void
}

const resourceId = 'a6-permission-resource'
const sessionScope = 'a6-session-scope'
const sessionGeneration = 7

function PermissionOwner({
  owner,
  bindingKey,
  client,
  query,
  descriptor,
}: {
  owner: string
  bindingKey: string
  client: QueryClient
  query: Query
  descriptor: PermissionErrorItem
}) {
  usePermissionErrorAcknowledgementSnapshot()
  useLayoutEffect(() => {
    commitPermissionQueryBinding(owner, bindingKey, [query], {
      sessionScope,
      sessionGeneration,
    })
    commitPermissionErrorDescriptors(owner, bindingKey, [descriptor])
    return () => deactivatePermissionQueryBinding(owner)
  }, [bindingKey, descriptor, owner, query])

  const projection = getPermissionErrorsForOwner(owner)
  return <PermissionErrorDialog errors={projection.errors} onDismiss={() => undefined} />
}

function OwnerHarness({
  owner,
  bindingKey,
  client,
  query,
  descriptor,
  ownerKey,
}: {
  owner: string
  bindingKey: string
  client: QueryClient
  query: Query
  descriptor: PermissionErrorItem
  ownerKey: number
}) {
  return (
    <QueryClientProvider client={client}>
      <button type="button">Stable focus target</button>
      <PermissionOwner
        key={ownerKey}
        owner={owner}
        bindingKey={bindingKey}
        client={client}
        query={query}
        descriptor={descriptor}
      />
    </QueryClientProvider>
  )
}

function createDescriptor(args: {
  client: QueryClient
  key: readonly unknown[]
  query: Query
  owner: string
  bindingKey: string
  queryFn: () => Promise<unknown>
  onRetryFailure: () => void
}): PermissionErrorItem {
  return {
    id: 'permission-query:a6',
    message: 'The permission service is temporarily unavailable.',
    queryIdentity: args.query,
    retry: context => {
      if (!context?.isOriginCurrent() || context.onAdmitted() === false) return { admitted: false }
      const completion = args.client.fetchQuery({
        queryKey: args.key,
        queryFn: args.queryFn,
        staleTime: 0,
      })
      return { admitted: true, completion }
    },
    onRetryFailure: (_error, context) => {
      if (!context.isOriginCurrent()) return 'stale'
      args.onRetryFailure()
      return 'presented'
    },
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('R73 real-code A6 Common permission owner', () => {
  it('removes a deleted Query Retry target before the next user input', async () => {
    const serviceFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      resourceId
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
    })
    const key = ['gfs', 'affordances', sessionScope, resourceId, 'main', sessionGeneration] as const
    let producerCalls = 0
    const producer = appServiceAffordanceProducer(async () => {
      producerCalls += 1
      if (producerCalls === 2) throw serviceFailure
      return heldPermissionResponse(['read', 'write'])
    })
    const queryFn = () => producer(resourceId)
    let view: ReturnType<typeof render> | undefined

    try {
      installPermissionErrorTracking(client)
      await client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })
      await expect(client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })).rejects.toThrow(
        /httpStatus=503/
      )
      const query = client.getQueryCache().find({ queryKey: key, exact: true })
      if (!query) throw new Error('Expected the producer-backed permission Query')
      const owner = 'a6-removal-owner'
      const descriptor = createDescriptor({
        client,
        key,
        query,
        owner,
        bindingKey: 'preview:removal:session-7',
        queryFn,
        onRetryFailure: () => undefined,
      })
      view = render(
        <OwnerHarness
          owner={owner}
          bindingKey="preview:removal:session-7"
          client={client}
          query={query}
          descriptor={descriptor}
          ownerKey={0}
        />
      )
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
      expect(producerCalls).toBe(2)

      await act(async () => {
        client.removeQueries({ queryKey: key, exact: true })
      })
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(screen.queryByRole('button', { name: 'Retry permission check' })).toBeNull()
      expect(getPermissionErrorsForOwner(owner)).toEqual({ errors: [], acknowledged: [] })

      fireEvent.click(screen.getByRole('button', { name: 'Stable focus target' }))
      expect(producerCalls).toBe(2)
    } finally {
      view?.unmount()
      client.clear()
    }
  })

  it('compares generated dismiss, refetch, recovery, Retry, new-failure and remount commands', async () => {
    const serviceFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      resourceId
    )

    class DismissFailure implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.hasFailure && !model.acknowledged
      }
      async run(model: Model): Promise<void> {
        fireEvent.click(
          within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close' })
        )
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
        model.acknowledged = true
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Stable focus target' })
        )
      }
      toString(): string {
        return 'dismiss the unresolved permission failure'
      }
    }

    class RepeatBackgroundFailure implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.hasFailure && model.acknowledged
      }
      async run(_model: Model, state: Real): Promise<void> {
        const focusBefore = document.activeElement
        state.setOutcome('failure')
        await act(async () => state.runQuery())
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(getPermissionErrorsForOwner(state.owner).acknowledged).toHaveLength(1)
        expect(document.activeElement).toBe(focusBefore)
      }
      toString(): string {
        return 'repeat a same-projection background failure without reopening the dialog'
      }
    }

    class RecoverFailure implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.hasFailure
      }
      async run(model: Model, state: Real): Promise<void> {
        state.setOutcome('success')
        await act(async () => state.runQuery())
        await waitFor(() => expect(state.client.getQueryState(state.key)?.status).toBe('success'))
        model.hasFailure = false
        model.acknowledged = false
        expect(getPermissionErrorsForOwner(state.owner)).toEqual({ errors: [], acknowledged: [] })
        expect(screen.queryByRole('alertdialog')).toBeNull()
      }
      toString(): string {
        return 'recover the exact Query with a producer success'
      }
    }

    class PublishNewFailure implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return !model.hasFailure
      }
      async run(model: Model, state: Real): Promise<void> {
        state.setOutcome('failure')
        await act(async () => state.runQuery())
        model.hasFailure = true
        model.acknowledged = false
        await screen.findByRole('alertdialog')
        expect(state.client.getQueryCache().find({ queryKey: state.key, exact: true })).toBe(
          state.query
        )
      }
      toString(): string {
        return 'publish a new visible failure after recovery'
      }
    }

    class RetryFailure implements AsyncCommand<Model, Real> {
      check(model: Readonly<Model>): boolean {
        return model.hasFailure && !model.acknowledged
      }
      async run(model: Model, state: Real): Promise<void> {
        const callsBefore = state.getProducerCalls()
        const failuresBefore = state.getRetryFailureCount()
        const retryItem = getPermissionErrorsForOwner(state.owner).errors[0]
        expect(retryItem?.retry).toBeTypeOf('function')
        state.setOutcome('failure')
        fireEvent.click(
          within(screen.getByRole('alertdialog')).getByRole('button', {
            name: 'Retry permission check',
          })
        )
        const duplicate = retryItem?.retry?.()
        // R74 permits a second Retry for the same owner/binding/Query while
        // the first fetch is active; TanStack joins it without a second producer.
        expect(duplicate?.admitted).toBe(true)
        await waitFor(() => expect(state.getProducerCalls()).toBe(callsBefore + 1))
        await waitFor(() => expect(state.getRetryFailureCount()).toBe(failuresBefore + 1))
        await screen.findByRole('alertdialog')
        model.retryFailureCount += 1
        expect(state.client.getQueryState(state.key)?.status).toBe('error')
        expect(getPermissionErrorsForOwner(state.owner).errors).toHaveLength(1)
      }
      toString(): string {
        return 'expose the terminal failure from an explicitly admitted Retry'
      }
    }

    class RemountOwner implements AsyncCommand<Model, Real> {
      check(): boolean {
        return true
      }
      async run(model: Model, state: Real): Promise<void> {
        state.remount()
        if (model.hasFailure && !model.acknowledged) await screen.findByRole('alertdialog')
        else expect(screen.queryByRole('alertdialog')).toBeNull()
        const projection = getPermissionErrorsForOwner(state.owner)
        expect(projection.errors.length > 0).toBe(model.hasFailure && !model.acknowledged)
        expect(projection.acknowledged.length > 0).toBe(model.hasFailure && model.acknowledged)
        expect(state.client.getQueryCache().find({ queryKey: state.key, exact: true })).toBe(
          state.query
        )
      }
      toString(): string {
        return 'remount the committed owner without replacing its Query identity'
      }
    }

    const commands = fc.commands<Model, Real, false>(
      [
        fc.constant(new DismissFailure()),
        fc.constant(new RepeatBackgroundFailure()),
        fc.constant(new RecoverFailure()),
        fc.constant(new PublishNewFailure()),
        fc.constant(new RetryFailure()),
        fc.constant(new RemountOwner()),
      ],
      { maxCommands: 16 }
    )

    await fc.assert(
      fc.asyncProperty(commands, async scheduled => {
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
        })
        installPermissionErrorTracking(client)
        const key = [
          'gfs',
          'affordances',
          sessionScope,
          resourceId,
          'main',
          sessionGeneration,
        ] as const
        let outcome: Outcome = 'success'
        let producerCalls = 0
        let retryFailureCount = 0
        const producer = appServiceAffordanceProducer(async () => {
          producerCalls += 1
          if (outcome === 'failure') throw serviceFailure
          return heldPermissionResponse(['read', 'write'])
        })
        const queryFn = () => producer(resourceId)
        let view: ReturnType<typeof render> | undefined

        try {
          await client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })
          const query = client.getQueryCache().find({ queryKey: key, exact: true })
          if (!query) throw new Error('Expected the real permission QueryClient entry')

          const owner = 'a6-preview-owner'
          const bindingKey = 'preview:A:session-7'
          const descriptor = createDescriptor({
            client,
            key,
            query,
            owner,
            bindingKey,
            queryFn,
            onRetryFailure: () => retryFailureCount++,
          })
          let ownerKey = 0
          const renderOwner = () => (
            <OwnerHarness
              owner={owner}
              bindingKey={bindingKey}
              client={client}
              query={query}
              descriptor={descriptor}
              ownerKey={ownerKey}
            />
          )
          view = render(renderOwner())
          const focusTarget = screen.getByRole('button', { name: 'Stable focus target' })
          focusTarget.focus()
          const state: Real = {
            client,
            query,
            owner,
            key,
            setOutcome: value => {
              outcome = value
            },
            runQuery: async () => {
              try {
                await client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })
              } catch {
                // The QueryCache owns the observable error state; rejection is expected here.
              }
            },
            getProducerCalls: () => producerCalls,
            getRetryFailureCount: () => retryFailureCount,
            remount: () => {
              screen.getByRole('button', { name: 'Stable focus target' }).focus()
              ownerKey += 1
              view?.rerender(renderOwner())
            },
          }
          outcome = 'failure'
          await act(async () => state.runQuery())
          await screen.findByRole('alertdialog')
          focusTarget.focus()
          const model: Model = { hasFailure: true, acknowledged: false, retryFailureCount: 0 }
          await fc.asyncModelRun(() => ({ model, real: state }), scheduled)
          const projection = getPermissionErrorsForOwner(owner)
          expect(projection.errors.length > 0).toBe(model.hasFailure && !model.acknowledged)
          expect(projection.acknowledged.length > 0).toBe(model.hasFailure && model.acknowledged)
          expect(client.getQueryState(key)?.status).toBe(model.hasFailure ? 'error' : 'success')
          expect(state.getRetryFailureCount()).toBe(model.retryFailureCount)
        } finally {
          view?.unmount()
          client.clear()
        }
      }),
      { numRuns: 40, seed: 142713 }
    )
  })

  it('publishes one producer failure when Retry joins a late-installed active Query', async () => {
    const serviceFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      resourceId
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
    })
    const key = ['gfs', 'affordances', sessionScope, resourceId, 'main', sessionGeneration] as const
    let producerCalls = 0
    let releasePending!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    let rejectPending!: (error: Error) => void
    const pendingResult = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (resolve, reject) => {
        releasePending = resolve
        rejectPending = reject
      }
    )
    const producer = appServiceAffordanceProducer(async () => {
      producerCalls += 1
      if (producerCalls === 3) return pendingResult
      if (producerCalls === 2) throw serviceFailure
      return heldPermissionResponse(['read', 'write'])
    })
    const queryFn = () => producer(resourceId)
    const onRetryFailure = vi.fn(() => 'presented' as const)
    let view: ReturnType<typeof render> | undefined

    try {
      await client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })
      await expect(client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })).rejects.toThrow(
        /httpStatus=503/
      )
      const query = client.getQueryCache().find({ queryKey: key, exact: true })
      if (!query) throw new Error('Expected the real permission QueryClient entry')
      const activeFetch = client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })
      void activeFetch.catch(() => undefined)
      await waitFor(() => expect(producerCalls).toBe(3))
      expect(query.state.fetchStatus).toBe('fetching')

      installPermissionErrorTracking(client)
      const owner = 'a6-late-installed-owner'
      const bindingKey = 'preview:A:session-7'
      const descriptor = createDescriptor({
        client,
        key,
        query,
        owner,
        bindingKey,
        queryFn,
        onRetryFailure,
      })
      view = render(
        <QueryClientProvider client={client}>
          <OwnerHarness
            owner={owner}
            bindingKey={bindingKey}
            client={client}
            query={query}
            descriptor={descriptor}
            ownerKey={0}
          />
        </QueryClientProvider>
      )
      const dialog = await screen.findByRole('alertdialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(getPermissionErrorsForOwner(owner).acknowledged).toHaveLength(1))

      rejectPending(serviceFailure)
      await expect(activeFetch).rejects.toThrow(/httpStatus=503/)
      await waitFor(() => expect(query.state.status).toBe('error'))
      expect(onRetryFailure).toHaveBeenCalledTimes(1)
      expect(getPermissionErrorsForOwner(owner).errors).toHaveLength(1)
      expect(getPermissionErrorsForOwner(owner).acknowledged).toHaveLength(0)
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
    } finally {
      view?.unmount()
      releasePending?.(heldPermissionResponse(['read', 'write']))
      client.clear()
    }
  })

  it('publishes a no-cache producer failure when Retry joins an active Query', async () => {
    const serviceFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      resourceId
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
    })
    const key = ['gfs', 'affordances', sessionScope, resourceId, 'main', sessionGeneration] as const
    let producerCalls = 0
    let rejectPending!: (error: Error) => void
    const pendingResult = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (_resolve, reject) => {
        rejectPending = reject
      }
    )
    const producer = appServiceAffordanceProducer(async () => {
      producerCalls += 1
      if (producerCalls === 1) throw serviceFailure
      return pendingResult
    })
    const queryFn = () => producer(resourceId)
    const onRetryFailure = vi.fn(() => 'presented' as const)
    let view: ReturnType<typeof render> | undefined

    try {
      await expect(client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })).rejects.toThrow(
        /httpStatus=503/
      )
      expect(producerCalls).toBe(1)
      const query = client.getQueryCache().find({ queryKey: key, exact: true })
      if (!query) throw new Error('Expected the real no-cache permission Query entry')
      expect(query.state.data).toBeUndefined()
      expect(query.state.status).toBe('error')

      installPermissionErrorTracking(client)
      const owner = 'a6-no-cache-join-owner'
      const bindingKey = 'preview:A:session-7'
      const descriptor = createDescriptor({
        client,
        key,
        query,
        owner,
        bindingKey,
        queryFn,
        onRetryFailure,
      })
      const activeFetch = client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })
      void activeFetch.catch(() => undefined)
      await waitFor(() => expect(producerCalls).toBe(2))
      expect(query.state.data).toBeUndefined()
      expect(query.state.fetchStatus).toBe('fetching')

      view = render(
        <QueryClientProvider client={client}>
          <OwnerHarness
            owner={owner}
            bindingKey={bindingKey}
            client={client}
            query={query}
            descriptor={descriptor}
            ownerKey={0}
          />
        </QueryClientProvider>
      )
      const dialog = await screen.findByRole('alertdialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(getPermissionErrorsForOwner(owner).acknowledged).toHaveLength(1))
      await Promise.resolve()
      expect(producerCalls).toBe(2)
      expect(query.state.fetchStatus).toBe('fetching')

      rejectPending(serviceFailure)
      await expect(activeFetch).rejects.toThrow(/httpStatus=503/)
      await waitFor(() => expect(onRetryFailure).toHaveBeenCalledTimes(1))
      expect(query.state.data).toBeUndefined()
      expect(query.state.status).toBe('error')
      expect(getPermissionErrorsForOwner(owner).errors).toHaveLength(1)
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
    } finally {
      view?.unmount()
      client.clear()
    }
  })

  it('observes both actual QueryCache terminal event orders under scheduler control', async () => {
    const serviceFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      resourceId
    )
    const observedOrders = new Set<string>()

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
        })
        installPermissionErrorTracking(client)
        const failures = appServiceAffordanceProducer(async () => {
          return scheduler.schedule(Promise.resolve(undefined), 'permission failure').then(() => {
            throw serviceFailure
          })
        })
        const successes = appServiceAffordanceProducer(async () => {
          return scheduler.schedule(
            Promise.resolve(heldPermissionResponse(['read'])),
            'permission recovery'
          )
        })
        const failureKey = ['gfs', 'affordances', sessionScope, 'a6-failure', 'main', 7] as const
        const successKey = ['gfs', 'affordances', sessionScope, 'a6-success', 'main', 7] as const
        const order: string[] = []
        const unsubscribe = client.getQueryCache().subscribe(event => {
          if (event.type === 'updated' && event.action.type === 'error') order.push('failure')
          if (event.type === 'updated' && event.action.type === 'success') order.push('success')
        })
        const failure = client.fetchQuery({
          queryKey: failureKey,
          queryFn: () => failures('a6-failure'),
        })
        const success = client.fetchQuery({
          queryKey: successKey,
          queryFn: () => successes('a6-success'),
        })
        void failure.catch(() => undefined)

        try {
          await waitFor(() => expect(scheduler.count()).toBe(2))
          await act(async () => scheduler.waitNext(1))
          await waitFor(() => expect(order).toHaveLength(1))
          const first = order[0]
          expect(first === 'failure' || first === 'success').toBe(true)
          await act(async () => scheduler.waitIdle())
          await success
          await waitFor(() => expect(order).toHaveLength(2))
          observedOrders.add(order.join(','))

          const failureQuery = client.getQueryCache().find({ queryKey: failureKey, exact: true })
          const successQuery = client.getQueryCache().find({ queryKey: successKey, exact: true })
          expect(failureQuery?.state.status).toBe('error')
          expect(successQuery?.state.status).toBe('success')
          expect(client.getQueryCache().getAll()).toContain(failureQuery)
          expect(client.getQueryCache().getAll()).toContain(successQuery)
        } finally {
          unsubscribe()
          client.clear()
        }
      }),
      { numRuns: 80, seed: 142714 }
    )

    expect(observedOrders).toEqual(new Set(['failure,success', 'success,failure']))
  })
})
