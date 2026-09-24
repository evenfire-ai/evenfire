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
// so the matching runs in a vm context under a deadline.
const MAX_REGEX_PATTERN_LENGTH = 256
const MAX_REGEX_INPUT_LENGTH = 4096
/** Time the regex rules of one workbook may take together. */
const REGEX_BUDGET_MS = 500

const MATCH_ALL = new vm.Script(
  'const re = new RegExp(pattern); const out = []; for (const t of texts) out.push(re.test(t)); out'
)

/** Time left for the regex rules of one workbook. */
export class RegexBudget {
  private remaining = REGEX_BUDGET_MS

  /** Which of `texts` match `pattern`, or undefined when the time ran out. */
  run(pattern: string, texts: string[]): boolean[] | undefined {
    if (this.remaining <= 0) return undefined
    const started = Date.now()
    try {
      const out = MATCH_ALL.runInContext(vm.createContext({ pattern, texts }), {
        timeout: Math.max(1, Math.round(this.remaining)),
      }) as boolean[]
      return Array.from(out)
    } catch {
      return undefined
    } finally {
      this.remaining -= Date.now() - started
    }
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
      if (!hits) {
        warnings.push(
          `${field}.regex took too long to test (over ${REGEX_BUDGET_MS} ms for all regex ` +
            'rules), so the rule was skipped; use contains, or a pattern without repeated ' +
            'alternatives such as (a|a)*.'
        )
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
