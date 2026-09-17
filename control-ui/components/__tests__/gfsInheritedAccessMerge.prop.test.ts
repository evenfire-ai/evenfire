import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { GfsInheritedAccessSource } from '../GfsGrantPanel.types'
import {
  type InheritedAccessContribution,
  type InheritedAccessFolder,
  isEditorPermissions,
  mergeInheritedAccessItem,
  planInheritedRoleChange,
  roleRank,
  strongestInheritedSource,
} from '../gfsInheritedAccessMerge'

/**
 * R1-M2 — property suite for the pure inherited-access merge core:
 * merge idempotency, no source dropped, effective role = strongest of
 * sources, and a total role order.
 */

const PERMISSION_BITS = ['read', 'write', 'delete', 'manage_acl', 'share'] as const

const permissionsArb = fc.uniqueArray(fc.constantFrom(...PERMISSION_BITS), {
  minLength: 1,
  maxLength: PERMISSION_BITS.length,
})

const subjectArb = fc.record({
  type: fc.constantFrom('user', 'team', 'host'),
  id: fc.string({ minLength: 1, maxLength: 8 }),
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

describe('gfsInheritedAccessMerge properties', () => {
  it('merge is idempotent: merge(merge(a, b), b) == merge(a, b)', () => {
    fc.assert(
      fc.property(
        contributionArb,
        contributionArb,
        distinctFoldersArb,
        distinctFoldersArb,
        (seed, repeat, seedFolders, repeatFolders) => {
          const seedFolder = seedFolders[0]
          const repeatFolder = repeatFolders[0]
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
        const once = mergeInheritedAccessItem(null, contribution, folders[0])
        const twice = mergeInheritedAccessItem(once, contribution, folders[0])
        expect(twice).toEqual(once)
      }),
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
            folders[0]
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
          expect(new Set(item.sources.map(source => source.resourceId))).toEqual(
            new Set(folders.map(folder => folder.resourceId))
          )
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
          folders.forEach((folder, index) => {
            item = mergeInheritedAccessItem(
              item,
              {
                subject,
                permissions: permissionSets[index % permissionSets.length],
                grantId: null,
                shareIds: [],
              },
              folder
            )
          })
          const merged = item as NonNullable<typeof item>
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

        const toSource = (permissions: string[]): GfsInheritedAccessSource => ({
          resourceId: 'r',
          name: 'r',
          permissions,
          grantId: null,
          shareIds: [],
        })
        const forward = strongestInheritedSource([toSource(left), toSource(right)])
        const backward = strongestInheritedSource([toSource(right), toSource(left)])
        expect(roleRank(forward?.permissions ?? [])).toBe(roleRank(backward?.permissions ?? []))
      }),
      { numRuns: 300 }
    )
  })

  it('the R1-H1 plan never drops an above-target source', () => {
    fc.assert(
      fc.property(
        distinctFoldersArb,
        fc.array(permissionsArb, { minLength: 1, maxLength: 8 }),
        (folders, permissionSets) => {
          const sources: GfsInheritedAccessSource[] = folders.map((folder, index) => ({
            resourceId: folder.resourceId,
            name: folder.name,
            permissions: permissionSets[index % permissionSets.length],
            grantId: null,
            shareIds: [],
          }))
          const permissions = [...new Set(sources.flatMap(source => source.permissions))]
          const item = { permissions, sources }
          const editorSources = sources.filter(source => isEditorPermissions(source.permissions))
          const readSources = sources.filter(source => !isEditorPermissions(source.permissions))

          const downgrade = planInheritedRoleChange(item, false)
          expect(downgrade).toHaveLength(editorSources.length)

          const upgrade = planInheritedRoleChange(item, true)
          if (isEditorPermissions(permissions)) {
            expect(upgrade).toHaveLength(0)
          } else {
            expect(upgrade).toHaveLength(1)
          }

          const noOp = planInheritedRoleChange(item, isEditorPermissions(permissions))
          expect(noOp).toHaveLength(0)
          expect(readSources.length + editorSources.length).toBe(sources.length)
        }
      ),
      { numRuns: 300 }
    )
  })
})
