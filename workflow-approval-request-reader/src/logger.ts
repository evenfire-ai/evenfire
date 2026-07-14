type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogFields = Record<string, unknown>

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const SENSITIVE_FIELD_RE = /(authorization|bearer|token|secret|password|credential|key)/i

function minLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.toLowerCase()
  if (value && value in LEVEL_PRIORITY) return value as LogLevel
  return 'info'
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  const clean: LogFields = {}
  for (const [key, fieldValue] of Object.entries(value as LogFields)) {
    clean[key] = SENSITIVE_FIELD_RE.test(key) ? '[redacted]' : sanitize(fieldValue, seen)
  }
  return clean
}

export class ReaderLogger {
  constructor(private readonly baseFields: LogFields = {}) {}

  child(fields: LogFields): ReaderLogger {
    return new ReaderLogger({ ...this.baseFields, ...fields })
  }

  debug(message: string, fields?: LogFields): void {
    this.emit('debug', message, fields)
  }

  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields)
  }

  error(message: string, fields?: LogFields): void {
    this.emit('error', message, fields)
  }

  private emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel()]) return

    const entry = sanitize({
      ts: new Date().toISOString(),
      level,
      svc: 'workflow-approval-request-reader',
      ...this.baseFields,
      msg: message,
      ...fields,
    })

    const serialized = JSON.stringify(entry)
    if (level === 'error') {
      console.error(serialized)
      return
    }
    if (level === 'warn') {
      console.warn(serialized)
      return
    }
    console.log(serialized)
  }
}

export const readerLogger = new ReaderLogger()
