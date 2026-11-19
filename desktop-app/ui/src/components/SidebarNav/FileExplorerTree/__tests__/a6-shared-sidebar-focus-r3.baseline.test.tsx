// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { releaseExpiredGfsDeferredReads } from '@lib/gfsDeferredReadGate'
import { gfsRidOfResourceId } from '@lib/gfsWatchKeys'
import { refetchWatchedFolder } from '@lib/gfsWatchReaction'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  affordancesResult,
  childView,
  gfsRouteFailureMessage,
  listAccessiblePage,
  listChildrenPage,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { heldPermissionResponse } from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FileExplorerTree } from '..'

const mockAuthContext = vi.hoisted(() => ({
  isAuthenticated: true,
  me: { id: 'user-1', teamId: 'team-1' },
  runtimeConfigState: { envKey: 'test' },
  sessionGeneration: 7,
}))
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => mockAuthContext,
}))

function installClerum(producers: {
  listAccessible?: () => Promise<unknown>
  listChildren: (...args: unknown[]) => Promise<unknown>
}) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 7) },
      gfs: {
        listAccessible: producers.listAccessible ?? vi.fn(async () => listAccessiblePage([])),
        listChildren: producers.listChildren,
        affordances: vi.fn(async () =>
          affordancesResult(heldPermissionResponse(['read', 'write']))
        ),
      },
    },
  })
}

function renderTree() {
  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  render(
    <QueryClientProvider client={queryClient}>
      <FileExplorerTree onOpenFolder={vi.fn()} onOpenPreview={vi.fn()} pushToast={vi.fn()} />
    </QueryClientProvider>
  )
  return { queryClient }
}

function ControllerFolderProbe() {
  const controller = useGfsBrowserController()
  return (
    <>
      <div data-testid="controller-current">{controller.current?.resourceId ?? 'none'}</div>
      <button type="button" onClick={() => void controller.openUri('gfs://main/reports')}>
        Open controller Reports
      </button>
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  focusManager.setFocused(undefined)
  vi.restoreAllMocks()
})

it('T-S1/S2: shared Sidebar/controller Query rejects focus before the 429 effect updates its ref', async () => {
  const limitMessage = await gfsRouteFailureMessage(
    client =>
      client.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  let attempts = 0
  const listChildren = vi.fn(async () => {
    attempts += 1
    if (attempts === 1) return listChildrenPage([childView('old-child', 'old.md', 'file')])
    throw new Error(limitMessage)
  })
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 7) },
      gfs: {
        listAccessible: vi.fn(async () =>
          listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
        ),
        resolve: vi.fn(async () => resolvedDirectory('reports', 'Reports')),
        listChildren,
        affordances: vi.fn(async () =>
          affordancesResult(heldPermissionResponse(['read', 'write']))
        ),
      },
    },
  })

  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  render(
    <QueryClientProvider client={client}>
      <ControllerFolderProbe />
      <FileExplorerTree onOpenFolder={vi.fn()} onOpenPreview={vi.fn()} pushToast={vi.fn()} />
    </QueryClientProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  expect(await screen.findByRole('button', { name: 'old.md' })).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open controller Reports' }))
  })
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)
  await waitFor(() => expect(screen.getByTestId('controller-current').textContent).toBe('reports'))
  expect(client.getQueryCache().find({ queryKey: key })?.getObserversCount()).toBe(2)
  expect(listChildren).toHaveBeenCalledTimes(1)
  let focusInjected = false
  const stop = client.getQueryCache().subscribe(event => {
    if (
      !focusInjected &&
      event.type === 'updated' &&
      event.query.queryKey[2] === 'test:user-1:team-1' &&
      event.query.queryKey[3] === 'children' &&
      event.query.queryKey[5] === 'reports' &&
      event.query.state.error
    ) {
      focusInjected = true
      // Query cache error state is already written; the controller passive
      // effect that copies its deadline into pausedUntilRef has not committed.
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    }
  })

  await act(async () => {
    await client.refetchQueries({ queryKey: key, exact: true })
  })
  stop()
  expect(focusInjected).toBe(true)
  expect(client.getQueryState(key)?.error?.message).toContain('retryAfterSeconds=7')
  expect(await screen.findByRole('button', { name: 'old.md' })).toBeTruthy()

  // A4 cost oracle: this controlled focus must not spend a read after the
  // same shared Query stores its 429 but before the controller effect runs.
  expect(listChildren).toHaveBeenCalledTimes(2)
})

