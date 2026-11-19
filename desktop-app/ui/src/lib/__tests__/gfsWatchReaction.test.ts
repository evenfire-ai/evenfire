import { afterEach, describe, expect, it } from 'vitest'
import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { childView, listChildrenPage } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { gfsRidOfResourceId } from '../gfsWatchKeys'
import type { GfsWatchAuthority } from '../gfsWatchReaction'
import {
  purgeGfsSessionCache,
  refetchGfsAccess,
  refetchGfsRoots,
  refetchWatchedFolder,
} from '../gfsWatchReaction'

const SCOPE = 'env:6f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b:team-1'
const AUTHORITY: GfsWatchAuthority = { scope: SCOPE, generation: 3 }
const FOLDER = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d'
const OTHER_FOLDER = '11111111-2222-4333-8444-555555555555'
const FOLDER_RID = gfsRidOfResourceId(FOLDER)

type Page = Awaited<ReturnType<typeof listChildrenPage>>

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const page = (names: string[], nextCursor: string | null) =>
  listChildrenPage(
    names.map(name => childView(`${name}-id`, name, 'file')),
    nextCursor
  )

const names = (data: { pages: Page[] } | undefined) =>
  (data?.pages ?? []).flatMap(p => p.items.map(item => item.name))

let unsubscribers: Array<() => void> = []
afterEach(() => {
  unsubscribers.forEach(off => off())
  unsubscribers = []
})

describe('refetchWatchedFolder (real TanStack)', () => {
  it('T-CB38: a change during fetchNextPage joins the page chain and runs a final pass', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = desktopQueryKeys.gfsChildren(SCOPE, FOLDER, 'main', 3)
    const pending: Array<{ cursor: string | undefined; gate: ReturnType<typeof gate<Page>> }> = []
    const reads: Array<string | undefined> = []
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key,
      queryFn: ({ pageParam }: { pageParam: string | undefined }) => {
        reads.push(pageParam)
        const g = gate<Page>()
        pending.push({ cursor: pageParam, gate: g })
        return g.promise
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
    })
    unsubscribers.push(observer.subscribe(() => undefined))
    pending.shift()!.gate.resolve(await page(['a-old'], 'page-2'))
    await expect.poll(() => names(observer.getCurrentResult().data)).toEqual(['a-old'])

    const next = observer.fetchNextPage()
    await expect.poll(() => pending.length).toBe(1)
    const reaction = refetchWatchedFolder(client, AUTHORITY, 'main', FOLDER_RID)

    // The page the user asked for still lands: the change did not abort it.
    pending.shift()!.gate.resolve(await page(['b-old'], null))
    await next
    expect(observer.getCurrentResult().isFetchNextPageError).toBe(false)
    expect(names(observer.getCurrentResult().data)).toEqual(['a-old', 'b-old'])

    // The final pass re-reads every loaded page with what the server has now.
    await expect.poll(() => pending.length).toBe(1)
    pending.shift()!.gate.resolve(await page(['a-new'], 'page-2'))
    await expect.poll(() => pending.length).toBe(1)
    pending.shift()!.gate.resolve(await page(['b-new'], null))
    await reaction
    expect(names(observer.getCurrentResult().data)).toEqual(['a-new', 'b-new'])
    expect(reads).toEqual([undefined, 'page-2', undefined, 'page-2'])
  })

  it('re-reads only the watched folder of the current session, once when nothing was in flight', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const reads: string[] = []
    const watch = (scope: string, folder: string, generation: number) => {
      const observer = new InfiniteQueryObserver(client, {
        queryKey: desktopQueryKeys.gfsChildren(scope, folder, 'main', generation),
        queryFn: async () => {
          reads.push(`${scope}|${folder}|${generation}`)
          return page(['row'], null)
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
      })
      unsubscribers.push(observer.subscribe(() => undefined))
    }
    watch(SCOPE, FOLDER, 3)
    watch(SCOPE, OTHER_FOLDER, 3)
    watch(SCOPE, FOLDER, 2)
    watch('env:other-user:team-1', FOLDER, 3)
    await expect.poll(() => reads.length).toBe(4)
    reads.length = 0

    await refetchWatchedFolder(client, AUTHORITY, 'main', FOLDER_RID)
    expect(reads).toEqual([`${SCOPE}|${FOLDER}|3`])

    reads.length = 0
    await refetchWatchedFolder(client, { scope: null, generation: 3 }, 'main', FOLDER_RID)
    expect(reads).toEqual([])
  })
})

