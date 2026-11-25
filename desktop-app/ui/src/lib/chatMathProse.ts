import { CHAT_MATH_MAX_SOURCE_CHARS } from '@constants/chatRendering'

const LATEX_COMMAND = /\\(?:[A-Za-z]|[,;: ])/
// Escapes used by Markdown but not by LaTeX.
const MARKDOWN_ESCAPE = /\\[^A-Za-z0-9\s\\,;:{}|%&$]/
const MARKDOWN_SYNTAX = /`|\]\(|\*\*|~~|\[\^|https?:|<\/?[a-z]+>/

const LATEX_WORDS = /\\[A-Za-z]+\*?|\{[^{}]*\}/g
const FUNCTION_NAMES =
  /(?<!\p{L})(?:sin|sen|cos|tan|cot|sec|csc|log|ln|lg|exp|max|min|lim|det|gcd|lcm|mod|dim|ker|deg|sup|inf|arg|var|cov|Pr|dx|dy|dz|dt|du|dv)(?!\p{L})/gu
// Two-letter English and Spanish words, to tell `\(ok\)` from `\(xy\)`.
const SHORT_WORD =
  /^(?:al|an|as|at|by|de|do|eg|el|en|es|go|ha|he|ie|if|in|is|it|la|le|lo|me|my|no|of|ok|on|or|se|si|so|te|to|tu|un|up|us|ve|vs|we|ya|yo)$/

const ACCENTED = /[À-ÖØ-öø-ɏ]/
// e.g. `Cost = 5 + 3`
const NAMED_VALUE = /^\p{L}+\s*=\s*[\d\s+\-*/().,%]+$/u
// Phone numbers, abbreviations, year ranges and versions.
const NOT_FORMULA = /\d\s+\d|\p{L}\.(?:\s|$)|\p{L}\.\p{L}\.|^\d{4}-\d{2,4}|^v\d|(?<!\\)[#$]/u
const SPACED_WORD = /(?<!\p{L})\p{L}{2,}\s|\s\p{L}{2,}(?!\p{L})/u
const EMPHASIS = /^\*[^*]+\*$|^_[^_]+_$/
const CURRENCY = /^\\\$\s?[\d.,]+$/

// Anchored at word starts to stay linear on long words.
const TWO_WORDS = /(?<!\p{L})\p{L}{2,}\s+\p{L}{2,}/u
const THREE_WORDS = /(?<!\p{L})\p{L}{2,}\s+\p{L}{2,}\s+\p{L}{2,}/u
const LONG_WORD = /\p{L}{4}/u
// Excludes products of symbols such as `NaCl` or `nRT`.
const PLAIN_WORD = /(?<!\p{L})\p{L}\p{Ll}{3}/u
const ONLY_LIST_OR_TABLE =
  /^(?:(?:[-*+]|\d+[.)])[ \t][^\n]*\n\s*)+(?:[-*+]|\d+[.)])[ \t][^\n]*$|^\|.*\|[ \t]*\n[ \t]*\|?[ \t]*:?-{2,}/
const WORD = /\p{Script=Latin}{2}/u

const MATH_SYMBOL = /[\u0370-\u03ff\u2200-\u22ff²³¹⁰-₟×÷±·→⇒ℝℕℤℚℂ]/u
const POWER_OR_INDEX = /[\p{L}\p{N})}\]|'][ \t]*[\^_][ \t]*[\p{L}\p{N}({\\+-]/u
const RELATION = /[\p{L}\p{N})}\]|'!²³][ \t]*[=≈≠≤≥<>][ \t]*[\p{L}\p{N}([{|\\√∑∫∞+-]/u
const SUM_OR_PRODUCT = /[\p{L}\p{N})}\]][ \t]*[+*][ \t]*[\p{L}\p{N}([{\\]/u
const CALL = /^\p{L}'*\([^()]*\)$/u
// `x`, `x'`, `(x, y)`, `[0, 1)`
const SYMBOLS = /^[([]?\s*-?(?:\p{L}|\p{N}+)'*(?:\s*,\s*-?(?:\p{L}|\p{N}+)'*)*\s*[)\]]?$/u

function wordsOf(source: string): string {
  let words = source
  // Twice, to strip nested braces.
  for (let pass = 0; pass < 2; pass++) words = words.replace(LATEX_WORDS, ' ')
  return words.replace(FUNCTION_NAMES, ' ')
}

/** Mixed pairs are accepted: `[0, 1)` is an interval. */
function bracketsClose(source: string): boolean {
  let depth = 0
  for (const char of source) {
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    if (depth < 0) return false
  }
  return depth === 0
}

