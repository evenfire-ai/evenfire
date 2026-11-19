// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  focusManager,
} from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fc, { type Scheduler } from 'fast-check'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useWindowFocusBridge } from '@hooks/useWindowFocusBridge'
import {
  childView,
  gfsRouteFailureMessage,
  listChildrenPage,
  resolveDeniedMessage,
  resolveResource,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../../pages/FilePreviewPage'
import { isGfsReadDeferred, releaseExpiredGfsDeferredReads } from '../gfsDeferredReadGate'
import { gfsRidOfResourceId } from '../gfsWatchKeys'
import { type GfsWatchAuthority, refetchGfsAccess, refetchWatchedFolder } from '../gfsWatchReaction'
import { desktopQueryDefaults } from '../queryClient'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const AUTHORITY: GfsWatchAuthority = {
  scope: 'env:a6-fixture:team-1',
  generation: 3,
}
const RESOURCE_IDS = ['row-a', 'row-b', 'row-c']
const DISPOSE: Array<() => void> = []
const CLIENTS: QueryClient[] = []

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
  vi.restoreAllMocks()
  for (const dispose of DISPOSE.splice(0)) dispose()
  for (const client of CLIENTS.splice(0)) client.clear()
})

type Gate<T = void> = { promise: Promise<T>; resolve: (value: T) => void }

function gate<T = void>(): Gate<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function makeClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  CLIENTS.push(client)
  return client
}

function scheduled<T>(scheduler: Scheduler, task: Promise<T>, label: string) {
  const result = task.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error })
  )
  return scheduler.schedule(result, label).then(outcome => {
    if (!outcome.ok) throw outcome.error
    return outcome.value
  })
}

async function settle(scheduler: Scheduler, work: Promise<unknown>) {
  await scheduler.waitIdle()
  await work
  await scheduler.waitIdle()
}

function rowKey(resourceId: string) {
  return desktopQueryKeys.gfsAffordances(
    resourceId.startsWith('row-') ? AUTHORITY.scope! : 'other',
    resourceId,
    'main',
    AUTHORITY.generation
  )
}

const PREVIEW_RESOURCE = '0123456789abcdef0123456789abcdef'
const PREVIEW_URI = `gfs://main/${PREVIEW_RESOURCE}`

function previewResult() {
  return resolveResource({
    resourceId: PREVIEW_RESOURCE,
    rid: PREVIEW_RESOURCE,
    gfsUri: PREVIEW_URI,
    drive: 'main',
    parentResourceId: 'source-parent',
    name: 'diagram.png',
    kind: 'file',
    version: 7,
    bytes: 1,
  })
}

function installPreviewBoundary(resolve: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolve,
        affordances: vi.fn(async () =>
          delegationAffordances(new Set(['read', 'write', 'delete']), false)
        ),
        downloadPreview: vi.fn(async () => ({
          bytes: new Uint8Array([1]).buffer,
        })),
      },
    },
  })
}

function previewHarness(includeWindowFocusBridge = true) {
  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope: 'preview-focus-user:main',
    sessionGeneration: 1,
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  })
  function PreviewContent() {
    return (
      <FilePreviewPage
        gfsUri={PREVIEW_URI}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
      />
    )
  }
  function FocusAwarePreview() {
    useWindowFocusBridge()
    return <PreviewContent />
  }
  function NativeOnlyPreview() {
    return <PreviewContent />
  }
  return includeWindowFocusBridge ? FocusAwarePreview : NativeOnlyPreview
}

interface IndependentKeyModel {
  readonly scope: string
  readonly generation: number
  readonly queryKey: readonly unknown[]
  readonly active: boolean
  readonly identityRetired: boolean
  readonly sameKeyReturnPossible: boolean
  readonly inFlight: boolean
  readonly errorKind: 'none' | 'rate-limited' | 'unauthorized' | 'forbidden'
  readonly blockedUntil: number
  readonly pendingRelevantWatch: boolean
  readonly pendingDue: boolean
  readonly cacheInvalidated: boolean
  readonly controllerEffectApplied: boolean
  readonly visibleAuthority: 'current' | 'denied' | 'unknown'
  readonly requestedPages: readonly (string | undefined)[]
  readonly lastAcceptedVersion: number | null
  readonly backendReadCount: number
}

interface IndependentPreviewModel {
  readonly uri: string
  readonly scope: string
  readonly latestVerdict: 'allowed' | 'denied' | 'unknown'
  readonly bodyVisible: boolean
  readonly copyEnabled: boolean
  readonly resolveFlight: boolean
}

interface IndependentRowModel {
  readonly keys: ReadonlyMap<string, IndependentKeyModel>
  readonly preview: IndependentPreviewModel
  readonly eventQueue: readonly ('watch' | 'focus' | 'timer' | 'identity-change')[]
}

