import { logger } from '../../logger'
import { Safety } from '../interfaces'
import { isPrivateIp } from '../tools/httpRequest'
import { SanitizedOutput, ValidationResult } from '../types'

/**
 * Basic safety implementation.
 *
 * Enforces the four checkpoints from the spec (section 6.1):
 * 1. Input validation
 * 2. Tool parameter validation
 * 3. Output sanitization
 * 4. LLM context wrapping
 *
 * This is a minimal viable implementation. Enhanced safety
 * (PII detection, rate limiting, content policy) can be added
 * by implementing the Safety interface and injecting via DI.
 */
/**
 * Returns the current set of secret name/value pairs whose plaintext should
 * be redacted from tool output. Called on every sanitize pass so a rotation
 * via ConfigStore takes effect immediately.
 */
export type SecretEntriesProvider = () => Array<{ name: string; value: string }>

// Any opening or closing `tool_output` tag, whatever its attributes, spacing or
// case, closed or not: the model must not read a forged wrapper boundary inside
// the content. `[^<>]*` stops at the next `<`, so each match scans only up to
// the next tag start and the whole pass stays linear; the optional `>` escapes
// an unclosed forged tag too. The replacement only escapes `<` and `>`, so no
// text is lost.
const TOOL_OUTPUT_TAG_PATTERN = /<(?:\s*\/)?\s*tool_output\b[^<>]*>?/gi

function wrapToolOutput(toolName: string, content: string, wasSanitized: boolean): string {
  const escaped = content.replace(TOOL_OUTPUT_TAG_PATTERN, tag =>
    tag.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  )
  return `<tool_output name="${toolName}" sanitized="${wasSanitized}">\n${escaped}\n</tool_output>`
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

type RedactionRange = { start: number; end: number; replacement: string }
// `scalar`: the piece is a whole number or literal, replaced by a JSON string.
type RedactionPiece = RedactionRange & { scalar: boolean }

/**
 * String tokens of a valid JSON text, found in one iterative scan. `tokenOf[i]`
 * is the index of the token whose inner span (between its quotes, escapes still
 * encoded) holds code unit `i`, or -1 outside every string. `escapeOffset[i]`
 * is the distance from code unit `i` back to the backslash that opens the
 * escape sequence holding it, or 0 when `i` is not inside one past its start.
 */
function scanJsonStrings(text: string): {
  tokens: Array<{ start: number; end: number }>
  tokenOf: Int32Array
  escapeOffset: Uint8Array
} {
  const tokens: Array<{ start: number; end: number }> = []
  const tokenOf = new Int32Array(text.length).fill(-1)
  const escapeOffset = new Uint8Array(text.length)
  let i = 0
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x22) {
      i++
      continue
    }
    const start = i + 1
    let j = start
    while (j < text.length && text.charCodeAt(j) !== 0x22) {
      if (text.charCodeAt(j) === 0x5c) {
        const length = text.charCodeAt(j + 1) === 0x75 ? 6 : 2
        for (let k = 1; k < length; k++) escapeOffset[j + k] = k
        j += length
      } else {
        j++
      }
    }
    if (j >= text.length) throw new Error('scanJsonStrings: unterminated string in valid JSON')
    tokenOf.fill(tokens.length, start, j)
    tokens.push({ start, end: j })
    i = j + 1
  }
  return { tokens, tokenOf, escapeOffset }
}

/**
 * A working copy of a text that redaction rules rewrite in turn, with the
 * range of the original text behind each of its code units. An original code
 * unit stands for itself; a replacement's code units stand for the union of
 * the ranges it replaced, so a later match that covers part of an earlier
 * replacement covers everything that replacement stands for, and a match
 * `[a, b)` stands for the range from code unit `a`'s start to code unit
 * `b - 1`'s end.
 *
 * Only the replacements are stored, as segments sorted along the copy: code
 * units `[textStart, textEnd)` stand for `[origStart, origEnd)`. The code
 * units between two segments are original and consecutive, and the first one
 * after a segment stands for that segment's `origEnd`, so the bookkeeping of a
 * replacement costs time in the number of segments, not in the length of the
 * text. Rebuilding the copy itself still costs time in its length.
 */
