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

  describe('producer-order chains, two controllers (RP-005 revalidation)', () => {
    // The controller's crumbs are ROOT-FIRST, and the publication step
    // reverses them into this registry's NEAREST-FIRST contract: a leaf L
    // under root > X > A > C publishes [C, A, X, root]. These regressions
    // hold the relocated chains to that contract — an order disagreement
    // between the producer and the relocation helper used to keep the stale
    // ancestors ABOVE the moved one and drop the still-real ones BELOW it.
    function registryWithProducerChains() {
      return {
        files: { resourceId: 'L', ancestorResourceIds: ['C', 'A', 'X', 'root'] },
        sidebar: { resourceId: 'B', ancestorResourceIds: ['P', 'root'] },
        preview: { resourceId: 'Q', ancestorResourceIds: ['root'] },
      }
    }

    it('keeps every ancestor below the moved one, in producer order', () => {
      // The sidebar moves A under B. C is BELOW A in the leaf's chain — it
      // stays; X and root sat ABOVE A and are replaced by B's own chain.
      expect(relocateObservedChain(['C', 'A', 'X', 'root'], 'A', 'B', ['P', 'root'])).toEqual([
        'C',
        'A',
        'B',
        'P',
        'root',
      ])
    })

    it('still claims the leaf for a later move of the intermediate ancestor below the moved one', () => {
      const afterFirst = relocatePublishedChains(registryWithProducerChains(), 'A', 'B')
      expect(afterFirst.files?.ancestorResourceIds).toEqual(['C', 'A', 'B', 'P', 'root'])
      // C survived the relocation as the leaf's nearest ancestor, so a
      // SECOND move of C — not just of A or B — must still claim the leaf.
      expect(ancestryDependentGfsResourceIds(Object.values(afterFirst), 'C')).toEqual(['L'])
      expect(ancestryDependentGfsResourceIds(Object.values(afterFirst), 'B')).toEqual(['L', 'B'])
    })

    it('relocates the chain when the OPEN resource itself is the moved one', () => {
      // The sidebar moves its own open B under Q. B's ENTIRE observed
      // ancestry belonged to the old location, so the new chain starts at Q
      // — plus Q's own observed ancestors, because the preview surface has
      // Q open. A later move of Q must then claim B.
      const after = relocatePublishedChains(registryWithProducerChains(), 'B', 'Q')
      expect(after.sidebar?.ancestorResourceIds).toEqual(['Q', 'root'])
      expect(ancestryDependentGfsResourceIds(Object.values(after), 'Q')).toEqual(['B', 'Q'])
    })

    it('stops the self-moved chain at the new parent when no surface has it open', () => {
      const after = relocatePublishedChains(
        { sidebar: { resourceId: 'B', ancestorResourceIds: ['P', 'root'] } },
        'B',
        'Q'
      )
      expect(after.sidebar?.ancestorResourceIds).toEqual(['Q'])
    })

    it("clears the open resource's ancestry when it moves to the drive root", () => {
      const after = relocatePublishedChains(registryWithProducerChains(), 'B', null)
      expect(after.sidebar?.ancestorResourceIds).toEqual([])
    })

    it('publishes the self-move relocation into the shared registry', () => {
      const queryClient = new QueryClient()
      publishGfsOpenLocation(queryClient, SCOPE, 'sidebar', {
        resourceId: 'B',
        ancestorResourceIds: ['P', 'root'],
      })
      publishGfsOpenLocation(queryClient, SCOPE, 'preview', {
        resourceId: 'Q',
        ancestorResourceIds: ['root'],
      })

      publishGfsMoveRelocation(queryClient, SCOPE, 'B', 'Q')

      expect(readGfsOpenLocations(queryClient, SCOPE)).toEqual([
        { resourceId: 'B', ancestorResourceIds: ['Q', 'root'] },
        { resourceId: 'Q', ancestorResourceIds: ['root'] },
      ])
      // The SECOND move now claims the sidebar's own open folder.
      expect(
        ancestryDependentGfsResourceIds(readGfsOpenLocations(queryClient, SCOPE), 'Q')
      ).toEqual(['B', 'Q'])
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
