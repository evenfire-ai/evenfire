import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  ancestryDependentGfsResourceIds,
  nextGfsOpenLocationId,
  publishGfsMoveRelocation,
  publishGfsOpenLocation,
  readGfsOpenLocations,
  relocateObservedChain,
  relocatePublishedChains,
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

  describe('two controllers, two moves (RP-005)', () => {
    // Files has the leaf L open, reached BY URI: no children listing ever
    // connected A to L, so the registry's observed chain is the only record
    // of it. The sidebar has B open.
    function twoControllers() {
      return {
        files: { resourceId: 'L', ancestorResourceIds: ['A', 'X', 'root'] },
        sidebar: { resourceId: 'B', ancestorResourceIds: ['P', 'root'] },
      }
    }

    it('relocates the chain of a resource below the moved one', () => {
      expect(relocateObservedChain(['A', 'X', 'root'], 'A', 'B', ['P', 'root'])).toEqual([
        'A',
        'B',
        'P',
        'root',
      ])
    })

    it('leaves a chain that does not contain the moved resource alone', () => {
      expect(relocateObservedChain(['P', 'root'], 'A', 'B', ['P', 'root'])).toEqual(['P', 'root'])
    })

    it('claims the descendant for the SECOND move after the first relocated its chain', () => {
      const afterFirst = relocatePublishedChains(twoControllers(), 'A', 'B')
      // The leaf's chain now names B, so B is one of its ancestors.
      expect(afterFirst.files?.ancestorResourceIds).toEqual(['A', 'B', 'P', 'root'])
      // The leaf is claimed, and so is the sidebar's own open folder: the
      // moved resource itself is always ancestry-dependent.
      expect(ancestryDependentGfsResourceIds(Object.values(afterFirst), 'B')).toEqual(['L', 'B'])
      // A move of B's own parent is claimed too.
      expect(ancestryDependentGfsResourceIds(Object.values(afterFirst), 'P')).toEqual(['L', 'B'])
    })

    it('publishes the relocation into the shared registry', () => {
      const queryClient = new QueryClient()
      publishGfsOpenLocation(queryClient, SCOPE, 'files', {
        resourceId: 'L',
        ancestorResourceIds: ['A', 'X', 'root'],
      })
      publishGfsOpenLocation(queryClient, SCOPE, 'sidebar', {
        resourceId: 'B',
        ancestorResourceIds: ['P', 'root'],
      })

      publishGfsMoveRelocation(queryClient, SCOPE, 'A', 'B')

      expect(readGfsOpenLocations(queryClient, SCOPE)).toEqual([
        { resourceId: 'L', ancestorResourceIds: ['A', 'B', 'P', 'root'] },
        { resourceId: 'B', ancestorResourceIds: ['P', 'root'] },
      ])
      // The second move now claims the leaf (and the sidebar's own open
      // folder, which is the moved resource itself).
      expect(
        ancestryDependentGfsResourceIds(readGfsOpenLocations(queryClient, SCOPE), 'B')
      ).toEqual(['L', 'B'])
    })
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
