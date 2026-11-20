import { describe, expect, it } from 'vitest'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { gfsActionOpeningAuthority } from './gfsActionOpeningAuthority'
import type { GfsResourceActionId } from './gfsResourceActions'

async function listedFile() {
  const page = await listChildrenPage([
    childView('file-t', 'notes.txt', 'file', { parentResourceId: 'folder-p', version: 3 }),
  ])
  return page.items[0]!
}

/** A "Shared with me" root: the listing reports no parent for it. */
async function sharedRootFile() {
  const page = await listAccessiblePage([
    accessibleResource('file-s', 'shared.txt', 'file', { version: 2 }),
  ])
  return page.items[0]!
}

describe('gfsActionOpeningAuthority', () => {
  it('checks the bits of every action whose editor it knows', async () => {
    const target = await listedFile()
    expect(gfsActionOpeningAuthority(target, 'delete')).toEqual({
      kind: 'check',
      resourceId: target.resourceId,
      resourceName: target.name,
      bits: ['delete'],
    })
    expect(gfsActionOpeningAuthority(target, 'share')).toEqual({
      kind: 'check',
      resourceId: target.resourceId,
      resourceName: target.name,
      bits: ['manage_acl'],
    })
    expect(gfsActionOpeningAuthority(target, 'move')).toEqual({
      kind: 'check',
      resourceId: 'folder-p',
      resourceName: 'the source folder',
      bits: ['write', 'delete'],
    })
  })

  it('refuses to open Move on a resource whose source folder is unknown', async () => {
    const target = await sharedRootFile()
    expect(target.parentResourceId ?? null).toBeNull()
    expect(gfsActionOpeningAuthority(target, 'move')).toEqual({
      kind: 'unverifiable',
      message: 'Could not verify the source folder for this move.',
    })
    // The same resource still opens the actions authorized on itself.
    expect(gfsActionOpeningAuthority(target, 'delete')).toMatchObject({
      kind: 'check',
      resourceId: 'file-s',
    })
  })

  it.each<GfsResourceActionId>(['upload-file', 'replace', 'download-zip', 'copy-content'])(
    'refuses to open %s, an action it has no opening authority for',
    async actionId => {
      const target = await listedFile()
      expect(gfsActionOpeningAuthority(target, actionId)).toEqual({
        kind: 'unverifiable',
        message: 'Could not verify permissions for this action.',
      })
    }
  )
})
