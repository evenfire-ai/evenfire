/** The PDF generator (clerum__generate_pdf): markdown body, tables and images typeset with pdfmake. */
import * as path from 'path'
import { type Content, type ContentText, type TDocumentDefinitions } from 'pdfmake/interfaces'
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
  writeArtifact,
} from './artifactOutput'
import {
  EMPTY_DOCUMENT_NOTE,
  PDF_FOOTER_SIZE,
  RUNNING_LINE_CHARS,
  footerLines,
  longestFitting,
  printedBranding,
} from './documentChrome'
import {
  MAX_DECODE_PIXELS,
  fitImageSize,
  imageDataUrl,
  loadEmbeddableImage,
} from './embeddedImages'
import { PDF_FONT_FAMILY, pdfGlyphSource } from './fonts'
import { htmlToPlainText } from './inlineMarkup'
import { choose } from './ownEntry'
import { PDF_CONTENT_WIDTH, type PdfBodyEnv, bodyToContent, buildTableNode } from './pdfBody'
import {
  PDF_TOP_MARGIN,
  RUNNING_STYLE,
  applyPageOrientation,
  headingKeeper,
  isBlankLine,
} from './pdfPagination'
import { PDF_PALETTES, statusColorFromPalette } from './pdfPalette'
import { BODY_FONT_SIZE, MIN_BOTTOM_MARGIN, PORTRAIT, type UnitMeasure } from './pdfTables'
import { LINE_FILL, PdfTypesetter } from './pdfText'
import { headerText, normalizeTableRows } from './tableRows'
import { documentEastAsianScript } from './textScript'
import { type InternalToolResult } from './types'

const PdfPrinter = require('pdfmake')

/** Keeps a tall image from taking a whole page on its own. */
const PDF_MAX_IMAGE_HEIGHT = 330

/** Vertical margin around an embedded image, above and below. */
const PDF_IMAGE_MARGIN = 10

/** The cover logo's box: its usual width, and a height a tall logo cannot exceed. */
const PDF_LOGO_BOX = { width: 120, height: 80 }

const PDF_LINE_HEIGHT = 1.3

interface PdfBranding {
  logoPath?: string
  companyName?: string
  footerText?: string
}

interface PdfImageRef {
  path: string
  width?: number
  height?: number
  alignment?: 'left' | 'center' | 'right'
}

interface PdfTableSpec {
  headers: unknown[]
  rows: unknown
  widths?: unknown
  layout?: 'striped' | 'minimal' | 'grid'
}

const IMAGE_ALIGNMENTS = new Set(['left', 'center', 'right'])

/**
 * `text` cut at a word, with an ellipsis, to one line of the running header,
 * where pdfmake drops whatever does not fit without a mark.
 */
function runningLine(text: string, width: number, measure: UnitMeasure): string {
  const fits = (s: string) => measure(s, false) * PDF_FOOTER_SIZE <= width * LINE_FILL
  if (text.length <= RUNNING_LINE_CHARS && fits(text)) return text
  // Far more than a line holds, so a huge title is never measured whole.
  const chars = Array.from(text.slice(0, RUNNING_LINE_CHARS))
  let kept = chars
    .slice(
      0,
      longestFitting(chars, s => fits(`${s.trimEnd()}…`))
    )
    .join('')
  const space = kept.lastIndexOf(' ')
  if (space > kept.length * 0.6) kept = kept.slice(0, space)
  return `${kept.trimEnd()}…`
}

