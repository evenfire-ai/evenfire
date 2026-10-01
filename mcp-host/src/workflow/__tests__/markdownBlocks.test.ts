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
  startsTable,
  stripListMarker,
} from '../markdownBlocks'

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
    it(`renders in linear time with ${name}`, async () => {
      const tool = INTERNAL_TOOLS.find(t => t.name === name)!
      const body = `a | b\n${' '.repeat(100000)}x`
      const started = performance.now()
      const result = await tool.execute({ filename: 'spaces', body }, outputDir)
      expect(result.success, result.error).toBe(true)
      expect(performance.now() - started).toBeLessThan(5000)
    })
  }
})
