/**
 * Spreadsheet cells as models send them.
 *
 * Numbers, percents, money and dates arrive as text ("1,234.50", "45%",
 * "$1,200", "2026-09-22") about as often as JSON numbers. Stored as text, Excel
 * cannot sum, sort or format them, so such a string is written as the value it
 * spells — unless reading it could change what it means.
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

export type CellKind =
  | 'text'
  | 'number'
  | 'percent'
  | 'currency'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'empty'

export interface SheetCell {
  /** What is written to the sheet. */
  value: string | number | boolean | Date | null
  kind: CellKind
  /** The cell as sent, as text; `contains` and `regex` rules test it. */
  text: string
  /** The number as written ('45%' is 45, '$1,200' is 1200); numeric rules compare with it. */
  written?: number
  /** Symbol a currency text carried. */
  currency?: string
  /** Written with a leading "+", which its format keeps showing. */
  signed?: boolean
  /** A time with seconds, shown with them. */
  seconds?: boolean
  /** A time with a UTC offset, moved to UTC. */
  shifted?: boolean
  /** Text left alone because it reads as two different numbers. */
  ambiguous?: boolean
}

// Groups of three with commas, or none. "1,5" and "1.234,50" stay text: which
// separator is the decimal one depends on a locale the call does not carry.
const NUMBER_CORE = /^(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)$/

/** Excel keeps 15 significant digits; longer numbers are IDs, cards or phones. */
const MAX_SIGNIFICANT_DIGITS = 15

/** Longest "+" number read as signed; international phone numbers are longer. */
const MAX_SIGNED_DIGITS = 6

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

type ParsedNumber = {
  value: number
  written: number
  percent: boolean
  currency?: string
  plus?: boolean
}

function parseNumberText(text: string): ParsedNumber | 'ambiguous' | undefined {
  // "(500)" is how accounting writes -500. "(1)" also marks a note, so the
  // parentheses are a sign only on a clear quantity, as a leading "+" is below.
  const accounting = /^\((.+)\)$/.exec(text)
  if (accounting && !/^[-+\u2212]/.test(accounting[1].trim())) {
    const inner = parseNumberText(accounting[1].trim())
    if (inner === undefined || inner === 'ambiguous') return inner
    const digits = accounting[1].replace(/\D/g, '').length
    if (!inner.currency && !inner.percent && !/[.,]/.test(accounting[1]) && digits < 3) {
      return undefined
    }
    return { ...inner, value: -inner.value, written: -inner.written }
  }
  let s = text
  let percent = false
  if (s.endsWith('%')) {
    percent = true
    s = s.slice(0, -1).trimEnd()
  }
  // A leading "+" is also how phone numbers and country codes are written, so
  // it is a sign only on a clear quantity: a percent, money, a decimal point or
  // grouping, or a number too short to be a phone number.
  let negative = s.startsWith('-')
  const plus = !negative && s.startsWith('+')
  if (negative || plus) s = s.slice(1)
  let currency: string | undefined
  const prefix = currencyPrefix(s)
  if (prefix) {
    currency = prefix[0]
    s = s.slice(prefix[1]).trimStart()
    if (!negative && s.startsWith('-')) {
      negative = true
      s = s.slice(1)
    }
  } else {
    const suffix = currencySuffix(s)
    if (suffix) {
      currency = suffix[0]
      s = s.slice(0, s.length - suffix[1]).trimEnd()
    }
  }
  if ((currency && percent) || !NUMBER_CORE.test(s)) return undefined
  if (plus && !percent && !currency && !/[.,]/.test(s) && s.length > MAX_SIGNED_DIGITS) {
    return undefined
  }
  // Leading zeros mark a code ("00123"), which a number would lose.
  if (/^0\d/.test(s)) return undefined
  if (s.replace(/\D/g, '').replace(/^0+/, '').length > MAX_SIGNIFICANT_DIGITS) return undefined
  // "1.200" is 1.2 in English and 1200 in Spanish or German.
  if (/^[1-9]\d{0,2}\.\d{3}$/.test(s)) return 'ambiguous'
  const plain = `${negative ? '-' : ''}${s.replace(/,/g, '')}`
  const written = Number(plain) || 0
  // Shifting the exponent in the text avoids 1.1 / 100 = 0.011000000000000001.
  const value = percent ? Number(`${plain}e-2`) || 0 : written
  return { value, written, percent, currency, ...(plus ? { plus } : {}) }
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/

type ParsedDate = { date: Date; time: boolean; seconds: boolean; shifted: boolean }

function parseDateText(text: string): ParsedDate | undefined {
  const m = ISO_DATE.exec(text)
  if (!m) return undefined
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [hour, minute, second] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)]
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined
  // Excel counts a 29 February 1900 that never existed, so the serial of any
  // earlier date shows one day late; those dates stay text.
  if (year < 1900 || (year === 1900 && month < 3)) return undefined
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0
  let time = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const check = new Date(time)
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined
  let offsetMinutes = 0
  if (m[8] && m[8] !== 'Z') {
    const digits = m[8].replace(':', '')
    offsetMinutes = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5) || 0)
    if (digits[0] === '-') offsetMinutes = -offsetMinutes
    time -= offsetMinutes * 60_000
  }
  return {
    date: new Date(time),
    time: m[4] !== undefined,
    seconds: m[6] !== undefined && (second !== 0 || ms !== 0),
    shifted: offsetMinutes !== 0,
  }
}

/**
 * The cell to write for `raw`. With `convert` false, text is kept as sent,
 * for columns declared as text or holding identifiers.
 */
