/**
 * Text cleanup applied to the arguments of every document generator.
 *
 * DOCX, XLSX and PPTX are XML, and XML 1.0 forbids most C0 control characters,
 * so one ANSI escape makes Word refuse a DOCX; the PDF renderer draws them as
 * boxes, and the markdown parsers split on '\n' only. Cleaning the arguments
 * once, before a generator reads them, covers every string that can reach a file.
 */
import { htmlToPlainText } from './inlineMarkup'

/**
 * CSI and terminated OSC sequences, then any other escape with its
 * intermediate bytes and final byte, as in ESC ( B, ESC 7 and ESC c.
 */
const ANSI_ESCAPE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[ -/]*[0-~]?/g

/** Characters XML 1.0 cannot carry, plus DEL. Tab and newline are kept. */
const UNREPRESENTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g

/** Half of a surrogate pair, left behind when a string is cut mid-emoji. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export function cleanText(text: string): string {
  return text
    .replace(/\r\n?|[\f\v\u2028\u2029]/g, '\n')
    .replace(ANSI_ESCAPE, '')
    .replace(UNREPRESENTABLE, '')
    .replace(LONE_SURROGATE, '')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const MAX_DEPTH = 64

/**
 * A copy of `value` with every string, object key included, run through
 * cleanText. A key that only matches another after cleaning is dropped: the
 * arguments were validated before cleaning, so the key already clean is the one
 * the schema checked. Values nested past MAX_DEPTH levels are kept as they are:
 * no generator reads that deep, and walking them could overflow the stack.
 */
export function cleanToolArgs<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value
  if (typeof value === 'string') return cleanText(value) as T
  if (Array.isArray(value)) return value.map(item => cleanToolArgs(item, depth + 1)) as T
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const clean = cleanText(key)
    if (Object.prototype.hasOwnProperty.call(out, clean)) continue
    if (clean !== key && Object.prototype.hasOwnProperty.call(value, clean)) continue
    // defineProperty keeps a key such as "__proto__" an ordinary own property.
    Object.defineProperty(out, clean, {
      value: cleanToolArgs(item, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out as T
}

/** Characters the document renderers draw as nothing. */
const INVISIBLE = /[­​-‏⁠-⁤﻿]/g

/** A backslash before ASCII punctuation, which markdown prints as that character. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g

/**
 * The text of every string in `args` in the forms a document generator may
 * print it: as sent, cleaned as cleanToolArgs cleans it, with HTML tags,
 * character references, backslash escapes and invisible characters taken out,
 * and with markdown markers taken out too. Text split by any of these prints
 * whole, so a check for leaked secrets that reads every form sees it whole.
 */
export function printedForms(args: unknown): string[] {
  const sent: string[] = []
  const collect = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (typeof value === 'string') sent.push(value)
    else if (Array.isArray(value)) value.forEach(item => collect(item, depth + 1))
    else if (isPlainObject(value)) Object.values(value).forEach(item => collect(item, depth + 1))
  }
  collect(args, 0)
  const cleaned = sent.map(cleanText)
  const printed = cleaned.map(text =>
    htmlToPlainText(text).replace(MARKDOWN_ESCAPE, '$1').replace(INVISIBLE, '')
  )
  const bare = printed.map(text => text.replace(/[*_~`]/g, ''))
  return [...sent, ...cleaned, ...printed, ...bare]
}
