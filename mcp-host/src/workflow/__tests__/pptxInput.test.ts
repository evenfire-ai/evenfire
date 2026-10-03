/**
 * How the PPTX tool reads the text a model sends before any slide is laid
 * out: lists, enums, KPIs and table cells.
 */
import { describe, expect, it } from 'vitest'
import {
  PptxInputError,
  type ReadContext,
  readEnum,
  readKpis,
  readStringList,
  readTable,
  readText,
} from '../pptxInput'

const context = (): ReadContext => ({ outputDir: '/nonexistent', warnings: [] })
const list = (value: unknown, ctx = context()) => readStringList(value, 'bullets', 200, ctx)

describe('readStringList', () => {
  it('reads one item per line and drops the bullet a slide prints itself', () => {
    expect(list('- One\n* Two\n\n• Three')).toEqual(['One', 'Two', 'Three'])
  })

  it('takes the numbers off a numbered list and keeps its order', () => {
    expect(list('1. First\n2) Second\n3. Third')).toEqual(['First', 'Second', 'Third'])
    expect(list(['1. First', '2. Second'])).toEqual(['First', 'Second'])
    expect(list('1. First\n\n2. Second')).toEqual(['First', 'Second'])
    expect(list('- Intro\n1. First\n2. Second')).toEqual(['Intro', 'First', 'Second'])
  })

  it('takes off numbers of two digits and more', () => {
    const items = Array.from({ length: 12 }, (_, i) => `Item ${i + 1}`)
    expect(list(items.map((item, i) => `${i + 1}. ${item}`).join('\n'))).toEqual(items)
  })

  it('takes off a 1 that numbers every item, as Markdown allows', () => {
    expect(list('1. First\n1. Second\n1. Third')).toEqual(['First', 'Second', 'Third'])
  })

  it('keeps a number that starts an item when the text is not a list', () => {
    expect(list('2024. A record year')).toEqual(['2024. A record year'])
    expect(list(['2024. A record year', 'Revenue doubled'])).toEqual([
      '2024. A record year',
      'Revenue doubled',
    ])
  })

  it('keeps numbers that do not count the items from 1: they are part of the text', () => {
    const ctx = context()
    const years = ['2024. A record year', '2025. Another strong year']
    expect(list(years, ctx)).toEqual(years)
    expect(list(years.join('\n'), ctx)).toEqual(years)
    expect(list(years.map(year => `- ${year}`).join('\n'), ctx)).toEqual(years)
    expect(list('- Revenue\n- 2024. A record year', ctx)).toEqual([
      'Revenue',
      '2024. A record year',
    ])
    expect(list(['1. Acme', '2. Globex', '5. Initech'], ctx)).toEqual([
      '1. Acme',
      '2. Globex',
      '5. Initech',
    ])
    expect(list('4. Fourth\n5. Fifth', ctx)).toEqual(['4. Fourth', '5. Fifth'])
    expect(list('1. First\n2. Second\n2024. A record year', ctx)).toEqual([
      '1. First',
      '2. Second',
      '2024. A record year',
    ])
    expect(ctx.warnings).toEqual([])
  })

  it('sets a nested bullet at the first level and says so', () => {
    const ctx = context()
    expect(list('- Revenue\n  - EMEA up 12%\n  1. APAC flat\n- Costs', ctx)).toEqual([
      'Revenue',
      'EMEA up 12%',
      'APAC flat',
      'Costs',
    ])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('bullets line 2 is a nested bullet')
  })

  it('numbers each run of nested items on its own', () => {
    const ctx = context()
    expect(list('1. Revenue\n  1. EMEA\n  2. APAC\n2. Costs\n  1. Payroll', ctx)).toEqual([
      'Revenue',
      'EMEA',
      'APAC',
      'Costs',
      'Payroll',
    ])
    expect(ctx.warnings).toHaveLength(1)
  })

  it('keeps the numbers of nested items that do not count from 1', () => {
    const ctx = context()
    expect(list('Milestones:\n  2024. Launch\n  2025. Growth', ctx)).toEqual([
      'Milestones:',
      '2024. Launch',
      '2025. Growth',
    ])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('bullets line 2 is a nested bullet')
    expect(list('1. Plan\n  - 2024. Launch\n2. Grow')).toEqual(['Plan', '2024. Launch', 'Grow'])
  })

  it('takes the numbers off an outline numbered at every level', () => {
    const outline = [
      '1. Plan',
      '   1. Build',
      '      1. Design',
      '      2. Code',
      '   2. Ship',
      '2. Grow',
    ]
    const ctx = context()
    expect(list(outline.join('\n'), ctx)).toEqual([
      'Plan',
      'Build',
      'Design',
      'Code',
      'Ship',
      'Grow',
    ])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('bullets line 2 is a nested bullet')
    expect(list(outline)).toEqual(['Plan', 'Build', 'Design', 'Code', 'Ship', 'Grow'])
    expect(list('1. A\n  1. B\n    1. C\n    2. D\n  2. E\n2. F')).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
    ])
    expect(list('1. A\n\t1. B\n\t\t1. C\n\t2. D')).toEqual(['A', 'B', 'C', 'D'])
    expect(list('1. A\n  1. B\n  2. C\n    1. D\n  3. E')).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(list('- A\n    1. B\n    2. C\n  1. D')).toEqual(['A', 'B', 'C', 'D'])
  })

  it('counts a numbered sublist on its own under each bullet', () => {
    const steps = [
      '- Setup',
      '  - Install:',
      '    1. Download',
      '    2. Unpack',
      '  - Configure:',
      '    1. Edit config',
      '- Run',
    ]
    expect(list(steps.join('\n'))).toEqual([
      'Setup',
      'Install:',
      'Download',
      'Unpack',
      'Configure:',
      'Edit config',
      'Run',
    ])
    expect(list('- A\n  1. B\n    1. C\n    2. D\n  2. E\n- F')).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
    ])
  })

  it('takes off the numbers of a nested count carried on under the next item', () => {
    expect(list('1. A\n  1. x\n  2. y\n2. B\n  3. z')).toEqual(['A', 'x', 'y', 'B', 'z'])
    expect(list('Q1\n  1. Hire\n  2. Launch\nQ2\n  3. Expand\n  4. Raise')).toEqual([
      'Q1',
      'Hire',
      'Launch',
      'Q2',
      'Expand',
      'Raise',
    ])
    expect(list('Intro\n  1. a\n    2. b\n  3. c')).toEqual(['Intro', 'a', 'b', 'c'])
  })

  it('takes off a nested number that could count an item, wherever it is set in', () => {
    expect(list('- A\n  2. B')).toEqual(['A', 'B'])
    // One line set in a column too far or too short leaves its neighbors alone.
    const shifted = '1. Plan\n  1. Build\n    1. Design\n    2. Code\n   2. Ship\n2. Grow'
    expect(list(shifted)).toEqual(['Plan', 'Build', 'Design', 'Code', 'Ship', 'Grow'])
    const phases = [
      '1. Plan',
      '  - Phase A',
      '    1. Build',
      '      1. Design',
      '     2. Ship',
      '      1. Review',
      '  - Phase B',
    ]
    expect(list(phases)).toEqual([
      'Plan',
      'Phase A',
      'Build',
      'Design',
      'Ship',
      'Review',
      'Phase B',
    ])
    const steps = [
      '1. Plan',
      '  1. Build',
      '   1. Design',
      '      1. Draft',
      '      2. Review',
      '    2. Code',
      '    3. Test',
    ]
    expect(list(steps)).toEqual(['Plan', 'Build', 'Design', 'Draft', 'Review', 'Code', 'Test'])
  })

  it('takes off numbers set to the right, as " 9." over "10."', () => {
    const items = Array.from({ length: 11 }, (_, i) => `Item ${i + 1}`)
    const aligned = (indent: string) =>
      items.map((item, i) => `${indent}${String(i + 1).padStart(2)}. ${item}`).join('\n')
    expect(list(aligned(''))).toEqual(items)
    expect(list(`Steps:\n${aligned('  ')}`)).toEqual(['Steps:', ...items])
  })

  it('keeps the numbers of a sublist that does not count, at any depth', () => {
    const ctx = context()
    expect(
      list('1. Plan\n   1. Build\n      2024. Launch\n      2025. Growth\n2. Grow', ctx)
    ).toEqual(['Plan', 'Build', '2024. Launch', '2025. Growth', 'Grow'])
    expect(list('1. A\n  1. x\n  2. y\n2. B\n  2024. z')).toEqual(['A', 'x', 'y', 'B', '2024. z'])
    expect(list('Steps:\n  9. i\n 2024. j')).toEqual(['Steps:', '9. i', '2024. j'])
    expect(list('Steps:\n 9. i\n2024. j')).toEqual(['Steps:', '9. i', '2024. j'])
    expect(ctx.warnings).toHaveLength(1)
  })

  it('names the array entry of a nested bullet', () => {
    const ctx = context()
    list(['Revenue', '  - EMEA up 12%'], ctx)
    expect(ctx.warnings[0]).toContain('bullets[1] is a nested bullet')
  })

  it('does not take indented prose for a nested bullet', () => {
    const ctx = context()
    expect(list('Revenue\n  grew in every region', ctx)).toEqual([
      'Revenue',
      'grew in every region',
    ])
    expect(ctx.warnings).toEqual([])
  })

  it('refuses a value that is not a list', () => {
    expect(() => list({ a: 1 })).toThrow(PptxInputError)
  })
})

