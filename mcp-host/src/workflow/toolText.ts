/**
 * Text cleanup applied to the arguments of every document generator.
 *
 * DOCX, XLSX and PPTX are XML, and XML 1.0 forbids most C0 control characters,
 * so one ANSI escape makes Word refuse a DOCX; the PDF renderer draws them as
 * boxes, and the markdown parsers split on '\n' only. Cleaning the arguments
 * once, before a generator reads them, covers every string that can reach a file.
 */
import { htmlToPlainText, inlineSpans } from './inlineMarkup'

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

/**
 * Characters a viewer draws as nothing (Unicode's default ignorables): bidi
 * controls, joiners, variation selectors, tags and the like.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu

/**
 * Markdown link syntax a viewer does not print: a destination of any kind
 * with its title ("](#notes)", "]( notes.md 'title')", "](<a b.md> (title))"),
 * a reference ("][r]"), a reference definition and the brackets around a
 * label. The text it runs on has its lines folded, so a definition is matched
 * wherever it stands, up to its title. Whitespace sits where only one
 * alternative can take it, and a label stops at the next bracket, so the
 * pattern stays linear.
 */
const LINK_TITLE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))`
const LINK_DESTINATION = String.raw`(?:<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))+)`
const LINK_SYNTAX = new RegExp(
  [
    String.raw`\]\([ \t]*(?:${LINK_DESTINATION}(?:[ \t]+(?:${LINK_TITLE}[ \t]*)?)?)?\)`,
    String.raw`\]\[[^\]\n]*\]`,
    String.raw`\[[^[\]\n]+\]:[ \t]*(?:<[^>\n]*>|\S+)(?:[ \t]+${LINK_TITLE})?`,
    String.raw`[[\]]`,
  ].join('|'),
  'g'
)

/** A backslash before ASCII punctuation, which markdown prints as that character. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g

/**
 * The text of every string in `args`, object keys included, in the forms a
 * document generator may print it: as sent, cleaned as cleanToolArgs cleans
 * it, with HTML tags, character references, backslash escapes and invisible
 * characters taken out, with markdown markers taken out too, and read as
 * inline markdown, where a link prints its label, and with the syntax of a
 * link of any kind taken out. Text split by any of these
 * prints whole, so a check for leaked secrets that reads every form sees it
 * whole. Keys count because a generator can print one, as an XLSX sheet prints
 * the keys of record rows as its header. Like cleanToolArgs, it reads no
 * deeper than MAX_DEPTH.
 */
export function printedForms(args: unknown): string[] {
  const sent: string[] = []
  const collect = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (typeof value === 'string') sent.push(value)
    else if (Array.isArray(value)) value.forEach(item => collect(item, depth + 1))
    else if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        sent.push(key)
        collect(item, depth + 1)
      }
    }
  }
  collect(args, 0)
  const cleaned = sent.map(cleanText)
  const printed = cleaned.map(text =>
    htmlToPlainText(text).replace(MARKDOWN_ESCAPE, '$1').replace(INVISIBLE, '')
  )
  const bare = printed.map(text => text.replace(/[*_~`]/g, ''))
  // As the PDF and DOCX generators read inline text, where a link or an image
  // prints only its label, so text one splits is seen whole.
  const spoken = cleaned.map(text =>
    inlineSpans(text)
      .map(span => span.text)
      .join('')
      .replace(INVISIBLE, '')
  )
  // As a markdown viewer prints a link of any kind: its label only.
  const unlinked = bare.map(text => text.replace(LINK_SYNTAX, ''))
  return [...sent, ...cleaned, ...printed, ...bare, ...spoken, ...unlinked]
}
