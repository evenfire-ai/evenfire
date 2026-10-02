import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { isGfsChildrenDenied, purgeDeniedGfsChildren } from '../deniedChildren'

describe('denied GFS children cache', () => {
  it('purges cached rows without representing a revoked folder as a successful empty folder', () => {
    const queryClient = new QueryClient()
    const queryKey = ['desktop-app', 'gfs', 'session', 'children', 'main', 'folder']
    queryClient.setQueryData(queryKey, {
      pages: [{ items: [{ resourceId: 'secret-child' }], nextCursor: 'next' }],
      pageParams: [undefined],
    })

    expect(
      purgeDeniedGfsChildren(queryClient, queryKey, new Error('resource denied httpStatus=403'))
    ).toBe(true)

    const cached = queryClient.getQueryData(queryKey)
    expect(cached).toMatchObject({
      accessDenied: true,
      pages: [{ items: [], nextCursor: null }],
    })
    expect(isGfsChildrenDenied(undefined, cached)).toBe(true)

    queryClient.setQueryData(queryKey, {
      pages: [{ items: [{ resourceId: 'newly-visible-child' }], nextCursor: null }],
      pageParams: [undefined],
    })
    expect(isGfsChildrenDenied(undefined, queryClient.getQueryData(queryKey))).toBe(false)
  })
})