class RedactionReplay {
  text: string
  readonly ranges: RedactionRange[] = []
  private count = 0
  private textStart = new Int32Array(0)
  private textEnd = new Int32Array(0)
  private origStart = new Int32Array(0)
  private origEnd = new Int32Array(0)

  constructor(content: string) {
    this.text = content
  }

  /**
   * Replaces sorted, non-overlapping, non-empty `matches` of `text` with a
   * non-empty `replacement`.
   */
  replace(matches: Array<[number, number]>, replacement: string): void {
    if (matches.length === 0) return
    if (replacement.length === 0) throw new Error('RedactionReplay: empty replacement')
    // Each match adds its own segment, and one more when it lies strictly
    // inside a segment, which it cuts into a part before and a part after it.
    // Typed arrays drop writes past their end, so the count is checked below.
    const capacity = this.count + 2 * matches.length
    const textStart = new Int32Array(capacity)
    const textEnd = new Int32Array(capacity)
    const origStart = new Int32Array(capacity)
    const origEnd = new Int32Array(capacity)
    let count = 0
    const parts: string[] = []
    let cursor = 0
    let shift = 0
    let k = 0
    // The end of the last segment before the current position, in the
    // current copy and in the original: an original code unit `p` after it
    // stands for `prevOrigEnd + (p - prevTextEnd)`.
    let prevTextEnd = 0
    let prevOrigEnd = 0
    for (const [a, b] of matches) {
      while (k < this.count && this.textEnd[k] <= a) {
        textStart[count] = this.textStart[k] + shift
        textEnd[count] = this.textEnd[k] + shift
        origStart[count] = this.origStart[k]
        origEnd[count] = this.origEnd[k]
        count++
        prevTextEnd = this.textEnd[k]
        prevOrigEnd = this.origEnd[k]
        k++
      }
      let start: number
      if (k < this.count && this.textStart[k] <= a) {
        start = this.origStart[k]
        if (this.textStart[k] < a) {
          // Keep the part of the segment before the match.
          textStart[count] = this.textStart[k] + shift
          textEnd[count] = a + shift
          origStart[count] = this.origStart[k]
          origEnd[count] = this.origEnd[k]
          count++
        }
      } else {
        start = prevOrigEnd + (a - prevTextEnd)
      }
      let last = -1
      while (k < this.count && this.textStart[k] < b) {
        last = k
        k++
      }
      let end: number
      if (last !== -1 && this.textEnd[last] > b) {
        end = this.origEnd[last]
        // Keep the part of the segment after the match for the next one.
        k = last
        this.textStart[last] = b
      } else {
        if (last !== -1) {
          prevTextEnd = this.textEnd[last]
          prevOrigEnd = this.origEnd[last]
        }
        end = prevOrigEnd + (b - prevTextEnd)
      }
      this.ranges.push({ start, end, replacement })
      textStart[count] = a + shift
      textEnd[count] = a + shift + replacement.length
      origStart[count] = start
      origEnd[count] = end
      count++
      parts.push(this.text.slice(cursor, a), replacement)
      cursor = b
      shift += replacement.length - (b - a)
    }
    for (; k < this.count; k++) {
      textStart[count] = this.textStart[k] + shift
      textEnd[count] = this.textEnd[k] + shift
      origStart[count] = this.origStart[k]
      origEnd[count] = this.origEnd[k]
      count++
    }
    if (count > capacity) throw new Error('RedactionReplay: segment capacity exceeded')
    parts.push(this.text.slice(cursor))
    this.text = parts.join('')
    this.count = count
    this.textStart = textStart
    this.textEnd = textEnd
    this.origStart = origStart
    this.origEnd = origEnd
  }
}

