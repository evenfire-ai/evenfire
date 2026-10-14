/**
 * How a sheet column is read and formatted: requested formats, the plan per column, and the value and width each cell is written with.
 */
import { isModelledFormatCode } from '../artifacts/shownNumbers'
import { headerText } from './tableRows'
import {
  type SheetCell,
  codeDigits,
  isQuantityText,
  looksLikeRefusedDate,
  looksLikeUnreadNumber,
  readCell,
  startsLikeFormula,
  visualWidth,
} from './xlsxCells'
import {
  type FormatSpec,
  NUMBER_FORMATS,
  currencyFormat,
  detectFormat,
  displayedWidth,
  formatSpec,
  headerCurrency,
  isIdentifierHeader,
  percentFormat,
} from './xlsxFormats'
import { fitLength, resolveColumn } from './xlsxSheet'

/** Longest text a cell holds; Excel asks to repair a file with more. */
const MAX_CELL_TEXT = 32_767

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Columns and the format each was asked for; keys that name nothing are reported. */
export function requestedFormats(
  columnFormats: unknown,
  header: unknown[],
  width: number,
  label: string,
  warnings: string[]
): Map<number, FormatSpec> {
  const formats = new Map<number, FormatSpec>()
  if (columnFormats === undefined || columnFormats === null) return formats
  if (!isRecord(columnFormats)) {
    warnings.push(`${label}.columnFormats must be an object such as {"Revenue": "currencyUsd"}.`)
    return formats
  }
  const setBy = new Map<number, string>()
  for (const [key, value] of Object.entries(columnFormats)) {
    const col = resolveColumn(key, header, width)
    if (col === undefined) {
      warnings.push(
        `${label}.columnFormats key '${key}' matches no column; use a header text, ` +
          "a column letter such as 'B', or a 0-based index."
      )
      continue
    }
    const spec = formatSpec(value)
    if (!spec) {
      warnings.push(
        `${label}.columnFormats['${key}'] '${String(value)}' is not a format, so the column was ` +
          'formatted automatically; use currencyUsd, currency:EUR, percent, percentPoints, ' +
          "integer, decimal, plain, date, datetime, text, or an Excel code such as '#,##0.0'."
      )
      continue
    }
    if (setBy.has(col)) {
      warnings.push(
        `${label}.columnFormats keys '${setBy.get(col)}' and '${key}' name the same column; '${key}' was used.`
      )
    }
    setBy.set(col, key)
    formats.set(col, spec)
  }
  return formats
}

export interface ColumnPlan {
  spec?: FormatSpec
  explicit: boolean
  /** Format for the column's cells that fit its spec. */
  numFmt?: string
  /** Plain numbers are stored divided by it: 100 for percentage points. */
  divisor: number
  /** Some amount in the column has decimals, so currency shows cents. */
  fraction: boolean
  /** Format shared by the column's percent cells, with the places any of them needs. */
  percentFmt?: string
}

function maxAbs(values: number[]): number {
  let max = 0
  for (const v of values) if (Math.abs(v) > max) max = Math.abs(v)
  return max
}

