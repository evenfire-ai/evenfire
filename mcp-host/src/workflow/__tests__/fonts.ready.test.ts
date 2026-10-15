/**
 * Font registration on an image whose bundled faces cannot be read: the failure
 * is reported once, and the system faces are still registered for charts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalFonts } from '@napi-rs/canvas'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureFontsReady', () => {
  it('reports bundled faces it cannot register and still registers the system faces', async () => {
    vi.resetModules()
    const { logger } = await import('../../logger')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    vi.spyOn(GlobalFonts, 'register').mockImplementationOnce(() => {
      throw new Error('unreadable face')
    })
    const system = vi.spyOn(GlobalFonts, 'registerFromPath')
    const fonts = await import('../fonts')

    fonts.ensureFontsReady()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'unreadable face' }),
      'Bundled Roboto faces could not be loaded'
    )
    // The system faces (macOS /System/Library/Fonts, Linux /usr/share/fonts) still register.
    expect(system).toHaveBeenCalled()

    fonts.ensureFontsReady()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('reports a bundled face the renderer refuses without throwing', async () => {
    vi.resetModules()
    const { logger } = await import('../../logger')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    // register answers null, not an error, for a face it cannot use.
    vi.spyOn(GlobalFonts, 'register').mockImplementationOnce(() => null)
    const fonts = await import('../fonts')

    fonts.ensureFontsReady()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('regular') }),
      'Bundled Roboto faces could not be loaded'
    )
  })
})
