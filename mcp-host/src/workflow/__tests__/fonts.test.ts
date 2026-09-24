/**
 * Text that is asked for must be drawable, and text that is not must be
 * rewritten rather than emitted as a wrong glyph or a blank box, whatever fonts
 * the image carries.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  CHART_FONT_FAMILY,
  CHART_FONT_STACK,
  PDF_FONT_FAMILY,
  PDF_MONO_FAMILY,
  asciiStandIn,
  canRender,
  ensureFontsReady,
  pdfFontDescriptors,
  pdfGlyphSource,
  sanitizeForFont,
} from '../fonts'
import { INTERNAL_TOOLS } from '../internalTools'
import { readPdf } from './support/pdfText'

describe('font provisioning', () => {
  it('registers a face without relying on the base image', () => {
    ensureFontsReady()
    expect(CHART_FONT_STACK).toContain(CHART_FONT_FAMILY)
    // Latin must be drawable on any image.
    expect(canRender('A')).toBe(true)
    expect(canRender('é')).toBe(true)
  })

  it('supplies pdfmake with embedded faces rather than a standard-14 name', () => {
    const descriptors = pdfFontDescriptors()
    const faces = descriptors[PDF_FONT_FAMILY]
    expect(faces).toBeDefined()
    for (const key of ['normal', 'bold', 'italics', 'bolditalics'] as const) {
      const face = faces[key]
      // An embedded buffer, a path to a real face, or a face inside a
      // collection — never the name of a core PDF font, which covers Latin-1 only.
      const file = Array.isArray(face) ? face[0] : face
      expect(Buffer.isBuffer(file) || (typeof file === 'string' && file.includes('/'))).toBe(true)
    }
  })

  it('registers a monospaced family for code', () => {
    const faces = pdfFontDescriptors()[PDF_MONO_FAMILY]
    expect(faces).toBeDefined()
    expect(Buffer.isBuffer(faces.normal) || typeof faces.normal === 'string').toBe(true)
  })

  it('never hands pdfmake a bare TrueType Collection path', () => {
    // pdfkit subsets a single face and cannot open a `.ttc` from a path alone;
    // doing so fails the whole document with "createSubset is not a function".
    // A collection is only usable as [path, postScriptName], which is how CJK
    // reaches a PDF at all, since Debian packages Noto CJK only that way.
    for (const faces of Object.values(pdfFontDescriptors())) {
      for (const face of Object.values(faces)) {
        if (typeof face === 'string') {
          expect(face.toLowerCase().endsWith('.ttc'), `${face} is a bare collection`).toBe(false)
        }
        if (Array.isArray(face)) {
          expect(face).toHaveLength(2)
          expect(typeof face[0]).toBe('string')
          // The face name is what pdfkit looks the glyph source up by.
          expect(typeof face[1]).toBe('string')
          expect(face[1].length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('glyph coverage', () => {
  it('reports ASCII as always renderable without measuring', () => {
    expect(canRender('x')).toBe(true)
    expect(canRender('9')).toBe(true)
  })
})

describe('asciiStandIn', () => {
  it('keeps the spaces that do not break a line from breaking one', () => {
    expect(asciiStandIn('\u202F')).toBe('\u00A0')
    expect(asciiStandIn('\u2007')).toBe('\u00A0')
    expect(asciiStandIn('\u2009')).toBe(' ')
  })
})

describe('sanitizeForFont', () => {
  it('leaves pure ASCII untouched', () => {
    const text = 'Revenue grew 12% in Q3 (USD 1,200).'
    expect(sanitizeForFont(text)).toBe(text)
  })

  it('never leaves a character that cannot be drawn', () => {
    const risky = '→ ✓ ✗ ≈ ≥ ≤ • — … α привет 中文 🎉'
    for (const ch of sanitizeForFont(risky)) expect(canRender(ch)).toBe(true)
  })

  it('substitutes rather than drops when a stand-in exists', () => {
    // Whatever the image's fonts cover, an arrow must survive as an arrow or as
    // its ASCII form — it must never vanish, which would change the meaning.
    const out = sanitizeForFont('cost A → B')
    expect(out.startsWith('cost A ')).toBe(true)
    expect(out === 'cost A → B' || out === 'cost A -> B').toBe(true)
  })

  it('drops zero-width characters that would confuse measurement', () => {
    expect(sanitizeForFont('a\u200Bb\uFEFFc')).toBe('abc')
  })

  it('handles an empty string', () => {
    expect(sanitizeForFont('')).toBe('')
  })
})

describe('coverage detection distinguishes a glyph from the missing-glyph box', () => {
  it('does not rewrite a character the chart fonts can draw', () => {
    // A glyph that darkens as many pixels as the missing-glyph box must still count as drawable.
    for (const ch of ['≥', '≤', '±', '×', '÷', 'α', 'я', 'é', '€']) {
      if (canRender(ch)) {
        expect(sanitizeForFont(ch), `${ch} was rewritten despite being drawable`).toBe(ch)
      }
    }
  })

  it('agrees with itself across repeated calls', () => {
    // The answer is cached per codepoint; a probe that is not deterministic
    // would make the first call decide every later one.
    for (const ch of ['→', '✓', '中', '≥']) {
      const first = canRender(ch)
      expect(canRender(ch)).toBe(first)
      expect(canRender(ch)).toBe(first)
    }
  })
})

describe('per-character fallback for PDFs', () => {
  const glyphs = pdfGlyphSource()

  it('sets plain text in the body face and code in the code face', () => {
    expect(glyphs.familyFor('A'.codePointAt(0)!, PDF_FONT_FAMILY)).toBe(PDF_FONT_FAMILY)
    expect(glyphs.familyFor('A'.codePointAt(0)!, PDF_MONO_FAMILY)).toBe(PDF_MONO_FAMILY)
  })

  it('keeps an accented letter in the code face, even when that is the standard Courier', () => {
    expect(glyphs.familyFor('\u00E9'.codePointAt(0)!, PDF_MONO_FAMILY)).toBe(PDF_MONO_FAMILY)
  })

  it('reports no face for a private-use character', () => {
    expect(glyphs.familyFor(0xe000, PDF_FONT_FAMILY)).toBeUndefined()
  })

  it('falls back only to faces fontkit shapes without hanging', () => {
    // Meetei Mayek, Kaithi, Sinhala and Balinese go through fontkit's Universal
    // Shaping Engine, which loops or throws on some of their sequences; the
    // images install faces for all of them.
    for (const cp of [0xabc0, 0xabed, 0x1108d, 0x0dbd, 0x0dda, 0x1b13]) {
      const family = glyphs.familyFor(cp, PDF_FONT_FAMILY)
      expect(family === undefined || !/Meetei|Kaithi|Sinhala|Balinese/.test(family), family).toBe(
        true
      )
    }
  })

  it('names every family it hands out in the printer descriptors', () => {
    const family = glyphs.familyFor(0x0645, PDF_FONT_FAMILY)
    const descriptors = glyphs.descriptors(family ? [family] : [])
    expect(descriptors[PDF_FONT_FAMILY]).toBeDefined()
    expect(descriptors[PDF_MONO_FAMILY]).toBeDefined()
    if (family) expect(descriptors[family]).toBeDefined()
  })

  it('takes Han characters in the variant of the document language from a CJK collection', async () => {
    const family = glyphs.familyFor(0x76f4, PDF_FONT_FAMILY)
    const faces = family ? glyphs.descriptors([family])[family] : undefined
    const face = faces?.normal
    // Only an image with the Noto CJK collection can run this.
    if (!Array.isArray(face) || !/CJKsc-/.test(face[1])) return
    expect((glyphs.descriptors([family!], 'ja')[family!].normal as string[])[1]).toMatch(/CJKjp-/)
    expect((glyphs.descriptors([family!], 'ko')[family!].normal as string[])[1]).toMatch(/CJKkr-/)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-cjk-'))
    try {
      const pdf = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pdf')!
      const r = await pdf.execute({ filename: 'ja.pdf', body: '直角の骨は誤写です。ひらがな' }, dir)
      expect(r.success, r.error).toBe(true)
      const raw = fs.readFileSync(r.artifact!.path).toString('latin1')
      expect(raw).toMatch(/NotoSansCJKjp-/)
      expect(raw).not.toMatch(/NotoSansCJKsc-/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('measures the body face at the size asked for', () => {
    const at10 = glyphs.measure('Revenue', PDF_FONT_FAMILY, 10, false)
    expect(at10).toBeGreaterThan(0)
    expect(glyphs.measure('Revenue', PDF_FONT_FAMILY, 20, false)).toBeCloseTo(at10 * 2, 1)
  })

  it('writes status emoji as text', () => {
    expect(asciiStandIn('\u2705')).toBe('OK')
    expect(asciiStandIn('\u274C')).toBe('X')
    expect(asciiStandIn('\u{1F7E2}')).toBe('(green)')
  })
})

// Only images that ship Arabic and Hebrew faces can run this; elsewhere the
// typesetter tests cover the ordering with made-up faces.
const hasRtlFaces =
  pdfGlyphSource().familyFor(0x0645, PDF_FONT_FAMILY) !== undefined &&
  pdfGlyphSource().familyFor(0x05e9, PDF_FONT_FAMILY) !== undefined

describe.skipIf(!hasRtlFaces)('Arabic and Hebrew in a PDF', () => {
  it('embeds faces for both scripts and leaves nothing out', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-rtl-'))
    try {
      const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pdf')!
      const result = await tool.execute(
        {
          filename: 'rtl.pdf',
          title: '\u062A\u0642\u0631\u064A\u0631',
          body: '\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645\n\n\u05E9\u05DC\u05D5\u05DD 100',
        },
        outputDir
      )
      expect(result.success).toBe(true)
      expect(result.content).not.toMatch(/left out/)
      const pages = await readPdf(path.join(outputDir, 'rtl.pdf'))
      const fonts = new Set(pages[0].fragments.map(f => f.font))
      expect([...fonts].some(f => /Arabic/i.test(f))).toBe(true)
      expect([...fonts].some(f => /Hebrew/i.test(f))).toBe(true)
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
