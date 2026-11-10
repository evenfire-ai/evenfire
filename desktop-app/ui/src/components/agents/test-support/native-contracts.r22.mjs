import { InfiniteQueryObserver, QueryClient } from '@tanstack/query-core'
import assert from 'node:assert/strict'

const rows = []
for (const kind of ['accessible', 'children']) {
  for (const precheck of [true, false]) {
    const c = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    })
    const calls = []
    const o = new InfiniteQueryObserver(c, {
      queryKey: ['desktop-app', 'gfs', 'scope', kind, 'main', 'A', 1],
      queryFn: async ({ pageParam }) => {
        calls.push(pageParam ?? null)
        return { items: [pageParam ?? 'one'], next: pageParam ? null : 'two' }
      },
      initialPageParam: undefined,
      getNextPageParam: p => p.next ?? undefined,
    })
    const off = o.subscribe(() => {})
    await o.refetch({ cancelRefetch: false })
    await o.fetchNextPage()
    const mark = calls.length
    if (!precheck || o.getCurrentResult().hasNextPage) await o.fetchNextPage()
    assert.equal(calls.length - mark, 0)
    assert.deepEqual(
      o.getCurrentResult().data.pages.flatMap(p => p.items),
      ['one', 'two']
    )
    assert.equal(o.getCurrentResult().isFetching, false)
    rows.push({ kind, control: 'no-next', precheck, addedPhysical: calls.length - mark, calls })
    off()
    c.clear()
  }
  const c = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  })
  let fresh = false
  const calls = []
  const o = new InfiniteQueryObserver(c, {
    queryKey: ['desktop-app', 'gfs', 'scope', kind, 'main', 'A', 1],
    queryFn: async ({ pageParam }) => {
      calls.push(pageParam ?? null)
      return {
        items: [pageParam ?? (fresh ? 'fresh-one' : 'one')],
        next: pageParam ? null : fresh ? 'fresh-two' : 'two',
      }
    },
    initialPageParam: undefined,
    getNextPageParam: p => p.next ?? undefined,
  })
  const off = o.subscribe(() => {})
  await o.refetch({ cancelRefetch: false })
  const clickTimeCursor = o.getCurrentResult().data.pages.at(-1).next
  fresh = true
  await o.refetch()
  // No adapter cursor read/override at dispatch. Native Core selects fresh-two.
  await o.fetchNextPage()
  assert.equal(clickTimeCursor, 'two')
  assert.equal(calls.at(-1), 'fresh-two')
  assert.deepEqual(
    o.getCurrentResult().data.pages.flatMap(p => p.items),
    ['fresh-one', 'fresh-two']
  )
  rows.push({ kind, control: 'current-cursor', clickTimeCursor, calls })
  off()
  c.clear()
}
console.log(JSON.stringify({ controls: rows.length, rows }, null, 2))