it('T-S1: an expanded Sidebar folder does not refetch during its producer 429 window', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  let attempts = 0
  const listChildren = vi.fn(async () => {
    attempts += 1
    if (attempts === 1) return listChildrenPage([childView('old-child', 'old.md', 'file')])
    if (attempts === 3) return listChildrenPage([childView('fresh-child', 'fresh.md', 'file')])
    throw new Error(message)
  })
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  expect(await screen.findByRole('button', { name: 'old.md' })).toBeTruthy()

  await act(async () => {
    await queryClient.refetchQueries({ queryKey: key, exact: true })
  })
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('error'))
  vi.useFakeTimers({ toFake: ['Date'] })
  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })

  expect(screen.getByRole('button', { name: 'old.md' })).toBeTruthy()
  expect(queryClient.getQueryState(key)?.status).toBe('error')
  // Initial success and explicit 429 remain the only reads during cooldown.
  expect(listChildren).toHaveBeenCalledTimes(2)
})

it('T-S1: an eligible post-deadline Sidebar focus shows the refreshed children', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  let attempts = 0
  const listChildren = vi.fn(async () => {
    attempts += 1
    if (attempts === 1) return listChildrenPage([childView('old-child', 'old.md', 'file')])
    if (attempts === 2) throw new Error(message)
    return listChildrenPage([childView('fresh-child', 'fresh.md', 'file')])
  })
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  expect(await screen.findByRole('button', { name: 'old.md' })).toBeTruthy()
  vi.useFakeTimers({ toFake: ['Date'] })
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: key, exact: true })
  })
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('error'))
  vi.setSystemTime(Date.now() + 8_000)
  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })

  expect(await screen.findByRole('button', { name: 'fresh.md' })).toBeTruthy()
  expect(listChildren).toHaveBeenCalledTimes(3)
})

it('T-S5-N: a no-data same-key collapse/remount does not retry a live folder 429', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  let recoverAt = Number.POSITIVE_INFINITY
  const listChildren = vi.fn(async () => {
    if (Date.now() >= recoverAt)
      return listChildrenPage([childView('fresh-child', 'fresh.md', 'file')])
    throw new Error(message)
  })
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)

  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  await waitFor(() => {
    expect(listChildren).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryState(key)?.status).toBe('error')
    expect(queryClient.getQueryData(key)).toBeUndefined()
  })
  vi.useFakeTimers({ toFake: ['Date'] })

  fireEvent.click(await screen.findByRole('button', { name: 'Collapse Reports' }))
  await act(async () => {
    await refetchWatchedFolder(
      queryClient,
      { scope: 'test:user-1:team-1', generation: 7 },
      'main',
      gfsRidOfResourceId('reports')
    )
  })
  // With no observer, the watch cannot issue an active read. It still marks
  // the same exact key stale before the temporary remount.
  expect(listChildren).toHaveBeenCalledTimes(1)
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  await waitFor(() => {
    expect(listChildren).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryState(key)?.status).toBe('error')
  })
  const readsDuringCooldown = listChildren.mock.calls.length

  recoverAt = Date.now() + 8_000
  fireEvent.click(await screen.findByRole('button', { name: 'Collapse Reports' }))
  vi.setSystemTime(recoverAt)
  act(() => releaseExpiredGfsDeferredReads(queryClient))
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  expect(await screen.findByRole('button', { name: 'fresh.md' })).toBeTruthy()
  const readsAfterDeadline = listChildren.mock.calls.length

  // Keep the expected-red cooldown count until after confirming same-key
  // eligibility and visible recovery beyond Retry-After.
  expect({ readsDuringCooldown, readsAfterDeadline }).toEqual({
    readsDuringCooldown: 1,
    readsAfterDeadline: 2,
  })
})

