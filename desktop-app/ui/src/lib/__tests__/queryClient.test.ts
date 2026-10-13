import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { desktopQueryDefaults, isQueryOlderThan } from '../queryClient'

const KEY = ['desktop-app', 'age-probe'] as const

describe('isQueryOlderThan', () => {
  const client = () => new QueryClient({ defaultOptions: desktopQueryDefaults })

  it('reports a query with no data (never loaded, or reset) as stale', () => {
    expect(isQueryOlderThan(client(), KEY, 15_000)).toBe(true)
  })

  it('compares the data age against the window at call time', () => {
    const queryClient = client()
    queryClient.setQueryData(KEY, 'v1', { updatedAt: Date.now() - 14_000 })
    expect(isQueryOlderThan(queryClient, KEY, 15_000)).toBe(false)
    queryClient.setQueryData(KEY, 'v2', { updatedAt: Date.now() - 15_000 })
    expect(isQueryOlderThan(queryClient, KEY, 15_000)).toBe(true)
  })

  it('treats a fetch in flight as fresh so it is not duplicated', async () => {
    const queryClient = client()
    let release: () => void = () => undefined
    const pending = queryClient.fetchQuery({
      queryKey: KEY,
      queryFn: () => new Promise<string>(resolve => (release = () => resolve('v'))),
    })
    expect(isQueryOlderThan(queryClient, KEY, 15_000)).toBe(false)
    release()
    await pending
    expect(isQueryOlderThan(queryClient, KEY, 15_000)).toBe(false)
  })
})