interface RealRows {
  readonly client: QueryClient
  readonly scheduler: Scheduler
  readonly reads: Map<string, number>
}

class AccessChangedDuringCooldown implements fc.AsyncCommand<IndependentRowModel, RealRows> {
  check(model: IndependentRowModel): boolean {
    return Array.from(model.keys.values()).some(
      key => key.pendingRelevantWatch && key.blockedUntil > Date.now()
    )
  }

  async run(model: IndependentRowModel, real: RealRows): Promise<void> {
    const work = refetchGfsAccess(real.client, AUTHORITY)
    await settle(real.scheduler, work)
    // A4 cost/liveness oracle: while the exact per-row 429 remains live, the
    // independent model retains one obligation and admits no actual new read.
    expect(Object.fromEntries(real.reads)).toEqual(
      Object.fromEntries(
        Array.from(model.keys, ([resourceId, key]) => [resourceId, key.backendReadCount])
      )
    )
  }

  toString(): string {
    return 'accessChanged while each active affordance key has a live 429'
  }
}

async function createThreeRowHarness(
  scheduler: Scheduler,
  scheduleResults = true,
  denialStatus: 429 | 401 | 403 = 429
) {
  const client = makeClient()
  const reads = new Map(RESOURCE_IDS.map(id => [id, 0]))
  const waits = new Map<string, Gate>()
  const denied = new Set<string>()
  const denial = await affordancesApiError(denialStatus, {
    code:
      denialStatus === 429 ? 'rate_limited' : denialStatus === 401 ? 'unauthorized' : 'forbidden',
    message:
      denialStatus === 429
        ? 'Too Many Requests'
        : denialStatus === 401
          ? 'Session expired'
          : 'Resource denied',
  })
  const producer = appServiceAffordanceProducer(async resourceId => {
    reads.set(resourceId, (reads.get(resourceId) ?? 0) + 1)
    const wait = waits.get(resourceId)
    if (wait) {
      waits.delete(resourceId)
      await wait.promise
    }
    if (denied.has(resourceId)) throw denial
    return heldPermissionResponse(['read', 'write', 'delete'])
  })
  const observers = RESOURCE_IDS.map(resourceId => {
    const observer = new QueryObserver(client, {
      queryKey: desktopQueryKeys.gfsAffordances(
        AUTHORITY.scope!,
        resourceId,
        'main',
        AUTHORITY.generation
      ),
      queryFn: () => {
        const result = producer(resourceId)
        return scheduleResults
          ? scheduled(scheduler, result, `IPC affordances ${resourceId}`)
          : result
      },
      ...desktopQueryDefaults.queries,
    })
    const stop = observer.subscribe(() => undefined)
    DISPOSE.push(stop)
    return observer
  })
  await expect.poll(() => Array.from(reads.values()).reduce((sum, value) => sum + value, 0)).toBe(3)
  expect(Object.fromEntries(reads)).toEqual({
    'row-a': 1,
    'row-b': 1,
    'row-c': 1,
  })
  return {
    client,
    scheduler,
    reads,
    waits,
    denied,
    observers,
    dispose() {
      for (const observer of observers) observer.destroy()
      client.clear()
    },
  }
}

it('T-R1/T-R6: generated accessChanged sequences match the independent quiescent read model', async () => {
  const commands = fc.commands([fc.constant(new AccessChangedDuringCooldown())], {
    maxCommands: 3,
    size: 'max',
  })
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), commands, async (scheduler, generated) => {
      const real = await createThreeRowHarness(scheduler)
      try {
        for (const resourceId of RESOURCE_IDS) real.denied.add(resourceId)

        // The first real accessChanged request batch obtains three
        // producer-backed HTTP 429s. It is the first deferred event that is due.
        await settle(real.scheduler, refetchGfsAccess(real.client, AUTHORITY))
        expect(Object.fromEntries(real.reads)).toEqual({
          'row-a': 2,
          'row-b': 2,
          'row-c': 2,
        })
        const eventAt = Date.now()
        const blockedUntil = eventAt + 7_000
        const model: IndependentRowModel = {
          keys: new Map(
            RESOURCE_IDS.map(resourceId => [
              resourceId,
              {
                scope: AUTHORITY.scope!,
                generation: AUTHORITY.generation!,
                queryKey: rowKey(resourceId),
                active: true,
                identityRetired: false,
                sameKeyReturnPossible: true,
                inFlight: false,
                errorKind: 'rate-limited' as const,
                blockedUntil,
                pendingRelevantWatch: true,
                pendingDue: true,
                cacheInvalidated: false,
                controllerEffectApplied: false,
                visibleAuthority: 'unknown' as const,
                requestedPages: [],
                lastAcceptedVersion: null,
                // The independent history is one ordinary initial check and
                // one explicit access-change attempt per active exact key.
                backendReadCount: 2,
              },
            ])
          ),
          preview: {
            uri: PREVIEW_URI,
            scope: 'preview-focus-user:main',
            latestVerdict: 'unknown',
            bodyVisible: false,
            copyEnabled: false,
            resolveFlight: false,
          },
          eventQueue: ['watch'],
        }
        const sequence = Array.from(generated)
        // Keep at least one generated A2 event so the property always checks
        // the violated A4 predicate; fast-check still shrinks the schedule.
        if (sequence.length === 0) sequence.push(new AccessChangedDuringCooldown())
        await fc.asyncModelRun(() => ({ model, real }), sequence)
      } finally {
        real.dispose()
      }
    }),
    { seed: 1241503, numRuns: 20, verbose: 2 }
  )
})

