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

  private static readonly ASSISTANT_RESPONSE_FILTER_PATTERNS: Array<{
    pattern: RegExp
    replacement: string
    warning: string
  }> = [
    {
      pattern: /<\/?tool_output\b[^>]*>/gi,
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
    console.log(`[NewCore:Safety] validateInput → length=${input?.length ?? 0}, passed=${valid}`)
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
      errors.push(`Private or link-local target "${hostname}" is blocked`)
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
    const result = this.sanitizeFreeformContent(output, {
      secretWarning: `Potential secret detected in ${toolName} output`,
    })
    console.log(
      `[NewCore:Safety] sanitizeOutput → tool=${toolName}, sanitized=${result.was_modified}, warnings=${result.warnings.length}`
    )
    return result
  }

  sanitizeAssistantResponse(response: string): SanitizedOutput {
    const result = this.sanitizeFreeformContent(response, {
      secretWarning: 'Potential secret detected in assistant response',
      extraFilters: BasicSafety.ASSISTANT_RESPONSE_FILTER_PATTERNS,
    })
    console.log(
      `[NewCore:Safety] sanitizeAssistantResponse → sanitized=${result.was_modified}, warnings=${result.warnings.length}`
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
    const escaped = content.replace(/<\/tool_output>/gi, '&lt;/tool_output&gt;')
    const wrapped = `<tool_output name="${toolName}" sanitized="${wasSanitized}">\n${escaped}\n</tool_output>`
    console.log(`[NewCore:Safety] wrapForLlm → tool=${toolName}, wrappedLength=${wrapped.length}`)
    return wrapped
  }

  private sanitizeFreeformContent(
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
      sanitized = sanitized.replace(pattern, '[filtered]')
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
      sanitized = sanitized.replace(pattern, '[REDACTED]')
      if (sanitized !== before) {
        warnings.push(options.secretWarning)
      }
    }

    // Defense-in-depth: redact ConfigStore-managed secret values by literal
    // substring match. Catches values that don't fit the regex shapes
    // above — operator-supplied integration tokens, the LLM key, etc.
    // Length-descending traversal ensures a longer secret containing a
    // shorter one is masked before the shorter pass would erase its anchor.
    const entries = this.secretEntriesProvider?.() ?? []
    for (const entry of entries) {
      if (!entry.value || entry.value.length < 4) continue // ignore trivially-short values
      if (!sanitized.includes(entry.value)) continue
      sanitized = sanitized.split(entry.value).join(`[REDACTED:${entry.name}]`)
      warnings.push(`ConfigStore secret value redacted (${entry.name})`)
    }

    return {
      content: sanitized,
      was_modified: sanitized !== content,
      warnings,
    }
  }
}