/**
 * Whether every code unit of each queried range lies in some range of
 * `ranges`. Ranges that overlap or touch are joined first, so a queried range
 * is covered exactly when one joined range holds it.
 */
function coverageOf(ranges: RedactionRange[]): (start: number, end: number) => boolean {
  const sorted = [...ranges].sort((x, y) => x.start - y.start)
  const starts: number[] = []
  const ends: number[] = []
  for (const range of sorted) {
    const last = ends.length - 1
    if (last >= 0 && range.start <= ends[last]) {
      if (range.end > ends[last]) ends[last] = range.end
    } else {
      starts.push(range.start)
      ends.push(range.end)
    }
  }
  return (start, end) => {
    // The last joined range that starts at or before `start`.
    let low = 0
    let high = starts.length - 1
    let found = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (starts[middle] <= start) {
        found = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return found !== -1 && ends[found] >= end
  }
}

// JSON punctuation and whitespace: the bytes outside a string that the in-place
// redaction keeps. Every other byte outside a string belongs to a number or a
// literal.
function isJsonStructural(code: number): boolean {
  return (
    code === 0x22 || // "
    code === 0x7b || // {
    code === 0x7d || // }
    code === 0x5b || // [
    code === 0x5d || // ]
    code === 0x3a || // :
    code === 0x2c || // ,
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d
  )
}

/**
 * For every code unit outside JSON punctuation and whitespace, the bounds of
 * the run of such code units holding it. Outside strings, that run is one
 * number or literal, bounded by punctuation, whitespace or the text's ends.
 */
function scalarBounds(text: string): { start: Int32Array; end: Int32Array } {
  const start = new Int32Array(text.length)
  const end = new Int32Array(text.length)
  let i = 0
  while (i < text.length) {
    if (isJsonStructural(text.charCodeAt(i))) {
      i++
      continue
    }
    let j = i + 1
    while (j < text.length && !isJsonStructural(text.charCodeAt(j))) j++
    start.fill(i, i, j)
    end.fill(j, i, j)
    i = j
  }
  return { start, end }
}

function patternMatches(text: string, pattern: RegExp): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) {
      throw new Error(`redaction pattern ${pattern} matched an empty string`)
    }
    matches.push([match.index, match.index + match[0].length])
  }
  return matches
}

type MatchFinder = (text: string) => Array<[number, number]>

/**
 * Each password label with its value, which runs to the next whitespace, `,`
 * or `;` and must be at least 8 code units long; values that overlap are
 * joined. Unlike one global regex, a label inside an earlier label's value
 * still starts a value of its own (`pwd :abcdefghpasswd =pwd=Ab3x`).
 */
function passwordValueMatches(text: string): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  const separatorPattern = /[\s,;]/g
  let separator = 0
  for (const label of text.matchAll(/(?:password|passwd|pwd)\s*[:=]\s*/gi)) {
    const valueStart = label.index + label[0].length
    // Value starts only grow, so a separator found for an earlier value is
    // still the next one when it is not before this value's start.
    if (separator < valueStart) {
      separatorPattern.lastIndex = valueStart
      separator = separatorPattern.exec(text)?.index ?? text.length
    }
    if (separator - valueStart < 8) continue
    const last = matches[matches.length - 1]
    if (last && label.index < last[1]) last[1] = separator
    else matches.push([label.index, separator])
  }
  return matches
}

// The same non-overlapping, left-to-right occurrences `split` finds.
function literalMatches(text: string, form: string): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  let at = text.indexOf(form)
  while (at !== -1) {
    matches.push([at, at + form.length])
    at = text.indexOf(form, at + form.length)
  }
  return matches
}

/**
 * Replaces each range of `content`. Ranges that overlap are joined into one,
 * replaced by `[REDACTED]` when their replacements differ; ranges that only
 * touch stay separate.
 */
