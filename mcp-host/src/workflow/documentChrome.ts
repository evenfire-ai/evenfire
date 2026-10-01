/** Branding, footer lines and the empty-document note shared by the PDF and DOCX generators. */
import { htmlToPlainLines, htmlToPlainText } from './inlineMarkup'
import type { UnitMeasure } from './pdfTables'
import { LINE_FILL } from './pdfText'

/**
 * Branding as it prints: HTML in the company name and footer read as text,
 * the footer keeping its lines.
 */
export function printedBranding(raw: unknown): {
  logoPath?: string
  companyName?: string
  footerText?: string
} {
  const branding = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const text = (value: unknown) =>
    value === undefined || value === null ? undefined : String(value)
  const companyName = text(branding.companyName)
  const footerText = text(branding.footerText)
  // Named rather than spread, so a key nothing prints is reported as ignored.
  return {
    ...(branding.logoPath !== undefined ? { logoPath: branding.logoPath as string } : {}),
    ...(companyName !== undefined ? { companyName: htmlToPlainText(companyName) } : {}),
    ...(footerText !== undefined ? { footerText: htmlToPlainLines(footerText) } : {}),
  }
}

/** Note for a PDF or DOCX written with nothing in it. */
export const EMPTY_DOCUMENT_NOTE =
  'The document is empty: body has no text, and no title, table or image was given. ' +
  'Pass the text to write as body.'

/** Footer lines that fit once the bottom margin has grown to hold them. */
export const PDF_MAX_FOOTER_LINES = 6

export const PDF_FOOTER_SIZE = 9

/** More characters than a header or footer line ever holds at the running size. */
export const RUNNING_LINE_CHARS = 400

/** The longest start of `chars` that fits `fits`, at least one character. */
export function longestFitting(chars: string[], fits: (text: string) => boolean): number {
  let lo = 1
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(chars.slice(0, mid).join(''))) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The footer text as the lines it will take, cut to what the bottom margin
 * can hold, with a note when anything is cut.
 */
export function footerLines(
  text: string,
  width: number,
  measure: UnitMeasure,
  warnings: string[]
): string[] {
  // Lines break where the typesetter breaks them, or the footer outgrows its margin.
  const fits = (s: string) => measure(s, false) * PDF_FOOTER_SIZE <= width * LINE_FILL
  // Far more characters than a footer line holds, so a huge word is never measured whole.
  const tooWide = (s: string) => s.length > RUNNING_LINE_CHARS || !fits(s)
  const lines: string[] = []
  // Counting stops one line past the most the footer holds.
  const full = () => lines.length > PDF_MAX_FOOTER_LINES
  for (const source of text.split('\n')) {
    let line = ''
    for (const word of source.split(/(\s+)/)) {
      if (full()) break
      if (line.trim() && tooWide(line + word)) {
        lines.push(line.trimEnd())
        line = word.trimStart()
      } else {
        line += word
      }
      // A word wider than the line, such as a long URL, takes as many lines as it fills.
      while (!full() && tooWide(line)) {
        const head = Array.from(line.slice(0, RUNNING_LINE_CHARS))
        if (head.length <= 1) break
        const piece = head.slice(0, longestFitting(head, fits)).join('')
        lines.push(piece)
        line = line.slice(piece.length)
      }
    }
    if (full()) break
    lines.push(line.trimEnd())
  }
  if (!full()) return lines
  warnings.push(
    `branding.footerText takes more than ${PDF_MAX_FOOTER_LINES} lines, the most that fit in the ` +
      'footer, so the rest was cut. Keep it to a line or two.'
  )
  const kept = lines.slice(0, PDF_MAX_FOOTER_LINES)
  kept[kept.length - 1] = `${kept[kept.length - 1]}...`
  return kept
}