export function readCell(raw: unknown, convert = true): SheetCell {
  if (raw === null || raw === undefined) return { value: null, kind: 'empty', text: '' }
  if (typeof raw === 'boolean') return { value: raw, kind: 'boolean', text: String(raw) }
  if (typeof raw === 'number') {
    return { value: raw, kind: 'number', text: String(raw), written: raw }
  }
  const text = String(raw)
  if (!convert) return { value: text, kind: 'text', text }
  const trimmed = text.trim()
  const date = parseDateText(trimmed)
  if (date) {
    return {
      value: date.date,
      kind: date.time ? 'datetime' : 'date',
      text,
      seconds: date.seconds,
      shifted: date.shifted,
    }
  }
  // U+2212 is the typographic minus sign.
  const parsed = parseNumberText(trimmed.replace(/^\u2212/, '-'))
  if (parsed === 'ambiguous') return { value: text, kind: 'text', text, ambiguous: true }
  if (!parsed) return { value: text, kind: 'text', text }
  return {
    value: parsed.value,
    kind: parsed.percent ? 'percent' : parsed.currency ? 'currency' : 'number',
    text,
    written: parsed.written,
    currency: parsed.currency,
    ...(parsed.plus ? { signed: true } : {}),
  }
}

const LOCALE_NUMBERS = [
  // 1.234,50 and 1.234.567: dot grouping.
  /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/,
  // 12,5: comma decimals.
  /^\d+,\d+$/,
  // 1 234,50 and 1'234.50: space or apostrophe grouping.
  /^\d{1,3}(?:[ '\u00A0\u202F]\d{3})+(?:[.,]\d+)?$/,
  // 12,34,567: Indian grouping.
  /^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$/,
  // 1e6: an exponent.
  /^\d+(?:\.\d+)?[eE][+-]?\d+$/,
]
const LOCALE_DATE = /^(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}\/\d{1,2}\/\d{1,2})$/

/**
 * Whether text kept as text is an ISO 8601 date this reader refused: one that
 * does not exist, or one before 1 March 1900, which Excel shows a day late.
 */
export function looksLikeRefusedDate(text: string): boolean {
  const s = text.trim()
  return ISO_DATE.test(s) && !parseDateText(s)
}

/**
 * Whether text kept as text spells a number or a date in a form this reader
 * does not convert ("1.234,50", "12,5%", "22/09/2026", "1e6"), so the caller
 * can be told it stayed text.
 */
export function looksLikeUnreadNumber(text: string): boolean {
  let s = text.trim()
  if (s.length > 64) return false
  if (LOCALE_DATE.test(s)) return true
  s = s.replace(/^[-+\u2212(]\s*/, '').replace(/\)$/, '')
  const prefix = currencyPrefix(s)
  if (prefix) s = s.slice(prefix[1]).trimStart()
  if (s.endsWith('%')) s = s.slice(0, -1).trimEnd()
  const suffix = currencySuffix(s)
  if (suffix) s = s.slice(0, s.length - suffix[1]).trimEnd()
  return LOCALE_NUMBERS.some(pattern => pattern.test(s))
}

/** Whether `raw` is text written as a percent or an amount of money. */
export function isQuantityText(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const s = raw.trim().replace(/^[-+\u2212]\s*/, '')
  return s.endsWith('%') || currencyPrefix(s) !== undefined || currencySuffix(s) !== undefined
}

/** Whether `text` is a run of digits a number would change: a leading zero, or over 15 of them. */
export function codeDigits(text: string): boolean {
  const s = text.trim()
  return /^\d+$/.test(s) && (/^0\d/.test(s) || s.length > MAX_SIGNIFICANT_DIGITS)
}

/** The number a rule value stands for, read the way cells are. */
export function ruleNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const cell = readCell(value)
  return cell.written
}

/** The instant a rule value names, when it is an ISO 8601 date. */
export function ruleDate(value: unknown): Date | undefined {
  return typeof value === 'string' ? parseDateText(value.trim())?.date : undefined
}

/**
 * Why `value` cannot be a cell, or undefined when it can. An object would reach
 * ExcelJS as a formula, hyperlink or rich text — a formula-injection guard that
 * only looks at strings never sees it.
 */
export function cellProblem(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : 'is not a finite number'
  }
  if (value instanceof Date) {
    return "is a Date object; send the date as ISO 8601 text such as '2026-09-22'"
  }
  if (Array.isArray(value)) return 'is an array; a cell holds a single value'
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .slice(0, 4)
      .map(k => k.slice(0, 24))
      .join(', ')
    return (
      `is an object${keys ? ` (keys: ${keys})` : ''}; formulas, links and rich text ` +
      'are not supported, so send the value itself'
    )
  }
  return `is a ${typeof value}`
}

const FORMULA_LEAD = /^[=+\-@\t\r]/

/** Text Excel would turn into a formula if the cell were edited and confirmed. */
export function startsLikeFormula(text: string): boolean {
  return FORMULA_LEAD.test(text)
}

const WIDE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u
const ZERO_WIDTH = /[\p{Mn}\p{Me}\u200B-\u200D\uFE0E\uFE0F]/u

/** Width of the widest line of `text` in Excel character units: CJK and emoji take two. */
export function visualWidth(text: string): number {
  let widest = 0
  for (const line of text.split('\n')) {
    let width = 0
    for (const ch of line) width += ZERO_WIDTH.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1
    if (width > widest) widest = width
  }
  return widest
}
