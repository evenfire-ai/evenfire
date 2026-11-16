// @vitest-environment jsdom
import { Suspense, startTransition, useLayoutEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Query, QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PermissionErrorDialog } from '@components/Common'
import { assertGfsAuthorityRetryAllowed } from '@lib/gfsAuthorityQueryPolicy'
import { isGfsSessionAuthorityFailure } from '@lib/gfsGrantErrors'
import { affordancesApiError } from '@/gfs/__fixtures__/permissionProducerFixtures'
import { desktopQueryKeys, hasGfsSessionGeneration } from '@/hooks/domain/queryKeys'
import type {
  PermissionErrorItem,
  PermissionRetryAttempt,
  PermissionRetryContext,
} from '../PermissionErrorDialog/types'
import {
  acknowledgePermissionErrors,
  commitPermissionErrorDescriptors,
  commitPermissionQueryBinding,
  deactivatePermissionQueryBinding,
  getPermissionErrorsForOwner,
  installPermissionErrorTracking,
  isPermissionErrorAcknowledged,
  permissionErrorToken,
  usePermissionErrorAcknowledgementSnapshot,
} from '../permissionErrorAcknowledgement'

afterEach(cleanup)

type PermissionQuery = Query

function permissionError(
  queryIdentity: PermissionQuery,
  retry?: (context?: PermissionRetryContext) => PermissionRetryAttempt
): PermissionErrorItem {
  return {
    id: `resource:${queryIdentity.state.errorUpdateCount}`,
    message: 'Could not verify permissions for report.txt.',
    errorUpdateCount: queryIdentity.state.errorUpdateCount,
    queryIdentity,
    retry,
  }
}

function Presenter({
  queryClient,
  queryIdentity,
  retry,
}: {
  queryClient: QueryClient
  queryIdentity: PermissionQuery
  retry?: () => PermissionRetryAttempt
}) {
  installPermissionErrorTracking(queryClient)
  usePermissionErrorAcknowledgementSnapshot()
  const error =
    queryIdentity.state.status === 'error' ? permissionError(queryIdentity, retry) : null
  const errors = error && !isPermissionErrorAcknowledged(error) ? [error] : []
  return <PermissionErrorDialog errors={errors} onDismiss={() => undefined} />
}

function RetryOwnerPresenter({
  queryClient,
  queryIdentity,
  owner,
  producer,
  retryAdapterIds,
}: {
  queryClient: QueryClient
  queryIdentity: Query
  owner: string
  producer: () => Promise<unknown>
  retryAdapterIds: string[]
}) {
  const [retryFailure, setRetryFailure] = useState('')
  installPermissionErrorTracking(queryClient)
  usePermissionErrorAcknowledgementSnapshot()
  const descriptor: PermissionErrorItem | null =
    queryIdentity.state.status === 'error'
      ? {
          id: `resource:${queryIdentity.state.errorUpdateCount}`,
          message: 'Could not verify permissions for report.txt.',
          queryIdentity,
          errorUpdateCount: queryIdentity.state.errorUpdateCount,
          retry: context => {
            const id = `resource:${queryIdentity.state.errorUpdateCount}`
            if (!context?.onAdmitted()) return { admitted: false }
            retryAdapterIds.push(id)
            const completion = queryClient.fetchQuery({
              queryKey: queryIdentity.queryKey,
              queryFn: producer,
              retry: false,
              staleTime: 0,
            })
            return { admitted: true, completion }
          },
          onRetryFailure: (error, context) => {
            if (!context.isOriginCurrent()) return 'stale'
            setRetryFailure(error instanceof Error ? error.message : String(error))
            return 'presented'
          },
        }
      : null
  useLayoutEffect(() => {
    commitPermissionQueryBinding(owner, 'binding-A', [queryIdentity])
    return () => deactivatePermissionQueryBinding(owner)
  }, [owner, queryIdentity])
  useLayoutEffect(() => {
    commitPermissionErrorDescriptors(owner, 'binding-A', descriptor ? [descriptor] : [])
  })
  return (
    <>
      <PermissionErrorDialog
        errors={getPermissionErrorsForOwner(owner).errors}
        onDismiss={() => undefined}
      />
      {retryFailure ? <div role="status">Retry failed: {retryFailure}</div> : null}
    </>
  )
}

