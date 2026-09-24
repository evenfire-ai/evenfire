/**
 * Number formats for XLSX columns: the keywords a caller may ask for, and the
 * format a column gets from its header and values when nobody asked.
 */
import { CURRENCY_SYMBOLS } from './xlsxCells'

export const NUMBER_FORMATS = {
  currencyUsd: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  currencyUsdInt: '"$"#,##0_);[Red]("$"#,##0)',
  percent: '0.0%',
  percentInt: '0%',
  integer: '#,##0',
  decimal: '#,##0.00',
  plain: '0',
  datetime: 'yyyy-mm-dd hh:mm',
  date: 'yyyy-mm-dd',
  text: '@',
}

/**
 * How a column is formatted. Decimals left undefined are chosen from the
 * values; `points` percents hold 45 for 45% and are divided by 100.
 */
export type FormatSpec =
  | { type: 'currency'; symbol?: string; decimals?: 0 | 2 }
  | { type: 'percent'; points: boolean; decimals?: 0 | 1 }
  | { type: 'number'; numFmt: string }
  | { type: 'date'; numFmt: string }
  | { type: 'text' }
  | { type: 'custom'; numFmt: string }

export function currencyFormat(symbol: string, decimals: number): string {
  const body = decimals > 0 ? '#,##0.00' : '#,##0'
  const literal = `"${symbol.replace(/"/g, '')}"`
  return `${literal}${body}_);[Red](${literal}${body})`
}

const KEYWORDS: Record<string, FormatSpec> = {
  currencyusd: { type: 'currency', symbol: '$', decimals: 2 },
  currencyusdint: { type: 'currency', symbol: '$', decimals: 0 },
  currency: { type: 'currency' },
  money: { type: 'currency' },
  percent: { type: 'percent', points: false, decimals: 1 },
  percentage: { type: 'percent', points: false, decimals: 1 },
  pct: { type: 'percent', points: false, decimals: 1 },
  '%': { type: 'percent', points: false, decimals: 1 },
  percentint: { type: 'percent', points: false, decimals: 0 },
  percentpoints: { type: 'percent', points: true },
  integer: { type: 'number', numFmt: NUMBER_FORMATS.integer },
  int: { type: 'number', numFmt: NUMBER_FORMATS.integer },
  decimal: { type: 'number', numFmt: NUMBER_FORMATS.decimal },
  number: { type: 'number', numFmt: NUMBER_FORMATS.decimal },
  plain: { type: 'number', numFmt: NUMBER_FORMATS.plain },
  year: { type: 'number', numFmt: NUMBER_FORMATS.plain },
  id: { type: 'number', numFmt: NUMBER_FORMATS.plain },
  date: { type: 'date', numFmt: NUMBER_FORMATS.date },
  datetime: { type: 'date', numFmt: NUMBER_FORMATS.datetime },
  timestamp: { type: 'date', numFmt: NUMBER_FORMATS.datetime },
  text: { type: 'text' },
  string: { type: 'text' },
  '@': { type: 'text' },
}

/**
 * Whether quotes and brackets close and there are at most four sections
 * (positive;negative;zero;text): Excel asks to repair a file with more.
 */
function wellFormedSections(code: string): boolean {
  let sections = 1
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (ch === '\\') i++
    else if (ch === '"' || ch === '[') {
      const end = code.indexOf(ch === '"' ? '"' : ']', i + 1)
      if (end < 0) return false
      i = end
    } else if (ch === ']') return false
    else if (ch === ';') sections++
  }
  return sections <= 4
}

/** A format code, as opposed to a word: digit placeholders or date parts only. */
function looksLikeFormatCode(code: string): boolean {
  if (/^general$/i.test(code)) return true
  if (!wellFormedSections(code)) return false
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
  return /^[0#?@.,%+\-/ :()ymdhsAMPEe_*;$€£¥]+$/.test(bare) && /[0#?@ymdhs]/i.test(bare)
}

/** The format a `columnFormats` value asks for, or undefined when it names none. */
export function formatSpec(value: unknown): FormatSpec | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  if (KEYWORDS[key]) return KEYWORDS[key]
  const code = /^(?:currency|money)[:(]?([a-z]{3})\)?$/.exec(key)?.[1] ?? key
  if (/^[a-z]{3}$/.test(code)) {
    const upper = code.toUpperCase()
    if (CURRENCY_SYMBOLS[upper]) return { type: 'currency', symbol: CURRENCY_SYMBOLS[upper] }
    if (code !== key) return { type: 'currency', symbol: `${upper} ` }
  }
  const trimmed = value.trim()
  return looksLikeFormatCode(trimmed) ? { type: 'custom', numFmt: trimmed } : undefined
}

