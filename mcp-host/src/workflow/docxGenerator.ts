/** The DOCX generator (clerum__generate_docx): markdown body, tables and images built with docx. */
import {
  AlignmentType,
  Document as DocxDocument,
  Footer as DocxFooter,
  Header as DocxHeader,
  Table as DocxTable,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  TabStopType,
  TextRun,
} from 'docx'
import * as fs from 'fs'
import { config } from '../config'
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
} from './artifactOutput'
import { EMPTY_DOCUMENT_NOTE, footerLines, printedBranding } from './documentChrome'
import { type DocxImagePlacement, docxImageParagraph } from './docxImages'
import { textRuns } from './docxInline'
import { bodyHasText, bodyToDocxChildren } from './docxMarkdown'
import {
  DOCX_COMPLEX_FONT,
  DOCX_LATIN_FONT,
  documentEastAsianScript,
  docxDirection,
  eastAsianScript,
} from './docxScript'
import {
  DOCX_CONTENT_WIDTH_TWIPS,
  DOCX_LANDSCAPE_CONTENT_WIDTH_TWIPS,
  DOCX_PALETTES,
  DocxListNumbering,
  docxHex,
} from './docxStyle'
import { buildDocxTable, docxSections } from './docxTable'
import { htmlToPlainText } from './inlineMarkup'
import { normalizeTableRows } from './tableRows'
import type { InternalToolResult } from './types'

/**
 * Widest a DOCX image is drawn, in pixels at 96 dpi; the page leaves about 601
 * between its margins.
 */
const DOCX_MAX_IMAGE_WIDTH = 560
const DOCX_MAX_IMAGE_HEIGHT = 380

/** Largest logo drawn above the title, in pixels. */
const DOCX_LOGO_BOX = { width: 160, height: 60 }

/** Footer lines kept, as in the PDF. */
const DOCX_MAX_FOOTER_LINES = 6

export const DOCX_IMAGE_FILE_DESCRIPTION =
  "File name in the output folder, as returned by clerum__generate_chart (e.g. 'sales.png'). " +
  'PNG, JPEG, GIF, WebP or SVG.'

interface DocxBranding {
  companyName?: string
  logoPath?: string
  footerText?: string
}

interface DocxImageArg {
  width?: number
  height?: number
  alignment?: string
}

interface DocxTableArg {
  headers?: unknown
  rows?: unknown
  layout?: unknown
}

