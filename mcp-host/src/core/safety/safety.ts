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

// JSON punctuation and whitespace: the only bytes outside a string that a
// redaction range may cover while the output can still be redacted in place.
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

  private static readonly SECRET_PATTERNS: RegExp[] = [
    /(?:sk|pk|api)[_-](?:live|test|prod)[_-][a-zA-Z0-9]{16,}/g,
    /(?:ghp|gho|ghs|ghr)_[a-zA-Z0-9]{36,}/g,
    /(?:xox[bprs])-[a-zA-Z0-9-]+/g,
    /Bearer\s+[a-zA-Z0-9._~+\/=-]{20,}/gi,
    /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    /(?:password|passwd|pwd)\s*[:=]\s*[^\s,;]{8,}/gi,
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
      // Closed tags only, because this replacement removes text. `[^<>]*`
      // keeps the scan linear (see TOOL_OUTPUT_TAG_PATTERN).
      pattern: /<(?:\s*\/)?\s*tool_output\b[^<>]*>/gi,
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
   * JSON syntax: the password value class `[^\s,;]{8,}` eats a closing `"}`,
   * and a raw `\n` escape is not whitespace to it. The text-pass result is
   * returned unchanged when it did not modify the output, when it still
   * parses, or when the original output does not parse.
   *
   * Otherwise the redaction is redone in place on the original text:
   * 1. One iterative scan records the inner span of every string token, keys
   *    and values alike, with escapes still encoded.
   * 2. Every injection pattern, secret pattern and configured secret form is
   *    matched independently against the original text.
   * 3. If a match covers any byte outside every string other than JSON
   *    punctuation or whitespace (a number, `true`, `false`, `null`), or
   *    touches no string at all, the text-pass result is returned.
   * 4. Each match is clipped to every string it covers and widened to whole
   *    escape sequences. Pieces that overlap or touch inside one string are
   *    merged (`[REDACTED]` when their replacements differ) and spliced in.
   *    Every byte outside the replaced pieces stays as it was.
   * 5. If that result does not parse, the text-pass result is returned.
   * The warnings are always the text pass's.
   */
  private sanitizeToolOutputContent(toolName: string, content: string): SanitizedOutput {
    const options = { secretWarning: `Potential secret detected in ${toolName} output` }
    const textPass = this.sanitizeFreeformContent(content, options)
    if (!textPass.was_modified || parsesAsJson(textPass.content) || !parsesAsJson(content)) {
      return textPass
    }
    const { tokens, tokenOf, escapeOffset } = scanJsonStrings(content)
    const pieces: RedactionRange[] = []
    for (const range of this.redactionRanges(content)) {
      let touchedString = false
      let i = range.start
      while (i < range.end) {
        const token = tokenOf[i]
        if (token === -1) {
          if (!isJsonStructural(content.charCodeAt(i))) return textPass
          i++
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
        pieces.push({ start, end, replacement: range.replacement })
        touchedString = true
        i = tokenEnd
      }
      if (!touchedString) return textPass
    }

    // A piece ends at most at its string's closing quote and the next string
    // starts at least two code units later, so merging sorted pieces that
    // overlap or touch only ever joins pieces of the same string.
    pieces.sort((a, b) => a.start - b.start)
    const merged: RedactionRange[] = []
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
      redacted += content.slice(cursor, piece.start) + piece.replacement
      cursor = piece.end
    }
    redacted += content.slice(cursor)
    if (!parsesAsJson(redacted)) return textPass
    return { content: redacted, was_modified: true, warnings: textPass.warnings }
  }

  /**
   * Every match of the redaction rules `sanitizeFreeformContent` applies to
   * tool output, each rule matched independently against `content`.
   */
  private redactionRanges(content: string): RedactionRange[] {
    const ranges: RedactionRange[] = []
    const addMatches = (pattern: RegExp, replacement: string) => {
      for (const match of content.matchAll(pattern)) {
        if (match[0].length === 0) continue
        ranges.push({ start: match.index, end: match.index + match[0].length, replacement })
      }
    }
    for (const pattern of BasicSafety.INJECTION_PATTERNS) {
      addMatches(pattern, BasicSafety.INJECTION_REPLACEMENT)
    }
    for (const pattern of BasicSafety.SECRET_PATTERNS) {
      addMatches(pattern, BasicSafety.SECRET_REPLACEMENT)
    }
    for (const secret of this.configuredSecretForms()) {
      const replacement = `[REDACTED:${secret.name}]`
      for (const form of secret.forms) {
        let at = content.indexOf(form)
        while (at !== -1) {
          ranges.push({ start: at, end: at + form.length, replacement })
          at = content.indexOf(form, at + form.length)
        }
      }
    }
    return ranges
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
    let sanitized = content
    const warnings: string[] = []

    for (const pattern of BasicSafety.INJECTION_PATTERNS) {
      const before = sanitized
      sanitized = sanitized.replace(pattern, BasicSafety.INJECTION_REPLACEMENT)
      if (sanitized !== before) {
        warnings.push('Potential prompt injection pattern filtered')
      }
    }

    for (const filter of options.extraFilters ?? []) {
      const before = sanitized
      sanitized = sanitized.replace(filter.pattern, filter.replacement)
      if (sanitized !== before) {
        warnings.push(filter.warning)
      }
    }

    for (const pattern of BasicSafety.SECRET_PATTERNS) {
      const before = sanitized
      sanitized = sanitized.replace(pattern, BasicSafety.SECRET_REPLACEMENT)
      if (sanitized !== before) {
        warnings.push(options.secretWarning)
      }
    }

    // Defense-in-depth: redact ConfigStore-managed secret values by literal
    // substring match, in plain and JSON-encoded form. Catches values that
    // don't fit the regex shapes above — operator-supplied integration
    // tokens, the LLM key, etc. Entries are traversed in provider order;
    // ConfigStore sorts them by descending length, so a longer secret
    // containing a shorter one is masked before the shorter pass would erase
    // its anchor.
    for (const secret of this.configuredSecretForms()) {
      const before = sanitized
      for (const form of secret.forms) {
        if (sanitized.includes(form)) {
          sanitized = sanitized.split(form).join(`[REDACTED:${secret.name}]`)
        }
      }
      if (sanitized !== before) {
        warnings.push(`ConfigStore secret value redacted (${secret.name})`)
      }
    }

    return {
      content: sanitized,
      was_modified: sanitized !== content,
      warnings,
    }
  }
}
