/**
 * Structured JSON logger for Clerum Workflow Runtime.
 *
 * Produces one JSON line per log entry to stdout. Cluster log collectors
 * (Loki, Fluent Bit) pick up stdout automatically.
 */

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

function redactValue(value: unknown, key: string, seen: WeakSet<object>): unknown {
  if (isSensitiveKey(key)) return REDACTED
  if (Array.isArray(value)) return value.map(item => redactValue(item, '', seen))
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey, seen),
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
