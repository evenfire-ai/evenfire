/**
 * Structured JSON logger for Kubernetes / Grafana Loki compatibility.
 *
 * Overrides console.log, console.error, and console.warn to emit
 * JSON lines with timestamp, level, component, and message fields.
 * Grafana auto-detects JSON log lines and parses all fields.
 *
 * Parses the existing [Component] prefix convention automatically:
 *   console.log("[Main] Server started") →
 *   {"timestamp":"...","level":"info","component":"Main","msg":"Server started"}
 *
 * Import this module once at the top of main.ts (before any other imports
 * that log at module scope):
 *   import "./logger";
 */

const COMPONENT_RE = /^\[([^\]]+)\]\s*/
const SENSITIVE_KEY_RE =
  /password|secret|token|authorization|cookie|api[_-]?key|dsn|private|refresh|credential|account[_-]?id/i
const UNSAFE_OBJECT_KEY = /^(?:__proto__|constructor|prototype)$/
const SAFE_OBJECT_KEY = /^[A-Za-z0-9._-]{1,64}$/

const originalLog = console.log.bind(console)
const originalError = console.error.bind(console)
const originalWarn = console.warn.bind(console)

function isSafeObjectKey(key: string): boolean {
  return SAFE_OBJECT_KEY.test(key) && !UNSAFE_OBJECT_KEY.test(key)
}

function cloneRedacted(value: unknown, key?: string): unknown {
  if (value === process.env) return '[Redacted]'
  if (key && SENSITIVE_KEY_RE.test(key)) return '[Redacted]'
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map(item => cloneRedacted(item))
  const out: Record<string, unknown> = Object.create(null)
  for (const nextKey of Object.keys(value as object)) {
    if (!isSafeObjectKey(nextKey)) continue
    if (SENSITIVE_KEY_RE.test(nextKey)) {
      out[nextKey] = '[Redacted]'
      continue
    }
    out[nextKey] = cloneRedacted((value as Record<string, unknown>)[nextKey], nextKey)
  }
  return out
}

export function redactUnknown(value: unknown, key?: string): unknown {
  try {
    return cloneRedacted(value, key)
  } catch {
    return '[Unserializable]'
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(a => (typeof a === 'string' ? a : JSON.stringify(redactUnknown(a)))).join(' ')
}

function emit(level: string, args: unknown[]): void {
  const raw = formatArgs(args)

  // Skip empty lines and separator lines (====, ----)
  const trimmed = raw.trim()
  if (!trimmed || /^[=\-]{3,}$/.test(trimmed)) return

  let component = ''
  let msg = raw

  const match = raw.match(COMPONENT_RE)
  if (match) {
    const parsed = match[1] ?? ''
    if (SAFE_OBJECT_KEY.test(parsed)) {
      component = parsed
      msg = raw.slice(match[0].length)
    }
  }

  const entry: Record<string, string> = {
    timestamp: new Date().toISOString(),
    level,
    msg: msg.replace(/[\r\n\u2028\u2029]/g, ' ').trim(),
  }

  if (component) {
    entry.component = component
  }

  const writer = level === 'error' ? originalError : level === 'warn' ? originalWarn : originalLog
  writer(JSON.stringify(entry))
}

console.log = (...args: unknown[]) => emit('info', args)
console.error = (...args: unknown[]) => emit('error', args)
console.warn = (...args: unknown[]) => emit('warn', args)