describe('permission error acknowledgement with real Query state', () => {
  it('releases a dormant owner after its exact Query is removed', async context => {
    const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc
    if (!collectGarbage) return context.skip()

    function createRemovedQueryReference(): WeakRef<Query> {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      installPermissionErrorTracking(queryClient)
      const queryKey = ['permission-owner-retirement', 'resource-a'] as const
      queryClient.setQueryData(queryKey, { permission: 'observed' })
      const query = queryClient.getQueryCache().find({ queryKey, exact: true })
      if (!query) throw new Error('QueryClient did not retain the failed permission Query')
      const owner = `retirement-${Math.random()}`
      const bindingKey = 'resource-a'
      commitPermissionQueryBinding(owner, bindingKey, [query])
      commitPermissionErrorDescriptors(owner, bindingKey, [permissionError(query)])
      deactivatePermissionQueryBinding(owner)
      const reference = new WeakRef(query)
      queryClient.removeQueries({ queryKey, exact: true })
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
      queryClient.clear()
      return reference
    }

    const reference = createRemovedQueryReference()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      collectGarbage()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(reference.deref()).toBeUndefined()
  })

  it('retains a generation-scoped authority route after the presenter becomes dormant', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const scope = ':user-a:team-a'
    const generation = 31
    const resourceId = 'authority-route-resource'
    const queryKey = desktopQueryKeys.gfsAffordances(scope, resourceId, 'main', generation)
    const accessKey = desktopQueryKeys.gfsAccessState(scope, generation)
    const owner = `authority-route-${Math.random()}`
    const failure = await affordancesApiError(
      401,
      { code: 'unauthorized', message: 'Session expired' },
      resourceId
    )
    let currentGeneration = generation
    let authorityEffects = 0
    try {
      installPermissionErrorTracking(queryClient)
      queryClient.setQueryData(accessKey, 'active')
      await queryClient.fetchQuery({
        queryKey,
        queryFn: async () => ({ held: ['read'] }),
        staleTime: 0,
      })
      const query = queryClient.getQueryCache().find({ queryKey, exact: true })
      if (!query) throw new Error('QueryClient did not retain the real permission Query')

      commitPermissionQueryBinding(owner, 'resource-A', [query], {
        authorityRoute: {
          scope,
          generation,
          isAuthorityFailure: error =>
            isGfsSessionAuthorityFailure(
              error instanceof Error ? error.message : String(error),
              'operation'
            ),
          handleAuthorityFailure: error => {
            if (
              !isGfsSessionAuthorityFailure(
                error instanceof Error ? error.message : String(error),
                'operation'
              )
            )
              return false
            if (currentGeneration !== generation) return true
            authorityEffects += 1
            queryClient.setQueryData(accessKey, 'revoked')
            queryClient.removeQueries({
              predicate: candidate =>
                candidate.queryKey[0] === 'desktop-app' &&
                candidate.queryKey[1] === 'gfs' &&
                candidate.queryKey[2] === scope &&
                hasGfsSessionGeneration(candidate.queryKey, generation),
            })
            return true
          },
        },
      })
      deactivatePermissionQueryBinding(owner)

      await expect(
        queryClient.fetchQuery({
          queryKey,
          queryFn: async () => Promise.reject(failure),
          staleTime: 0,
        })
      ).rejects.toBe(failure)

      expect(queryClient.getQueryData(accessKey)).toBe('revoked')
      expect(queryClient.getQueryCache().find({ queryKey, exact: true })).toBeUndefined()
      expect(authorityEffects).toBe(1)
    } finally {
      deactivatePermissionQueryBinding(owner)
      queryClient.clear()
    }
  })

  it('does not let a retained old-generation route revoke the replacement namespace', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const scope = ':user-a:team-a'
    const oldGeneration = 32
    const newGeneration = 33
    const resourceId = 'authority-route-generation'
    const oldKey = desktopQueryKeys.gfsAffordances(scope, resourceId, 'main', oldGeneration)
    const newKey = desktopQueryKeys.gfsChildren(scope, 'replacement-folder', 'main', newGeneration)
    const oldAccessKey = desktopQueryKeys.gfsAccessState(scope, oldGeneration)
    const newAccessKey = desktopQueryKeys.gfsAccessState(scope, newGeneration)
    const owner = `authority-route-generation-${Math.random()}`
    const failure = await affordancesApiError(
      401,
      { code: 'unauthorized', message: 'Session expired' },
      resourceId
    )
    let currentGeneration = oldGeneration
    try {
      installPermissionErrorTracking(queryClient)
      queryClient.setQueryData(oldAccessKey, 'active')
      queryClient.setQueryData(newAccessKey, 'active')
      queryClient.setQueryData(newKey, { pages: [{ items: [{ resourceId: 'new-file' }] }] })
      await queryClient.fetchQuery({
        queryKey: oldKey,
        queryFn: async () => ({ held: ['read'] }),
        staleTime: 0,
      })
      const oldQuery = queryClient.getQueryCache().find({ queryKey: oldKey, exact: true })
      if (!oldQuery) throw new Error('QueryClient did not retain the old permission Query')
      commitPermissionQueryBinding(owner, 'old-generation', [oldQuery], {
        authorityRoute: {
          scope,
          generation: oldGeneration,
          isAuthorityFailure: error =>
            isGfsSessionAuthorityFailure(
              error instanceof Error ? error.message : String(error),
              'operation'
            ),
          handleAuthorityFailure: error => {
            if (
              !isGfsSessionAuthorityFailure(
                error instanceof Error ? error.message : String(error),
                'operation'
              )
            )
              return false
            if (currentGeneration !== oldGeneration) return true
            queryClient.setQueryData(oldAccessKey, 'revoked')
            queryClient.removeQueries({
              predicate: candidate =>
                candidate.queryKey[0] === 'desktop-app' &&
                candidate.queryKey[1] === 'gfs' &&
                candidate.queryKey[2] === scope &&
                hasGfsSessionGeneration(candidate.queryKey, oldGeneration),
            })
            return true
          },
        },
      })
      deactivatePermissionQueryBinding(owner)
      currentGeneration = newGeneration

      await expect(
        queryClient.fetchQuery({
          queryKey: oldKey,
          queryFn: async () => Promise.reject(failure),
          staleTime: 0,
        })
      ).rejects.toBe(failure)

      expect(queryClient.getQueryData(newAccessKey)).toBe('active')
      expect(queryClient.getQueryData(newKey)).toEqual({
        pages: [{ items: [{ resourceId: 'new-file' }] }],
      })
      expect(queryClient.getQueryData(oldAccessKey)).toBe('active')
    } finally {
      deactivatePermissionQueryBinding(owner)
      queryClient.clear()
    }
  })

  it('keeps a dismissed Query episode acknowledged across owner departure and return', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const queryKey = ['permission-dormant-owner', 'resource-a'] as const
    const failure = Object.assign(new Error('permission service unavailable'), { httpStatus: 503 })
    await expect(
      queryClient.fetchQuery({ queryKey, queryFn: async () => Promise.reject(failure) })
    ).rejects.toBe(failure)
    const queryIdentity = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!queryIdentity) throw new Error('QueryClient did not retain the failed permission Query')
    const trackedQuery = queryIdentity
    const error = permissionError(trackedQuery)
    acknowledgePermissionErrors([error])
    const previewOwner = `c1b2-preview-${Math.random()}`
    const filesOwner = `c1b2-files-${Math.random()}`

    function BindingPresenter() {
      installPermissionErrorTracking(queryClient)
      usePermissionErrorAcknowledgementSnapshot()
      useLayoutEffect(() => {
        commitPermissionQueryBinding(previewOwner, 'preview-a', [trackedQuery])
        commitPermissionQueryBinding(filesOwner, 'folder-a', [trackedQuery])
        commitPermissionErrorDescriptors(filesOwner, 'folder-a', [currentError])
        deactivatePermissionQueryBinding(previewOwner)
        return () => {
          deactivatePermissionQueryBinding(previewOwner)
          deactivatePermissionQueryBinding(filesOwner)
        }
      }, [])
      const currentError = permissionError(trackedQuery)
      const errors = getPermissionErrorsForOwner(filesOwner).errors
      return (
        <>
          <button
            onClick={() => {
              commitPermissionQueryBinding(filesOwner, 'folder-b', [])
            }}
          >
            Commit Files departure
          </button>
          <button
            onClick={() => {
              commitPermissionQueryBinding(filesOwner, 'folder-a', [trackedQuery])
              commitPermissionErrorDescriptors(filesOwner, 'folder-a', [currentError])
            }}
          >
            Return to Files binding
          </button>
          <PermissionErrorDialog errors={errors} onDismiss={() => undefined} />
        </>
      )
    }

    try {
      render(<BindingPresenter />)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Commit Files departure' }))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Return to Files binding' }))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(isPermissionErrorAcknowledged(error)).toBe(true)
    } finally {
      deactivatePermissionQueryBinding(previewOwner)
      deactivatePermissionQueryBinding(filesOwner)
      queryClient.clear()
    }
  })

  it('does not acknowledge a guard-rejected Retry during an automatic Query fetch', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const queryKey = ['permission-retry-guard', 'resource-a'] as const
    const rateLimited = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'resource-a'
    )
    queryClient.setQueryData(queryKey, { permission: true })
    await expect(
      queryClient.fetchQuery({ queryKey, queryFn: async () => Promise.reject(rateLimited) })
    ).rejects.toBe(rateLimited)
    const queryIdentity = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!queryIdentity) throw new Error('QueryClient did not retain the failed permission Query')
    const errorUpdateCount = queryIdentity.state.errorUpdateCount
    let settleAutomaticFetch!: (value: { permission: true }) => void
    const automaticFetch = queryClient.fetchQuery({
      queryKey,
      queryFn: () =>
        new Promise<{ permission: true }>(resolve => {
          settleAutomaticFetch = resolve
        }),
    })
    expect(queryIdentity.state.fetchStatus).toBe('fetching')
    expect(queryIdentity.state.errorUpdateCount).toBe(errorUpdateCount)

    let retryAdmissions = 0
    const retry = () => {
      try {
        assertGfsAuthorityRetryAllowed(queryClient, queryKey)
        retryAdmissions += 1
        return { admitted: true }
      } catch {
        return { admitted: false }
      }
    }
    const view = render(
      <Presenter queryClient={queryClient} queryIdentity={queryIdentity} retry={retry} />
    )
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
    expect(retryAdmissions).toBe(0)
    expect(queryIdentity.state.fetchStatus).toBe('fetching')
    view.rerender(
      <Presenter queryClient={queryClient} queryIdentity={queryIdentity} retry={retry} />
    )
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(/Could not verify permissions for report.txt/)).toBeTruthy()

    await act(async () => {
      settleAutomaticFetch({ permission: true })
      await automaticFetch
    })
    queryClient.clear()
  })

  it('acknowledges only after a real QueryClient Retry enters fetching', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const queryKey = ['permission-retry', 'resource-a'] as const
    await expect(
      queryClient.fetchQuery({
        queryKey,
        queryFn: async () => {
          throw new Error('permission service unavailable')
        },
      })
    ).rejects.toThrow('permission service unavailable')
    const queryIdentity = queryClient.getQueryCache().find({ queryKey, exact: true })
    expect(queryIdentity?.state.status).toBe('error')
    expect(queryIdentity?.state.fetchStatus).toBe('idle')
    if (!queryIdentity) throw new Error('QueryClient did not retain the failed permission Query')

    let settleRetry!: (value: { permission: boolean }) => void
    const retryResult = new Promise<{ permission: boolean }>(resolve => {
      settleRetry = resolve
    })
    let retryPromise: Promise<{ permission: boolean }> | undefined
    const retry = () => {
      retryPromise = queryClient.fetchQuery({
        queryKey,
        queryFn: () => retryResult,
      })
      return { admitted: true, completion: retryPromise }
    }

    const view = render(
      <Presenter queryClient={queryClient} queryIdentity={queryIdentity} retry={retry} />
    )
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))

    expect(queryIdentity.state.fetchStatus).toBe('fetching')
    view.rerender(
      <Presenter queryClient={queryClient} queryIdentity={queryIdentity} retry={retry} />
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await act(async () => {
      settleRetry({ permission: true })
      await retryPromise
    })
    expect(queryIdentity.state.status).toBe('success')
    queryClient.clear()
  })

  it('routes a retained Retry callback through the latest exact-Query adapter', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = ['permission-latest-retry-adapter', 'resource-a'] as const
    const failure = new Error('permission service unavailable')
    await expect(
      queryClient.fetchQuery({ queryKey, queryFn: async () => Promise.reject(failure) })
    ).rejects.toBe(failure)
    const query = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!query) throw new Error('QueryClient did not retain the real permission Query')
    const owner = `latest-retry-adapter-${Math.random()}`
    const retryAdapterIds: string[] = []
    let releaseRetry!: (value: { permission: true }) => void
    const pendingRetry = new Promise<{ permission: true }>(resolve => {
      releaseRetry = resolve
    })
    let completion: Promise<unknown> | undefined

    const view = render(
      <RetryOwnerPresenter
        queryClient={queryClient}
        queryIdentity={query}
        owner={owner}
        producer={() => {
          completion = pendingRetry
          return pendingRetry
        }}
        retryAdapterIds={retryAdapterIds}
      />
    )
    try {
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
      const initialToken = permissionErrorToken(permissionError(query))

      await expect(
        queryClient.fetchQuery({
          queryKey,
          queryFn: async () => Promise.reject(failure),
          retry: false,
          staleTime: 0,
        })
      ).rejects.toBe(failure)
      await waitFor(() =>
        expect(getPermissionErrorsForOwner(owner).errors[0]?.id).not.toBe('resource:1')
      )
      expect(permissionErrorToken(permissionError(query))).toBe(initialToken)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      })
      await waitFor(() => expect(query.state.fetchStatus).toBe('fetching'))
      expect(retryAdapterIds).toEqual(['resource:2'])
      expect(screen.queryByRole('alertdialog')).toBeNull()

      await act(async () => {
        releaseRetry({ permission: true })
        await completion
      })
      expect(query.state.status).toBe('success')
      expect(screen.queryByRole('alertdialog')).toBeNull()
    } finally {
      view.unmount()
      releaseRetry({ permission: true })
      deactivatePermissionQueryBinding(owner)
      queryClient.clear()
    }
  })

  it('does not project an admitted Retry failure into a newer committed binding', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const queryKey = ['permission-origin-binding', 'resource-a'] as const
    const failure = Object.assign(new Error('permission service unavailable'), { httpStatus: 503 })
    await expect(
      queryClient.fetchQuery({ queryKey, queryFn: async () => Promise.reject(failure) })
    ).rejects.toBe(failure)
    const query = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!query) throw new Error('QueryClient did not retain the real permission Query')
    const trackedQuery = query
    const owner = `origin-binding-${Math.random()}`
    let retryCompletion: Promise<unknown> | undefined
    let rejectRetry!: (error: Error) => void
    const retryProducer = new Promise<never>((_resolve, reject) => {
      rejectRetry = reject
    })

    function OwnerPresenter({ bindingKey }: { bindingKey: string }) {
      installPermissionErrorTracking(queryClient)
      usePermissionErrorAcknowledgementSnapshot()
      useLayoutEffect(() => {
        commitPermissionQueryBinding(owner, bindingKey, [trackedQuery])
        const errors =
          trackedQuery.state.status === 'error'
            ? [
                permissionError(trackedQuery, context => {
                  context?.onAdmitted()
                  retryCompletion = queryClient.fetchQuery({
                    queryKey,
                    queryFn: () => retryProducer,
                    retry: false,
                  })
                  return { admitted: true, completion: retryCompletion }
                }),
              ]
            : []
        commitPermissionErrorDescriptors(owner, bindingKey, errors)
      })
      return (
        <PermissionErrorDialog
          errors={getPermissionErrorsForOwner(owner).errors}
          onDismiss={() => undefined}
        />
      )
    }

    try {
      const view = render(<OwnerPresenter bindingKey="binding-A" />)
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(query.state.fetchStatus).toBe('fetching'))
      view.rerender(<OwnerPresenter bindingKey="binding-B" />)
      expect(screen.queryByRole('alertdialog')).toBeNull()

      await act(async () => {
        rejectRetry(failure)
        await retryCompletion?.catch(() => undefined)
      })
      expect(trackedQuery.state.status).toBe('error')
      expect(query.state.error).toBe(failure)
      expect(getPermissionErrorsForOwner(owner).errors).toEqual([])
      expect(getPermissionErrorsForOwner(owner).acknowledged).toEqual([])
      expect(screen.queryByRole('alertdialog')).toBeNull()
    } finally {
      deactivatePermissionQueryBinding(owner)
      queryClient.clear()
    }
  })

  it('keeps a real Query failure acknowledged across presenter unmount and remount', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const queryKey = ['permission-remount', 'resource-a'] as const
    await expect(
      queryClient.fetchQuery({
        queryKey,
        queryFn: async () => {
          throw new Error('permission service unavailable')
        },
      })
    ).rejects.toThrow('permission service unavailable')
    const queryIdentity = queryClient.getQueryCache().find({ queryKey, exact: true })
    expect(queryIdentity?.state.status).toBe('error')
    expect(queryIdentity?.state.errorUpdateCount).toBe(1)
    if (!queryIdentity) throw new Error('QueryClient did not retain the failed permission Query')
    const retainedQuery = queryIdentity

    function RemountingPresenter() {
      installPermissionErrorTracking(queryClient)
      usePermissionErrorAcknowledgementSnapshot()
      const error = retainedQuery.state.status === 'error' ? permissionError(retainedQuery) : null
      const errors = error && !isPermissionErrorAcknowledged(error) ? [error] : []
      return <PermissionErrorDialog errors={errors} onDismiss={() => undefined} />
    }

    const firstMount = render(<RemountingPresenter />)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    firstMount.unmount()

    render(<RemountingPresenter />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(isPermissionErrorAcknowledged(permissionError(retainedQuery))).toBe(true)
    queryClient.clear()
  })

  it('keeps dismissal across same-projection refetch and presenter remount', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = ['permission-refetch-remount', 'resource-a'] as const
    const failure = new Error('permission service unavailable')
    const fail = async () => Promise.reject(failure)
    await expect(queryClient.fetchQuery({ queryKey, queryFn: fail })).rejects.toBe(failure)
    const queryIdentity = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!queryIdentity) throw new Error('QueryClient did not retain the failed permission Query')

    const firstMount = render(<Presenter queryClient={queryClient} queryIdentity={queryIdentity} />)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    firstMount.unmount()

    await expect(queryClient.fetchQuery({ queryKey, queryFn: fail })).rejects.toBe(failure)
    expect(queryIdentity.state.errorUpdateCount).toBe(2)
    render(<Presenter queryClient={queryClient} queryIdentity={queryIdentity} />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    queryClient.clear()
  })

  it('publishes an admitted Retry failure without a Query observer rerender', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = ['permission-retry-publication', 'resource-a'] as const
    const failure = new Error('permission service unavailable')
    await expect(
      queryClient.fetchQuery({ queryKey, queryFn: async () => Promise.reject(failure) })
    ).rejects.toBe(failure)
    const queryIdentity = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!queryIdentity) throw new Error('QueryClient did not retain the failed permission Query')
    let retryPromise: Promise<never> | undefined
    const retry = () => {
      retryPromise = queryClient.fetchQuery({
        queryKey,
        queryFn: async () => Promise.reject(failure),
      })
      return { admitted: true, completion: retryPromise }
    }
    try {
      render(<Presenter queryClient={queryClient} queryIdentity={queryIdentity} retry={retry} />)
      expect(screen.getByRole('alertdialog')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      await act(async () => {
        await retryPromise?.catch(() => undefined)
      })
      expect(queryIdentity.state.status).toBe('error')
      expect(screen.getByRole('alertdialog')).toBeTruthy()
    } finally {
      queryClient.clear()
    }
  })

  it('reports a failure from a replacement Query with the same key', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = ['permission-replacement', 'resource-a'] as const
    const failure = new Error('permission service unavailable')
    const fail = () =>
      queryClient.fetchQuery({ queryKey, queryFn: async () => Promise.reject(failure) })
    await expect(fail()).rejects.toBe(failure)
    const firstQuery = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!firstQuery) throw new Error('QueryClient did not retain the first failed Query')
    const view = render(<Presenter queryClient={queryClient} queryIdentity={firstQuery} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    queryClient.removeQueries({ queryKey, exact: true })
    await expect(fail()).rejects.toBe(failure)
    const replacementQuery = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!replacementQuery) throw new Error('QueryClient did not retain the replacement Query')
    expect(replacementQuery).not.toBe(firstQuery)
    view.rerender(<Presenter queryClient={queryClient} queryIdentity={replacementQuery} />)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    queryClient.clear()
  })

  it('reports failures after recovery, reset, and A-to-B-to-A projection changes', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = ['permission-episode-boundaries', 'resource-a'] as const
    const firstFailure = new Error('permission service unavailable')
    const secondFailure = new Error('permission service timed out')
    const failWith = (error: Error) =>
      queryClient.fetchQuery({ queryKey, queryFn: async () => Promise.reject(error) })
    await expect(failWith(firstFailure)).rejects.toBe(firstFailure)
    const queryIdentity = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!queryIdentity) throw new Error('QueryClient did not retain the failed permission Query')
    const view = render(<Presenter queryClient={queryClient} queryIdentity={queryIdentity} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await expect(failWith(secondFailure)).rejects.toBe(secondFailure)
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await expect(failWith(firstFailure)).rejects.toBe(firstFailure)
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await queryClient.fetchQuery({ queryKey, queryFn: async () => ({ permission: true }) })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await expect(failWith(firstFailure)).rejects.toBe(firstFailure)
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await queryClient.resetQueries({ queryKey, exact: true })
    await expect(failWith(firstFailure)).rejects.toBe(firstFailure)
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    view.unmount()
    queryClient.clear()
  })

  it('uses the committed Query when Escape arrives during an abandoned concurrent render', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKeyA = ['permission-concurrent-escape', 'resource-a'] as const
    const queryKeyB = ['permission-concurrent-escape', 'resource-b'] as const
    await expect(
      queryClient.fetchQuery({
        queryKey: queryKeyA,
        queryFn: async () => {
          throw new Error('resource A permission failure')
        },
      })
    ).rejects.toThrow('resource A permission failure')
    await expect(
      queryClient.fetchQuery({
        queryKey: queryKeyB,
        queryFn: async () => {
          throw new Error('resource B permission failure')
        },
      })
    ).rejects.toThrow('resource B permission failure')
    const queryA = queryClient.getQueryCache().find({ queryKey: queryKeyA, exact: true })
    const queryB = queryClient.getQueryCache().find({ queryKey: queryKeyB, exact: true })
    if (!queryA || !queryB) throw new Error('QueryClient did not retain both failed Queries')
    const errorA = { ...permissionError(queryA), id: 'resource-a', message: 'Could not verify A' }
    const errorB = { ...permissionError(queryB), id: 'resource-b', message: 'Could not verify B' }
    installPermissionErrorTracking(queryClient)

    let releaseRender!: () => void
    const renderGate = new Promise<void>(resolve => {
      releaseRender = resolve
    })
    const attemptedBRender = vi.fn()
    function HoldConcurrentRender(): never {
      attemptedBRender()
      throw renderGate
    }
    function ConcurrentCandidate() {
      const [candidate, setCandidate] = useState<'A' | 'B'>('A')
      const currentError = candidate === 'A' ? errorA : errorB
      return (
        <>
          <PermissionErrorDialog errors={[currentError]} onDismiss={() => undefined} />
          {candidate === 'B' ? <HoldConcurrentRender /> : null}
          <button onClick={() => startTransition(() => setCandidate('B'))}>
            Start B candidate
          </button>
        </>
      )
    }

    try {
      render(
        <Suspense fallback={<p>Pending candidate</p>}>
          <ConcurrentCandidate />
        </Suspense>
      )
      const committedDialog = screen.getByRole('alertdialog')
      expect(within(committedDialog).getByText('Could not verify A')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Start B candidate' }))
      await waitFor(() => expect(attemptedBRender).toHaveBeenCalled())
      expect(screen.getByRole('alertdialog')).toBe(committedDialog)
      fireEvent.keyDown(committedDialog, { key: 'Escape' })

      expect(isPermissionErrorAcknowledged(errorA)).toBe(true)
      expect(isPermissionErrorAcknowledged(errorB)).toBe(false)
    } finally {
      releaseRender()
      queryClient.clear()
    }
  })
})