it('T-R2: a joined affordance 429 blocks the watch helper trailing pass', async () => {
  const real = await createThreeRowHarness(fc.schedulerFor([]), false)
  try {
    for (const resourceId of RESOURCE_IDS) real.denied.add(resourceId)
    for (const resourceId of RESOURCE_IDS) real.waits.set(resourceId, gate())
    const joinedGates = Array.from(real.waits.values())

    const joinedReads = real.observers.map(observer => observer.refetch())
    await expect.poll(() => real.client.isFetching()).toBe(3)
    const expectedAtQuiescence = { 'row-a': 2, 'row-b': 2, 'row-c': 2 }
    const watch = refetchGfsAccess(real.client, AUTHORITY)
    for (const wait of joinedGates) wait.resolve()
    await Promise.all(joinedReads)
    await watch

    // The actual first query is the joined request and returns 429. A4 allows
    // no new same-key read before its deadline; the baseline trailing pass does.
    expect(Object.fromEntries(real.reads)).toEqual(expectedAtQuiescence)
  } finally {
    real.dispose()
  }
})

it('T-R2/T-R4: a joined row 429 gates a no-data remount before the watch continuation', async () => {
  const rateLimit = await affordancesApiError(429, {
    code: 'rate_limited',
    message: 'Too many requests',
  })
  const client = makeClient()
  const key = rowKey('row-a')
  const initialRead = gate()
  let reads = 0
  const producer = appServiceAffordanceProducer(async () => {
    if (reads === 1) throw rateLimit
    return heldPermissionResponse(['read', 'write'])
  })
  const queryFn = async () => {
    reads += 1
    if (reads === 1) await initialRead.promise
    return producer('row-a')
  }
  const originalObserver = new QueryObserver(client, {
    queryKey: key,
    queryFn,
    meta: { gfsDeferredReadEligible: true },
    ...desktopQueryDefaults.queries,
  })
  const originalUnsubscribe = originalObserver.subscribe(() => undefined)
  DISPOSE.push(originalUnsubscribe)
  expect(isGfsReadDeferred(client, key)).toBe(false)
  let remountedObserver: QueryObserver<unknown, Error, unknown, typeof key> | undefined
  let remountedUnsubscribe: (() => void) | undefined
  let remountEnabledAt429: boolean | undefined
  const stopCacheListener = client.getQueryCache().subscribe(event => {
    if (
      event.type !== 'updated' ||
      event.action.type !== 'error' ||
      event.query.queryHash !==
        client.getQueryCache().find({ queryKey: key, exact: true })?.queryHash ||
      remountedObserver
    )
      return
    remountEnabledAt429 = !isGfsReadDeferred(client, key)
    remountedObserver = new QueryObserver(client, {
      queryKey: key,
      queryFn,
      enabled: remountEnabledAt429,
      meta: { gfsDeferredReadEligible: true },
      ...desktopQueryDefaults.queries,
    })
    remountedUnsubscribe = remountedObserver.subscribe(() => undefined)
  })
  try {
    await expect.poll(() => reads).toBe(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    const watch = refetchGfsAccess(client, AUTHORITY)
    initialRead.resolve()
    await watch
    await expect.poll(() => client.isFetching()).toBe(0)

    expect(reads).toBe(1)
    expect(remountEnabledAt429).toBe(false)
    expect(client.getQueryState(key)?.status).toBe('error')

    const deniedAt = client.getQueryState(key)?.errorUpdatedAt ?? Date.now()
    vi.setSystemTime(deniedAt + 8_000)
    act(() => releaseExpiredGfsDeferredReads(client))
    await expect.poll(() => reads).toBe(2)
    await waitFor(() => expect(client.getQueryState(key)?.status).toBe('success'))
    expect(client.getQueryData(key)).toMatchObject({ held: ['read', 'write'] })
    expect(reads).toBe(2)
  } finally {
    stopCacheListener()
    remountedUnsubscribe?.()
    remountedObserver?.destroy()
    vi.useRealTimers()
    originalObserver.destroy()
    client.clear()
  }
})

it('T-R3: one due row refresh extends a newer 429 deadline and settles on one success', async () => {
  const firstLimit = await affordancesApiError(429, {
    code: 'rate_limited',
    message: 'Too many requests',
  })
  const renewedLimit = await affordancesApiError(429, {
    code: 'rate_limited',
    message: 'Too many requests',
  })
  const client = makeClient()
  const key = rowKey('row-a')
  let reads = 0
  const producer = appServiceAffordanceProducer(async () => {
    reads += 1
    if (reads === 2) throw firstLimit
    if (reads === 3) throw renewedLimit
    return heldPermissionResponse(['read', 'write'])
  })
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => producer('row-a'),
    meta: { gfsDeferredReadEligible: true },
    ...desktopQueryDefaults.queries,
  })
  const unsubscribe = observer.subscribe(() => undefined)
  DISPOSE.push(unsubscribe)
  try {
    await expect.poll(() => reads).toBe(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    await refetchGfsAccess(client, AUTHORITY)
    expect(reads).toBe(2)

    const firstErrorAt = client.getQueryState(key)?.errorUpdatedAt ?? Date.now()
    vi.setSystemTime(firstErrorAt + 8_000)
    act(() => releaseExpiredGfsDeferredReads(client))
    await expect.poll(() => reads).toBe(3)
    expect(client.getQueryState(key)?.status).toBe('error')

    const renewedErrorAt = client.getQueryState(key)?.errorUpdatedAt ?? Date.now()
    vi.setSystemTime(renewedErrorAt + 3_000)
    await refetchGfsAccess(client, AUTHORITY)
    expect(reads).toBe(3)

    vi.setSystemTime(renewedErrorAt + 8_000)
    act(() => releaseExpiredGfsDeferredReads(client))
    await expect.poll(() => reads).toBe(4)
    await waitFor(() => expect(client.getQueryState(key)?.status).toBe('success'))
    expect(client.getQueryData(key)).toMatchObject({ held: ['read', 'write'] })
    expect(reads).toBe(4)
  } finally {
    vi.useRealTimers()
    observer.destroy()
    client.clear()
  }
})

