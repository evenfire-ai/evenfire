type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogFields = Record<string, unknown>

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const SENSITIVE_FIELD_RE = /(authorization|bearer|token|secret|password|credential|key)/i

// Cycle-safe depth cap for chained `Error.cause` (and nested AggregateError errors).
const MAX_ERROR_CAUSE_DEPTH = 8
// Upper bound on how many `AggregateError.errors` entries we flatten per error.
const MAX_AGGREGATE_ERRORS = 10

function minLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.toLowerCase()
  if (value && value in LEVEL_PRIORITY) return value as LogLevel
  return 'info'
}

// Flatten an Error into a plain object. `Error` own props (name/message/stack)
// are non-enumerable, so a bare Error serializes to `{}`; we surface name and
// message, recurse `cause`, and bound `AggregateError.errors`. `stack` is
// intentionally omitted (see issue #453 — no stacks at info/error by default).
function flattenError(error: Error, seen: WeakSet<object>, depth: number): LogFields {
  const clean: LogFields = { name: error.name, message: error.message }

  // Preserve any custom enumerable own fields (e.g. `code`, `statusCode`),
  // redacted by key. `cause`/`errors` are handled explicitly below.
  for (const [key, fieldValue] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause' || key === 'errors') {
      continue
    }
    clean[key] = SENSITIVE_FIELD_RE.test(key) ? '[redacted]' : sanitize(fieldValue, seen)
  }

  if (error.cause !== undefined) {
    clean.cause = sanitizeErrorLike(error.cause, seen, depth)
  }

  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    const total = error.errors.length
    clean.errors = error.errors
      .slice(0, MAX_AGGREGATE_ERRORS)
      .map(inner => sanitizeErrorLike(inner, seen, depth))
    if (total > MAX_AGGREGATE_ERRORS) {
      clean.errors_truncated = total - MAX_AGGREGATE_ERRORS
    }
  }

  return clean
}

// Flatten a value reached from an Error's `cause`/`errors`, enforcing the
// cycle guard and depth cap before recursing into a nested Error.
function sanitizeErrorLike(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]'
    if (depth <= 0) return '[MaxDepth]'
    seen.add(value)
    return flattenError(value, seen, depth - 1)
  }
  return sanitize(value, seen)
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (value instanceof Error) return flattenError(value, seen, MAX_ERROR_CAUSE_DEPTH)

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
