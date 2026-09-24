/**
 * The typesetter against a made-up set of faces, so the per-character fallback
 * and right-to-left ordering are checked on any machine, whatever fonts it has.
 */
import { describe, expect, it } from 'vitest'
import type { Content } from 'pdfmake/interfaces'
import type { PdfGlyphSource } from '../fonts'
import { PdfTypesetter, type TypesetContext } from '../pdfText'

const COVERAGE: Record<string, (cp: number) => boolean> = {
  Body: cp => cp < 0x250 || cp === 0x2022,
  ClerumMono: cp => cp >= 0x20 && cp <= 0x7e,
  // Shapes, so fontkit orders its runs itself.
  Arabic: cp => cp >= 0x600 && cp <= 0x6ff,
  // No layout tables: its runs must arrive already in display order.
  Hebrew: cp => cp >= 0x590 && cp <= 0x5ff,
}

const source: PdfGlyphSource = {
  familyFor(cp, base) {
    if (COVERAGE[base]?.(cp)) return base
    return ['Body', 'Arabic', 'Hebrew'].find(f => COVERAGE[f](cp))
  },
  reversesRtl: family => family === 'Arabic',
  measure: (text, _family, size) => [...text].length * size * 0.5,
  metrics: family =>
    ({
      Body: { ascent: 0.9, lineHeight: 1.2 },
      ClerumMono: { ascent: 0.6, lineHeight: 0.8 },
      Arabic: { ascent: 1.4, lineHeight: 2.1 },
      Hebrew: { ascent: 1.0, lineHeight: 1.3 },
    })[family],
  descriptors: () => ({}),
  isFallback: family => family === 'Arabic' || family === 'Hebrew',
  // A lone shadda stands for a sequence fontkit fails to shape.
  shapes: (_family, texts) => !texts.some(t => t.includes('\u0651')),
}

const ctx: TypesetContext = {
  width: 500,
  font: 'Body',
  fontSize: 10,
  bold: false,
  lineHeight: 1.3,
}

function typeset(
  node: Record<string, unknown>,
  context = ctx
): { node: Record<string, unknown>; setter: PdfTypesetter } {
  const setter = new PdfTypesetter(source)
  setter.typeset(node as unknown as Content, context)
  return { node, setter }
}

function runs(node: Record<string, unknown>): Array<Record<string, unknown>> {
  return node.text as Array<Record<string, unknown>>
}

describe('per-character faces', () => {
  it('gives a run the face that can draw it and keeps plain text in the body face', () => {
    const { node, setter } = typeset({ text: 'Total: \u05D0 x' })
    const out = runs(node)
    expect(out.map(r => r.font ?? 'Body')).toEqual(['Body', 'Hebrew', 'Body'])
    expect([...setter.families].sort()).toEqual(['Body', 'Hebrew'])
  })

  it('keeps run properties when a run is split', () => {
    const { node } = typeset({ text: [{ text: 'a\u05D0', bold: true, link: 'https://x.test' }] })
    for (const run of runs(node)) {
      expect(run.bold).toBe(true)
      expect(run.link).toBe('https://x.test')
    }
  })

  it('falls back from the code face to the body face before any other', () => {
    const { node } = typeset(
      { text: 'caf\u00E9', font: 'ClerumMono' },
      { ...ctx, font: 'ClerumMono' }
    )
    expect(runs(node).map(r => [r.text, r.font])).toEqual([
      ['caf', undefined],
      ['\u00E9', 'Body'],
    ])
  })

  it('expands a tab to spaces in code and to one space in text', () => {
    expect(runs(typeset({ text: 'a\tb' }).node)[0].text).toBe('a b')
    const code = typeset({ text: 'a\tb', font: 'ClerumMono' }, { ...ctx, font: 'ClerumMono' })
    expect(runs(code.node)[0].text).toBe('a    b')
  })

  it('writes a status emoji as text and reports what no face can draw', () => {
    const { node, setter } = typeset({ text: 'done \u2705 \u{1F680} \u4E2D' })
    const text = runs(node)
      .map(r => r.text)
      .join('')
    expect(text).toBe('done OK  ')
    const [warning] = setter.warnings()
    expect(warning).toMatch(/2 character\(s\) of emoji, Chinese text/)
    expect(warning).toMatch(/U\+1F680/)
    expect(warning).toMatch(/U\+4E2D/)
  })

  it('leaves an empty paragraph empty', () => {
    expect(typeset({ text: '' }).node.text).toBe('')
  })
})