it('T-S5-C: a cached same-key collapse/remount keeps visible children without a cooldown read', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  const listChildren = vi
    .fn()
    .mockResolvedValueOnce(listChildrenPage([childView('old-child', 'old.md', 'file')]))
    .mockRejectedValueOnce(new Error(message))
    .mockResolvedValue(listChildrenPage([childView('latest-child', 'latest.md', 'file')]))
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)

  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  expect(await screen.findByRole('button', { name: 'old.md' })).toBeTruthy()
  vi.useFakeTimers({ toFake: ['Date'] })
  await act(async () => {
    await refetchWatchedFolder(
      queryClient,
      { scope: 'test:user-1:team-1', generation: 7 },
      'main',
      gfsRidOfResourceId('reports')
    )
  })
  await waitFor(() => {
    expect(listChildren).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryState(key)?.status).toBe('error')
  })
  expect(screen.getByRole('button', { name: 'old.md' })).toBeTruthy()

  fireEvent.click(await screen.findByRole('button', { name: 'Collapse Reports' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  await waitFor(() => {
    expect(listChildren).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryState(key)?.status).toBe('error')
  })
  const readsDuringCooldown = listChildren.mock.calls.length
  const oldVisibleDuringCooldown = Boolean(screen.queryByRole('button', { name: 'old.md' }))

  // Cached-data refetchOnMount must obey the same deferred admission as the
  // no-data path; pagination data remains visible while the 429 is current.
  fireEvent.click(await screen.findByRole('button', { name: 'Collapse Reports' }))
  vi.setSystemTime(Date.now() + 8_000)
  act(() => releaseExpiredGfsDeferredReads(queryClient))
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(3))
  expect(await screen.findByRole('button', { name: 'latest.md' })).toBeTruthy()
  expect({
    readsDuringCooldown,
    oldVisibleDuringCooldown,
    readsAfterDeadline: listChildren.mock.calls.length,
  }).toEqual({
    readsDuringCooldown: 2,
    oldVisibleDuringCooldown: true,
    readsAfterDeadline: 3,
  })
})

it('T-S3: a watched-folder event does not spend a read during its recorded 429 window', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  const listChildren = vi
    .fn()
    .mockRejectedValueOnce(new Error(message))
    .mockResolvedValue(listChildrenPage([childView('fresh-child', 'fresh.md', 'file')]))
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)

  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  await waitFor(() => {
    expect(listChildren).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryState(key)?.status).toBe('error')
  })
  await act(async () => {
    await refetchWatchedFolder(
      queryClient,
      { scope: 'test:user-1:team-1', generation: 7 },
      'main',
      gfsRidOfResourceId('reports')
    )
  })

  expect(listChildren).toHaveBeenCalledTimes(1)
})

it('T-S3: a watched-folder refresh after the 429 deadline updates visible children', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  const listChildren = vi
    .fn()
    .mockRejectedValueOnce(new Error(message))
    .mockResolvedValue(listChildrenPage([childView('fresh-child', 'fresh.md', 'file')]))
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)

  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  await waitFor(() => {
    expect(listChildren).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryState(key)?.status).toBe('error')
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 8_000)
  await act(async () => {
    await refetchWatchedFolder(
      queryClient,
      { scope: 'test:user-1:team-1', generation: 7 },
      'main',
      gfsRidOfResourceId('reports')
    )
  })

  expect(listChildren).toHaveBeenCalledTimes(2)
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('success'))
  expect(screen.getByRole('button', { name: 'fresh.md' })).toBeTruthy()
})

