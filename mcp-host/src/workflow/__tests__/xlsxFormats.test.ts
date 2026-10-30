/**
 * The number format an XLSX column gets: the one a caller asks for by
 * keyword or code, and the one its header and values suggest otherwise.
 */
import { describe, expect, it } from 'vitest'
import {
  NUMBER_FORMATS,
  currencyFormat,
  detectFormat,
  displayedWidth,
  formatSpec,
  headerCurrency,
  isIdentifierHeader,
  percentFormat,
} from '../xlsxFormats'

describe('formatSpec', () => {
  it('reads keywords in any case and spacing', () => {
    expect(formatSpec('Currency USD')).toEqual({ type: 'currency', symbol: '$', decimals: 2 })
    expect(formatSpec('percent-int')).toEqual({ type: 'percent', points: false, decimals: 0 })
    expect(formatSpec('date')).toEqual({ type: 'date', numFmt: NUMBER_FORMATS.date })
  })

  it('reads a currency by its code, known or not', () => {
    expect(formatSpec('EUR')).toEqual({ type: 'currency', symbol: '€' })
    expect(formatSpec('currency:xyz')).toEqual({ type: 'currency', symbol: 'XYZ ' })
  })

  it('takes an Excel format code as it is, and nothing else', () => {
    expect(formatSpec('#,##0.000')).toEqual({ type: 'custom', numFmt: '#,##0.000' })
    expect(formatSpec('bold please')).toBeUndefined()
    expect(formatSpec('toString')).toBeUndefined()
    expect(formatSpec(42)).toBeUndefined()
  })
})

describe('detectFormat', () => {
  it('formats money, percents, dates and years from the header', () => {
    expect(detectFormat('Revenue', [1200])).toEqual({ type: 'currency', symbol: '$' })
    expect(detectFormat('Price (EUR)', [10])).toEqual({ type: 'currency', symbol: '€' })
    expect(detectFormat('Monto', [1200])).toEqual({
      type: 'number',
      numFmt: NUMBER_FORMATS.integer,
    })
    expect(detectFormat('Churn rate', [0.05])).toEqual({ type: 'percent', points: false })
    expect(detectFormat('Share', [45])).toEqual({ type: 'percent', points: true })
    expect(detectFormat('Created at', [46000])).toEqual({
      type: 'date',
      numFmt: NUMBER_FORMATS.date,
    })
    expect(detectFormat('Year', [2026])).toEqual({ type: 'number', numFmt: NUMBER_FORMATS.plain })
  })

  it('keeps identifiers and exchange rates from being read as amounts or shares', () => {
    expect(detectFormat('Invoice No.', [1001])).toEqual({
      type: 'number',
      numFmt: NUMBER_FORMATS.plain,
    })
    expect(detectFormat('Exchange rate', [17.2])).toEqual({
      type: 'number',
      numFmt: NUMBER_FORMATS.decimal,
    })
  })

  it('shows as many decimals as a value needs', () => {
    expect(detectFormat('p', [0.0012])).toEqual({ type: 'number', numFmt: '#,##0.0000' })
    expect(detectFormat('x', [])).toBeUndefined()
  })
})

describe('header words', () => {
  it('names the currency of a header by code or symbol', () => {
    expect(headerCurrency('Total (MXN)')).toBe('MX$')
    expect(headerCurrency('Cost R$')).toBe('R$')
    // "pen" is a word in lowercase, a currency only in capitals.
    expect(headerCurrency('pen count')).toBeUndefined()
  })

  it('tells identifiers from counts and amounts', () => {
    expect(isIdentifierHeader('Zip code')).toBe(true)
    expect(isIdentifierHeader('Número de factura')).toBe(true)
    expect(isIdentifierHeader('Number of employees')).toBe(false)
    expect(isIdentifierHeader('Ticket price')).toBe(false)
  })
})

describe('formats and widths', () => {
  it('writes currency formats with the symbol quoted', () => {
    expect(currencyFormat('€', 2)).toBe('"€"#,##0.00_);[Red]("€"#,##0.00)')
    expect(currencyFormat('a"b', 0)).toBe('"ab"#,##0_);[Red]("ab"#,##0)')
  })

  it('shows whole percents without a decimal', () => {
    expect(percentFormat(undefined, [0.25, 0.5])).toBe(NUMBER_FORMATS.percentInt)
    expect(percentFormat(undefined, [0.255])).toBe(NUMBER_FORMATS.percent)
  })

  it('measures a value as its format shows it', () => {
    expect(displayedWidth(1234567, NUMBER_FORMATS.integer)).toBe('1,234,567'.length)
    expect(displayedWidth(new Date(0), NUMBER_FORMATS.date)).toBe(10)
    expect(displayedWidth(new Date(0), NUMBER_FORMATS.datetime)).toBe(16)
  })
})