export async function runGenerateDocx(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  try {
    const filename = outputFilename(args.filename, 'docx', 'output')
    const title = args.title ? htmlToPlainText(String(args.title)) : undefined
    const headline = args.headline ? htmlToPlainText(String(args.headline)) : undefined
    const body = String(args.body ?? '')
    const palette = DOCX_PALETTES[String(args.palette ?? 'default')] ?? DOCX_PALETTES.default
    const branding: DocxBranding = printedBranding(args.branding)
    const images: unknown[] = Array.isArray(args.images) ? args.images : []
    const tables: unknown[] = Array.isArray(args.tables) ? args.tables : []
    const warnings: string[] = []
    const numbering = new DocxListNumbering()
    const imageBox = { width: DOCX_MAX_IMAGE_WIDTH, height: DOCX_MAX_IMAGE_HEIGHT }
    let embedded = 0
    let imageLeftOut = false
    const embed = (
      ref: unknown,
      label: string,
      box: { width: number; height: number },
      placement: DocxImagePlacement
    ): Paragraph | undefined => {
      const paragraph = docxImageParagraph(ref, outputDir, box, placement, warnings, label)
      if (paragraph) embedded++
      else imageLeftOut = true
      return paragraph
    }

    const children: (Paragraph | DocxTable)[] = []

    if (branding.logoPath) {
      const logo = embed(branding.logoPath, 'branding.logoPath', DOCX_LOGO_BOX, {
        spacing: { after: 160 },
      })
      if (logo) children.push(logo)
    }
    if (title) {
      children.push(
        new Paragraph({
          ...docxDirection(title),
          heading: HeadingLevel.TITLE,
          spacing: { after: 120 },
          children: textRuns(
            title,
            { bold: true, color: docxHex(palette.primary), size: 48 },
            eastAsianScript(title)
          ),
        })
      )
    }
    if (headline) {
      children.push(
        new Paragraph({
          ...docxDirection(headline),
          spacing: { after: 240 },
          children: textRuns(
            headline,
            { italics: true, color: docxHex(palette.muted), size: 26 },
            eastAsianScript(headline)
          ),
        })
      )
    }

    children.push(
      ...bodyToDocxChildren(body, {
        palette,
        numbering,
        warnings,
        image: (file, alt) =>
          embed(file, 'body', imageBox, {
            altText: alt,
            spacing: { before: 120, after: 120 },
          }),
      })
    )

    let tablesWritten = 0
    const tableTexts: unknown[] = []
    tables.forEach((table, i) => {
      const spec = (table && typeof table === 'object' ? table : {}) as DocxTableArg
      const headers = Array.isArray(spec.headers) ? spec.headers : []
      if (headers.length === 0) {
        warnings.push(
          `tables[${i}] has no headers and was left out; give it a headers array of column names.`
        )
        return
      }
      const rows = normalizeTableRows(spec.rows, headers, `tables[${i}]`, warnings)
      tableTexts.push(...headers)
      for (const row of rows) tableTexts.push(...row)
      const layout = spec.layout === 'minimal' || spec.layout === 'grid' ? spec.layout : 'striped'
      children.push(buildDocxTable(headers, rows, palette, layout, warnings, `tables[${i}]`))
      children.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
      tablesWritten++
    })

    images.forEach((img, i) => {
      const spec = (img && typeof img === 'object' ? img : {}) as DocxImageArg
      const paragraph = embed(img, `images[${i}]`, imageBox, {
        width: spec.width,
        height: spec.height,
        alignment: spec.alignment,
        spacing: { before: 160, after: 160 },
      })
      if (paragraph) children.push(paragraph)
    })

    if (embedded === 0 && !title && !headline && tablesWritten === 0 && !bodyHasText(body)) {
      if (warnings.length > 0) {
        const hint = imageLeftOut
          ? ' Pass images as file names in the output folder, such as those clerum__generate_chart returns.'
          : ''
        return {
          success: false,
          error: `Nothing could be written to ${filename}. ${[...new Set(warnings)].join(' ')}${hint}`,
        }
      }
      warnings.push(EMPTY_DOCUMENT_NOTE)
    }

    // The page number follows the first footer line; the docx lib writes it as
    // a field Word fills in on open. The other lines are run from a leading
    // newline and lose its empty run, so each starts on a line of its own.
    const footerMuted = { color: docxHex(palette.muted), size: 18 }
    const footerLines = (branding.footerText ?? '').replace(/\r\n?/g, '\n').split('\n')
    if (footerLines.length > DOCX_MAX_FOOTER_LINES) {
      warnings.push(
        `branding.footerText takes ${footerLines.length} lines, but only ` +
          `${DOCX_MAX_FOOTER_LINES} fit in the footer, so the rest was cut. Keep it to a line or two.`
      )
      footerLines.length = DOCX_MAX_FOOTER_LINES
      footerLines[DOCX_MAX_FOOTER_LINES - 1] += '...'
    }
    const [firstFooterLine, ...moreFooterLines] = footerLines
    const headerMuted = { color: docxHex(palette.muted), size: 18 }
    const companyName = branding.companyName ?? ''
    // The page number and the title sit at the right margin, on a right tab
    // stop at the width of the section's page.
    const running = (width: number) => {
      const tabStops = [{ type: TabStopType.RIGHT, position: width }]
      const footer = new DocxFooter({
        children: [
          new Paragraph({
            alignment: AlignmentType.LEFT,
            tabStops,
            children: [
              ...textRuns(firstFooterLine, footerMuted, eastAsianScript(firstFooterLine)),
              new TextRun({ text: '\t', ...footerMuted }),
              new TextRun({ children: ['Page ', PageNumber.CURRENT], ...footerMuted }),
              new TextRun({ children: [' / ', PageNumber.TOTAL_PAGES], ...footerMuted }),
              ...(moreFooterLines.length > 0
                ? textRuns(
                    `\n${moreFooterLines.join('\n')}`,
                    footerMuted,
                    eastAsianScript(moreFooterLines.join(' '))
                  ).slice(1)
                : []),
            ],
          }),
        ],
      })
      const header = new DocxHeader({
        children: [
          new Paragraph({
            alignment: AlignmentType.LEFT,
            tabStops,
            children: [
              ...textRuns(companyName, headerMuted, eastAsianScript(companyName)),
              new TextRun({ text: '\t', ...headerMuted }),
              ...textRuns(title ?? '', headerMuted, eastAsianScript(title ?? '')),
            ],
          }),
        ],
      })
      return { header, footer }
    }
    const portrait = running(DOCX_CONTENT_WIDTH_TWIPS)
    const landscape = running(DOCX_LANDSCAPE_CONTENT_WIDTH_TWIPS)

    // Runs of Han characters alone name no East Asian face and take this one.
    const eastAsia = documentEastAsianScript(
      [title, headline, body, branding.companyName, branding.footerText, ...tableTexts]
        .filter((text): text is string => typeof text === 'string')
        .join('\n')
    )
    const doc = new DocxDocument({
      creator: branding.companyName ?? '',
      title: title ?? 'Report',
      description: headline,
      styles: {
        default: {
          document: {
            run: {
              font: {
                ascii: DOCX_LATIN_FONT,
                hAnsi: DOCX_LATIN_FONT,
                cs: DOCX_COMPLEX_FONT,
                ...(eastAsia ? { eastAsia: eastAsia.font } : {}),
              },
              ...(eastAsia ? { language: { eastAsia: eastAsia.lang } } : {}),
              size: 22,
              color: docxHex(palette.text),
            },
            paragraph: { spacing: { line: 320, after: 80 } },
          },
        },
      },
      numbering: { config: numbering.config() },
      sections: docxSections(children).map(section => ({
        properties: section.landscape
          ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
          : {},
        headers: { default: (section.landscape ? landscape : portrait).header },
        footers: { default: (section.landscape ? landscape : portrait).footer },
        children: section.children,
      })),
    })

    const buffer = await Packer.toBuffer(doc)
    ensureDir(outputDir)
    const target = claimOutputFile(outputDir, filename)
    enforceQuota(outputDir, buffer.byteLength, replacedBytes(target))
    fs.writeFileSync(target.filePath, buffer)

    return artifactResult(target, 'docx', { warnings: [...new Set(warnings)] })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