/** Header words, lowercased and without accents: "Tasa de conversión" → tasa, de, conversion. */
export function headerTokens(header: unknown): string[] {
  return String(header ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const words = (list: string): Set<string> => new Set(list.split(' '))

/** English money words show a dollar sign. */
const MONEY_WORDS_DOLLAR = words(
  'amount amounts revenue revenues price prices cost costs fee fees charge charges payment ' +
    'payments balance balances mrr arr salary salaries spend budget income profit profits expense expenses'
)
/** Spanish and Portuguese money words name no currency, so none is shown. */
const MONEY_WORDS = words(
  'monto montos importe importes ingreso ingresos precio precios costo costos coste costes pago ' +
    'pagos saldo saldos tarifa tarifas gasto gastos presupuesto salario sueldo ganancia ganancias ' +
    'preco precos custo custos receita receitas pagamento pagamentos faturamento montante orcamento'
)
const PERCENT_WORDS = words(
  'pct percent percentage porcentaje porcentagem percentual rate tasa taxa share participacion'
)
/** Rates that are not shares of a whole. */
const NOT_PERCENT_WORDS = words('exchange fx cambio heart hourly frame bit baud')
const DATE_WORDS = words('date dates fecha fechas timestamp datetime')
/** Events that date a row alone or with "at"/"on" ("Created at"); "Accounts created" is a count. */
const DATE_EVENT_WORDS = words('created updated started completed modified')
const DATE_EVENT_LINKS = words('at on el time')
const YEAR_WORDS = words('year years yr fy ano anos anio')
/** Identifiers read as numbers only lose digits or gain separators. */
const ID_WORDS = words(
  'id ids uuid code codes codigo codigos sku ean upc isbn zip zipcode postal postcode cp cep ' +
    'phone phones telephone telefono telefone tel mobile celular movil nif rfc dni cuit cuil ' +
    'iban folio ref reference tracking ticket'
)
/** Things that are numbered; with a word for "number" the header names an identifier. */
const NUMBERED_WORDS = words(
  'invoice factura fatura account cuenta conta employee empleado order pedido customer ' +
    'cliente document documento policy poliza serial contract contrato member socio case caso ' +
    'receipt recibo transaction transaccion'
)
/** "No.", "Nº", "Número": singular only, so "Number of employees" stays a count. */
const NUMBER_WORDS = words('number no num nro numero n')

const HEADER_CODE = new RegExp(
  `(?:^|[^A-Za-z])(${Object.keys(CURRENCY_SYMBOLS).join('|')})(?![A-Za-z])`,
  'gi'
)
/** Codes that are also English words ("pen", "cop", "ars") count only in capitals. */
const WORD_CODES = new Set(['PEN', 'COP', 'ARS'])
const HEADER_SYMBOLS: Array<[string, string]> = [
  ['US$', '$'],
  ['MX$', 'MX$'],
  ['CA$', 'CA$'],
  ['R$', 'R$'],
  ['A$', 'A$'],
  ['€', '€'],
  ['£', '£'],
  ['¥', '¥'],
  ['₹', '₹'],
  ['₩', '₩'],
  ['$', '$'],
]

/** The currency a header names by code or symbol, as the symbol to show. */
export function headerCurrency(header: unknown): string | undefined {
  const text = String(header ?? '')
  for (const [, code] of text.matchAll(HEADER_CODE)) {
    const upper = code.toUpperCase()
    if (!WORD_CODES.has(upper) || code === upper) return CURRENCY_SYMBOLS[upper]
  }
  return HEADER_SYMBOLS.find(([written]) => text.includes(written))?.[1]
}

/**
 * Whether a header names an identifier: an ID, code, postcode or phone number,
 * or a numbered thing such as "Invoice No.", "Invoice #" or "Número de factura".
 */
export function isIdentifierHeader(header: unknown): boolean {
  const tokens = headerTokens(header)
  // "Ticket price" and "Code coverage %" name amounts, not identifiers.
  const amount = [MONEY_WORDS_DOLLAR, MONEY_WORDS, PERCENT_WORDS].some(set =>
    tokens.some(t => set.has(t))
  )
  if (amount || String(header ?? '').includes('%')) return false
  if (tokens.some(t => ID_WORDS.has(t))) return true
  return (
    tokens.some(t => NUMBERED_WORDS.has(t)) &&
    (tokens.some(t => NUMBER_WORDS.has(t)) || String(header ?? '').includes('#'))
  )
}

function maxAbs(values: number[]): number {
  let max = 0
  for (const v of values) if (Math.abs(v) > max) max = Math.abs(v)
  return max
}

// Excel serials for 1950-01-01 and 2100-12-31: a number outside this range
// under a "date" header is a count, not a day.
const SERIAL_MIN = 18264
const SERIAL_MAX = 73415

/** The format a column's header and numbers suggest, when no format was asked for. */
export function detectFormat(header: unknown, numbers: number[]): FormatSpec | undefined {
  if (numbers.length === 0) return undefined
  const tokens = headerTokens(header)
  const has = (set: Set<string>) => tokens.some(t => set.has(t))
  const ints = numbers.every(n => Number.isInteger(n))

  if (isIdentifierHeader(header)) {
    return ints ? { type: 'number', numFmt: NUMBER_FORMATS.plain } : undefined
  }
  const symbol = headerCurrency(header)
  if (symbol || has(MONEY_WORDS_DOLLAR)) {
    return { type: 'currency', symbol: symbol ?? '$' }
  }
  if (has(MONEY_WORDS)) {
    return { type: 'number', numFmt: ints ? NUMBER_FORMATS.integer : NUMBER_FORMATS.decimal }
  }
  const percentSign = String(header ?? '').includes('%')
  if (percentSign || (has(PERCENT_WORDS) && !has(NOT_PERCENT_WORDS))) {
    // Fractions stop at 1 (100%); a column reaching past 1.5 holds points, 45 for
    // 45%. Under a "%" header, values past 1 are points too: "Churn %" of 1.1.
    const max = maxAbs(numbers)
    return { type: 'percent', points: max > 1.5 || (percentSign && max > 1) }
  }
  const dated =
    has(DATE_WORDS) || (has(DATE_EVENT_WORDS) && (tokens.length === 1 || has(DATE_EVENT_LINKS)))
  if (dated && numbers.every(n => n >= SERIAL_MIN && n <= SERIAL_MAX)) {
    return { type: 'date', numFmt: ints ? NUMBER_FORMATS.date : NUMBER_FORMATS.datetime }
  }
  if (has(YEAR_WORDS) || (ints && numbers.every(n => n >= 1900 && n <= 2100))) {
    return { type: 'number', numFmt: NUMBER_FORMATS.plain }
  }
  return { type: 'number', numFmt: ints ? NUMBER_FORMATS.integer : decimalFormat(numbers) }
}

/** Places `n` needs to show without rounding, up to six. */
function placesOf(n: number): number {
  for (let places = 0; places < 6; places++) {
    if (Math.abs(n - Number(n.toFixed(places))) <= 1e-9 * Math.max(1, Math.abs(n))) return places
  }
  return 6
}

/** Two places, or as many as a value needs: a p-value of 0.0012 must not show 0.00. */
function decimalFormat(numbers: number[]): string {
  let places = 2
  for (const n of numbers) places = Math.max(places, placesOf(n))
  return places === 2 ? NUMBER_FORMATS.decimal : `#,##0.${'0'.repeat(places)}`
}

function wholePercents(fractions: number[]): boolean {
  return fractions.every(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9)
}

/** The numFmt a percent column gets for these stored fractions. */
export function percentFormat(decimals: 0 | 1 | undefined, fractions: number[]): string {
  const d = decimals ?? (wholePercents(fractions) ? 0 : 1)
  return d === 0 ? NUMBER_FORMATS.percentInt : NUMBER_FORMATS.percent
}

/** Approximate width of a number or date as `numFmt` displays it, in characters. */
export function displayedWidth(value: number | Date, numFmt: string | undefined): number {
  if (value instanceof Date) {
    if (!numFmt || !/h/i.test(numFmt)) return 10
    return /s/i.test(numFmt.replace(/"[^"]*"/g, '')) ? 19 : 16
  }
  if (!numFmt || numFmt === '@' || /^general$/i.test(numFmt)) {
    return Math.min(String(value).length, 11)
  }
  const section = numFmt.split(';')[0]
  const literals = (section.match(/"[^"]*"/g) ?? []).join('').replace(/"/g, '').length
  const bare = section.replace(/"[^"]*"/g, '')
  const decimals = /\.(0+)/.exec(bare)?.[1].length ?? 0
  const percent = bare.includes('%')
  const shown = Math.abs(percent ? value * 100 : value).toLocaleString('en-US', {
    useGrouping: bare.includes(','),
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  const padding = bare.includes('_') ? 1 : 0
  const sign = value < 0 ? (numFmt.includes('(') ? 2 : 1) : 0
  return shown.length + literals + (percent ? 1 : 0) + padding + sign
}
