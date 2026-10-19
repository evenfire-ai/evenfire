/**
 * Direction and script handling for the generated Word documents.
 *
 * Word lays out a paragraph right to left only when it carries w:bidi, and
 * treats neutral characters inside a run as right-to-left only when the run
 * carries w:rtl. Arabic and Hebrew letters take the complex-script font (w:cs)
 * and CJK the East Asian one, so both are named explicitly: a document that
 * names only a Latin face leaves Word to substitute, which draws boxes where
 * the substitute lacks the glyphs.
 */
import { isRtlText } from './textDirection'

/** Latin face of the body text. */
export const DOCX_LATIN_FONT = 'Calibri'

/**
 * Complex-script face for Arabic and Hebrew. Arial carries both in every
 * weight on Windows and Word for Mac; where its italic lacks Arabic, Word
 * slants the upright glyphs.
 */
export const DOCX_COMPLEX_FONT = 'Arial'

/** Paragraph options that set the paragraph's direction from its text. */
export function docxDirection(text: string): { bidirectional?: true } {
  return isRtlText(text) ? { bidirectional: true } : {}
}
