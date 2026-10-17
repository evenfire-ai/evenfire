/**
 * Money written as text: the currency symbols and codes a number may carry,
 * read the same by the sheet writer (xlsxCells) and the chart reader
 * (chartData).
 */

/** Symbol shown for each currency code; codes that share "$" keep a prefix. */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  INR: '₹',
  KRW: '₩',
  BRL: 'R$',
  MXN: 'MX$',
  CAD: 'CA$',
  AUD: 'A$',
  CHF: 'CHF ',
  COP: 'COP ',
  CLP: 'CLP ',
  ARS: 'ARS ',
  PEN: 'S/ ',
}

/** Symbols a price may be written with, longest first so "R$" wins over "$". */
const WRITTEN_SYMBOLS: Array<[string, string]> = [
  ['US$', '$'],
  ['MX$', 'MX$'],
  ['CA$', 'CA$'],
  ['R$', 'R$'],
  ['A$', 'A$'],
  ['$', '$'],
  ['€', '€'],
  ['£', '£'],
  ['¥', '¥'],
  ['₹', '₹'],
  ['₩', '₩'],
]

/** The currency symbol `s` opens with and the length of what spells it. */
export function currencyPrefix(s: string): [string, number] | undefined {
  for (const [written, symbol] of WRITTEN_SYMBOLS) {
    if (s.startsWith(written)) return [symbol, written.length]
  }
  const code = /^([A-Z]{3})\s?(?=[\d.-])/.exec(s)
  if (code && CURRENCY_SYMBOLS[code[1]]) return [CURRENCY_SYMBOLS[code[1]], code[0].length]
  return undefined
}

/** The currency symbol `s` closes with and the length of what spells it. */
export function currencySuffix(s: string): [string, number] | undefined {
  for (const [written, symbol] of WRITTEN_SYMBOLS) {
    if (s.endsWith(written)) return [symbol, written.length]
  }
  const code = /(?<=\d)\s?([A-Z]{3})$/.exec(s)
  if (code && CURRENCY_SYMBOLS[code[1]]) return [CURRENCY_SYMBOLS[code[1]], code[0].length]
  return undefined
}