function applyRedactionRanges(
  content: string,
  ranges: RedactionRange[],
  mixedReplacement: string
): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)
  const parts: string[] = []
  let cursor = 0
  let current: RedactionRange | undefined
  for (const range of sorted) {
    if (current && range.start < current.end) {
      if (range.end > current.end) current.end = range.end
      if (range.replacement !== current.replacement) current.replacement = mixedReplacement
      continue
    }
    if (current) {
      parts.push(content.slice(cursor, current.start), current.replacement)
      cursor = current.end
    }
    current = { ...range }
  }
  if (current) {
    parts.push(content.slice(cursor, current.start), current.replacement)
    cursor = current.end
  }
  parts.push(content.slice(cursor))
  return parts.join('')
}

export class BasicSafety implements Safety {
  /**
   * Optional callback that returns ConfigStore-managed secret values. When
   * present, `sanitizeOutput` and `sanitizeAssistantResponse` will replace
   * any occurrence of those values in their input with `[REDACTED:<KEY>]`.
   *
   * This is defense-in-depth on top of the regex-based SECRET_PATTERNS:
   * regexes only catch well-known credential shapes; this catches values
   * an operator explicitly told us to treat as secret, regardless of shape.
   */
  constructor(private readonly secretEntriesProvider?: SecretEntriesProvider) {}

  // Cache patterns as static class constants
  private static readonly INJECTION_PATTERNS: RegExp[] = [
    /<\/?system>/gi,
    /<\/?assistant>/gi,
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    /<<SYS>>/gi,
    /<<\/SYS>>/gi,
  ]