describe('right-to-left text', () => {
  it('hands a shaped script over in reading order, since fontkit reverses it', () => {
    const { node } = typeset({ text: 'A \u0628\u062C C' })
    expect(runs(node).map(r => r.text)).toEqual(['A ', '\u0628\u062C', ' C'])
  })

  it('puts an unshaped script into display order itself', () => {
    const { node } = typeset({ text: 'A \u05D0\u05D1 C' })
    expect(runs(node).map(r => r.text)).toEqual(['A ', '\u05D1\u05D0', ' C'])
  })

  it('right-aligns a right-to-left paragraph and orders its words', () => {
    const { node } = typeset({ text: '\u05D0 \u05D1' })
    expect(node.alignment).toBe('right')
    expect(
      runs(node)
        .map(r => r.text)
        .join('')
    ).toBe('\u05D1 \u05D0')
  })

  it('keeps an alignment the caller set', () => {
    expect(typeset({ text: '\u05D0', alignment: 'center' }).node.alignment).toBe('center')
  })

  it('breaks a long paragraph into lines itself so each line reads in order', () => {
    // Ten 4-letter words at 5pt a letter: 20pt each plus spaces, about 4 a line in 100pt.
    const words = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0x5d0 + i).repeat(4))
    const { node } = typeset({ text: words.join(' ') }, { ...ctx, width: 100 })
    const lines = runs(node)
      .map(r => r.text)
      .join('')
      .split('\n')
    expect(lines.length).toBeGreaterThan(2)
    // The first line holds the first words, shown right to left.
    expect(lines[0].trim().split(' ').reverse()[0]).toBe(words[0])
    expect(lines.flatMap(l => l.trim().split(' ')).sort()).toEqual([...words].sort())
  })

  it('measures within the width a table cell gives it', () => {
    const cell = { text: Array.from({ length: 8 }, () => '\u05D0\u05D0\u05D0').join(' ') }
    const table = { table: { widths: [40], body: [[cell]] } }
    typeset(table)
    expect(runs(cell).some(r => String(r.text).includes('\n'))).toBe(true)
  })

  // fontkit reverses a whole run once its first letter is Arabic, and Arabic-Indic
  // digits count as Arabic: the run is handed over as the reverse of what shows.
  it('keeps Arabic-Indic digits in their order next to a percent sign', () => {
    const { node } = typeset({
      text: '\u0628\u0646\u0633\u0628\u0629 \u0661\u0662\u066A \u0641\u064A',
    })
    const number = runs(node).find(r => String(r.text).includes('\u0661'))
    // Shown left to right as percent, one, two: twelve percent.
    expect(number?.text).toBe('\u0662\u0661\u066A')
  })

  it('keeps Arabic-Indic and Persian digits in order on their own', () => {
    expect(runs(typeset({ text: '\u0661\u0662\u0663' }).node).map(r => r.text)).toEqual([
      '\u0663\u0662\u0661',
    ])
    const persian = typeset({
      text: '\u0628\u0646\u0633\u0628\u0629 \u06F1\u06F2 \u0641\u064A',
    }).node
    expect(runs(persian).find(r => String(r.text).includes('\u06F1'))?.text).toBe('\u06F2\u06F1')
  })

  it('never puts Latin and Arabic letters in one run', () => {
    const mixed: PdfGlyphSource = { ...source, familyFor: () => 'Arabic' }
    const setter = new PdfTypesetter(mixed)
    const node = { text: 'ab \u0628\u062C' }
    setter.typeset(node as unknown as Content, { ...ctx, font: 'Arabic' })
    const texts = runs(node).map(r => String(r.text))
    expect(texts.some(t => /[a-z]/.test(t) && /[\u0600-\u06FF]/.test(t))).toBe(false)
  })

  it('breaks a right-to-left word wider than the line', () => {
    const { node } = typeset({ text: '\u05D0'.repeat(300) }, { ...ctx, width: 100 })
    const lines = runs(node)
      .map(r => r.text)
      .join('')
      .split('\n')
    // 5pt a letter in 94pt of line: 18 letters a line.
    expect(lines.length).toBe(Math.ceil(300 / 18))
    expect(lines.join('')).toBe('\u05D0'.repeat(300))
  })
})

describe('long words', () => {
  it('breaks a stretch with no break in it wherever it fills the line', () => {
    const { node } = typeset({ text: `data: ${'A'.repeat(1000)} end` }, { ...ctx, width: 100 })
    const text = runs(node)
      .map(r => r.text)
      .join('')
    const lines = text.split('\n')
    expect(lines.length).toBeGreaterThan(40)
    for (const line of lines.slice(1, -1)) expect(line.length * 5).toBeLessThanOrEqual(94)
    expect(text.replace(/\n/g, '')).toBe(`data: ${'A'.repeat(1000)} end`)
  })

  it('leaves words that fit, and ideographic text pdfmake breaks itself, alone', () => {
    const { node } = typeset({ text: `${'word '.repeat(200)}${'\u4E2D'.repeat(300)}` })
    expect(runs(node).some(r => String(r.text).includes('\n'))).toBe(false)
  })
})

