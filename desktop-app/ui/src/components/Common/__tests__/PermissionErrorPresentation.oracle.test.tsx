// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { type Query, QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { PermissionErrorDialog } from '@components/Common'
import { assertGfsAuthorityRetryAllowed } from '@lib/gfsAuthorityQueryPolicy'
import { affordancesApiError } from '@/gfs/__fixtures__/permissionProducerFixtures'
import type { PermissionErrorItem, PermissionRetryAttempt } from '../PermissionErrorDialog/types'
import {
  acknowledgePermissionErrors,
  installPermissionErrorTracking,
  isPermissionErrorAcknowledged,
  usePermissionErrorAcknowledgementSnapshot,
} from '../permissionErrorAcknowledgement'

afterEach(cleanup)

type PermissionQuery = Query

function permissionError(
  queryIdentity: PermissionQuery,
  retry?: () => PermissionRetryAttempt
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

describe('permission error acknowledgement with real Query state', () => {
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
})
