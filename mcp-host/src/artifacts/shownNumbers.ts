/**
 * What a spreadsheet shows for a number under a number format code, so a
 * protected value it displays is found although the file only stores the
 * number: a date serial under a date format, digits under a grouping format or
 * beside quoted text. A spreadsheet renders in its viewer's locale, so a
 * protected number is looked for as any locale may write it (showsNumber),
 * with month and day names in English, German, French and Spanish, and, for
 * the built-in short date, in the date patterns locales commonly use.
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
  // Excel's euro placement tags, which move the symbol and nothing else.
  if (/^x-euro[12]$/i.test(tag)) return true
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
 * The ways a viewer may show `value` under `code` (`code` modelled), as shown;
 * compare a protected number with showsNumber, which reads any locale's
 * grouping. For a built-in short date id, pass `shortDate` to render the
 * common date patterns instead of `code`.
 */
export function shownForms(value: number, code: string, shortDate = false): string[] {
  const key = `${shortDate ? 'S' : 'C'}\u0000${code}\u0000${value}`
  const known = memo.get(key)
  if (known) return known
  const nf = numfmt()
  const forms = new Set<string>()
  for (const each of renderedCodes(code, shortDate)) {
    forms.add(nf.format(each, value, { locale: 'en', throws: false }))
    if (NAMED.test(each)) {
      for (const locale of NAME_LOCALES) {
        forms.add(nf.format(each, value, { locale, throws: false }))
      }
    }
  }
  const out = [...forms].filter(Boolean)
  if (memo.size >= MEMO_LIMIT) memo.clear()
  memo.set(key, out)
  return out
}

/** A run of digits with single separators between them, as a number is shown. */
const NUMBER_RUN = /\d+(?:[,.'\u2019\u00A0\u202F ]\d+)*/g
const RUN_PART = /\d+|[,.'\u2019\u00A0\u202F ]/g
/** Separators that only ever group digits: spaces and apostrophes, never a decimal mark. */
const BLOCK_SEPARATOR = /^[ \u00A0\u202F'\u2019]$/

/** Whether `groups` are the digit groups of one number as a locale groups thousands. */
function groupedValidly(groups: string[]): boolean {
  if (groups.length < 2) return true
  const [first, ...rest] = groups
  const last = rest[rest.length - 1]
  const western = first.length <= 3 && rest.every(group => group.length === 3)
  // Indian grouping: 3 digits last, 2 in each group before them.
  const indian =
    first.length <= 2 &&
    rest.length >= 2 &&
    last.length === 3 &&
    rest.slice(0, -1).every(group => group.length === 2)
  return western || indian
}

/** Whether every separator in `separators` is `separators[0]`. */
function oneSeparator(separators: string[]): boolean {
  return separators.every(sep => sep === separators[0])
}

/** The most groups one number is read across: 24 digits in groups of three. */
const MAX_GROUPS = 8

/**
 * The digits a stretch of digit groups and the separators between them may
 * stand for: all of them, where the separators group thousands as some locale
 * does; those before the last separator, where that one is a decimal point
 * and the rest group thousands; and, for groups set apart by spaces or
 * apostrophes only (a card or phone number), all of them as a whole number.
 * A decimal part is never joined to what comes before it: "54.32" shows 54
 * and 32, not 5432.
 */
function readStretch(groups: string[], separators: string[], within: string[], whole: string[]) {
  if (oneSeparator(separators) && groupedValidly(groups)) within.push(groups.join(''))
  const decimal = separators[separators.length - 1]
  const grouping = separators.slice(0, -1)
  if (
    (decimal === '.' || decimal === ',') &&
    (grouping.length === 0 || (oneSeparator(grouping) && grouping[0] !== decimal)) &&
    groupedValidly(groups.slice(0, -1))
  ) {
    within.push(groups.slice(0, -1).join(''))
  }
  if (separators.every(sep => BLOCK_SEPARATOR.test(sep))) whole.push(groups.join(''))
}

/**
 * Every reading of a shown run of digits and separators: each group on its
 * own, and each stretch of up to MAX_GROUPS groups read as one number (a space
 * may group thousands or just stand between two numbers, as in "Q1 15,432").
 */
function readings(run: string): { within: string[]; whole: string[] } {
  const groups: string[] = []
  const separators: string[] = []
  for (const part of run.match(RUN_PART) ?? []) {
    if (/\d/.test(part)) groups.push(part)
    else separators.push(part)
  }
  const within = [...groups]
  const whole: string[] = []
  for (let from = 0; from < groups.length; from++) {
    for (let to = from + 1; to < Math.min(groups.length, from + MAX_GROUPS); to++) {
      readStretch(groups.slice(from, to + 1), separators.slice(from, to), within, whole)
    }
  }
  return { within, whole }
}

/**
 * Whether `text` shows `secret` as a number, written as any locale writes it.
 * Only a secret that is a number counts: digits, with separators or not, at
 * least four of them; any other secret is found by its exact text instead.
 */
export function showsNumber(text: string, secret: string): boolean {
  if (!/^[\d,.'\u2019\u00A0\u202F ]+$/.test(secret)) return false
  const digits = withoutSeparators(secret)
  if (digits.length < 4 || !/\d/.test(text)) return false
  // A secret written with separators may use another locale's decimal mark.
  const asWritten = digits !== secret
  for (const run of text.match(NUMBER_RUN) ?? []) {
    const { within, whole } = readings(run)
    if (within.some(reading => reading.includes(digits))) return true
    if (whole.includes(digits)) return true
    if (asWritten && withoutSeparators(run).includes(digits)) return true
  }
  return false
}
