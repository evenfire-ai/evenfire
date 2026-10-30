/**
 * Conditional formatting for XLSX columns: each rule is checked once, and every
 * cell it styles is tested against the value as the caller wrote it.
 */
import * as vm from 'node:vm'
import safeRegex from 'safe-regex'
import { type SheetCell, ruleDate, ruleNumber } from './xlsxCells'
import { argumentColor } from './xlsxSheet'

export interface XlsxConditionalRule {
  equals?: unknown
  notEquals?: unknown
  greaterThan?: unknown
  lessThan?: unknown
  /** Inclusive `[min, max]`. */
  between?: unknown
  contains?: unknown
  regex?: unknown
  fillColor?: unknown
  fontColor?: unknown
  bold?: unknown
}

export interface PreparedRule {
  matches(cell: SheetCell): boolean
  fill?: string
  font?: string
  bold?: boolean
}

// Pattern and input are both model-supplied, and a backtracking engine takes
// exponential time on patterns such as ^(a|a)*$ that no static check catches,
// so each match runs in a vm context under a deadline. The work all rules may
// do is counted in characters rather than timed, so a busy host applies the
// same rules as an idle one.
const MAX_REGEX_PATTERN_LENGTH = 256
const MAX_REGEX_INPUT_LENGTH = 4096
/** Characters the regex rules of one workbook may test together. */
const REGEX_CHARACTER_BUDGET = 10_000_000
/** Longest one rule's match may run; an ordinary pattern takes microseconds. */
const REGEX_CALL_TIMEOUT_MS = 250

// Wrapped in a function so the script can run again in the same context.
const MATCH_ALL = new vm.Script(
  '(() => { const re = new RegExp(pattern); const out = []; for (const t of texts) out.push(re.test(t)); return out })()'
)

/** Why a regex rule was not applied. */
export type RegexSkip =
  | { reason: 'budget'; characters: number }
  | { reason: 'timeout'; ms: number }
  | { reason: 'after-timeout' }
  | { reason: 'error'; message: string }

/**
 * The regex matching of one workbook. One context serves every rule, so the
 * cost is the matching, not setting up a context per rule. After one rule
 * runs out of time the rest are not tried, which bounds how long a workbook
 * of hostile patterns can hold the host.
 */
export class RegexBudget {
  private remaining: number
  private timedOut = false
  private context?: vm.Context

  constructor(
    private readonly characters = REGEX_CHARACTER_BUDGET,
    private readonly callTimeoutMs = REGEX_CALL_TIMEOUT_MS
  ) {
    this.remaining = characters
  }