describe('readText', () => {
  const noted = (text: string): boolean => {
    const ctx = context()
    readText(text, 'title', 200, ctx)
    return ctx.warnings.some(w => w.includes('holds markdown or HTML'))
  }

  it('notes text the document tools would print otherwise', () => {
    for (const text of [
      '**Revenue**',
      '`npm ci`',
      '~~old~~',
      '&amp; co',
      '<b>x</b>',
      '[d](https://x.test)',
    ]) {
      expect(noted(text), text).toBe(true)
    }
  })

  it('leaves ordinary text, single asterisks included, alone', () => {
    for (const text of ['2*3*4 = 24', '*approx*', 'snake_case', 'AT&T', 'a < b > c', 'C:\\dir']) {
      expect(noted(text), text).toBe(false)
    }
  })
})

describe('readEnum', () => {
  it('accepts an allowed value and names the field of any other', () => {
    expect(readEnum('a', 'f', ['a', 'b'] as const)).toBe('a')
    expect(readEnum('', 'f', ['a'] as const)).toBeUndefined()
    expect(() => readEnum('c', 'f', ['a', 'b'] as const)).toThrow(
      'f must be one of a, b; received "c".'
    )
  })
})

describe('readKpis', () => {
  it('requires a value and reads a number as text', () => {
    const ctx = context()
    expect(readKpis([{ label: 'Revenue', value: 48 }], 'kpis', ctx)[0]).toMatchObject({
      label: 'Revenue',
      value: '48',
    })
    expect(() => readKpis([{ label: 'Revenue' }], 'kpis', ctx)).toThrow('kpis[0].value is missing')
  })
})

describe('readTable', () => {
  it('refuses a cell that is an object, naming it', () => {
    expect(() => readTable({ headers: ['A'], rows: [[{ x: 1 }]] }, 'table', context())).toThrow(
      PptxInputError
    )
  })
})