export async function runGeneratePdf(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  try {
    const filename = outputFilename(args.filename, 'pdf', 'output')
    const warnings: string[] = []
    const glyphs = pdfGlyphSource()
    // Titles take no formatting, so HTML in them is read as text.
    const title = args.title ? htmlToPlainText(String(args.title)) || undefined : undefined
    const body = String(args.body ?? '')
    const palette =
      PDF_PALETTES[choose(args.palette, Object.keys(PDF_PALETTES), 'default', 'palette', warnings)]
    const branding: PdfBranding = printedBranding(args.branding)
    const imageRefs = Array.isArray(args.images) ? args.images : []
    const tables = (Array.isArray(args.tables) ? args.tables : []) as PdfTableSpec[]
    const coverPage = Boolean(args.coverPage)
    const headline = args.headline ? htmlToPlainText(String(args.headline)) || undefined : undefined
    const statusBand = statusColorFromPalette(palette, args.statusColor as string | undefined)

    // A path outside the output folder still fails the call, but says what to pass instead.
    const loadImage = (ref: unknown, label: string) => {
      try {
        const image = loadEmbeddableImage(ref, outputDir, warnings, label)
        // pdfkit decodes every pixel of a PNG to embed it, so a small file of a
        // huge image takes gigabytes; the other formats embed the bytes as they are.
        if (image && image.pixels.width * image.pixels.height > MAX_DECODE_PIXELS) {
          warnings.push(
            `${label} '${path.basename(image.path)}' is ${image.pixels.width} x ${image.pixels.height} ` +
              `pixels, more than the ${MAX_DECODE_PIXELS / 1e6} million a PDF image may have, so it ` +
              'was left out. Scale it down first.'
          )
          return undefined
        }
        return image
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `${label}: ${reason}. Images are read from the output folder; pass the file name ` +
            "clerum__generate_chart returned, such as 'sales.png'."
        )
      }
    }

    // The footer sets the bottom margin, and with it the room images and tables have.
    const pageNumberWidth = 40
    // Measured at 100pt and scaled down: at 1pt the canvas rounds widths to hundredths.
    const measure: UnitMeasure = (text, bold) =>
      glyphs.measure(text, PDF_FONT_FAMILY, 100, bold) / 100
    const footer = branding.footerText
      ? footerLines(branding.footerText, PDF_CONTENT_WIDTH - pageNumberWidth, measure, warnings)
      : []
    const bottomMargin = Math.max(MIN_BOTTOM_MARGIN, 34 + footer.length * PDF_FOOTER_SIZE * 1.3)
    const contentHeight = PORTRAIT.height - (bottomMargin - MIN_BOTTOM_MARGIN)

    let imagesRequested = 0
    let imagesPlaced = 0
    const placeImage = (
      ref: unknown,
      label: string,
      sizing: { width?: unknown; height?: unknown; alignment?: unknown } = {}
    ): Content | undefined => {
      imagesRequested++
      const src = typeof ref === 'string' ? ref : undefined
      if (src && /^(https?:|data:)/i.test(src)) {
        warnings.push(
          `${label} is a web address or inline data, which is not downloaded; save the image to the ` +
            'output folder first (clerum__generate_chart does) and pass its file name.'
        )
        return undefined
      }
      const image = loadImage(ref, label)
      if (!image) return undefined
      const requested = {
        ...(typeof sizing.width === 'number' ? { width: sizing.width } : {}),
        ...(typeof sizing.height === 'number' ? { height: sizing.height } : {}),
      }
      const sized = requested.width !== undefined || requested.height !== undefined
      const box = fitImageSize(
        image,
        {
          width: PDF_CONTENT_WIDTH,
          // An image given a size may take the page, less its own margins.
          height: sized ? contentHeight - 2 * PDF_IMAGE_MARGIN : PDF_MAX_IMAGE_HEIGHT,
        },
        requested
      )
      imagesPlaced++
      return {
        image: imageDataUrl(image),
        width: box.width,
        height: box.height,
        alignment: IMAGE_ALIGNMENTS.has(String(sizing.alignment)) ? sizing.alignment : 'center',
        margin: [0, PDF_IMAGE_MARGIN, 0, PDF_IMAGE_MARGIN],
      } as Content
    }

    const env: PdfBodyEnv = {
      warnings,
      measure,
      image: src => placeImage(src, `The body image '${src}'`),
      landscape: new Set(),
      tableCount: 0,
      tablesBuilt: 0,
      bottomMargin,
    }

    const content: Content[] = []

    // Cover page.
    if (coverPage) {
      const coverTitle = title ?? headline ?? filename.replace(/\.pdf$/, '')
      if (!title) {
        warnings.push(
          `coverPage was set without a title, so the cover shows '${coverTitle}'; pass title to choose it.`
        )
      }
      if (statusBand) {
        content.push({
          canvas: [
            {
              type: 'rect',
              x: 0,
              y: 0,
              w: PDF_CONTENT_WIDTH,
              h: 6,
              color: statusBand,
            },
          ],
          margin: [0, 0, 0, 24],
        })
      }
      if (branding.logoPath) {
        const logo = loadImage(branding.logoPath, 'branding.logoPath')
        if (logo) {
          const box = fitImageSize(logo, PDF_LOGO_BOX, { width: PDF_LOGO_BOX.width })
          content.push({
            image: imageDataUrl(logo),
            width: box.width,
            height: box.height,
            margin: [0, 0, 0, 12],
          })
        }
      }
      content.push({
        text: coverTitle,
        style: 'cover',
        color: palette.primary,
        margin: [0, 80, 0, 12],
      })
      if (headline && title) {
        content.push({
          text: headline,
          style: 'lead',
          color: palette.muted,
          margin: [0, 0, 0, 20],
        })
      }
      content.push({
        text: new Date().toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
        color: palette.muted,
        fontSize: 11,
        margin: [0, 0, 0, 0],
        pageBreak: 'after',
      })
    } else {
      if (title) {
        content.push({
          text: title,
          style: 'docTitle',
          color: palette.primary,
          margin: [0, 0, 0, 12],
        })
      }
      const coverOnly = [
        headline ? 'headline' : '',
        args.statusColor ? 'statusColor' : '',
        branding.logoPath ? 'branding.logoPath' : '',
      ].filter(Boolean)
      if (coverOnly.length > 0) {
        const many = coverOnly.length > 1
        warnings.push(
          `${coverOnly.join(', ')} ${many ? 'are' : 'is'} only drawn on the cover page, so ` +
            `${many ? 'they were' : 'it was'} left out; pass coverPage: true to show ${many ? 'them' : 'it'}.`
        )
      }
    }

    // Body.
    content.push(...bodyToContent(body, palette, env))

    // Tables (after body).
    tables.forEach((t, index) => {
      const label = `tables[${index}]`
      if (!t || !Array.isArray(t.headers) || t.headers.length === 0) {
        warnings.push(`${label} has no headers and was left out; pass headers: ['Column', ...].`)
        return
      }
      const rows = normalizeTableRows(t.rows, t.headers, label, warnings).map(row =>
        row.map(cell => (cell === null || cell === undefined ? '' : String(cell)))
      )
      content.push(
        buildTableNode(
          {
            headers: t.headers.map(headerText),
            rows,
            layout: t.layout,
            widths: t.widths,
            label,
            rowLabel: row => `${label}.rows[${row}]`,
          },
          palette,
          env,
          image =>
            warnings.push(
              `${label} names the image '${image.src}' in a cell, which a table cannot hold; pass it in images instead.`
            )
        )
      )
    })

    // Images (charts, logos) at the end of the body.
    imageRefs.forEach((ref, index) => {
      const sizing = ref && typeof ref === 'object' ? (ref as PdfImageRef) : {}
      const block = placeImage(ref, `images[${index}]`, sizing)
      if (block) content.push(block)
    })

    if (imagesRequested > 0 && imagesPlaced === 0 && content.every(isBlankLine)) {
      return {
        success: false,
        error: `No PDF was written: none of the images could be embedded. ${warnings.join(' ')}`,
      }
    }
    if (content.every(isBlankLine)) warnings.push(EMPTY_DOCUMENT_NOTE)

    const pageOrientation = applyPageOrientation(content, env.landscape)

    const styles: Record<string, Record<string, unknown>> = {
      cover: { fontSize: 36, bold: true },
      lead: { fontSize: 16, italics: true },
      docTitle: { fontSize: 22, bold: true },
      h1: { fontSize: 18, bold: true, color: palette.primary },
      h2: { fontSize: 14, bold: true, color: palette.primary },
      h3: { fontSize: 12, bold: true, color: palette.muted },
      [RUNNING_STYLE]: { fontSize: PDF_FOOTER_SIZE, color: palette.muted },
    }
    const typesetter = new PdfTypesetter(glyphs, styles)
    const base = {
      width: PDF_CONTENT_WIDTH,
      font: PDF_FONT_FAMILY,
      fontSize: BODY_FONT_SIZE,
      bold: false,
      lineHeight: PDF_LINE_HEIGHT,
    }
    typesetter.typeset(content, base)

    // The running header and footer are laid out on every page, so their text
    // is typeset once here and copied into each page's nodes.
    const running = (text: string | undefined, width: number): ContentText => {
      const node: ContentText = { text: text ?? '', style: RUNNING_STYLE }
      typesetter.typeset(node, { ...base, width })
      return node
    }
    // The title is printed whole on the first page; the running header takes one line of it.
    const half = PDF_CONTENT_WIDTH / 2
    const company = branding.companyName && runningLine(branding.companyName, half, measure)
    if (company && company !== branding.companyName) {
      warnings.push('branding.companyName is longer than the page header and was shortened there.')
    }
    const companyNode = running(company || undefined, half)
    const headerTitleNode = running(title && runningLine(title, half, measure), half)
    const footerNode = running(footer.join('\n'), PDF_CONTENT_WIDTH - pageNumberWidth)
    typesetter.settleShaping()
    const copy = (node: ContentText): ContentText => JSON.parse(JSON.stringify(node))

    const docDef: TDocumentDefinitions = {
      info: {
        title: title ?? 'Report',
        ...(branding.companyName ? { creator: branding.companyName } : {}),
      },
      pageSize: 'A4',
      pageOrientation,
      pageMargins: [40, PDF_TOP_MARGIN, 40, bottomMargin],
      defaultStyle: {
        font: PDF_FONT_FAMILY,
        fontSize: BODY_FONT_SIZE,
        color: palette.text,
        lineHeight: PDF_LINE_HEIGHT,
      },
      styles,
      pageBreakBefore: headingKeeper(content) as unknown as TDocumentDefinitions['pageBreakBefore'],
      header: (currentPage: number) =>
        currentPage === 1 && coverPage
          ? null
          : {
              columns: [copy(companyNode), { ...copy(headerTitleNode), alignment: 'right' }],
              style: RUNNING_STYLE,
              margin: [40, 24, 40, 0],
            },
      footer: (currentPage: number, pageCount: number) => ({
        columns: [
          copy(footerNode),
          {
            text: `${currentPage} / ${pageCount}`,
            style: RUNNING_STYLE,
            alignment: 'right',
            width: pageNumberWidth,
          },
        ],
        style: RUNNING_STYLE,
        margin: [40, 0, 40, 24],
      }),
      content,
    }

    // Han characters take the glyph forms of the document's language.
    const language = documentEastAsianScript(
      [
        title,
        body,
        branding.companyName,
        branding.footerText,
        ...tables.map(t => JSON.stringify([t.headers, t.rows])),
      ]
        .filter(text => text !== undefined && text !== null)
        .map(String)
        .join('\n')
    )?.lang
    const printer = new PdfPrinter(glyphs.descriptors(typesetter.families, language))
    const pdfDoc = printer.createPdfKitDocument(docDef)

    const pdfBuffer: Buffer = await new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      pdfDoc.on('data', (c: Buffer) => chunks.push(c))
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)))
      pdfDoc.on('error', reject)
      pdfDoc.end()
    })

    ensureDir(outputDir)
    const target = claimOutputFile(outputDir, filename)
    enforceQuota(outputDir, pdfBuffer.byteLength, replacedBytes(target))
    writeArtifact(target, pdfBuffer)

    return artifactResult(target, 'pdf', { warnings: [...warnings, ...typesetter.warnings()] })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