it('T-R2 200 control: a joined affordance success keeps its bounded trailing refresh', async () => {
  const real = await createThreeRowHarness(fc.schedulerFor([]), false)
  try {
    for (const resourceId of RESOURCE_IDS) real.waits.set(resourceId, gate())
    const inFlightGates = Array.from(real.waits.values())
    const joinedReads = real.observers.map(observer => observer.refetch())
    await expect.poll(() => real.client.isFetching()).toBe(3)
    const watch = refetchGfsAccess(real.client, AUTHORITY)
    for (const wait of inFlightGates) wait.resolve()
    await Promise.all(joinedReads)
    await watch

    // One initial check, the joined successful check, and exactly one valid
    // catch-up pass for each row that was already in flight at event admission.
    expect(Object.fromEntries(real.reads)).toEqual({
      'row-a': 3,
      'row-b': 3,
      'row-c': 3,
    })
  } finally {
    real.dispose()
  }
})

it.each([401, 403] as const)(
  'T-R2 security control: a joined affordance %i preserves its denial without a trailing batch',
  async status => {
    const real = await createThreeRowHarness(fc.schedulerFor([]), false, status)
    try {
      for (const resourceId of RESOURCE_IDS) {
        real.denied.add(resourceId)
        real.waits.set(resourceId, gate())
      }
      const joinedGates = Array.from(real.waits.values())
      const joinedReads = real.observers.map(observer => observer.refetch())
      await expect.poll(() => real.client.isFetching()).toBe(3)
      const watch = refetchGfsAccess(real.client, AUTHORITY)
      for (const wait of joinedGates) wait.resolve()
      await Promise.all(joinedReads)
      await watch

      expect(Object.fromEntries(real.reads)).toEqual({
        'row-a': 2,
        'row-b': 2,
        'row-c': 2,
      })
      for (const observer of real.observers) {
        expect(observer.getCurrentResult().error).toBeTruthy()
      }
    } finally {
      real.dispose()
    }
  }
)

