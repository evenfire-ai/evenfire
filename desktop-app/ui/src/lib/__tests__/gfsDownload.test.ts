// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveGfsFileToDisk } from '../gfsDownload'

describe('saveGfsFileToDisk', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records the save as an open through the renderer download action', async () => {
    const download = vi.fn(async () => ({ bytes: new ArrayBuffer(3) }))
    Object.defineProperty(window, 'clerum', { configurable: true, value: { gfs: { download } } })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-save'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    await saveGfsFileToDisk('gfs://main/file-1', 'file.txt')

    expect(download).toHaveBeenCalledWith('gfs://main/file-1', { recordOpen: true })
  })
})
