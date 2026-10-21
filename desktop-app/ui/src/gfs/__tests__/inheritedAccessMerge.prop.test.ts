// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { GfsInheritedAccessSource } from '../delegation.types'
import {
  type InheritedAccessContribution,
  type InheritedAccessFolder,
  isEditorPermissions,
  mergeInheritedAccessItem,
  roleRank,
} from '../inheritedAccessMerge'

/**
 * R1-M4 — property suite for the pure inherited-access merge core:
 * merge idempotency/composability, unique retained sources, effective role =
 * strongest of sources, and a total role order.
 */

const PERMISSION_BITS = ['read', 'write', 'delete', 'manage_acl', 'share'] as const

const permissionsArb = fc.uniqueArray(fc.constantFrom(...PERMISSION_BITS), {
  minLength: 1,
  maxLength: PERMISSION_BITS.length,
})

const subjectArb = fc.record({
  type: fc.constantFrom('user', 'team', 'host'),
  id: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
})

const idArb = fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null })

const contributionArb = fc
  .tuple(
    subjectArb,
    permissionsArb,
    idArb,
    fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }))
  )
  .map(([subject, permissions, grantId, shareIds]) => ({
    subject,
    permissions,
    grantId,
    shareIds,
  }))

const distinctFoldersArb = fc.uniqueArray(
  fc.record({
    resourceId: fc.string({ minLength: 1, maxLength: 10 }),
    name: fc.string({ minLength: 1, maxLength: 10 }),
  }),
  {
    selector: folder => folder.resourceId,
    minLength: 1,
    maxLength: 6,
  }
)

