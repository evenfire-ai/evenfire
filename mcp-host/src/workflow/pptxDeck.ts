/**
 * Builds the .pptx for clerum__generate_pptx with pptxgenjs.
 *
 * Coordinates are inches. Arguments are read by pptxInput (and pptxTemplates),
 * then every slide is laid out from measured text before anything is drawn:
 * lists and tables that do not fit continue on further slides, titles and
 * values shrink to fit their boxes, and pictures keep their proportions.
 */
import { documentEastAsianScript } from './docxScript'
import { own } from './ownEntry'
import { type DrawContext, hex } from './pptxDraw'
import {
  PptxInputError,
  type PptxSlide,
  type ReadContext,
  isRecord,
  readPicture,
  readSlides,
  readText,
} from './pptxInput'
import { frameFor, planSlide } from './pptxLayout'
import { withOnePropertiesPerParagraph } from './pptxPackage'
import { drawFooter, drawSlide } from './pptxRender'
import { deckText, hanLanguage } from './pptxRuns'
import { type PptxTemplate, buildTemplateSlides } from './pptxTemplates'
import { PPTX_FONT_FACE, TEXT_INSET_X, truncateToLines, wrapLines } from './pptxText'
import { PPTX_ASPECT_RATIOS, PPTX_PALETTES, PPTX_TEMPLATES } from './pptxVocabulary'
import { keepZipTextWhole } from './zipText'

const PptxGenJS = require('pptxgenjs')

function pick<T>(
  table: Record<string, T>,
  value: unknown,
  fallback: string,
  field: string,
  warnings: string[]
): T {
  if (value === undefined || value === null || value === '') return table[fallback]
  const entry = typeof value === 'string' ? own(table, value) : undefined
  if (entry) return entry
  warnings.push(
    `${field} ${JSON.stringify(value)} is not one of ${Object.keys(table).join(', ')}; ` +
      `"${fallback}" was used.`
  )
  return table[fallback]
}

/** The slides `args` describe, from a template's data or from slides[]. */
function readDeck(args: Record<string, unknown>, ctx: ReadContext): PptxSlide[] {
  const template = args.template ?? 'custom'
  if (template === 'custom') {
    if (args.slides === undefined && args.data !== undefined) {
      throw new PptxInputError(
        `data is only read with a template: set template to one of ${PPTX_TEMPLATES.join(', ')}, ` +
          'or send the slides in slides[].'
      )
    }
    if (args.data !== undefined) {
      ctx.warnings.push(
        `data was ignored: it is only read when template is one of ${PPTX_TEMPLATES.join(', ')}.`
      )
    }
    return readSlides(args.slides, ctx)
  }
  if (!(PPTX_TEMPLATES as readonly unknown[]).includes(template)) {
    throw new PptxInputError(
      `template ${JSON.stringify(template)} is not a template. Use one of ` +
        `${PPTX_TEMPLATES.join(', ')} with data, or custom with slides[].`
    )
  }
  const slides = buildTemplateSlides(template as PptxTemplate, args.data, ctx)
  if (args.slides !== undefined) {
    ctx.warnings.push(
      `slides was left out: template "${String(template)}" builds the slides from data. Leave ` +
        'template out to send your own slides.'
    )
  }
  return slides
}

/**
 * Build the deck `args` describe. Returns the file contents and the number of
 * slides; anything repaired or left out is added to `warnings`. Throws
 * PptxInputError, naming the field, for arguments no deck can be built from.
 */
export async function buildPptxDeck(
  args: Record<string, unknown>,
  outputDir: string,
  warnings: string[]
): Promise<{ buffer: Buffer; slides: number }> {
  const ctx: ReadContext = { outputDir, warnings }
  const specs = readDeck(args, ctx)
  const palette = pick(PPTX_PALETTES, args.palette, 'default', 'palette', warnings)
  const aspect = pick(PPTX_ASPECT_RATIOS, args.aspectRatio, 'wide', 'aspectRatio', warnings)
  if (args.branding !== undefined && args.branding !== null && !isRecord(args.branding)) {
    throw new PptxInputError(
      'branding must be an object with companyName, logoPath and footerText.'
    )
  }
  const branding = isRecord(args.branding) ? args.branding : {}
  const companyName = readText(branding.companyName, 'branding.companyName', 200, ctx)
  const footerText = readText(branding.footerText, 'branding.footerText', 200, ctx)
  const logo =
    branding.logoPath !== undefined && branding.logoPath !== null && branding.logoPath !== ''
      ? readPicture(branding.logoPath, 'branding.logoPath', ctx)
      : undefined

  const pptx = new PptxGenJS()
  pptx.layout = aspect.name
  // The family is set on the theme, never on a run: pptxgenjs writes a run's
  // face as its East Asian face too, and Arial has no CJK, so PowerPoint would
  // pick CJK glyphs one by one from fallback fonts. Left to the theme, it uses
  // the face for each run's language tag instead.
  pptx.theme = { headFontFace: PPTX_FONT_FACE, bodyFontFace: PPTX_FONT_FACE }
  // Always assign every metadata field (even when empty). pptxgenjs otherwise
  // fills `dc:subject` / `dc:creator` with its own default strings, which would
  // surface as an unintentional brand mark in the deliverable.
  pptx.title = readText(args.title, 'title', 200, ctx) ?? ''
  pptx.subject = readText(args.subject, 'subject', 200, ctx) ?? ''
  pptx.author = readText(args.author, 'author', 200, ctx) ?? ''
  // pptxgenjs writes the company into docProps/app.xml without escaping it,
  // where an unescaped "&" or "<" makes the whole file unreadable.
  pptx.company = (companyName ?? '').replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!
  )

  const frame = frameFor(aspect.width, aspect.height)
  const planned = specs.flatMap(spec => planSlide(spec, frame, warnings))
  const drawCtx: DrawContext = { frame, palette, pptx, warnings, logo }

  let footer = [companyName, footerText].filter(Boolean).join(' · ') || undefined
  if (footer && wrapLines(footer, 9, frame.width / 2 - TEXT_INSET_X).length > 1) {
    footer = truncateToLines(footer, 9, frame.width / 2 - TEXT_INSET_X, 1)
    warnings.push(
      'branding: the company name and footer text are too long for one footer line and were shortened.'
    )
  }

  const han = documentEastAsianScript(deckText(specs))?.lang
  planned.forEach((plan, i) => {
    const slide = pptx.addSlide()
    if (han) hanLanguage.set(slide, han)
    slide.background = { color: hex(palette.background) }
    drawSlide(slide, plan, drawCtx)
    if (plan.spec.notes && planned[i - 1]?.spec !== plan.spec) slide.addNotes(plan.spec.notes)
    // The cover carries its own date instead of the footer.
    if (plan.spec.layout !== 'cover') drawFooter(slide, footer, i + 1, planned.length, drawCtx)
  })

  // A title shortened on a slide split into parts is reported once, not per part.
  const unique = [...new Set(warnings)]
  warnings.splice(0, warnings.length, ...unique)

  keepZipTextWhole()
  const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
  return { buffer: await withOnePropertiesPerParagraph(buffer), slides: planned.length }
}