describe('access and roots reactions', () => {
  function observe(client: QueryClient, key: readonly unknown[], reads: string[]) {
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => {
        reads.push(String(key[3]))
        return { ok: true }
      },
    })
    unsubscribers.push(observer.subscribe(() => undefined))
  }

  it('re-reads roots and every open sharing dialog on an access change, not listings', async () => {
    const client = new QueryClient()
    const reads: string[] = []
    observe(client, desktopQueryKeys.gfsAccessible(SCOPE, 'main', 3), reads)
    observe(client, desktopQueryKeys.gfsGrants(SCOPE, FOLDER, 'main', 3), reads)
    observe(client, desktopQueryKeys.gfsShares(SCOPE, FOLDER, 'main', 3), reads)
    observe(client, desktopQueryKeys.gfsInheritedAccess(SCOPE, FOLDER, 'main', 3), reads)
    observe(client, desktopQueryKeys.gfsAffordances(SCOPE, FOLDER, 'main', 3), reads)
    observe(client, desktopQueryKeys.gfsChildren(SCOPE, FOLDER, 'main', 3), reads)
    await expect.poll(() => reads.length).toBe(6)
    reads.length = 0

    await refetchGfsAccess(client, AUTHORITY)
    expect(reads.sort()).toEqual(
      ['accessible', 'affordances', 'grants', 'inherited-access', 'shares'].sort()
    )

    reads.length = 0
    await refetchGfsRoots(client, AUTHORITY)
    expect(reads).toEqual(['accessible'])
  })
})

describe('access and roots reactions during "load more" (real TanStack)', () => {
  for (const [name, react] of [
    ['accessChanged', refetchGfsAccess],
    ['roots_changed', refetchGfsRoots],
  ] as const) {
    it(`${name} during fetchNextPage of the roots lets the page land, then re-reads`, async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const pending: Array<ReturnType<typeof gate<Page>>> = []
      const reads: Array<string | undefined> = []
      const observer = new InfiniteQueryObserver(client, {
        queryKey: desktopQueryKeys.gfsAccessible(SCOPE, 'main', 3),
        queryFn: ({ pageParam }: { pageParam: string | undefined }) => {
          reads.push(pageParam)
          const g = gate<Page>()
          pending.push(g)
          return g.promise
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last: Page) => last.nextCursor ?? undefined,
      })
      unsubscribers.push(observer.subscribe(() => undefined))
      pending.shift()!.resolve(await page(['root-a'], 'page-2'))
      await expect.poll(() => names(observer.getCurrentResult().data)).toEqual(['root-a'])

      const next = observer.fetchNextPage()
      await expect.poll(() => pending.length).toBe(1)
      const reaction = react(client, AUTHORITY)

      pending.shift()!.resolve(await page(['root-b'], null))
      // Polled, not awaited: a cancelled fetchNextPage settles only with the
      // refetch that replaced it, which this test never answers.
      await expect
        .poll(() => names(observer.getCurrentResult().data), { timeout: 1_000 })
        .toEqual(['root-a', 'root-b'])
      await next
      expect(observer.getCurrentResult().isFetchNextPageError).toBe(false)

      // The joined page may predate the change: one more pass reads what is current.
      await expect.poll(() => pending.length).toBe(1)
      pending.shift()!.resolve(await page(['root-a2'], 'page-2'))
      await expect.poll(() => pending.length).toBe(1)
      pending.shift()!.resolve(await page(['root-b2'], null))
      await reaction
      expect(names(observer.getCurrentResult().data)).toEqual(['root-a2', 'root-b2'])
      expect(reads).toEqual([undefined, 'page-2', undefined, 'page-2'])
    })
  }
})

describe('access reaction cost', () => {
  it('an unrelated read in flight does not make the access change read idle queries twice', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const grantsReads: number[] = []
    const grants = new QueryObserver(client, {
      queryKey: desktopQueryKeys.gfsGrants(SCOPE, FOLDER, 'main', 3),
      queryFn: async () => {
        grantsReads.push(grantsReads.length)
        return { ok: true }
      },
    })
    unsubscribers.push(grants.subscribe(() => undefined))
    await expect.poll(() => grantsReads.length).toBe(1)
    grantsReads.length = 0

    // A use-time check (as a drag adjudication runs) with no observer, in flight.
    const affordances = gate<{ ok: boolean }>()
    const check = client.fetchQuery({
      queryKey: desktopQueryKeys.gfsAffordances(SCOPE, OTHER_FOLDER, 'main', 3),
      queryFn: () => affordances.promise,
    })
    await expect.poll(() => client.isFetching()).toBe(1)

    const reaction = refetchGfsAccess(client, AUTHORITY)
    affordances.resolve({ ok: true })
    await check
    await reaction
    expect(grantsReads).toHaveLength(1)
  })
})

describe('purgeGfsSessionCache', () => {
  it('drops every GFS query and revokes access for the session, with nothing mounted', () => {
    const client = new QueryClient()
    client.setQueryData(desktopQueryKeys.gfsChildren(SCOPE, FOLDER, 'main', 3), { pages: [] })
    client.setQueryData(desktopQueryKeys.gfsAccessible('env:other', 'main', 1), { items: [] })

    purgeGfsSessionCache(client, AUTHORITY)

    expect(client.getQueryCache().findAll({ queryKey: desktopQueryKeys.gfsRoot })).toHaveLength(0)
    expect(client.getQueryData(desktopQueryKeys.gfsAccessState(SCOPE, 3))).toBe('revoked')
  })
})
