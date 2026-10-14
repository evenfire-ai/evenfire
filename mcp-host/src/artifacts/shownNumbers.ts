/**
 * What a spreadsheet shows for a number under a number format code, so a
 * protected value it displays is found although the file only stores the
 * number: a date serial under a date format, digits under a grouping format or
 * beside quoted text. A spreadsheet renders in its viewer's locale, so a value
 * is compared without separators (any locale's grouping reads the same), with
 * month and day names in English, German, French and Spanish, and, for the
 * built-in short date, in the date patterns locales commonly use.
 */
import type * as Numfmt from 'numfmt'

/** Excel's own limit on the length of a format code. */
export const MAX_FORMAT_CODE_LENGTH = 255

let formatter: typeof Numfmt | undefined
function numfmt(): typeof Numfmt {
  // Loaded on first use: only a scan with protected values configured needs it.
  formatter ??= require('numfmt') as typeof Numfmt
  return formatter
}

/**
 * The built-in formats ExcelJS can write by id (ECMA-376 Part 1, 18.8.30),
 * which a package names without a <numFmt> element. Other ids are not
 * modelled.
 */
const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  // As Excel shows it; ExcelJS's own table spells it 'mmss.0'.
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@',
}

/** Built-in ids a viewer shows with its own short date pattern. */
const SHORT_DATE_IDS = new Set([14, 22])
const SHORT_DATES = [
  'm/d/yyyy',
  'mm/dd/yyyy',
  'd/m/yyyy',
  'dd/mm/yyyy',
  'dd.mm.yyyy',
  'd.m.yyyy',
  'dd-mm-yyyy',
  'yyyy-mm-dd',
  'yyyy/mm/dd',
  'm/d/yy',
  'd/m/yy',
  'dd/mm/yy',
  'dd.mm.yy',
  'yy/mm/dd',
]
const SHORT_TIMES = ['h:mm', 'hh:mm', 'h:mm AM/PM']

/** The format a built-in id stands for, or undefined when the id is not modelled. */
export function builtinFormatCode(id: number): string | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_FORMATS, id) ? BUILTIN_FORMATS[id] : undefined
}

export function isShortDateId(id: number): boolean {
  return SHORT_DATE_IDS.has(id)
}

/**
 * Whether a locale tag (the part of [$...] after '$') leaves numbers and dates
 * as this module renders them: a currency with no locale, a plain locale id
 * ([$-409], [$€-407]) or a plain language tag ([$-de-DE]). An id with
 * calendar or digit bytes ([$-1070000], [$-D000409]), a system format
 * ([$-F800], [$-x-sysdate]), a calendar suffix ([$-th-TH,107]) or a tag
 * extension ([$-ja-JP-x-gannen], [$-th-TH-u-nu-thai]) is shown otherwise.
 */
function isModelledLocale(value: string): boolean {
  const dash = value.indexOf('-')
  if (dash < 0) return true
  const tag = value.slice(dash + 1)
  // Ids from 0xF000 are system formats; bytes above 0xFFFF pick a calendar or digits.
  if (/^[0-9A-F]{1,8}$/i.test(tag)) return parseInt(tag, 16) < 0xf000
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag) && !/-[a-z](?:-|$)/i.test(tag)
}

/**
 * Whether this module renders `code` the way a spreadsheet would: a code it
 * parses, within Excel's length, with no system date or time, no native
 * digit set (DBNum, NatNum) and no other calendar.
 */
export function isModelledFormatCode(code: string): boolean {
  if (code.length === 0 || code.length > MAX_FORMAT_CODE_LENGTH) return false
  const nf = numfmt()
  if (!nf.isValidFormat(code)) return false
  return nf
    .tokenize(code)
    .every(
      token =>
        token.type !== 'dbnum' &&
        token.type !== 'natnum' &&
        !(token.type === 'locale' && !isModelledLocale(String(token.value)))
    )
}

/** Whether `code` shows an integer as its plain digits, which the stored value already spells. */
export function showsIntegerAsStored(code: string, value: number): boolean {
  return /^(?:general|0|@)$/i.test(code) && Number.isInteger(value) && Math.abs(value) < 1e11
}

/** Locales rendered natively: their month and day names differ. */
const NAME_LOCALES = ['de', 'fr', 'es']

/**
 * Characters locales use to group digits or mark decimals: comma, period,
 * apostrophe (de-CH), typographic apostrophe, no-break and narrow no-break
 * space (fr), space.
 */
const SEPARATORS = /[,.'\u2019\u00A0\u202F ]/g

/**
 * `text` without separators. A value shown in any locale ("1,234.5",
 * "1.234,5", "1 234,5", "1'234.5", "12,34,567") reads the same this way, so a
 * protected value is compared in this form with each rendering: whenever it
 * occurs in some locale's rendering, its separator-free form occurs in the
 * separator-free rendering.
 */
export function withoutSeparators(text: string): string {
  return text.replace(SEPARATORS, '')
}

/** Month and day names, and AM/PM, are words a locale translates. */
const NAMED = /m{3,}|d{3,}|AM\/PM|A\/P/i

/** The codes shownForms renders a value under. */
function renderedCodes(code: string, shortDate: boolean): readonly string[] {
  if (!shortDate) return [code]
  return code.includes('h')
    ? SHORT_DATES.flatMap(date => SHORT_TIMES.map(time => `${date} ${time}`))
    : SHORT_DATES
}

const MEMO_LIMIT = 20_000
const renderCounts = new Map<string, number>()

/**
 * How many renderings shownForms makes for one value under `code`, which is
 * what a scan's time budget counts: a built-in short date is rendered in
 * every common pattern, a pattern with names in every name locale.
 */
export function renderCount(code: string, shortDate = false): number {
  const key = `${shortDate ? 'S' : 'C'}\u0000${code}`
  let count = renderCounts.get(key)
  if (count === undefined) {
    count = renderedCodes(code, shortDate).reduce(
      (n, each) => n + (NAMED.test(each) ? 1 + NAME_LOCALES.length : 1),
      0
    )
    if (renderCounts.size >= MEMO_LIMIT) renderCounts.clear()
    renderCounts.set(key, count)
  }
  return count
}

const memo = new Map<string, string[]>()

/**
 * The ways a viewer may show `value` under `code` (`code` modelled), each
 * without separators. For a built-in short date id, pass `shortDate` to render
 * the common date patterns instead of `code`.
 */
export function shownForms(value: number, code: string, shortDate = false): string[] {
  const key = `${shortDate ? 'S' : 'C'}\u0000${code}\u0000${value}`
  const known = memo.get(key)
  if (known) return known
  const nf = numfmt()
  const forms = new Set<string>()
  for (const each of renderedCodes(code, shortDate)) {
    forms.add(withoutSeparators(nf.format(each, value, { locale: 'en', throws: false })))
    if (NAMED.test(each)) {
      for (const locale of NAME_LOCALES) {
        forms.add(withoutSeparators(nf.format(each, value, { locale, throws: false })))
      }
    }
  }
  const out = [...forms].filter(Boolean)
  if (memo.size >= MEMO_LIMIT) memo.clear()
  memo.set(key, out)
  return out
}