it.each(['query-first', 'native-first'] as const)(
  'T-P1: one Preview focus is single-read when %s arrives first',
  async order => {
    const pendingResolvers: Array<(value: Awaited<ReturnType<typeof previewResult>>) => void> = []
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(previewResult())
      .mockImplementation(
        () =>
          new Promise<Awaited<ReturnType<typeof previewResult>>>(done => {
            pendingResolvers.push(done)
          })
      )
    installPreviewBoundary(resolve)
    const client = makeClient()
    const Preview = previewHarness(order === 'query-first')
    const model = {
      uri: PREVIEW_URI,
      scope: 'preview-focus-user:main',
      latestVerdict: 'allowed' as 'allowed' | 'denied' | 'unknown',
      bodyVisible: true,
      copyEnabled: true,
      resolveFlight: false,
      eventQueue: ['mount resolved 200'],
    }
    render(<Preview />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Options for diagram.png' }))
    expect(
      (
        screen.getByRole('menuitem', {
          name: 'Copy content',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)

    if (order === 'query-first') {
      await act(async () => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      await act(async () => window.dispatchEvent(new Event('focus')))
    } else {
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
    }
    model.eventQueue.push(`E1 ${order} first focus notification`)
    model.resolveFlight = true
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))

    if (order === 'query-first') {
      await act(async () => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
        window.dispatchEvent(new Event('focus'))
      })
    } else {
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
    }
    model.eventQueue.push(`E1 ${order} second focus notification while resolver pending`)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () =>
      Promise.all(pendingResolvers.map(async done => done(await previewResult())))
    )
    const key = [
      ...desktopQueryKeys.gfsRoot,
      'preview-focus-user:main',
      'preview-resource',
      PREVIEW_URI,
      { sessionGeneration: 1 },
    ] as const
    await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))
    model.resolveFlight = false
    model.latestVerdict = 'allowed'
    model.bodyVisible = true
    model.copyEnabled = true

    // One E1 owns exactly one focus resolver IPC regardless of which observer
    // event is delivered first while the physical resolver remains pending.
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(model.uri).toBe(PREVIEW_URI)
    expect(model.scope).toBe('preview-focus-user:main')
    expect(model.latestVerdict).toBe('allowed')
    expect(model.bodyVisible && model.copyEnabled && !model.resolveFlight).toBe(true)
    expect(screen.getByAltText('Preview of diagram.png')).toBeTruthy()
  }
)

it('T-S4 200 control: a joined page lands before one trailing watched-folder pass', async () => {
  const client = makeClient()
  const folder = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d'
  const folderRid = gfsRidOfResourceId(folder)
  const joined = gate<void>()
  const reads: Array<string | undefined> = []
  type Page = Awaited<ReturnType<typeof listChildrenPage>>
  let firstPageReads = 0
  const observer = new InfiniteQueryObserver(client, {
    queryKey: desktopQueryKeys.gfsChildren(AUTHORITY.scope!, folder, 'main', AUTHORITY.generation),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<Page> => {
      reads.push(pageParam)
      if (pageParam === 'page-2' && reads.length === 2) {
        await joined.promise
        return listChildrenPage([childView('second-old', 'second-old.md', 'file')])
      }
      if (pageParam === undefined) {
        firstPageReads += 1
        return firstPageReads === 1
          ? listChildrenPage([childView('first-old', 'first-old.md', 'file')], 'page-2')
          : listChildrenPage([childView('first-new', 'first-new.md', 'file')], 'page-2')
      }
      return listChildrenPage([childView('second-new', 'second-new.md', 'file')])
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
    ...desktopQueryDefaults.queries,
  })
  const stop = observer.subscribe(() => undefined)
  DISPOSE.push(stop)
  await waitFor(() => expect(reads).toHaveLength(1))
  const nextPage = observer.fetchNextPage()
  await waitFor(() => expect(client.isFetching()).toBe(1))
  const watch = refetchWatchedFolder(client, AUTHORITY, 'main', folderRid)
  joined.resolve()
  await nextPage
  await waitFor(() => expect(reads).toHaveLength(4))
  await watch

  expect(reads).toEqual([undefined, 'page-2', undefined, 'page-2'])
  expect(observer.getCurrentResult().data?.pages.map(page => page.items[0]?.name)).toEqual([
    'first-new.md',
    'second-new.md',
  ])
  expect(observer.getCurrentResult().isFetchNextPageError).toBe(false)
})

it('T-S4: a joined listChildren 429 blocks the watched-folder trailing page pass', async () => {
  const client = makeClient()
  const folder = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d'
  const folderRid = gfsRidOfResourceId(folder)
  const limitMessage = await gfsRouteFailureMessage(
    producer => producer.listChildren(folder, 'fixture-session-token', { drive: 'main' }),
    429,
    { code: 'rate_limited', message: 'too many requests' },
    { 'retry-after': '7' }
  )
  const joined = gate<void>()
  const reads: Array<string | undefined> = []
  type Page = Awaited<ReturnType<typeof listChildrenPage>>
  let recovery = false
  const observer = new InfiniteQueryObserver(client, {
    queryKey: desktopQueryKeys.gfsChildren(AUTHORITY.scope!, folder, 'main', AUTHORITY.generation),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<Page> => {
      reads.push(pageParam)
      if (recovery) {
        return pageParam === undefined
          ? listChildrenPage([childView('recovered-first-page', 'recovered.md', 'file')], 'page-2')
          : listChildrenPage([childView('recovered-second-page', 'recovered-part-2.md', 'file')])
      }
      if (pageParam === 'page-2') {
        await joined.promise
        throw new Error(limitMessage)
      }
      return pageParam === undefined
        ? listChildrenPage([childView('first-page', 'first.md', 'file')], 'page-2')
        : listChildrenPage([childView('latest-first-page', 'latest.md', 'file')], 'page-2')
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
    ...desktopQueryDefaults.queries,
  })
  const stop = observer.subscribe(() => undefined)
  DISPOSE.push(stop)
  await waitFor(() => expect(reads).toHaveLength(1))
  const nextPage = observer.fetchNextPage()
  await waitFor(() => expect(client.isFetching()).toBe(1))
  const watch = refetchWatchedFolder(client, AUTHORITY, 'main', folderRid)
  joined.resolve()
  await nextPage
  await watch

  const readsDuringCooldown = reads.length
  expect(observer.getCurrentResult().data?.pages).toHaveLength(1)

  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 8_000)
  recovery = true
  const recoveredWatch = refetchWatchedFolder(client, AUTHORITY, 'main', folderRid)
  await recoveredWatch

  expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.name).toBe('recovered.md')
  expect({ readsDuringCooldown, totalReads: reads.length }).toEqual({
    readsDuringCooldown: 2,
    totalReads: 3,
  })
})