it('T-S3: unknown Retry-After uses the bounded folder fallback before focus', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' }
  )
  const listChildren = vi.fn(async () => {
    throw new Error(message)
  })
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('error'))

  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
  expect(queryClient.getQueryState(key)?.error?.message).toContain('httpStatus=429')
  expect(listChildren).toHaveBeenCalledTimes(1)
})

it('T-S6: a newer watched-folder 429 extends the focus cooldown', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  let attempts = 0
  let successAt = Number.POSITIVE_INFINITY
  const listChildren = vi.fn(async () => {
    attempts += 1
    if (attempts === 1) return listChildrenPage([childView('old-child', 'old.md', 'file')])
    if (Date.now() >= successAt)
      return listChildrenPage([childView('fresh-child', 'fresh.md', 'file')])
    throw new Error(message)
  })
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  expect(await screen.findByRole('button', { name: 'old.md' })).toBeTruthy()
  vi.useFakeTimers({ toFake: ['Date'] })
  await act(async () => {
    await refetchWatchedFolder(
      queryClient,
      { scope: 'test:user-1:team-1', generation: 7 },
      'main',
      gfsRidOfResourceId('reports')
    )
  })
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('error'))

  const firstLimitAt = Date.now()
  successAt = firstLimitAt + 16_000
  vi.setSystemTime(firstLimitAt + 8_000)
  act(() => releaseExpiredGfsDeferredReads(queryClient))
  await act(async () => {
    await refetchWatchedFolder(
      queryClient,
      { scope: 'test:user-1:team-1', generation: 7 },
      'main',
      gfsRidOfResourceId('reports')
    )
  })
  const readsAfterRenewal = attempts
  vi.setSystemTime(firstLimitAt + 10_000)
  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })

  // The second 429 arrived after the original 7s pause expired. At t=10s the
  // renewed exact-key deadline is active, so focus cannot spend another read.
  expect(queryClient.getQueryState(key)?.error?.message).toContain('retryAfterSeconds=7')
  const readsBeforeRenewedDeadline = attempts

  // The active deferred observer owns the one eligible due read. A second
  // synthetic focus after that read would be a separate valid event.
  successAt = Date.now()
  vi.setSystemTime(firstLimitAt + 16_000)
  act(() => releaseExpiredGfsDeferredReads(queryClient))
  await waitFor(() => expect(screen.getByRole('button', { name: 'fresh.md' })).toBeTruthy())
  expect(await screen.findByRole('button', { name: 'fresh.md' })).toBeTruthy()
  const readsAfterDeadline = attempts
  expect({
    readsAfterRenewal,
    readsBeforeRenewedDeadline,
    readsAfterDeadline,
  }).toEqual({
    readsAfterRenewal: 3,
    readsBeforeRenewedDeadline: 3,
    readsAfterDeadline: 4,
  })
})

it('T-S6: focus respects the newer folder 429 deadline', async () => {
  const message = await gfsRouteFailureMessage(
    producer =>
      producer.listChildren('reports', 'fixture-session-token', {
        drive: 'main',
      }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  let attempts = 0
  const listChildren = vi.fn(async () => {
    attempts += 1
    if (attempts === 1) return listChildrenPage([childView('old-child', 'old.md', 'file')])
    if (attempts === 4) return listChildrenPage([childView('fresh-child', 'fresh.md', 'file')])
    throw new Error(message)
  })
  installClerum({
    listAccessible: vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    ),
    listChildren,
  })
  const { queryClient } = renderTree()
  const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', 'reports', 'main', 7)
  fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
  expect(await screen.findByRole('button', { name: 'old.md' })).toBeTruthy()

  await act(async () => {
    await queryClient.refetchQueries({ queryKey: key, exact: true })
  })
  await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(2))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 6_000)
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: key, exact: true })
  })
  await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(3))
  expect(queryClient.getQueryState(key)?.error?.message).toContain('retryAfterSeconds=7')

  vi.setSystemTime(Date.now() + 2_000)
  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
  expect(listChildren).toHaveBeenCalledTimes(3)
  expect(queryClient.getQueryState(key)?.error?.message).toContain('retryAfterSeconds=7')
})
