/**
 * The shape of an XLSX sheet request: its rows, its name, the columns other
 * arguments point at, and the colors it names.
 */
import { headerText, normalizeTableRows } from './tableRows'
import { cellProblem } from './xlsxCells'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Widest row. A loop, because `Math.max(...rows)` passes every row as an
 * argument and overflows the stack at about 120k rows.
 */
export function tableWidth(rows: unknown[][]): number {
  let width = 0
  for (const row of rows) if (row.length > width) width = row.length
  return width
}

/** Throws, naming the cell, when a row carries a value that is not a cell. */
function checkCells(rows: unknown, headers: unknown, label: string): void {
  const fail = (where: string, value: unknown) => {
    const problem = cellProblem(value)
    if (problem) {
      throw new Error(
        `${label}.${where} ${problem}. A cell must be text, a number, true/false or null.`
      )
    }
  }
  if (Array.isArray(headers)) headers.forEach((h, c) => fail(`headers[${c}]`, h))
  if (!Array.isArray(rows)) return
  rows.forEach((row, r) => {
    if (Array.isArray(row)) row.forEach((v, c) => fail(`rows[${r}][${c}]`, v))
    else if (isRecord(row)) for (const [k, v] of Object.entries(row)) fail(`rows[${r}].${k}`, v)
  })
}

export interface SheetTable {
  header: unknown[]
  rows: unknown[][]
}

/**
 * Header and data rows of a sheet. The header is `headers` when given, else the
 * first row; rows sent as `{Header: value}` records are read by header name,
 * and when every row is a record the header is the union of their keys.
 */
export function sheetTable(
  sheet: { rows?: unknown; headers?: unknown },
  label: string,
  warnings: string[]
): SheetTable {
  checkCells(sheet.rows, sheet.headers, label)
  if (Array.isArray(sheet.headers)) {
    const header = sheet.headers
    return { header, rows: normalizeTableRows(sheet.rows, header, label, warnings) }
  }
  if (!Array.isArray(sheet.rows)) {
    return { header: [], rows: normalizeTableRows(sheet.rows, [], label, warnings) }
  }
  const rows = sheet.rows as unknown[]
  const first = rows.findIndex(r => Array.isArray(r) || isRecord(r))
  if (first >= 0 && Array.isArray(rows[first])) {
    const header = rows[first] as unknown[]
    const rest = rows.filter((_, i) => i !== first)
    return { header, rows: normalizeTableRows(rest, header, label, warnings) }
  }
  const keys = new Set<string>()
  for (const row of rows) if (isRecord(row)) for (const k of Object.keys(row)) keys.add(k)
  const header = [...keys]
  return { header, rows: normalizeTableRows(rows, header, label, warnings) }
}

const MAX_SHEET_NAME = 31
const FORBIDDEN_SHEET_CHARS = /[\\/?*:[\]]/g

/** The longest prefix of `text` within `max` UTF-16 units that does not split a character. */
export function fitLength(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ''
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
    text
  )) {
    if (out.length + segment.length > max) break
    out += segment
  }
  return out
}

function stripQuotes(text: string): string {
  return text
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim()
}

/**
 * Sheet names Excel accepts, unique within one workbook. ExcelJS throws on an
 * empty name, "History", the characters \ / ? * : [ ], a leading or trailing
 * apostrophe and a case-insensitive duplicate — failing the whole workbook —
 * and cuts names at 31 units, which can split an emoji or make two long names
 * collide.
 */
export class SheetNames {
  // Excel reserves "History" for its change log.
  private readonly used = new Set(['history'])