export function planColumn(
  cells: SheetCell[],
  header: unknown,
  requested: FormatSpec | undefined,
  name: string,
  warnings: string[]
): ColumnPlan {
  const numbers: number[] = []
  const currencies = new Set<string>()
  let fraction = false
  for (const cell of cells) {
    if (cell.kind === 'number') numbers.push(cell.value as number)
    if ((cell.kind === 'number' || cell.kind === 'currency') && !Number.isInteger(cell.value)) {
      fraction = true
    }
    if (cell.currency) currencies.add(cell.currency)
  }
  const spec = requested ?? detectFormat(header, numbers)
  const written = cells.flatMap(cell => (cell.kind === 'percent' ? [cell.value as number] : []))
  const plan: ColumnPlan = {
    spec,
    explicit: requested !== undefined,
    divisor: 1,
    fraction,
    ...(written.length > 0 ? { percentFmt: percentFormat(undefined, written) } : {}),
  }
  if (!spec) return plan
  if (spec.type === 'currency') {
    const symbol =
      spec.symbol ?? headerCurrency(header) ?? (currencies.size === 1 ? [...currencies][0] : '$')
    plan.numFmt = currencyFormat(symbol, spec.decimals ?? (fraction ? 2 : 0))
  } else if (spec.type === 'percent') {
    plan.divisor = spec.points ? 100 : 1
    // Cells written as percents ('12.5%') count too, or 12.5% would show as 13%.
    const shares = cells.flatMap(cell => (cell.kind === 'percent' ? [cell.value as number] : []))
    plan.numFmt = percentFormat(spec.decimals, [...numbers.map(n => n / plan.divisor), ...shares])
    const max = maxAbs(numbers)
    const key = headerText(header)
    if (spec.points && !requested) {
      warnings.push(
        `${name}: values up to ${max} were read as percentage points (45 = 45%)` +
          (max <= 1.5 ? `; if they are fractions use columnFormats {'${key}': 'percent'}.` : '.')
      )
    } else if (!requested && numbers.length > 0) {
      warnings.push(
        `${name}: values up to ${max} were read as fractions (0.8 = 80%); if they are ` +
          `percentage points use columnFormats {'${key}': 'percentPoints'}.`
      )
    } else if (!spec.points && requested && max > 1.5) {
      warnings.push(
        `${name} is formatted as a percent, which expects fractions (0.45 = 45%), but holds ` +
          `values up to ${max}; use 'percentPoints' for values such as 45.`
      )
    }
  } else if (spec.type === 'text') {
    plan.numFmt = NUMBER_FORMATS.text
  } else {
    plan.numFmt = spec.numFmt
  }
  return plan
}

/**
 * Whether every text value in column `c` is a plain integer. Identifier columns
 * are converted only then: "02134" must stay text, and converting its
 * neighbours would leave a column of numbers and text that sorts apart.
 */
export function plainIntegers(rows: unknown[][], c: number): boolean {
  return rows.every(
    row => typeof row[c] !== 'string' || /^(?:0|[1-9]\d{0,14})$/.test(row[c].trim())
  )
}

/**
 * A value in column `c` that a number would change (a leading zero, more than
 * 15 digits), when every value there is a whole number: such a column is kept
 * as text throughout, so its values sort and match as one type.
 */
export function codeColumn(rows: unknown[][], c: number): string | undefined {
  let code: string | undefined
  for (const row of rows) {
    const v = row[c]
    if (v === null || v === undefined || v === '') continue
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0) return undefined
    } else if (typeof v !== 'string' || !/^\s*\d+\s*$/.test(v)) {
      return undefined
    } else if (code === undefined && codeDigits(v)) {
      code = v.trim()
    }
  }
  return code
}

/** Text cut to the cell limit, recording `address` when it was cut. */
export function capText<T>(value: T, address: string, cut: string[]): T {
  if (typeof value !== 'string' || value.length <= MAX_CELL_TEXT) return value
  cut.push(address)
  return fitLength(value, MAX_CELL_TEXT) as T
}

/**
 * Whether a requested format applies to `cell`. A percent or an amount in
 * another currency keeps its own format: '45%' under 'integer' would show 0,
 * and '$1,200' under 'percent' 120000%.
 */
export function fits(spec: FormatSpec, cell: SheetCell): boolean {
  const { kind } = cell
  switch (spec.type) {
    case 'text':
      return true
    case 'custom':
      if (kind === 'percent') return spec.numFmt.includes('%')
      if (kind === 'currency') return !!cell.currency && spec.numFmt.includes(cell.currency.trim())
      return kind === 'number' || kind === 'date' || kind === 'datetime'
    case 'date':
      return kind === 'number' || kind === 'date' || kind === 'datetime'
    case 'percent':
      return kind === 'number' || kind === 'percent'
    case 'currency':
      return (
        kind === 'number' ||
        (kind === 'currency' && (!cell.currency || !spec.symbol || cell.currency === spec.symbol))
      )
    default:
      return kind === 'number'
  }
}

