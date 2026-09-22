import { describe, expect, it } from 'vitest'
import { isGfsPreviewFile, resolveGfsPreview } from '../gfsPreview'

const resource = (name: string) => ({ name, gfsUri: `gfs://main/${name}`, bytes: 10 })

describe('gfsPreview — resolveGfsPreview', () => {
  it('detects an image and carries its mimeType (case-insensitive extension)', () => {
    expect(resolveGfsPreview(resource('diagram.PNG'))).toEqual({
      gfsUri: 'gfs://main/diagram.PNG',
      kind: 'image',
      mimeType: 'image/png',
      name: 'diagram.PNG',
      bytes: 10,
    })
  })

  it('detects markdown with no mimeType field', () => {
    const preview = resolveGfsPreview(resource('README.md'))
    expect(preview).toEqual({
      gfsUri: 'gfs://main/README.md',
      kind: 'markdown',
      name: 'README.md',
      bytes: 10,
    })
    expect(Object.prototype.hasOwnProperty.call(preview, 'mimeType')).toBe(false)
  })

  it('detects a video and carries its mimeType', () => {
    expect(resolveGfsPreview(resource('demo.mp4'))).toEqual({
      gfsUri: 'gfs://main/demo.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      name: 'demo.mp4',
      bytes: 10,
    })
  })

  it('treats .txt as a (markdown-kind) previewable text file', () => {
    expect(resolveGfsPreview(resource('notes.txt'))?.kind).toBe('markdown')
  })

  it('returns null for a non-previewable file (caller downloads instead)', () => {
    expect(resolveGfsPreview(resource('archive.zip'))).toBeNull()
    expect(resolveGfsPreview(resource('no-extension'))).toBeNull()
  })
})

describe('gfsPreview — isGfsPreviewFile', () => {
  it('mirrors resolveGfsPreview for the extension-only gate', () => {
    expect(isGfsPreviewFile('diagram.png')).toBe(true)
    expect(isGfsPreviewFile('README.md')).toBe(true)
    expect(isGfsPreviewFile('demo.mp4')).toBe(true)
    expect(isGfsPreviewFile('archive.zip')).toBe(false)
    expect(isGfsPreviewFile('no-extension')).toBe(false)
  })
})