it.each([401, 403] as const)(
  'T-S4 security control: a joined listChildren %i retains its denial without a trailing read',
  async status => {
    const client = makeClient()
    const folder = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d'
    const folderRid = gfsRidOfResourceId(folder)
    const denialMessage = await gfsRouteFailureMessage(
      producer =>
        producer.listChildren(folder, 'fixture-session-token', {
          drive: 'main',
        }),
      status,
      {
        code: status === 401 ? 'unauthorized' : 'forbidden',
        message: status === 401 ? 'session rejected' : 'resource denied',
      }
    )
    const joined = gate<void>()
    const reads: Array<string | undefined> = []
    type Page = Awaited<ReturnType<typeof listChildrenPage>>
    const observer = new InfiniteQueryObserver(client, {
      queryKey: desktopQueryKeys.gfsChildren(
        AUTHORITY.scope!,
        folder,
        'main',
        AUTHORITY.generation
      ),
      queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<Page> => {
        reads.push(pageParam)
        if (pageParam === 'page-2') {
          await joined.promise
          throw new Error(denialMessage)
        }
        if (reads.length === 1) {
          return listChildrenPage([childView('first-page', 'first.md', 'file')], 'page-2')
        }
        return listChildrenPage([childView('unexpected', 'unexpected.md', 'file')], 'page-2')
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
      ...desktopQueryDefaults.queries,
    })
    const stop = observer.subscribe(() => undefined)
    DISPOSE.push(stop)
    await waitFor(() => expect(reads).toHaveLength(1))
    const nextPage = observer.fetchNextPage()
    await waitFor(() => expect(client.isFetching()).toBe(1))
    const watch = refetchWatchedFolder(client, AUTHORITY, 'main', folderRid)
    joined.resolve()
    await nextPage
    await watch

    expect(reads).toEqual([undefined, 'page-2'])
    expect(observer.getCurrentResult().isFetchNextPageError).toBe(true)
    expect(observer.getCurrentResult().data?.pages[0]?.items[0]?.name).toBe('first.md')
  }
)

it('T-P1-D/T-P2: delayed Query focus after native resolver settlement does not issue a second IPC', async () => {
  let resolveNative!: (value: Awaited<ReturnType<typeof previewResult>>) => void
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(previewResult())
    .mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof previewResult>>>(done => {
          resolveNative = done
        })
    )
    .mockResolvedValue(previewResult())
  installPreviewBoundary(resolve)

  const client = makeClient()
  const pausedMutations = gate<void>()
  vi.spyOn(client, 'resumePausedMutations').mockReturnValue(pausedMutations.promise)
  const FocusAwarePreview = previewHarness()
  render(<FocusAwarePreview />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))

  await act(async () => {
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
  })
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))

  // QueryClient's automatic focus delivery remains held while the native
  // focus-owned request settles, exposing the serial-not-overlap ordering.
  await act(async () => resolveNative(await previewResult()))
  const key = [
    ...desktopQueryKeys.gfsRoot,
    'preview-focus-user:main',
    'preview-resource',
    PREVIEW_URI,
    { sessionGeneration: 1 },
  ] as const
  await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))
  await act(async () => pausedMutations.resolve())
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))

  // One OS focus maps to one native IPC even after delayed Query focus settles.
  expect(resolve).toHaveBeenCalledTimes(2)
})