/** The sections of a format code, split at ';' outside quotes, brackets and escapes. */
function formatSections(code: string): string[] {
  const sections: string[] = []
  let start = 0
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    if (ch === '\\') i++
    else if (ch === '"' || ch === '[') {
      const end = code.indexOf(ch === '"' ? '"' : ']', i + 1)
      i = end < 0 ? code.length : end
    } else if (ch === ';') {
      sections.push(code.slice(start, i))
      start = i + 1
    }
  }
  sections.push(code.slice(start))
  return sections
}

/** `section` with its color, condition and locale tags first, then `sign`. */
function signed(section: string, sign: string): string {
  const tags = /^(?:\[[^\]]*\])*/.exec(section)?.[0] ?? ''
  return `${tags}${sign}${section.slice(tags.length)}`
}

/**
 * `numFmt` showing a "+" before a positive value, as the cell was written. A
 * format of one section gets its negative and zero sections too, since Excel
 * would otherwise print a negative as "-+5". The sign goes after the tags that
 * open a section. A format with a text section or a condition keeps its
 * sections as they are, as does one the sign would make invalid.
 */
function withPlus(numFmt: string | undefined): string {
  const format = numFmt ?? 'General'
  const sections = formatSections(format)
  const plain = sections.map(section => section.replace(/"[^"]*"|\\./g, ''))
  if (plain.some(section => section.includes('@') || /\[[<>=]/.test(section))) return format
  const plus =
    sections.length === 1
      ? `${signed(format, '+')};${signed(format, '-')};${format}`
      : [signed(sections[0], '+'), ...sections.slice(1)].join(';')
  return isModelledFormatCode(plus) ? plus : format
}

/** The value written for `cell` and the format it is shown with. */
export function cellOutput(
  cell: SheetCell,
  plan: ColumnPlan
): { value: SheetCell['value']; numFmt?: string } {
  const out = plainCellOutput(cell, plan)
  return cell.signed && typeof out.value === 'number' && out.value > 0
    ? { ...out, numFmt: withPlus(out.numFmt) }
    : out
}

function plainCellOutput(
  cell: SheetCell,
  plan: ColumnPlan
): { value: SheetCell['value']; numFmt?: string } {
  const { spec } = plan
  const value =
    cell.kind === 'number' && plan.divisor !== 1
      ? Number(((cell.value as number) / plan.divisor).toPrecision(15))
      : cell.value
  switch (cell.kind) {
    case 'text': {
      // Under the Text format, text that starts like a formula stays text even
      // when the cell is edited, so nothing has to be added to it.
      const asText = spec?.type === 'text' || startsLikeFormula(cell.text)
      return { value, numFmt: asText ? NUMBER_FORMATS.text : undefined }
    }
    case 'boolean':
    case 'empty':
      return { value }
  }
  if (plan.explicit && spec && fits(spec, cell)) return { value, numFmt: plan.numFmt }
  switch (cell.kind) {
    case 'number':
      return { value, numFmt: plan.numFmt }
    case 'percent':
      return {
        value,
        numFmt:
          spec?.type === 'percent'
            ? plan.numFmt
            : (plan.percentFmt ?? percentFormat(undefined, [value as number])),
      }
    case 'currency':
      return { value, numFmt: currencyFormat(cell.currency ?? '$', plan.fraction ? 2 : 0) }
    case 'date':
      return { value, numFmt: NUMBER_FORMATS.date }
    default:
      return { value, numFmt: cell.seconds ? 'yyyy-mm-dd hh:mm:ss' : NUMBER_FORMATS.datetime }
  }
}

export function cellWidth(value: unknown, numFmt: string | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number' || value instanceof Date) return displayedWidth(value, numFmt)
  if (typeof value === 'boolean') return 5
  return visualWidth(String(value))
}

/** Each column's cells as they will be written: codes stay text, other columns are converted. */
export function readColumns(
  rows: unknown[][],
  header: unknown[],
  width: number,
  requested: Map<number, FormatSpec>,
  columnName: (c: number) => string,
  warnings: string[]
): SheetCell[][] {
  const columns: SheetCell[][] = Array.from({ length: width }, () => [])
  for (let c = 0; c < width; c++) {
    const format = requested.get(c)
    const code = format ? undefined : codeColumn(rows, c)
    if (code !== undefined) {
      warnings.push(
        `${columnName(c)}: kept as text because '${code}' ` +
          `${code.startsWith('0') ? 'has a leading zero' : 'has more than 15 digits'}, ` +
          'which a number would lose.'
      )
      for (const row of rows) {
        const v = row[c]
        columns[c].push(readCell(typeof v === 'number' ? String(v) : v, false))
      }
      continue
    }
    const convert = format
      ? format.type !== 'text'
      : !isIdentifierHeader(header[c]) || plainIntegers(rows, c)
    // A percent or an amount of money is never an identifier.
    for (const row of rows) {
      columns[c].push(readCell(row[c], convert || (!format && isQuantityText(row[c]))))
    }
  }
  return columns
}

/** Warnings about what a column holds: ambiguous, unread or refused values, UTC shifts and misfits. */
export function reportColumnReads(
  columns: SheetCell[][],
  requested: Map<number, FormatSpec>,
  columnName: (c: number) => string,
  warnings: string[]
): void {
  columns.forEach((cells, c) => {
    const ambiguous = cells.find(cell => cell.ambiguous)
    if (ambiguous) {
      warnings.push(
        `${columnName(c)}: '${ambiguous.text}' was kept as text because it reads as two ` +
          'different numbers depending on the locale; send numbers as JSON numbers.'
      )
    }
    const unread = requested.has(c)
      ? []
      : cells.filter(
          cell => cell.kind === 'text' && !cell.ambiguous && looksLikeUnreadNumber(cell.text)
        )
    if (unread.length > 0) {
      const sample = unread[0].text.trim()
      warnings.push(
        `${columnName(c)}: ` +
          (unread.length === 1
            ? `'${sample}' was kept as text`
            : `${unread.length} values such as '${sample}' were kept as text`) +
          '; send JSON numbers, or ISO 8601 dates such as 2026-09-22.'
      )
    }
    const refused = requested.has(c)
      ? []
      : cells.filter(cell => cell.kind === 'text' && looksLikeRefusedDate(cell.text))
    if (refused.length > 0) {
      const sample = refused[0].text.trim()
      warnings.push(
        `${columnName(c)}: ` +
          (refused.length === 1
            ? `'${sample}' was kept as text: it is not a real date, or it is`
            : `${refused.length} dates such as '${sample}' were kept as text: each is not a ` +
              'real date, or is') +
          ' before 1 March 1900, where Excel dates start.'
      )
    }
    if (cells.some(cell => cell.shifted)) {
      warnings.push(`${columnName(c)}: times with a UTC offset were converted to UTC.`)
    }
    const spec = requested.get(c)
    if (spec && spec.type !== 'text') {
      const misfits = cells.filter(
        cell =>
          cell.kind !== 'empty' && cell.kind !== 'boolean' && !cell.ambiguous && !fits(spec, cell)
      )
      if (misfits.length > 0) {
        const hint =
          spec.type === 'date'
            ? "ISO 8601 dates such as '2026-09-22'"
            : spec.type === 'custom'
              ? "JSON numbers or ISO 8601 dates such as '2026-09-22'"
              : 'JSON numbers such as 1234.5'
        const chars = [...misfits[0].text]
        const sample = chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : misfits[0].text
        const which =
          misfits.length === 1
            ? `'${sample}' does not fit the format columnFormats asked for, so it was`
            : `${misfits.length} values such as '${sample}' do not fit the format ` +
              'columnFormats asked for, so they were'
        warnings.push(`${columnName(c)}: ${which} written as sent; send ${hint}.`)
      }
    }
  })
}