/** Tells a `\(…\)` formula from parentheses escaped in Markdown. */
export function bracketsHoldMath(source: string): boolean {
  if (MARKDOWN_SYNTAX.test(source)) return false
  if (LATEX_COMMAND.test(source)) return true
  const text = source.trim()
  if (text.length > CHAT_MATH_MAX_SOURCE_CHARS) return false
  if (NAMED_VALUE.test(text)) return true
  if (
    MARKDOWN_ESCAPE.test(text) ||
    text.includes('\\\\') ||
    EMPHASIS.test(text) ||
    CURRENCY.test(text) ||
    NOT_FORMULA.test(text) ||
    ACCENTED.test(text) ||
    LONG_WORD.test(text) ||
    (SPACED_WORD.test(wordsOf(text)) && !RELATION.test(text)) ||
    TWO_WORDS.test(text) ||
    /\p{L}{2,}-\p{L}{2,}/u.test(text) ||
    /^[A-Z]{2,}$/.test(text)
  ) {
    return false
  }
  if (/^[a-z]{2}$/.test(text)) return !SHORT_WORD.test(text)
  return (
    SYMBOLS.test(text) ||
    MATH_SYMBOL.test(text) ||
    /[\^_=+\-*/<>{}|0-9]/.test(text) ||
    /\p{L}'*[([]/u.test(text) ||
    /^(?:sin|sen|cos|tan|log|ln|exp)\s+\p{L}$/u.test(text) ||
    /[\p{L}\p{N})]!$/u.test(text)
  )
}

/** Lenient: `$$` alone on its lines is math unless it reads as prose, Markdown or code. */
export function displayHoldsMath(source: string): boolean {
  const text = source.trim()
  if (!/[\p{L}\p{N}\\]/u.test(text) && !MATH_SYMBOL.test(text)) return false
  if (MARKDOWN_SYNTAX.test(text)) return false
  if (/\\[A-Za-z]/.test(text)) return true
  if (text.length > CHAT_MATH_MAX_SOURCE_CHARS || ONLY_LIST_OR_TABLE.test(text)) return false
  if (/^[,;:)!?\]}]/.test(text) || /;[ \t]*$/m.test(text)) return false
  const words = wordsOf(text)
  if (THREE_WORDS.test(words) || /\p{Lu}{4}/u.test(words)) return false
  if (/^\p{Lu}{2,}(?:_\p{Lu}{2,})+$/u.test(text)) return false
  if (RELATION.test(text) || POWER_OR_INDEX.test(text)) return true
  // Without a relation, words or adjacent numbers are prose.
  return !(PLAIN_WORD.test(words) || /\d\s+(?:\p{L}\s+)?\d/u.test(text))
}

/** Stricter for `\[…\]`, which may also be an escaped label or date. */
export function bracketDisplayHoldsMath(source: string): boolean {
  const text = source.trim()
  if (/\\[A-Za-z]/.test(text)) return displayHoldsMath(text)
  if (text.length > CHAT_MATH_MAX_SOURCE_CHARS) return false
  if (MARKDOWN_ESCAPE.test(text) || /(?<!\\)[#$]/.test(text)) return false
  // A lone symbol on one line is a label, e.g. `\[1\]`.
  const symbols = SYMBOLS.test(text) && (text.includes(',') || source.includes('\n'))
  const operators = POWER_OR_INDEX.test(text) || RELATION.test(text) || SUM_OR_PRODUCT.test(text)
  return (
    (symbols || operators || MATH_SYMBOL.test(text) || CALL.test(text)) && displayHoldsMath(text)
  )
}

/** Strict: within a sentence `$$` is also used for prices, shell variables and SQL bodies. */
export function inlineDollarsHoldMath(source: string): boolean {
  const text = source.trim()
  if (MARKDOWN_SYNTAX.test(text) || /["“”]|\('/.test(text)) return false
  const words = wordsOf(text)
  if (/\\[A-Za-z]/.test(text)) return !THREE_WORDS.test(words)
  if (text.length > CHAT_MATH_MAX_SOURCE_CHARS) return false
  if (text === source && SYMBOLS.test(text)) return true
  if (LONG_WORD.test(words) || TWO_WORDS.test(words)) return false
  if (/;/.test(text) || !bracketsClose(text)) return false
  if (/^[,;:.)!?\]}=*/<>·•–—]/.test(text) || /[+\-*/=<>_^,:]$/.test(text)) return false
  if (POWER_OR_INDEX.test(text) || RELATION.test(text)) return true
  return (
    !WORD.test(words) && (SUM_OR_PRODUCT.test(text) || MATH_SYMBOL.test(text) || CALL.test(text))
  )
}
