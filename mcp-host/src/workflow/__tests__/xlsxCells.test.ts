/**
 * How one XLSX cell is read from what a model sends: which text becomes a
 * number, a percent, an amount or a date, and which stays text because
 * converting it would change it.
 */
import { describe, expect, it } from 'vitest'
import {
  cellProblem,
  codeDigits,
  currencyPrefix,
  currencySuffix,
  isQuantityText,
  looksLikeRefusedDate,
  looksLikeUnreadNumber,
  readCell,
  ruleDate,
  ruleNumber,
  startsLikeFormula,
  visualWidth,
} from '../xlsxCells'

describe('readCell', () => {
  it('keeps values that are already typed', () => {
    expect(readCell(null)).toEqual({ value: null, kind: 'empty', text: '' })
    expect(readCell(true)).toMatchObject({ value: true, kind: 'boolean' })
    expect(readCell(12.5)).toMatchObject({ value: 12.5, kind: 'number', written: 12.5 })
  })

  it('reads grouped numbers, percents and amounts', () => {
    expect(readCell('1,200')).toMatchObject({ value: 1200, kind: 'number' })
    expect(readCell('45%')).toMatchObject({ value: 0.45, kind: 'percent', written: 45 })
    expect(readCell('$1,200.50')).toMatchObject({
      value: 1200.5,
      kind: 'currency',
      currency: '$',
      written: 1200.5,
    })
    expect(readCell('−5')).toMatchObject({ value: -5, kind: 'number' })
    expect(readCell('(1,200)')).toMatchObject({ value: -1200, kind: 'number' })
  })

  it('keeps as text what a number would change', () => {
    for (const text of ['00501', '4111111111111111', '(2024)', '1,5', '1.234,50', 'N/A']) {
      expect(readCell(text), text).toMatchObject({ value: text, kind: 'text' })
    }
  })

  it('keeps text as sent when the column is not converted', () => {
    expect(readCell('1,200', false)).toEqual({ value: '1,200', kind: 'text', text: '1,200' })
  })

  it('reads ISO 8601 dates and times, and refuses one Excel would show wrong', () => {
    const date = readCell('2026-09-22')
    expect(date.kind).toBe('date')
    expect((date.value as Date).toISOString()).toBe('2026-09-22T00:00:00.000Z')
    expect(readCell('2026-09-22T10:30:00Z').kind).toBe('datetime')
    expect(readCell('2026-02-30').kind).toBe('text')
    expect(readCell('1900-02-28').kind).toBe('text')
  })
})

describe('the text a reader leaves alone', () => {
  it('names the refused dates and the numbers written for another locale', () => {
    expect(looksLikeRefusedDate('2026-02-30')).toBe(true)
    expect(looksLikeRefusedDate('2026-02-28')).toBe(false)
    for (const text of ['1.234,50', '12,5%', '22/09/2026', '1e6', '€ 1.234,50']) {
      expect(looksLikeUnreadNumber(text), text).toBe(true)
    }
    expect(looksLikeUnreadNumber('Revenue')).toBe(false)
  })

  it('tells codes from numbers', () => {
    expect(codeDigits('00501')).toBe(true)
    expect(codeDigits('1234567890123456')).toBe(true)
    expect(codeDigits('12345')).toBe(false)
  })

  it('reads currency symbols and codes on either side', () => {
    expect(currencyPrefix('$12')).toEqual(['$', 1])
    expect(currencyPrefix('EUR 12')).toEqual(['€', 4])
    expect(currencySuffix('12 €')).toEqual(['€', 1])
    expect(currencyPrefix('ABC 12')).toBeUndefined()
    expect(isQuantityText('-$5')).toBe(true)
    expect(isQuantityText('5')).toBe(false)
  })
})

describe('rule values', () => {
  it('reads a rule threshold the way a cell is read', () => {
    expect(ruleNumber('45%')).toBe(45)
    expect(ruleNumber('$1,200')).toBe(1200)
    expect(ruleNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(ruleNumber({})).toBeUndefined()
    expect(ruleDate('2026-09-22')?.toISOString()).toBe('2026-09-22T00:00:00.000Z')
    expect(ruleDate('next week')).toBeUndefined()
  })
})

describe('cellProblem', () => {
  it('accepts what a cell holds and names what it cannot', () => {
    for (const ok of [null, undefined, 'a', 1, false]) expect(cellProblem(ok)).toBeUndefined()
    expect(cellProblem(Number.NaN)).toBe('is not a finite number')
    expect(cellProblem([1])).toBe('is an array; a cell holds a single value')
    expect(cellProblem({ formula: 'NOW()' })).toContain('is an object (keys: formula)')
    expect(cellProblem(new Date(0))).toContain('is a Date object')
  })
})

describe('startsLikeFormula', () => {
  it('flags every lead Excel reads as a formula', () => {
    for (const lead of ['=1', '+1', '-1', '@x', '\tx', '\rx']) {
      expect(startsLikeFormula(lead), JSON.stringify(lead)).toBe(true)
    }
    expect(startsLikeFormula('a=1')).toBe(false)
  })
})

describe('visualWidth', () => {
  it('counts CJK and emoji as two, marks as none, and takes the widest line', () => {
    expect(visualWidth('abc')).toBe(3)
    expect(visualWidth('売上')).toBe(4)
    expect(visualWidth('é')).toBe(1)
    expect(visualWidth('ab\nabcd')).toBe(4)
  })
})
