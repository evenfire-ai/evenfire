import { describe, expect, it } from 'vitest'
import { markPluginGfsPreviewUnavailable } from '../gfsEntityChangeState'

describe('plugin preview unavailable reconciliation', () => {
  it('increments the reload identity once and preserves it on repeated invalidation', () => {
    const available = {
      gfsUri: 'gfs://main/image',
      name: 'diagram.png',
      bytes: 32,
      mimeType: 'image/png',
      version: 8,
      reloadVersion: 4,
    }

    const unavailable = markPluginGfsPreviewUnavailable(available, available.gfsUri)
    expect(unavailable).toMatchObject({ unavailable: true, reloadVersion: 5 })
    expect(markPluginGfsPreviewUnavailable(unavailable, available.gfsUri)).toBe(unavailable)
  })

  it('does not alter an unrelated or absent plugin preview', () => {
    const current = {
      gfsUri: 'gfs://main/visible.png',
      name: 'visible.png',
      bytes: 8,
      mimeType: 'image/png',
      reloadVersion: 1,
    }

    expect(markPluginGfsPreviewUnavailable(current, 'gfs://main/other.png')).toBe(current)
    expect(markPluginGfsPreviewUnavailable(null, 'gfs://main/visible.png')).toBeNull()
  })
})
