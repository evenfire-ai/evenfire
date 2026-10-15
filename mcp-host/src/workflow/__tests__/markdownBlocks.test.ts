import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import {
  ORDERED_RE,
  isListLine,
  isTableSeparator,
  parseColumnAlignments,
  readBlock,
  startsTable,
  stripListMarker,
} from '../markdownBlocks'
import { allText, readPdf } from './support/pdfText'

describe('delimiter rows', () => {
  it('reads a delimiter row as GFM does', () => {
    expect(isTableSeparator('|---|:--:|')).toBe(true)
    expect(isTableSeparator('--- | ---')).toBe(true)
    // One column needs a pipe on either side; a bare rule is no table.
    expect(isTableSeparator('| --- |')).toBe(true)
    expect(isTableSeparator('| ---')).toBe(true)
    expect(isTableSeparator('--- |')).toBe(true)
    expect(isTableSeparator('---')).toBe(false)
    expect(isTableSeparator('|---||---|')).toBe(false)
    expect(isTableSeparator('| a | --- |')).toBe(false)
  })

  it('starts a table only at a row the delimiter row matches', () => {
    expect(startsTable(['| a |', '| --- |'], 0)).toBe(true)
    expect(startsTable(['a | b', '--- | ---'], 0)).toBe(true)
    expect(startsTable(['a | b', '---|'], 0)).toBe(false)
    expect(startsTable(['a', '| ---'], 0)).toBe(false)
  })

  it('reads the alignments a delimiter row declares', () => {
    expect(parseColumnAlignments('| :-- | :-: | --: | --- |')).toEqual([
      'left',
      'center',
      'right',
      'left',
    ])
  })

  it('checks a row with a long run of spaces in linear time', () => {
    for (const line of [
      `a |${' '.repeat(100000)}x`,
      `|${' '.repeat(100000)}-`,
      `-${' '.repeat(100000)}|`,
    ]) {
      const started = performance.now()
      isTableSeparator(line)
      expect(performance.now() - started).toBeLessThan(200)
    }
  })
})

describe('list items', () => {
  it('numbers an item with one to nine digits, as CommonMark does', () => {
    expect(isListLine('123456789. nine digits')).toBe(true)
    expect(isListLine('1234567890. ten digits')).toBe(false)
    expect(ORDERED_RE.exec('12) item')?.[1]).toBe('12')
    expect(stripListMarker('  - item')).toBe('item')
    expect(stripListMarker('3. item')).toBe('item')
  })
})

describe('a body with a long run of spaces after a pipe row', () => {
  let outputDir: string
  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-md-blocks-'))
  })
  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  for (const name of ['clerum__generate_pdf', 'clerum__generate_docx']) {
    it(`renders it as fast as the same body without the pipe with ${name}`, async () => {
      const tool = INTERNAL_TOOLS.find(t => t.name === name)!
      const timed = async (body: string): Promise<number> => {
        const started = performance.now()
        const result = await tool.execute({ filename: 'spaces', body }, outputDir)
        expect(result.success, result.error).toBe(true)
        return performance.now() - started
      }
      // Loaded first, so neither time below holds the library's loading.
      await timed('a | b\nx')
      const spaces = ' '.repeat(50_000)
      // Laying out the spaces takes the same time in both; the quadratic scan
      // of the pipe row took minutes. Compared, not timed alone, so a loaded
      // machine slows both.
      const plain = await timed(`a b\n${spaces}x`)
      const piped = await timed(`a | b\n${spaces}x`)
      expect(piped).toBeLessThan(plain * 3 + 500)
    }, 60_000)
  }
})

describe('readBlock', () => {
  const block = (body: string, at = 0) => readBlock(body.split('\n'), at)

  it('runs a fence to its closing fence, with the language noted', () => {
    expect(block('```sh\nls\n\nls -l\n```\nafter')).toEqual({
      kind: 'code',
      language: 'sh',
      code: ['ls', '', 'ls -l'],
      next: 5,
    })
    // An unclosed fence takes the rest of the body.
    expect(block('```\nx')).toMatchObject({ kind: 'code', code: ['x'], next: 3 })
  })

  it('reads a heading without its closing hashes, once', () => {
    expect(block('## Title ##')).toEqual({ kind: 'heading', level: 2, text: 'Title', next: 1 })
    expect(block('# Title # #')).toMatchObject({ text: 'Title #' })
    expect(block('# C#')).toMatchObject({ text: 'C#' })
  })

  it('ends a table at a blank line or at the start of another block, as GFM does', () => {
    const table = '| A | B |\n|---|--:|\n| 1 | 2 |'
    expect(block(`${table}\n| 3 | 4 |\n\nafter`)).toEqual({
      kind: 'table',
      headers: ['A', 'B'],
      alignments: ['left', 'right'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
      next: 4,
    })
    for (const other of ['- item | x', '# Head | x', '> quote | x', '```x|y']) {
      expect(block(`${table}\n${other}`), other).toMatchObject({ kind: 'table', next: 3 })
    }
  })

  it('takes "- - -" for a rule, not a list', () => {
    expect(block('- - -')).toEqual({ kind: 'rule', next: 1 })
    expect(block('- item')).toEqual({ kind: 'list' })
  })

  it('reads consecutive quote lines as paragraphs', () => {
    expect(block('> one\n> two\n>\n> three\nafter')).toEqual({
      kind: 'quote',
      paragraphs: ['one two', 'three'],
      next: 4,
    })
  })

  it('leaves blank lines and text to the renderer', () => {
    expect(block('   ')).toEqual({ kind: 'blank', next: 1 })
    expect(block('Some *text*')).toEqual({ kind: 'text', line: 'Some *text*', next: 1 })
  })
})

describe('a list item with a pipe right after a table', () => {
  let outputDir: string
  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-md-blocks-'))
  })
  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  it('is a list item in the PDF, as in the DOCX, not one more table row', async () => {
    const pdf = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_pdf')!
    const body = '| A | B |\n|---|---|\n| 1 | 2 |\n- item | x'
    const result = await pdf.execute({ filename: 'l.pdf', body }, outputDir)
    expect(result.success, result.error).toBe(true)
    // As a row, the pipe would split "- item" and "x" into two cells and print neither.
    expect(allText(await readPdf(result.artifact!.path))).toMatch(/item\s+\|\s+x/)
  })
})