describe('line spacing', () => {
  it('opens up the lines of a face shorter than an em', () => {
    const { node } = typeset({ text: 'a b' }, { ...ctx, font: 'ClerumMono', lineHeight: 1.25 })
    expect(runs(node)[0].lineHeight).toBeCloseTo((1.25 * 1.1) / 0.8, 5)
  })

  it('keeps a tall fallback face from spacing its lines far apart', () => {
    const { node } = typeset({ text: 'a \u0628 \u05D0' })
    const byFont = Object.fromEntries(runs(node).map(r => [String(r.font ?? 'Body'), r]))
    expect(byFont.Arabic.lineHeight).toBeCloseTo((1.3 * 1.2 * 1.2) / 2.1, 5)
    expect(byFont.Body.lineHeight).toBeUndefined()
    expect(byFont.Hebrew.lineHeight).toBeUndefined()
  })
})

describe('right-to-left lists and tables', () => {
  type Row = Array<Record<string, unknown>>
  const cellText = (cell: Record<string, unknown>): string =>
    (cell.text as Array<Record<string, unknown>>).map(r => r.text).join('')

  it('puts the bullets of a right-to-left list on the right', () => {
    const node: Record<string, unknown> = {
      ul: [{ text: '\u05D0 \u05D1' }, { text: '\u05D2' }],
      margin: [0, 4, 0, 6],
    }
    typeset(node)
    expect(node.ul).toBeUndefined()
    const body = (node.table as { body: Row[] }).body
    expect(body).toHaveLength(2)
    expect(cellText(body[0][1])).toBe('\u2022')
    expect(body[0][0].alignment).toBe('right')
    expect(node.margin).toEqual([0, 4, 0, 6])
  })

  it('numbers a right-to-left list from its start, the number read first', () => {
    const node: Record<string, unknown> = {
      ol: [{ text: '\u05D0' }, [{ text: '\u05D1' }, { ul: [{ text: '\u05D2' }] }]],
      start: 3,
    }
    typeset(node)
    const body = (node.table as { body: Row[] }).body
    expect(body.map(row => cellText(row[1]))).toEqual(['.3', '.4'])
    // The nested list keeps its place under its item, and is mirrored too.
    const nested = (body[1][0].stack as Array<Record<string, unknown>>)[1]
    expect(nested.table).toBeDefined()
  })

  it('leaves a left-to-right list to pdfmake', () => {
    const node: Record<string, unknown> = { ul: [{ text: 'one \u05D0' }, { text: 'two' }] }
    typeset(node)
    expect(node.ul).toHaveLength(2)
    expect(node.table).toBeUndefined()
  })

  it('runs the columns of a right-to-left table from the right', () => {
    const table = {
      headerRows: 1,
      widths: [100, 50],
      body: [
        [{ text: '\u05D0', id: 'h' }, { text: '\u05D1' }],
        [{ text: 'one' }, { text: '2' }],
      ],
    }
    typeset({ table })
    expect(table.widths).toEqual([50, 100])
    expect(table.body.map(row => row.map(cellText))).toEqual([
      ['\u05D1', '\u05D0'],
      ['2', 'one'],
    ])
  })

  it('starts the cells of a mirrored table at the right', () => {
    const table = {
      headerRows: 1,
      widths: [100, 50],
      body: [
        [{ text: '\u05D0' }, { text: '\u05D1' }],
        [{ text: 'one' }, { text: '2', alignment: 'center' }],
      ],
    }
    typeset({ table })
    expect(table.body[1].map(cell => cell.alignment)).toEqual(['center', 'right'])
  })

  it('lines up the first baselines of cells set in faces of different heights', () => {
    const arabic: Record<string, unknown> = { text: '\u0628' }
    const latin: Record<string, unknown> = { text: 'x' }
    const plain: Record<string, unknown> = { text: 'y' }
    typeset({ table: { widths: [100, 100], body: [[arabic, latin], [plain]] } })
    // (1.4 - 0.9) em at 10pt.
    expect(latin.margin).toEqual([0, 5, 0, 0])
    expect(arabic.margin).toBeUndefined()
    expect(plain.margin).toBeUndefined()
  })

  it('keeps the column order of a table whose headers read left to right', () => {
    const table = {
      headerRows: 1,
      widths: [100, 50],
      body: [
        [{ text: 'Name' }, { text: '\u05D0' }],
        [{ text: 'x' }, { text: 'y' }],
      ],
    }
    typeset({ table })
    expect(table.widths).toEqual([100, 50])
  })
})

describe('runs pdfkit cannot lay out', () => {
  it('leaves out only the runs that fail, with a note, and keeps the rest', () => {
    const typesetter = new PdfTypesetter(source)
    const first = { text: 'Intro \u0645\u0631\u062d\u0628\u0627 end' }
    const second = { text: 'More \u0651\u0628 text' }
    typesetter.typeset([first, second], ctx)
    typesetter.settleShaping()
    const shown = (node: { text: unknown }) =>
      (node.text as Array<{ text: string }>).map(r => r.text).join('')
    expect(shown(first)).toContain('\u0645')
    expect(shown(second)).not.toContain('\u0651')
    expect(shown(second)).toContain('More')
    expect(typesetter.warnings().join(' ')).toMatch(
      /2 character\(s\) of Arabic text are in a sequence the PDF renderer cannot lay out/
    )
  })
})
