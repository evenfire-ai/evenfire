/**
 * Palettes, page geometry and list numbering for the generated Word documents.
 */
import { AlignmentType, type ILevelsOptions, LevelFormat } from 'docx'

export interface DocxPalette {
  // Stored as '#xxxxxx' like the PDF palettes; docxHex() gives the bare form docx expects.
  primary: string
  primaryDark: string
  text: string
  muted: string
  border: string
  zebra: string
  surface: string
}

export const DOCX_PALETTES: Record<string, DocxPalette> = {
  default: {
    primary: '#0f172a',
    primaryDark: '#020617',
    text: '#0f172a',
    muted: '#475569',
    border: '#cbd5e1',
    zebra: '#f8fafc',
    surface: '#f1f5f9',
  },
  corporate: {
    primary: '#1e3a8a',
    primaryDark: '#1e293b',
    text: '#1e293b',
    muted: '#475569',
    border: '#cbd5e1',
    zebra: '#f1f5f9',
    surface: '#e0f2fe',
  },
  warm: {
    primary: '#b45309',
    primaryDark: '#78350f',
    text: '#2f2823',
    muted: '#66584c',
    border: '#d6d2cc',
    zebra: '#fefdfb',
    surface: '#f7f7f5',
  },
  alert: {
    primary: '#9f1239',
    primaryDark: '#4c0519',
    text: '#1f2937',
    muted: '#4b5563',
    border: '#fecaca',
    zebra: '#fef2f2',
    surface: '#fee2e2',
  },
}

/** '#1e3a8a' as the bare uppercase hex docx expects for colors and fills. */
export function docxHex(c: string): string {
  return c.startsWith('#') ? c.slice(1).toUpperCase() : c.toUpperCase()
}

/** Width between the margins of the default A4 page (11906 twips less two 1440 margins). */
export const DOCX_CONTENT_WIDTH_TWIPS = 9026

/** The same page turned to landscape (16838 twips less two 1440 margins). */
export const DOCX_LANDSCAPE_CONTENT_WIDTH_TWIPS = 16838 - 2 * 1440

/** Word's list levels are 0-8. */
export const DOCX_LIST_LEVELS = 9

const BULLET_REFERENCE = 'doc-bullets'
const ORDERED_REFERENCE = 'doc-ordered'
const BULLET_GLYPHS = ['\u2022', '\u25E6', '\u25AA']
const ORDERED_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN]

function levels(ordered: boolean, start: number): ILevelsOptions[] {
  return Array.from({ length: DOCX_LIST_LEVELS }, (_, level) => ({
    level,
    format: ordered ? ORDERED_FORMATS[level % 3] : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : BULLET_GLYPHS[level % 3],
    start,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 240 } } },
  }))
}

export interface DocxListRef {
  reference: string
  instance: number
}

/**
 * Numbering for the lists of one document. Every list gets its own instance,
 * because paragraphs sharing an instance form one sequence in Word.
 */
export class DocxListNumbering {
  private nextInstance = 0
  private readonly starts = new Set<number>()

  begin(ordered: boolean, start = 1): DocxListRef {
    const instance = this.nextInstance++
    if (!ordered) return { reference: BULLET_REFERENCE, instance }
    if (start === 1) return { reference: ORDERED_REFERENCE, instance }
    // docx sets an instance's start from its definition, so each start needs its own.
    this.starts.add(start)
    return { reference: `${ORDERED_REFERENCE}-from-${start}`, instance }
  }

  config(): Array<{ reference: string; levels: ILevelsOptions[] }> {
    return [
      { reference: BULLET_REFERENCE, levels: levels(false, 1) },
      { reference: ORDERED_REFERENCE, levels: levels(true, 1) },
      ...[...this.starts].map(start => ({
        reference: `${ORDERED_REFERENCE}-from-${start}`,
        levels: levels(true, start),
      })),
    ]
  }
}
