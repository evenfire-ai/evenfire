import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  ancestryDependentGfsResourceIds,
  nextGfsOpenLocationId,
  publishGfsOpenLocation,
  readGfsOpenLocations,
} from '../gfsOpenLocations'

const SCOPE = 'test:user-1:team-1'
const OTHER_SCOPE = 'test:user-1:team-2'

describe('gfsOpenLocations', () => {
  it('gives every controller mount its own registry identity', () => {
    expect(nextGfsOpenLocationId()).not.toBe(nextGfsOpenLocationId())
  })

  it("publishes and retracts one mount's open location per session scope", () => {
    const queryClient = new QueryClient()
    publishGfsOpenLocation(queryClient, SCOPE, 'mount-a', {
      resourceId: 'leaf-1',
      ancestorResourceIds: ['ancestor-1'],
    })
    publishGfsOpenLocation(queryClient, SCOPE, 'mount-b', {
      resourceId: 'other-1',
      ancestorResourceIds: [],
    })

    expect(readGfsOpenLocations(queryClient, SCOPE)).toEqual([
      { resourceId: 'leaf-1', ancestorResourceIds: ['ancestor-1'] },
      { resourceId: 'other-1', ancestorResourceIds: [] },
    ])

    // A mount that closes its location retracts only its own entry.
    publishGfsOpenLocation(queryClient, SCOPE, 'mount-a', null)
    expect(readGfsOpenLocations(queryClient, SCOPE)).toEqual([
      { resourceId: 'other-1', ancestorResourceIds: [] },
    ])

    // Another session scope never sees another scope's locations.
    expect(readGfsOpenLocations(queryClient, OTHER_SCOPE)).toEqual([])
  })

  it('claims only the resources whose observed ancestry contains the moved resource', () => {
    const locations = [
      { resourceId: 'leaf-1', ancestorResourceIds: ['ancestor-1', 'parent-1'] },
      { resourceId: 'sibling-1', ancestorResourceIds: ['parent-1'] },
      { resourceId: 'moved-1', ancestorResourceIds: [] },
    ]

    expect(ancestryDependentGfsResourceIds(locations, 'ancestor-1')).toEqual(['leaf-1'])
    expect(ancestryDependentGfsResourceIds(locations, 'parent-1')).toEqual(['leaf-1', 'sibling-1'])
    expect(ancestryDependentGfsResourceIds(locations, 'moved-1')).toEqual(['moved-1'])
    expect(ancestryDependentGfsResourceIds(locations, 'unrelated-1')).toEqual([])
  })

  it('keeps the registry inside the shared query cache', () => {
    const queryClient = new QueryClient()
    publishGfsOpenLocation(queryClient, SCOPE, 'mount-a', {
      resourceId: 'leaf-1',
      ancestorResourceIds: [],
    })
    expect(queryClient.getQueryData(desktopQueryKeys.gfsOpenLocations(SCOPE))).toMatchObject({
      'mount-a': { resourceId: 'leaf-1' },
    })
  })
})
