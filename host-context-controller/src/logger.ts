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
  // Error.message / stack are non-enumerable; Object.entries would log `{ err: {} }`.
  // An Error is rendered from a fixed set of fields, never from its own keys: an
  // ApiException carries the response `body` and `headers`, which are not copied.
  // - `stack` keeps the frame lines only. Its first line repeats the message, and
  //   an ApiException message embeds the response body. The search for the first
  //   frame starts after the `name: message` header, so a message that contains
  //   frame-like text is not copied a second time.
  // - `code` is kept when it is a string or a number.
  // - `cause` is rendered when it is an Error. The Error is held in `seen` only
  //   while its own cause chain renders, so a cause cycle ends, and the same Error
  //   under two fields still renders twice.
  if (value instanceof Error) {
    const error: LogFields = { name: value.name, message: value.message }
    const stack = typeof value.stack === 'string' ? value.stack : ''
    const header = `${value.name}: ${value.message}`
    const frames = stack.indexOf('\n    at ', stack.startsWith(header) ? header.length : 0)
    if (frames !== -1) error.stack = stack.slice(frames + 1)
    const code = (value as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') error.code = code
    const cause = (value as { cause?: unknown }).cause
    if (cause instanceof Error && !seen.has(value)) {
      seen.add(value)
      error.cause = sanitize(cause, seen)
      seen.delete(value)
    }
    return error
  }
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  const clean: LogFields = {}
  for (const [key, fieldValue] of Object.entries(value as LogFields)) {
    clean[key] = SENSITIVE_FIELD_RE.test(key) ? '[redacted]' : sanitize(fieldValue, seen)
  }
  return clean
}

export class HostContextLogger {
  constructor(private readonly baseFields: LogFields = {}) {}

  child(fields: LogFields): HostContextLogger {
    return new HostContextLogger({ ...this.baseFields, ...fields })
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
      svc: 'host-context-controller',
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

export const hccLogger = new HostContextLogger()
