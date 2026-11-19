import { describe, expect, it } from 'vitest'
import { childView, listChildrenPage } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { gfsActionOpeningAuthority } from './gfsActionOpeningAuthority'
import type { GfsResourceActionId } from './gfsResourceActions'

async function listedFile() {
  const page = await listChildrenPage([
    childView('file-t', 'notes.txt', 'file', { parentResourceId: 'folder-p', version: 3 }),
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
    expect(gfsActionOpeningAuthority(target, 'move')).toEqual({
      kind: 'check',
      resourceId: 'folder-p',
      resourceName: 'the source folder',
      bits: ['write', 'delete'],
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