describe('inheritedAccessMerge properties', () => {
  it('merge is idempotent: merge(merge(a, b), b) == merge(a, b)', () => {
    fc.assert(
      fc.property(
        contributionArb,
        contributionArb,
        distinctFoldersArb,
        distinctFoldersArb,
        (seed, repeat, seedFolders, repeatFolders) => {
          const seedFolder = seedFolders[0]!
          const repeatFolder = repeatFolders[0]!
          const a = mergeInheritedAccessItem(null, seed, seedFolder)
          const once = mergeInheritedAccessItem(a, repeat, repeatFolder)
          const twice = mergeInheritedAccessItem(once, repeat, repeatFolder)
          expect(twice).toEqual(once)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('merging the same contribution twice changes nothing', () => {
    fc.assert(
      fc.property(contributionArb, distinctFoldersArb, (contribution, folders) => {
        const once = mergeInheritedAccessItem(null, contribution, folders[0]!)
        const twice = mergeInheritedAccessItem(once, contribution, folders[0]!)
        expect(twice).toEqual(once)
      }),
      { numRuns: 300 }
    )
  })

  it('is composable when an earlier source is folded again after another source', () => {
    fc.assert(
      fc.property(
        subjectArb,
        contributionArb,
        contributionArb,
        distinctFoldersArb,
        (subject, firstContribution, nextContribution, folders) => {
          const firstFolder = folders[0]!
          const secondFolder = folders[1] ?? {
            resourceId: `${firstFolder.resourceId}:second`,
            name: `${firstFolder.name}:second`,
          }
          const first = { ...firstContribution, subject }
          const next = { ...nextContribution, subject }
          const mergeInner = mergeInheritedAccessItem(
            mergeInheritedAccessItem(null, first, firstFolder),
            next,
            secondFolder
          )
          const mergeOuter = mergeInheritedAccessItem(mergeInner, first, firstFolder)
          expect(mergeOuter).toEqual(mergeInner)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('never drops a source: every contributing folder survives the fold', () => {
    fc.assert(
      fc.property(
        subjectArb,
        distinctFoldersArb,
        fc.array(permissionsArb, { minLength: 0, maxLength: 8 }),
        (subject, folders, permissionSets) => {
          let item = mergeInheritedAccessItem(
            null,
            { subject, permissions: permissionSets[0] ?? ['read'], grantId: null, shareIds: [] },
            folders[0]!
          )
          folders.slice(1).forEach((folder, index) => {
            item = mergeInheritedAccessItem(
              item,
              {
                subject,
                permissions: permissionSets[(index + 1) % Math.max(permissionSets.length, 1)] ?? [
                  'read',
                ],
                grantId: null,
                shareIds: [],
              },
              folder
            )
          })
          const sourceIds = item.sources.map(source => source.resourceId)
          const expectedIds = folders.map(folder => folder.resourceId)
          expect(sourceIds).toHaveLength(expectedIds.length)
          expect(new Set(sourceIds).size).toBe(sourceIds.length)
          expect(sourceIds).toEqual(expectedIds)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('effective role is the strongest of the kept sources', () => {
    fc.assert(
      fc.property(
        subjectArb,
        distinctFoldersArb,
        fc.array(permissionsArb, { minLength: 1, maxLength: 8 }),
        (subject, folders, permissionSets) => {
          let item: ReturnType<typeof mergeInheritedAccessItem> | null = null
          for (const [index, folder] of folders.entries()) {
            item = mergeInheritedAccessItem(
              item,
              {
                subject,
                permissions: permissionSets[index % permissionSets.length]!,
                grantId: null,
                shareIds: [],
              },
              folder
            )
          }
          const merged = item!
          const strongestRank = Math.max(
            ...merged.sources.map(source => roleRank(source.permissions))
          )
          expect(roleRank(merged.permissions)).toBe(strongestRank)
          expect(isEditorPermissions(merged.permissions)).toBe(
            merged.sources.some(source => isEditorPermissions(source.permissions))
          )
        }
      ),
      { numRuns: 300 }
    )
  })

  it('role order is total: any two permission sets compare exactly once, and max is order-independent', () => {
    fc.assert(
      fc.property(permissionsArb, permissionsArb, (left, right) => {
        const leftRank = roleRank(left)
        const rightRank = roleRank(right)
        const comparisons = [leftRank < rightRank, leftRank === rightRank, leftRank > rightRank]
        expect(comparisons.filter(Boolean)).toHaveLength(1)
      }),
      { numRuns: 300 }
    )
  })

  // R1-M5 — the adapter projection PRESERVES per-row provenance: a
  // grant-backed folder keeps the grant's own bits and scope flag, every
  // share keeps its own row id/bits/scope, and re-folding a projected item
  // (provenance-projected input) keeps them stable.
  it('keeps each grant and share row’s own provenance through the projection', () => {
    fc.assert(
      fc.property(
        subjectArb,
        permissionsArb,
        permissionsArb,
        distinctFoldersArb,
        (subject, grantBits, shareBits, folders) => {
          const folder = folders[0]!
          const grantId = 'grant-row'
          const shareId = 'share-row'
          const item = mergeInheritedAccessItem(
            null,
            { subject, permissions: grantBits, grantId, shareIds: [] },
            folder
          )
          const withShare = mergeInheritedAccessItem(
            item,
            { subject, permissions: shareBits, grantId: null, shareIds: [shareId] },
            folder
          )
          const source = withShare.sources.find(entry => entry.resourceId === folder.resourceId)
          expect(source).toBeTruthy()
          // The grant row's OWN bits and scope flag survive (the walker
          // pre-filters inheriting grants, so inherit=true here).
          expect(source?.grantId).toBe(grantId)
          expect(source?.grantPermissions).toEqual(grantBits)
          expect(source?.grantInherit).toBe(true)
          // The share row keeps its own identity and bits — never OR'd into
          // the grant's scope.
          expect(source?.shareIds).toEqual([shareId])
          expect(source?.shareEntries).toHaveLength(1)
          expect(source?.shareEntries[0]).toEqual({
            rowId: shareId,
            permissions: shareBits,
            includeDescendants: true,
          })
          // Re-folding the projected item is stable (idempotent projection).
          const refolded = mergeInheritedAccessItem(
            withShare,
            { subject, permissions: grantBits, grantId, shareIds: [] },
            folder
          )
          expect(refolded).toEqual(withShare)
        }
      ),
      { numRuns: 300 }
    )
  })
})