  // Each entry is one rule.
  private static readonly SECRET_PATTERNS: Array<RegExp | MatchFinder> = [
    /(?:sk|pk|api)[_-](?:live|test|prod)[_-][a-zA-Z0-9]{16,}/g,
    /(?:ghp|gho|ghs|ghr)_[a-zA-Z0-9]{36,}/g,
    /(?:xox[bprs])-[a-zA-Z0-9-]+/g,
    /Bearer\s+[a-zA-Z0-9._~+\/=-]{20,}/gi,
    /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    // Password values, from every password label to the next separator, so
    // a value that holds a label (`password=abc=pwd=defghijk`) is covered
    // whole.
    passwordValueMatches,
    // AWS access keys
    /AKIA[0-9A-Z]{16}/g,
    // Slack webhook URLs
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9\/]+/g,
  ]

  private static readonly INJECTION_REPLACEMENT = '[filtered]'
  private static readonly SECRET_REPLACEMENT = '[REDACTED]'

  private static readonly ASSISTANT_RESPONSE_FILTER_PATTERNS: Array<{
    pattern: RegExp
    replacement: string
    warning: string
  }> = [
    {
      // A closed tag is removed whole. An unclosed one loses only `<tool_output`,
      // because this replacement removes text and the prose after it must stay.
      // `[^<>]*` keeps the scan linear (see TOOL_OUTPUT_TAG_PATTERN).
      pattern: /<(?:\s*\/)?\s*tool_output\b(?:[^<>]*>)?/gi,
      replacement: '[filtered]',
      warning: 'Potential tool_output tag filtered from assistant response',
    },
  ]

  private static readonly HTTP_BLOCKED_HOST_PATTERNS: Array<{
    pattern: RegExp
    reason: string
  }> = [
    {
      pattern: /^localhost$/i,
      reason: 'localhost targets are not allowed',
    },
    {
      pattern: /^kubernetes\.default(?:\.svc(?:\.cluster\.local)?)?$/i,
      reason: 'Kubernetes API service targets are not allowed',
    },
    {
      pattern: /\.svc(?:\.cluster\.local)?$/i,
      reason: 'cluster service domains are not allowed',
    },
    {
      pattern: /\.cluster\.local$/i,
      reason: 'cluster-local domains are not allowed',
    },
    {
      pattern: /^metadata\.google\.internal$/i,
      reason: 'cloud metadata endpoints are not allowed',
    },
  ]

  private static readonly SHELL_BLOCKED_PATTERNS: Array<{
    pattern: RegExp
    reason: string
  }> = [
    {
      pattern: /\/var\/run\/secrets\/kubernetes\.io\/serviceaccount/i,
      reason: 'service account token paths are blocked',
    },
    {
      pattern: /\/proc\/self\/environ/i,
      reason: 'process environment dumps are blocked',
    },
    {
      pattern: /169\.254\.169\.254/i,
      reason: 'cloud metadata endpoints are blocked',
    },
    {
      pattern: /\bkubernetes\.default(?:\.svc(?:\.cluster\.local)?)?\b/i,
      reason: 'Kubernetes API service targets are blocked',
    },
    {
      pattern: /\b[a-z0-9.-]+\.svc(?:\.cluster\.local)?\b/i,
      reason: 'cluster service domains are blocked',
    },
    {
      pattern: /\bmetadata\.google\.internal\b/i,
      reason: 'cloud metadata endpoints are blocked',
    },
  ]

  /**
   * Checkpoint 1: Validate user input before LLM sees it.
   */
  validateInput(input: string): ValidationResult {
    const errors: string[] = []

    if (!input || input.trim().length === 0) {
      errors.push('Empty input')
    }
    if (input.length > 50000) {
      errors.push('Input exceeds maximum length (50,000 characters)')
    }

    const valid = errors.length === 0
    logger.info(
      { component: 'Safety', length: input?.length ?? 0, passed: valid },
      'Input validated'
    )
    return { is_valid: valid, errors }
  }

  /**
   * Checkpoint 2: Validate tool parameters before execution.
   *
   * Basic implementation: passthrough. MCP servers handle their
   * own parameter validation via JSON Schema.
   * Future: add custom rules per tool.
   */
  validateToolParams(toolName: string, params: Record<string, unknown>): ValidationResult {
    if (toolName === 'http_request') {
      return this.validateHttpRequestParams(params)
    }

    if (toolName === 'shell_exec') {
      return this.validateShellExecParams(params)
    }

    return { is_valid: true, errors: [] }
  }

  private validateHttpRequestParams(params: Record<string, unknown>): ValidationResult {
    const errors: string[] = []
    const rawUrl = params.url

    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
      return {
        is_valid: false,
        errors: ['http_request.url must be a non-empty string'],
      }
    }

    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return { is_valid: false, errors: ['http_request.url must be a valid URL'] }
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      errors.push(`Protocol "${url.protocol}" is not allowed`)
    }

    const hostname = url.hostname.trim().toLowerCase()
    if (!hostname) {
      errors.push('URL hostname is required')
    }

    if (hostname && isPrivateIp(hostname)) {
      errors.push(`Non-public target "${hostname}" is blocked`)
    }

    for (const rule of BasicSafety.HTTP_BLOCKED_HOST_PATTERNS) {
      if (rule.pattern.test(hostname)) {
        errors.push(rule.reason)
      }
    }

    return { is_valid: errors.length === 0, errors }
  }

  private validateShellExecParams(params: Record<string, unknown>): ValidationResult {
    const command = params.command
    if (typeof command !== 'string' || command.trim().length === 0) {
      return {
        is_valid: false,
        errors: ['shell_exec.command must be a non-empty string'],
      }
    }

    const errors = BasicSafety.SHELL_BLOCKED_PATTERNS.filter(rule =>
      rule.pattern.test(command)
    ).map(rule => rule.reason)

    return { is_valid: errors.length === 0, errors }
  }

  /**
   * Checkpoint 3: Sanitize tool output after execution.
   *
   * Strips potential prompt injection patterns that could
   * cause the LLM to deviate from its instructions.
   */
  sanitizeOutput(toolName: string, output: string): SanitizedOutput {
    const result = this.sanitizeToolOutputContent(toolName, output)
    logger.info(
      {
        component: 'Safety',
        toolName,
        sanitized: result.was_modified,
        warningCount: result.warnings.length,
      },
      'Tool output sanitized'
    )
    return result
  }

  sanitizeAssistantResponse(response: string): SanitizedOutput {
    const result = this.sanitizeFreeformContent(response, {
      secretWarning: 'Potential secret detected in assistant response',
      extraFilters: BasicSafety.ASSISTANT_RESPONSE_FILTER_PATTERNS,
    })
    logger.info(
      { component: 'Safety', sanitized: result.was_modified, warningCount: result.warnings.length },
      'Assistant response sanitized'
    )
    return result
  }

  /**
   * Checkpoint 4: Wrap tool output for LLM context.
   *
   * Risk 4.10: Escape closing tags in content to prevent XML injection.
   * The LLM sees: <tool_output name="x" sanitized="true">content</tool_output>
   * If content contains </tool_output>, the LLM could interpret it as end-of-output.
   */
  wrapForLlm(toolName: string, content: string, wasSanitized: boolean): string {
    // Risk 4.10: Escape potential closing tags in content
    const wrapped = wrapToolOutput(toolName, content, wasSanitized)
    logger.info(
      { component: 'Safety', toolName, wrappedLength: wrapped.length },
      'Tool output wrapped'
    )
    return wrapped
  }

  previewOutputForLlm(toolName: string, content: string): string {
    const sanitized = this.sanitizeToolOutputContent(toolName, content)
    return wrapToolOutput(toolName, sanitized.content, sanitized.was_modified)
  }

  /**
   * Tool-output redaction that keeps JSON output parseable. The text pass
   * (`sanitizeFreeformContent`) runs over the raw text, so a match can swallow
   * JSON syntax: a password value, which runs to the next whitespace, `,` or
   * `;`, eats a closing `"}`, and a raw `\n` escape is not whitespace to it. The text-pass result is
   * returned unchanged when it did not modify the output, when it still
   * parses, or when the original output does not parse.
   *
   * Otherwise the redaction is redone in place on the original text:
   * 1. One iterative scan records the inner span of every string token, keys
   *    and values alike, with escapes still encoded.
   * 2. The ranges are the ones the text pass applies (`redactionPlan`): every
   *    rule's matches on the replayed working copy, mapped back to the
   *    original text, plus its matches on the original text itself.
   * 3. Each match is clipped to every string it covers and widened to whole
   *    escape sequences. A number or literal (`true`, `false`, `null`) the
   *    match covers in part or whole is replaced whole by the replacement as
   *    a JSON string. JSON punctuation and whitespace are kept. A match that
   *    covers neither a string nor a scalar returns the text-pass result.
   * 4. Pieces that overlap or touch inside one token are merged (`[REDACTED]`
   *    when their replacements differ) and spliced in. Every byte outside the
   *    replaced pieces stays as it was.
   * 5. If that result does not parse, the text-pass result is returned.
   * The warnings are always the text pass's.
   */
  private sanitizeToolOutputContent(toolName: string, content: string): SanitizedOutput {
    const plan = this.redactionPlan(content, {
      secretWarning: `Potential secret detected in ${toolName} output`,
    })
    const textPass = this.applyRedactionPlan(content, plan)
    if (!textPass.was_modified || parsesAsJson(textPass.content) || !parsesAsJson(content)) {
      return textPass
    }
    const { tokens, tokenOf, escapeOffset } = scanJsonStrings(content)
    let scalars: { start: Int32Array; end: Int32Array } | undefined
    const pieces: RedactionPiece[] = []
    for (const range of plan.ranges) {
      let touched = false
      let i = range.start
      while (i < range.end) {
        const token = tokenOf[i]
        if (token === -1) {
          if (isJsonStructural(content.charCodeAt(i))) {
            i++
            continue
          }
          // Outside strings, a run of non-structural bytes is one number or
          // literal. Its bounds are computed once, so many matches inside one
          // long number cost one pass over it.
          scalars ??= scalarBounds(content)
          const end = scalars.end[i]
          pieces.push({
            start: scalars.start[i],
            end,
            replacement: range.replacement,
            scalar: true,
          })
          touched = true
          i = end
          continue
        }
        const tokenEnd = tokens[token].end
        let start = i
        let end = Math.min(range.end, tokenEnd)
        start -= escapeOffset[start]
        if (end < tokenEnd && escapeOffset[end] > 0) {
          const escapeStart = end - escapeOffset[end]
          end = escapeStart + (content.charCodeAt(escapeStart + 1) === 0x75 ? 6 : 2)
        }
        pieces.push({ start, end, replacement: range.replacement, scalar: false })
        touched = true
        i = tokenEnd
      }
      if (!touched) return textPass
    }

    // A string piece ends at most at its closing quote and a scalar piece at
    // the byte before the next punctuation or whitespace; the next token starts
    // at least one code unit after either, so merging sorted pieces that
    // overlap or touch only ever joins pieces of the same token.
    pieces.sort((a, b) => a.start - b.start)
    const merged: RedactionPiece[] = []
    for (const piece of pieces) {
      const last = merged[merged.length - 1]
      if (last && piece.start <= last.end) {
        last.end = Math.max(last.end, piece.end)
        if (last.replacement !== piece.replacement) {
          last.replacement = BasicSafety.SECRET_REPLACEMENT
        }
      } else {
        merged.push({ ...piece })
      }
    }
    let redacted = ''
    let cursor = 0
    for (const piece of merged) {
      const replacement = piece.scalar ? JSON.stringify(piece.replacement) : piece.replacement
      redacted += content.slice(cursor, piece.start) + replacement
      cursor = piece.end
    }
    redacted += content.slice(cursor)
    if (!parsesAsJson(redacted)) return textPass
    return { content: redacted, was_modified: true, warnings: textPass.warnings }
  }

  /**
   * The ranges of `content` to redact and the warnings to report. Each rule
   * (injection patterns, extra filters, secret patterns, configured secret
   * forms, in that order) is matched twice:
   * - on a working copy where the earlier rules' matches are already
   *   replaced, so a rule can match across an earlier replacement
   *   (`[INST]passwd = [INST]passwd = value`); each such match is mapped back
   *   to the range of `content` it covers (`RedactionReplay`);
   * - on `content` itself, so a secret whose label or prefix an earlier
   *   rule's match swallowed is still found (`xoxb-1234-abcdBearer <token>`);
   *   a match the replay ranges already cover whole is dropped.
   * A rule's warning is reported when the replay matching finds something or
   * a match on `content` is kept.
   */
  private redactionPlan(
    content: string,
    options: {
      secretWarning: string
      extraFilters?: Array<{ pattern: RegExp; replacement: string; warning: string }>
    }
  ): { ranges: RedactionRange[]; warnings: string[] } {
    const rules: Array<{
      replacement: string
      warning: string
      find: MatchFinder[]
    }> = []
    for (const pattern of BasicSafety.INJECTION_PATTERNS) {
      rules.push({
        replacement: BasicSafety.INJECTION_REPLACEMENT,
        warning: 'Potential prompt injection pattern filtered',
        find: [text => patternMatches(text, pattern)],
      })
    }
    for (const filter of options.extraFilters ?? []) {
      rules.push({
        replacement: filter.replacement,
        warning: filter.warning,
        find: [text => patternMatches(text, filter.pattern)],
      })
    }
    for (const pattern of BasicSafety.SECRET_PATTERNS) {
      rules.push({
        replacement: BasicSafety.SECRET_REPLACEMENT,
        warning: options.secretWarning,
        find: [
          typeof pattern === 'function' ? pattern : (text: string) => patternMatches(text, pattern),
        ],
      })
    }
    for (const secret of this.configuredSecretForms()) {
      rules.push({
        replacement: `[REDACTED:${secret.name}]`,
        warning: `ConfigStore secret value redacted (${secret.name})`,
        find: secret.forms.map(form => (text: string) => literalMatches(text, form)),
      })
    }

    const replay = new RedactionReplay(content)
    const replayed: boolean[] = []
    const direct: Array<Array<[number, number]>> = []
    for (const rule of rules) {
      let found = false
      const original: Array<[number, number]> = []
      for (const find of rule.find) {
        // Until a rule replaces something, the copy is `content`, so the
        // matches on `content` are the replay's own, which it covers whole.
        const untouched = replay.ranges.length === 0
        const matches = find(replay.text)
        if (matches.length > 0) found = true
        replay.replace(matches, rule.replacement)
        if (untouched) continue
        // A loop, not `push(...)`: spreading one argument per match overflows
        // the call stack at about 120k matches.
        for (const match of find(content)) original.push(match)
      }
      replayed.push(found)
      direct.push(original)
    }

    // A match on `content` that the replay already covers adds nothing, and
    // dropping it keeps the result equal to the in-order replacement.
    const covered = coverageOf(replay.ranges)

    const ranges = [...replay.ranges]
    const warnings: string[] = []
    rules.forEach((rule, index) => {
      let found = replayed[index]
      for (const [start, end] of direct[index]) {
        if (covered(start, end)) continue
        ranges.push({ start, end, replacement: rule.replacement })
        found = true
      }
      if (found) warnings.push(rule.warning)
    })
    return { ranges, warnings }
  }

  private applyRedactionPlan(
    content: string,
    plan: { ranges: RedactionRange[]; warnings: string[] }
  ): SanitizedOutput {
    const sanitized = applyRedactionRanges(content, plan.ranges, BasicSafety.SECRET_REPLACEMENT)
    return { content: sanitized, was_modified: sanitized !== content, warnings: plan.warnings }
  }

  /**
   * The ConfigStore secret values to redact by literal match, each with every
   * form it takes in output: the plain value and, when different, its JSON
   * string encoding (a value holding `"`, `\` or a control character appears
   * escaped inside raw JSON). The encoded form, never shorter, comes first so
   * the plain pass cannot split it.
   */
  private configuredSecretForms(): Array<{ name: string; forms: string[] }> {
    const secrets: Array<{ name: string; forms: string[] }> = []
    for (const entry of this.secretEntriesProvider?.() ?? []) {
      if (!entry.value || entry.value.length < 4) continue // ignore trivially-short values
      const encoded = JSON.stringify(entry.value).slice(1, -1)
      secrets.push({
        name: entry.name,
        forms: encoded === entry.value ? [entry.value] : [encoded, entry.value],
      })
    }
    return secrets
  }

  /**
   * The core redaction primitive: strip injection patterns, well-known secret
   * shapes, and operator-configured secret values by literal match. Public so
   * callers that must redact WITHOUT the per-call logging of `sanitizeOutput`
   * (e.g. the session auto-title derivation and list projection, spec 15) can
   * reuse the exact same secret list. Does NOT log — the caller decides.
   */
  sanitizeFreeformContent(
    content: string,
    options: {
      secretWarning: string
      extraFilters?: Array<{ pattern: RegExp; replacement: string; warning: string }>
    }
  ): SanitizedOutput {
    // ConfigStore-managed secret values are redacted by literal match, in
    // plain and JSON-encoded form: defense-in-depth for values that don't fit
    // the regex shapes (operator-supplied integration tokens, the LLM key,
    // etc.). Entries are traversed in provider order; ConfigStore sorts them
    // by descending length, so a longer secret containing a shorter one is
    // masked before the shorter pass would erase its anchor.
    return this.applyRedactionPlan(content, this.redactionPlan(content, options))
  }
}