  name(requested: unknown, index: number, warnings: string[]): string {
    const asked = requested === null || requested === undefined ? '' : String(requested)
    const base =
      stripQuotes(
        fitLength(stripQuotes(asked.replace(FORBIDDEN_SHEET_CHARS, '-')), MAX_SHEET_NAME)
      ) || `Sheet${index + 1}`
    let name = base
    for (let n = 2; this.used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`
      name = `${fitLength(base, MAX_SHEET_NAME - suffix.length).trimEnd()}${suffix}`
    }
    this.used.add(name.toLowerCase())
    if (name !== asked) {
      warnings.push(
        `sheets[${index}].name '${asked}' was saved as '${name}': Excel sheet names need 1 to 31 ` +
          'characters, none of \\ / ? * : [ ], no apostrophe at either end, must differ from ' +
          "each other ignoring case, and can't be History."
      )
    }
    return name
  }
}

function lettersToIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/**
 * The 0-based column `ref` names: its header text (exact, then ignoring case
 * and surrounding space), its Excel letter, or its 0-based index. Undefined
 * when it names no column of the sheet.
 */
export function resolveColumn(ref: unknown, header: unknown[], width: number): number | undefined {
  const inRange = (i: number) => (Number.isInteger(i) && i >= 0 && i < width ? i : undefined)
  if (typeof ref === 'number') return inRange(ref)
  if (typeof ref !== 'string') return undefined
  const exact = header.findIndex(h => headerText(h) === ref)
  if (exact >= 0) return exact
  const wanted = ref.trim().toLowerCase()
  const loose = header.findIndex(h => headerText(h).trim().toLowerCase() === wanted)
  if (loose >= 0) return loose
  if (/^[A-Za-z]{1,3}$/.test(wanted)) return inRange(lettersToIndex(wanted))
  if (/^\d+$/.test(wanted)) return inRange(Number(wanted))
  return undefined
}

const NAMED_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  orange: 'FFA500',
  purple: '800080',
  pink: 'FFC0CB',
  brown: 'A52A2A',
  gray: '808080',
  grey: '808080',
  navy: '000080',
  teal: '008080',
  maroon: '800000',
  olive: '808000',
  lime: '00FF00',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  silver: 'C0C0C0',
  gold: 'FFD700',
  indigo: '4B0082',
  lightgray: 'D3D3D3',
  lightgrey: 'D3D3D3',
  darkgray: 'A9A9A9',
  darkgrey: 'A9A9A9',
  lightgreen: '90EE90',
  darkgreen: '006400',
  lightblue: 'ADD8E6',
  darkblue: '00008B',
  darkred: '8B0000',
}

/**
 * ARGB for a CSS hex color ("#1e3a8a", "#fff", "#1e3a8a80"), a bare 8-digit
 * Excel ARGB ("FF1E3A8A"), rgb(), or a basic CSS name. Alpha is dropped:
 * Excel fills and fonts are opaque.
 */
export function parseColor(input: unknown): string | undefined {
  const text = String(input ?? '').trim()
  const css = text.startsWith('#')
  const hex = css ? text.slice(1) : text
  if (/^[0-9a-f]{3,4}$/i.test(hex)) {
    return `FF${[...hex.slice(0, 3)].map(c => c + c).join('')}`.toUpperCase()
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) return `FF${hex}`.toUpperCase()
  if (/^[0-9a-f]{8}$/i.test(hex)) return `FF${css ? hex.slice(0, 6) : hex.slice(2)}`.toUpperCase()
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*[,)]/i.exec(text)
  if (rgb && rgb.slice(1, 4).every(v => Number(v) <= 255)) {
    return `FF${rgb
      .slice(1, 4)
      .map(v => Number(v).toString(16).padStart(2, '0'))
      .join('')}`.toUpperCase()
  }
  const named = NAMED_COLORS[text.toLowerCase().replace(/[\s_-]+/g, '')]
  return named ? `FF${named}` : undefined
}

/**
 * parseColor for a caller's argument: an unreadable color is reported and
 * replaced by `fallback`, or ignored when there is none.
 */
export function argumentColor(
  input: unknown,
  field: string,
  warnings: string[],
  fallback?: string
): string | undefined {
  if (input === undefined || input === null || input === '') return fallback
  const argb = parseColor(input)
  if (argb) return argb
  warnings.push(
    `${field} '${String(input)}' is not a color, so ${fallback ? 'the default was used' : 'it was ignored'}; ` +
      "use a hex color such as '#1e3a8a'."
  )
  return fallback
}