it('T-P2: repeated native focus joins a held non-abortable resolver IPC', async () => {
  const pendingResolvers: Array<(value: Awaited<ReturnType<typeof previewResult>>) => void> = []
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(previewResult())
    .mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof previewResult>>>(done => {
          pendingResolvers.push(done)
        })
    )
  installPreviewBoundary(resolve)
  const client = makeClient()
  const pausedMutations = gate<void>()
  vi.spyOn(client, 'resumePausedMutations').mockReturnValue(pausedMutations.promise)
  const FocusAwarePreview = previewHarness()
  render(<FocusAwarePreview />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))

  await act(async () => {
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
  })
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  await act(async () => {
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
  })
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  expect(pendingResolvers).toHaveLength(1)

  // The native focus owner keeps the one non-abortable preload invocation alive.
  await act(async () =>
    Promise.all(pendingResolvers.map(async done => done(await previewResult())))
  )
  const key = [
    ...desktopQueryKeys.gfsRoot,
    'preview-focus-user:main',
    'preview-resource',
    PREVIEW_URI,
    { sessionGeneration: 1 },
  ] as const
  await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))
  expect(resolve).toHaveBeenCalledTimes(2)
})

it.each([401, 403] as const)(
  'T-P3: joined resolver focus %i reaches its authority boundary without stale bytes',
  async status => {
    const denialMessage = await resolveDeniedMessage(
      PREVIEW_URI,
      {
        code: status === 401 ? 'unauthorized' : 'forbidden',
        message: status === 401 ? 'Session expired' : 'Resource access revoked',
      },
      status
    )
    const denial = new Error(denialMessage)
    const pendingDenials: Array<(error: Error) => void> = []
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(previewResult())
      .mockImplementation(
        () =>
          new Promise<Awaited<ReturnType<typeof previewResult>>>((_finish, reject) =>
            pendingDenials.push(reject)
          )
      )
    installPreviewBoundary(resolve)

    let accessState: 'active' | 'revoked' = 'active'
    const handleAuthorityFailure = vi.fn(() => {
      if (status === 401) {
        accessState = 'revoked'
        return true
      }
      return false
    })
    hookMock.useGfsBrowserController.mockImplementation(() => ({
      accessState,
      sessionScope: 'preview-focus-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure,
    }))
    function FocusAwarePreview() {
      useWindowFocusBridge()
      return (
        <FilePreviewPage
          gfsUri={PREVIEW_URI}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
      )
    }

    const client = makeClient()
    const view = render(<FocusAwarePreview />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(resolve.mock.calls.length).toBeGreaterThan(1))
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(pendingDenials.length).toBeGreaterThan(0)
    await act(async () => pendingDenials.forEach(reject => reject(denial)))

    if (status === 401) {
      await waitFor(() => expect(handleAuthorityFailure).toHaveBeenCalled())
      view.rerender(<FocusAwarePreview />)
    }
    await waitFor(() => expect(screen.queryByAltText('Preview of diagram.png')).toBeNull())
    expect(screen.getByText('File unavailable')).toBeTruthy()
    await waitFor(() => expect(client.isFetching()).toBe(0))

    // One physical focus-owned resolve is expected across both native focus
    // notifications; the current auto-focus observer creates extra IPCs.
    expect(resolve).toHaveBeenCalledTimes(2)
    if (status === 401) expect(handleAuthorityFailure).toHaveBeenCalled()
    else expect(handleAuthorityFailure).toHaveReturnedWith(false)
    client.clear()
  }
)

it('T-P4: producer-backed Preview resolver 429 prevents another native focus IPC', async () => {
  const producerRateLimit = await affordancesApiError(429, {
    code: 'rate_limited',
    message: 'Too many requests',
  })
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(previewResult())
    // `resolve` is the sole mocked IPC boundary; the ApiError came through
    // the real HTTP client from a 429 + Retry-After response.
    .mockRejectedValueOnce(producerRateLimit)
    .mockResolvedValue(previewResult())
  installPreviewBoundary(resolve)

  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope: 'preview-focus-user:main',
    sessionGeneration: 1,
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  })
  function NativeOnlyPreview() {
    return (
      <FilePreviewPage
        gfsUri={PREVIEW_URI}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
      />
    )
  }
  const client = makeClient()
  render(<NativeOnlyPreview />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))

  await act(async () => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  const key = [
    ...desktopQueryKeys.gfsRoot,
    'preview-focus-user:main',
    'preview-resource',
    PREVIEW_URI,
    { sessionGeneration: 1 },
  ] as const
  expect(client.getQueryState(key)?.status).toBe('error')

  await act(async () => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  expect(resolve).toHaveBeenCalledTimes(2)
})

