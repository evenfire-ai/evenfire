/**
 * Font registration on an image whose faces cannot be read or are refused: the
 * failure is reported, and the faces that remain are still used.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalFonts } from '@napi-rs/canvas'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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

describe('a failed bundled-font load', () => {
  const MINUTE = 60_000

  async function freshFonts() {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    const { logger } = await import('../../logger')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const system = vi.spyOn(GlobalFonts, 'registerFromPath')
    return { error, info, system, fonts: await import('../fonts') }
  }

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms)

  it('loads the bundled faces once when nothing fails', async () => {
    const register = vi.spyOn(GlobalFonts, 'register')
    const { error, fonts } = await freshFonts()

    fonts.ensureFontsReady()
    later(60 * MINUTE)
    fonts.ensureFontsReady()
    expect(register).toHaveBeenCalledTimes(2)
    expect(error).not.toHaveBeenCalled()
  })

  it('tries again after a passing failure, registers only the missing face, and the system faces once', async () => {
    const register = vi.spyOn(GlobalFonts, 'register').mockImplementationOnce(() => null)
    const { error, info, system, fonts } = await freshFonts()

    fonts.ensureFontsReady()
    expect(error).toHaveBeenCalledWith(
      { err: 'the renderer refused the regular face', attempts: 1, retryInMs: 30_000 },
      'Bundled Roboto faces could not be loaded'
    )
    const systemCalls = system.mock.calls.length
    expect(register).toHaveBeenCalledTimes(2)

    // Not again before the delay.
    later(10_000)
    fonts.ensureFontsReady()
    expect(register).toHaveBeenCalledTimes(2)

    later(20_000)
    fonts.ensureFontsReady()
    // Only the regular face, which was refused; the bold one is already in.
    expect(register).toHaveBeenCalledTimes(3)
    expect(register.mock.calls[2][1]).toBe(fonts.CHART_FONT_FAMILY)
    expect(info).toHaveBeenCalledWith(
      { attempts: 2 },
      'Bundled Roboto faces loaded after a failed try'
    )

    later(60 * MINUTE)
    fonts.ensureFontsReady()
    expect(register).toHaveBeenCalledTimes(3)
    expect(error).toHaveBeenCalledTimes(1)
    expect(system.mock.calls.length).toBe(systemCalls)
  })

  it('stops trying after a persistent failure and keeps drawing with the system faces', async () => {
    const register = vi.spyOn(GlobalFonts, 'register').mockImplementation(() => {
      throw new Error('unreadable face')
    })
    const { error, system, fonts } = await freshFonts()

    fonts.ensureFontsReady()
    const systemCalls = system.mock.calls.length
    expect(systemCalls).toBeGreaterThan(0)
    for (const wait of [30_000, 5 * MINUTE, 30 * MINUTE]) {
      later(wait)
      fonts.ensureFontsReady()
    }
    expect(register).toHaveBeenCalledTimes(4)
    expect(error.mock.calls.map(([fields]) => fields)).toEqual([
      { err: 'unreadable face', attempts: 1, retryInMs: 30_000 },
      { err: 'unreadable face', attempts: 2, retryInMs: 5 * MINUTE },
      { err: 'unreadable face', attempts: 3, retryInMs: 30 * MINUTE },
      { err: 'unreadable face', attempts: 4 },
    ])
    expect(error.mock.calls[3][1]).toBe(
      'Bundled Roboto faces could not be loaded; system faces are used from now on'
    )

    later(24 * 60 * MINUTE)
    fonts.ensureFontsReady()
    expect(register).toHaveBeenCalledTimes(4)
    expect(system.mock.calls.length).toBe(systemCalls)
  })
})