  /** Which of `texts` match `pattern`, or why they were not tested. */
  run(pattern: string, texts: string[]): boolean[] | RegexSkip {
    if (this.timedOut) return { reason: 'after-timeout' }
    const cost = texts.reduce((sum, t) => sum + t.length + 1, 0)
    if (cost > this.remaining) return { reason: 'budget', characters: this.characters }
    this.remaining -= cost
    this.context ??= vm.createContext({})
    this.context.pattern = pattern
    this.context.texts = texts
    try {
      const out = MATCH_ALL.runInContext(this.context, { timeout: this.callTimeoutMs }) as boolean[]
      return Array.from(out)
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        this.timedOut = true
        return { reason: 'timeout', ms: this.callTimeoutMs }
      }
      return { reason: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}

/** The warning for a regex rule `field` that was not applied. */
function skipNote(field: string, skip: RegexSkip): string {
  switch (skip.reason) {
    case 'budget':
      return (
        `${field}.regex was skipped: the regex rules of a workbook may test ` +
        `${skip.characters.toLocaleString('en-US')} characters together, and this one would ` +
        'pass that; use contains where a plain match will do.'
      )
    case 'timeout':
      return (
        `${field}.regex took too long to test (over ${skip.ms} ms), so the rule was skipped; ` +
        'use contains, or a pattern without repeated alternatives such as (a|a)*.'
      )
    case 'after-timeout':
      return (
        `${field}.regex was skipped: a regex rule before it took too long, so the workbook's ` +
        'remaining regex rules were not tested.'
      )
    case 'error':
      return `${field}.regex could not be tested (${skip.message}), so the rule was skipped.`
  }
}

function sameValue(cell: SheetCell, expected: unknown): boolean {
  if (cell.kind === 'empty') return expected === null || expected === ''
  if (cell.kind === 'boolean' || typeof expected === 'boolean') {
    return cell.text.toLowerCase() === String(expected).trim().toLowerCase()
  }
  if (cell.value instanceof Date) {
    return ruleDate(expected)?.getTime() === cell.value.getTime()
  }
  if (cell.written !== undefined) {
    const n = ruleNumber(expected)
    if (n !== undefined) return n === cell.written
  }
  return (
    cell.text.trim().toLowerCase() ===
    String(expected ?? '')
      .trim()
      .toLowerCase()
  )
}

function compileRegex(pattern: unknown, field: string, warnings: string[]): RegExp | undefined {
  const reject = (why: string) => {
    warnings.push(`${field} ${why}, so the rule was skipped.`)
    return undefined
  }
  if (typeof pattern !== 'string') return reject('must be text')
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return reject(`is longer than ${MAX_REGEX_PATTERN_LENGTH} characters`)
  }
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch {
    return reject('is not a valid regular expression')
  }
  // safe-regex turns away nested unbounded quantifiers (star height > 1) before
  // they spend the time budget.
  if (!safeRegex(pattern)) {
    return reject(
      'has nested repetition that can hang the match; use contains or a simpler pattern'
    )
  }
  return regex
}

/**
 * The usable rules of one `conditionalFormatting` entry. A rule that cannot
 * work is skipped with a warning naming it instead of failing the workbook.
 * `texts` are the column's cells as sent, which regex rules are run on here.
 */
export function prepareRules(
  rules: unknown,
  label: string,
  warnings: string[],
  texts: string[],
  budget: RegexBudget
): PreparedRule[] {
  if (!Array.isArray(rules)) {
    warnings.push(`${label}.rules must be an array of rules; nothing was formatted.`)
    return []
  }
  const prepared: PreparedRule[] = []
  rules.forEach((raw, i) => {
    const field = `${label}.rules[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(
        `${field} must be an object such as {"equals": "Late", "fillColor": "#fee2e2"}.`
      )
      return
    }
    const rule = raw as XlsxConditionalRule
    const bound = (key: 'greaterThan' | 'lessThan') => {
      if (rule[key] === undefined) return undefined
      const n = ruleNumber(rule[key])
      if (n === undefined)
        warnings.push(`${field}.${key} must be a number, so the rule was skipped.`)
      return n ?? null
    }
    const greaterThan = bound('greaterThan')
    const lessThan = bound('lessThan')
    if (greaterThan === null || lessThan === null) return
    let range: [number, number] | undefined
    if (rule.between !== undefined) {
      const ends = Array.isArray(rule.between) ? rule.between.map(ruleNumber) : []
      if (ends.length !== 2 || ends.some(e => e === undefined)) {
        warnings.push(`${field}.between must be [min, max], so the rule was skipped.`)
        return
      }
      range = [Math.min(ends[0]!, ends[1]!), Math.max(ends[0]!, ends[1]!)]
    }
    let regexHits: Map<string, boolean> | undefined
    if (rule.regex !== undefined) {
      const regex = compileRegex(rule.regex, `${field}.regex`, warnings)
      if (!regex) return
      const inputs = [...new Set(texts.map(t => t.slice(0, MAX_REGEX_INPUT_LENGTH)))]
      const hits = budget.run(regex.source, inputs)
      if (!Array.isArray(hits)) {
        warnings.push(skipNote(field, hits))
        return
      }
      regexHits = new Map(inputs.map((t, j) => [t, hits[j]]))
    }
    const contains = rule.contains === undefined ? undefined : String(rule.contains).toLowerCase()

    prepared.push({
      matches(cell) {
        if (rule.equals !== undefined && !sameValue(cell, rule.equals)) return false
        if (rule.notEquals !== undefined && sameValue(cell, rule.notEquals)) return false
        const n = cell.written
        if (greaterThan !== undefined && !(n !== undefined && n > greaterThan)) return false
        if (lessThan !== undefined && !(n !== undefined && n < lessThan)) return false
        if (range && !(n !== undefined && n >= range[0] && n <= range[1])) return false
        if (contains !== undefined && !cell.text.toLowerCase().includes(contains)) return false
        if (regexHits && !regexHits.get(cell.text.slice(0, MAX_REGEX_INPUT_LENGTH))) return false
        return true
      },
      fill: argumentColor(rule.fillColor, `${field}.fillColor`, warnings),
      font: argumentColor(rule.fontColor, `${field}.fontColor`, warnings),
      bold: typeof rule.bold === 'boolean' ? rule.bold : undefined,
    })
  })
  return prepared
}
