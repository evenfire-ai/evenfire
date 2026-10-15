/**
 * Font registration on an image whose faces cannot be read or are refused: the
 * failure is reported, and the faces that remain are still used.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalFonts } from '@napi-rs/canvas'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A letter of each script the PDF warns about. */
const LETTER: Record<string, number> = {
  CJK: 0x4e2d,
  Arabic: 0x0627,
  Hebrew: 0x05d0,
  Devanagari: 0x0915,
  Bengali: 0x0995,
  Gurmukhi: 0x0a15,
  Gujarati: 0x0a95,
  Oriya: 0x0b15,
  Tamil: 0x0b95,
  Telugu: 0x0c15,
  Kannada: 0x0c95,
  Malayalam: 0x0d15,
  Thai: 0x0e01,
  Lao: 0x0e81,
  Khmer: 0x1780,
  Myanmar: 0x1000,
  Armenian: 0x0531,
  Georgian: 0x10d0,
  Ethiopic: 0x1200,
}

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

  it('reports a bundled face the renderer refuses without throwing, and still tries the other', async () => {
    vi.resetModules()
    const { logger } = await import('../../logger')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    // register answers null, not an error, for a face it cannot use.
    const register = vi.spyOn(GlobalFonts, 'register').mockImplementationOnce(() => null)
    const fonts = await import('../fonts')

    fonts.ensureFontsReady()
    expect(register).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'the renderer refused the regular face' }),
      'Bundled Roboto faces could not be loaded'
    )
  })

  it('reports a system face the renderer refuses without throwing', async () => {
    vi.resetModules()
    const { logger } = await import('../../logger')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const system = vi.spyOn(GlobalFonts, 'registerFromPath').mockImplementation(() => null)
    const fonts = await import('../fonts')

    fonts.ensureFontsReady()
    expect(system).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      { file: system.mock.calls[0][0], err: 'the renderer refused the face' },
      'Font face could not be registered'
    )
  })

  it('falls back to the bundled face when the renderer refuses the PDF body face', async () => {
    vi.resetModules()
    const { logger } = await import('../../logger')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const fonts = await import('../fonts')
    fonts.ensureFontsReady()
    const register = GlobalFonts.registerFromPath.bind(GlobalFonts)
    vi.spyOn(GlobalFonts, 'registerFromPath').mockImplementation((file, alias) =>
      alias === fonts.PDF_FONT_FAMILY ? null : register(file, alias)
    )

    const body = fonts.pdfFontDescriptors()[fonts.PDF_FONT_FAMILY]
    expect(Buffer.isBuffer(body.normal)).toBe(true)
    const refused = warn.mock.calls.find(
      ([, msg]) => msg === 'PDF body face could not be registered; the bundled Roboto face is used'
    )
    if (!refused) {
      // Only an image with a body face of its own registers one; CI installs Noto and DejaVu.
      expect(process.env.CI, 'CI installs the body faces').not.toBe('true')
      return
    }
    expect(refused[0]).toEqual(expect.objectContaining({ err: 'the renderer refused the face' }))
  })

  it('names in its warning only scripts no face draws in a PDF', async () => {
    vi.resetModules()
    const { logger } = await import('../../logger')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const fonts = await import('../fonts')
    const glyphs = fonts.pdfGlyphSource()
    glyphs.isFallback('none')

    const call = warn.mock.calls.find(
      ([, msg]) =>
        msg === 'No installed face draws these scripts, so PDFs leave their characters out'
    )
    const named: string[] = (call?.[0] as { scripts?: string[] } | undefined)?.scripts ?? []
    for (const script of named) {
      expect(LETTER[script], script).toBeDefined()
      expect(glyphs.familyFor(LETTER[script], fonts.PDF_FONT_FAMILY), script).toBeUndefined()
    }
  })
})
