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
} from '../pptxInput'

const context = (): ReadContext => ({ outputDir: '/nonexistent', warnings: [] })
const list = (value: unknown, ctx = context()) => readStringList(value, 'bullets', 200, ctx)

describe('readStringList', () => {
  it('reads one item per line and drops the bullet a slide prints itself', () => {
    expect(list('- One\n* Two\n\n• Three')).toEqual(['One', 'Two', 'Three'])
  })

  it('takes the numbers off a numbered list and keeps its order', () => {
    expect(list('1. First\n2) Second\n10. Tenth')).toEqual(['First', 'Second', 'Tenth'])
    expect(list(['1. First', '2. Second'])).toEqual(['First', 'Second'])
  })

  it('keeps a number that starts an item when the text is not a list', () => {
    expect(list('2024. A record year')).toEqual(['2024. A record year'])
    expect(list(['2024. A record year', 'Revenue doubled'])).toEqual([
      '2024. A record year',
      'Revenue doubled',
    ])
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
