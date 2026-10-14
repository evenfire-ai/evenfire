/**
 * How a sheet column is read and formatted: requested formats, the plan per column, and the value and width each cell is written with.
 */
import { headerText } from './tableRows'
import { type SheetCell, codeDigits, startsLikeFormula, visualWidth } from './xlsxCells'
import {
  type FormatSpec,
  NUMBER_FORMATS,
  currencyFormat,
  detectFormat,
  displayedWidth,
  formatSpec,
  headerCurrency,
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

interface ColumnPlan {
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

/** The value written for `cell` and the format it is shown with. */
/**
 * `numFmt` showing a "+" before a positive value, as the cell was written. A
 * format of one section gets its negative and zero sections too, since Excel
 * would otherwise print a negative as "-+5".
 */
function withPlus(numFmt: string | undefined): string {
  const format = numFmt ?? 'General'
  const sections = format.split(';')
  if (sections.length === 1) return `+${format};-${format};${format}`
  return [`+${sections[0]}`, ...sections.slice(1)].join(';')
}

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