it('T-P4: an eligible native Preview focus revalidates after the resolver 429 deadline', async () => {
  const producerRateLimit = await affordancesApiError(429, {
    code: 'rate_limited',
    message: 'Too many requests',
  })
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(previewResult())
    .mockRejectedValueOnce(producerRateLimit)
    .mockResolvedValue(previewResult())
  installPreviewBoundary(resolve)

  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope: 'preview-focus-user:main',
    sessionGeneration: 1,
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  })
  function NativeOnlyPreview() {
    return (
      <FilePreviewPage
        gfsUri={PREVIEW_URI}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
      />
    )
  }
  const client = makeClient()
  render(<NativeOnlyPreview />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))

  await act(async () => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  const key = [
    ...desktopQueryKeys.gfsRoot,
    'preview-focus-user:main',
    'preview-resource',
    PREVIEW_URI,
    { sessionGeneration: 1 },
  ] as const
  expect(client.getQueryState(key)?.status).toBe('error')

  vi.useFakeTimers({ toFake: ['Date'] })
  const failedAt = Date.now()
  vi.setSystemTime(failedAt + 61_000)
  await act(async () => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(3))
  expect(client.getQueryState(key)?.status).toBe('success')
  expect(screen.getByAltText('Preview of diagram.png')).toBeTruthy()
})

it.each([200, 401] as const)(
  'T-P5: an old Preview %i completion cannot replace or revoke a new URI and session',
  async completionStatus => {
    const oldUri = PREVIEW_URI
    const newUri = 'gfs://main/abcdef0123456789abcdef0123456789'
    const resource = (uri: string, resourceId: string, name: string) =>
      resolveResource({
        resourceId,
        rid: resourceId,
        gfsUri: uri,
        drive: 'main',
        parentResourceId: 'source-parent',
        name,
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    let finishOldFocus!: (result: Awaited<ReturnType<typeof previewResult>>) => void
    let rejectOldFocus!: (error: Error) => void
    const oldFocus = new Promise<Awaited<ReturnType<typeof previewResult>>>((resolve, reject) => {
      finishOldFocus = resolve
      rejectOldFocus = reject
    })
    const oldSessionExpired = new Error(
      await resolveDeniedMessage(oldUri, { code: 'unauthorized', message: 'session expired' }, 401)
    )
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(resource(oldUri, PREVIEW_RESOURCE, 'old.png'))
      .mockImplementationOnce(() => oldFocus)
      .mockResolvedValue(resource(newUri, 'abcdef0123456789abcdef0123456789', 'new.png'))
    installPreviewBoundary(resolve)

    const handleAuthorityFailure = vi.fn(() => true)
    let authority = {
      accessState: 'active',
      sessionScope: 'preview-old-session:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure,
    }
    hookMock.useGfsBrowserController.mockImplementation(() => authority)
    function ChangingPreview({ uri, name }: { uri: string; name: string }) {
      useWindowFocusBridge()
      return (
        <FilePreviewPage
          gfsUri={uri}
          fileName={name}
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
      )
    }

    const client = makeClient()
    const view = render(<ChangingPreview uri={oldUri} name="old.png" />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    expect(await screen.findByAltText('Preview of old.png')).toBeTruthy()
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    await act(async () => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))

    authority = {
      ...authority,
      sessionScope: 'preview-new-session:main',
      sessionGeneration: 2,
    }
    view.rerender(<ChangingPreview uri={newUri} name="new.png" />)
    expect(await screen.findByAltText('Preview of new.png')).toBeTruthy()
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(3))

    await act(async () => {
      if (completionStatus === 401) {
        rejectOldFocus(oldSessionExpired)
      } else {
        finishOldFocus(await resource(oldUri, PREVIEW_RESOURCE, 'old.png'))
      }
    })
    expect(screen.getByAltText('Preview of new.png')).toBeTruthy()
    expect(screen.queryByAltText('Preview of old.png')).toBeNull()
    expect(handleAuthorityFailure).not.toHaveBeenCalled()
  }
)

it('T-P6: an accessChanged watch does not interrupt a pending Preview focus refresh', async () => {
  let finishFocus!: (value: Awaited<ReturnType<typeof previewResult>>) => void
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(previewResult())
    .mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof previewResult>>>(done => {
          finishFocus = done
        })
    )
    .mockResolvedValue(previewResult())
  installPreviewBoundary(resolve)

  const client = makeClient()
  const Preview = previewHarness(false)
  render(<Preview />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
  await act(async () => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))

  await act(async () => refetchGfsAccess(client, AUTHORITY))
  expect(resolve).toHaveBeenCalledTimes(2)
  await act(async () => finishFocus(await previewResult()))

  expect(screen.getByAltText('Preview of diagram.png')).toBeTruthy()
  expect(resolve).toHaveBeenCalledTimes(2)
})
