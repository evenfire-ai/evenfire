import { describe, expect, it } from 'vitest'
import {
  accessibleResource,
  affordancesResult,
  childView,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { gfsRowActionAvailability } from './gfsRowActionAvailability'

const NONE = {
  canDelete: false,
  canRename: false,
  canWrite: false,
  canManage: false,
  canMove: false,
}

async function sharedRoot(permissions: string[], parentResourceId: string | null = null) {
  const page = await listAccessiblePage([
    accessibleResource('shared', 'shared.txt', 'file', { permissions, parentResourceId }),
  ])
  return page.items[0]!
}

async function folderChild(parentResourceId = 'parent') {
  const page = await listChildrenPage([
    childView('child', 'child.txt', 'file', { parentResourceId }),
  ])
  return page.items[0]!
}

describe('gfsRowActionAvailability', () => {
  it('gates shared-root rows on the permissions their listing carries, not on row affordances', async () => {
    const resource = await sharedRoot(['read', 'write', 'manage_acl'])
    const everything = await affordancesResult(
      heldAffordances(['read', 'write', 'delete', 'manage_acl'])
    )

    expect(
      gfsRowActionAvailability({
        resource,
        listing: 'roots',
        rowAffordances: everything,
        parentAffordances: null,
      })
    ).toEqual({ ...NONE, canRename: true, canWrite: true, canManage: true })
  })

  it('gates folder children on their own affordances, which the listing does not carry', async () => {
    const resource = await folderChild()
    const writeDelete = await affordancesResult(heldAffordances(['read', 'write', 'delete']))

    expect(
      gfsRowActionAvailability({
        resource,
        listing: 'folder',
        rowAffordances: writeDelete,
        parentAffordances: null,
      })
    ).toEqual({ ...NONE, canDelete: true, canRename: true, canWrite: true })
    expect(
      gfsRowActionAvailability({
        resource,
        listing: 'folder',
        rowAffordances: null,
        parentAffordances: null,
      })
    ).toEqual(NONE)
  })

  it('offers move only with write and delete on the exact old parent', async () => {
    const resource = await folderChild('parent')
    const rowOnly = await affordancesResult(
      heldAffordances(['read', 'write', 'delete', 'manage_acl'])
    )
    const parentWriteDelete = await affordancesResult(heldAffordances(['write', 'delete']))
    const parentWriteOnly = await affordancesResult(heldAffordances(['write']))
    const availability = (parentAffordances: typeof parentWriteDelete | null) =>
      gfsRowActionAvailability({
        resource,
        listing: 'folder',
        rowAffordances: rowOnly,
        parentAffordances,
      }).canMove

    expect(availability(parentWriteDelete)).toBe(true)
    expect(availability(parentWriteOnly)).toBe(false)
    expect(availability(null)).toBe(false)
  })

  it('never offers move for a row with no parent, whatever authority is supplied', async () => {
    const resource = await sharedRoot(['read', 'write', 'delete'], null)
    const parentWriteDelete = await affordancesResult(heldAffordances(['write', 'delete']))

    expect(
      gfsRowActionAvailability({
        resource,
        listing: 'roots',
        rowAffordances: null,
        parentAffordances: parentWriteDelete,
      }).canMove
    ).toBe(false)
  })
})
