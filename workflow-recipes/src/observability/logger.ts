/**
 * Structured JSON logger for Clerum Workflow Runtime.
 *
 * Produces one JSON line per log entry to stdout. Cluster log collectors
 * (Loki, Fluent Bit) pick up stdout automatically.
 */
import { isNativeError } from 'node:util/types'

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  withStep(stepId: string): Logger
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const REDACTED = '[REDACTED]'
// Error causes can contain arbitrary response objects or recurse indefinitely.
const MAX_ERROR_DEPTH = 6
const MAX_ERROR_TEXT_LENGTH = 16_384
const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /api[_-]?key/i,
]

function getMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase()
  if (env && env in LEVEL_PRIORITY) return env as LogLevel
  return 'info'
}

function isTestSilent(): boolean {
  return process.env.NODE_ENV === 'test' && !process.env.LOG_LEVEL
}

function safeCycles(): (_key: string, value: unknown) => unknown {
  const seen = new WeakSet()
  return (_key: string, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}

function emit(entry: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify(entry, safeCycles()) + '\n')
  } catch {
    // Fallback: never throw from logger
    process.stdout.write(
      JSON.stringify({ level: 'error', msg: 'logger serialization failed' }) + '\n'
    )
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key))
}

function redactErrorText(text: string): string {
  if (text.length > MAX_ERROR_TEXT_LENGTH) return '[Truncated]'
  // Newly exposed native diagnostics must not reintroduce access data through
  // messages/stack traces. URLs are removed in full, including private paths.
  return (
    text
      // ApiException duplicates JSON.stringify(body/headers) on these diagnostic
      // lines. Remove the entire sections, including fields not named sensitive,
      // while retaining the HTTP code, ordinary message and stack frames.
      .replace(/^(\s*(?:Body|Headers):)[^\r\n]*/gim, '$1 ' + REDACTED)
      // Generic messages can embed quoted JSON, including escaped JSON strings.
      // Its value may itself contain quotes/newlines, so do not guess its end:
      // preserve the diagnostic prefix and redact the remaining fragment.
      .replace(
        /(\b[\w.-]*(?:authorization|cookie|token|secret|password|credential|api[_-]?key)[\w.-]*\\*["']\s*:\s*)[\s\S]*/gi,
        '$1' + REDACTED
      )
      .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, REDACTED)
      .replace(/\b(?:authorization|set-cookie|cookie)\s*:\s*[^\r\n]+/gi, REDACTED)
      .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, REDACTED)
      .replace(
        /(\b[\w.-]*(?:token|secret|password|credential|api[_-]?key)[\w.-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        `$1${REDACTED}`
      )
  )
}

function redactValue(value: unknown, key: string, seen: WeakSet<object>, errorDepth = 0): unknown {
  if (isSensitiveKey(key)) return REDACTED
  if (errorDepth > 0 && /^(body|headers|request|response)$/i.test(key)) return REDACTED
  if (errorDepth > 0 && typeof value === 'string') return redactErrorText(value)
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[Circular]'
    if (errorDepth >= MAX_ERROR_DEPTH) return '[Truncated]'
    seen.add(value)
    const nativeError = isNativeError(value)
    const nextDepth = errorDepth > 0 || nativeError ? errorDepth + 1 : 0
    if (Array.isArray(value)) return value.map(item => redactValue(item, '', seen, nextDepth))
    let fields: Record<string, unknown> = value as Record<string, unknown>
    if (nativeError) {
      try {
        fields = {
          ...value,
          name: value.name,
          message: value.message,
          stack: value.stack,
          ...('cause' in value ? { cause: value.cause } : {}),
        }
      } catch {
        // A custom Error accessor must not replace the failure being reported.
        return { name: 'Error', message: '[Unserializable]' }
      }
    }
    return Object.fromEntries(
      Object.entries(fields).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey, seen, nextDepth),
      ])
    )
  }
  return value
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>()
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, redactValue(value, key, seen)])
  )
}

function createLoggerImpl(
  component: 'wrc' | 'coordinator' | 'mcp_host',
  recipeName: string,
  stepId?: string
): Logger {
  const correlationId = process.env.CLERUM_CORRELATION_ID || 'unknown'
  const silent = isTestSilent()
  const minLevel = getMinLevel()

  function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (silent) return
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      correlationId,
      recipeName,
      component,
      msg,
    }

    if (stepId) entry.stepId = stepId
    if (fields) Object.assign(entry, redactFields(fields))

    emit(entry)
  }

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    withStep: (sid: string) => createLoggerImpl(component, recipeName, sid),
  }
}

export function createLogger(
  component: 'wrc' | 'coordinator' | 'mcp_host',
  recipeName: string
): Logger {
  return createLoggerImpl(component, recipeName)
}
