import { describe, expect, it } from 'vitest'
import {
  openGfsResourcePayload,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '../../gfs/__fixtures__/gfsProducerFixtures'
import { gfsResourceOpenTarget } from '../gfsPreview'

const RID = '859df99de46b407bb0ec4b0f7cb424a5'
const URI = `gfs://main/${RID}`

// Both producers that feed `gfsResourceOpenTarget`: the plugin SDK wire payload
// (`bytes: null` when the resolve omits it) and the resolve result itself.
const producers = [
  ['plugin payload', openGfsResourcePayload],
  ['resolved resource', resolveResource],
] as const

describe.each(producers)('gfsResourceOpenTarget — %s', (_label, produce) => {
  it('opens a directory in the files browser, even when its name looks previewable', async () => {
    const resource = await produce(resolvedDirectory(RID, 'notes.md', { gfsUri: URI }))

    expect(gfsResourceOpenTarget(resource)).toEqual({ kind: 'files', gfsUri: URI })
  })

  it('opens a previewable file as a preview of the resolved resource', async () => {
    const resource = await produce(
      resolvedFile(RID, 'README.md', { gfsUri: URI, bytes: 120, version: 7 })
    )

    expect(gfsResourceOpenTarget(resource)).toEqual({
      kind: 'preview',
      preview: { gfsUri: URI, kind: 'markdown', name: 'README.md', bytes: 120, version: 7 },
    })
  })

  it('opens an image as an image preview with its mime type', async () => {
    const resource = await produce(resolvedFile(RID, 'diagram.PNG', { gfsUri: URI, bytes: 9 }))

    expect(gfsResourceOpenTarget(resource)).toEqual({
      kind: 'preview',
      preview: {
        gfsUri: URI,
        kind: 'image',
        mimeType: 'image/png',
        name: 'diagram.PNG',
        bytes: 9,
        version: 1,
      },
    })
  })

  it('opens a non-previewable file in the files browser at its resolved uri', async () => {
    const resource = await produce(resolvedFile(RID, 'report.pdf', { gfsUri: URI }))

    expect(gfsResourceOpenTarget(resource)).toEqual({ kind: 'files', gfsUri: URI })
  })

  it('treats a resource without a byte count as zero bytes', async () => {
    const { bytes: _omitted, ...withoutBytes } = resolvedFile(RID, 'demo.mp4', { gfsUri: URI })
    const resource = await produce(withoutBytes)

    expect(gfsResourceOpenTarget(resource)).toEqual({
      kind: 'preview',
      preview: {
        gfsUri: URI,
        kind: 'video',
        mimeType: 'video/mp4',
        name: 'demo.mp4',
        bytes: 0,
        version: 1,
      },
    })
  })
})

it('the plugin payload carries `bytes: null` when the resolve omits it', async () => {
  const { bytes: _omitted, ...withoutBytes } = resolvedFile(RID, 'demo.mp4', { gfsUri: URI })

  expect((await openGfsResourcePayload(withoutBytes)).bytes).toBeNull()
})
