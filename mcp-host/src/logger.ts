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
  /password|secret|token|authorization|cookie|api[_-]?key|dsn|private|refresh|credential/i

const originalLog = console.log.bind(console)
const originalError = console.error.bind(console)
const originalWarn = console.warn.bind(console)

export function redactUnknown(value: unknown, key?: string): unknown {
  if (value === process.env) return '[Redacted]'
  if (key && SENSITIVE_KEY_RE.test(key)) return '[Redacted]'
  if (Array.isArray(value)) return value.map(item => redactUnknown(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactUnknown(childValue, childKey)
    }
    return out
  }
  return value
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
    component = match[1]
    msg = raw.slice(match[0].length)
  }

  const entry: Record<string, string> = {
    timestamp: new Date().toISOString(),
    level,
    msg: msg.trim(),
  }

  if (component) {
    entry.component = component
  }

  const writer = level === 'error' ? originalError : originalLog
  writer(JSON.stringify(entry))
}

console.log = (...args: unknown[]) => emit('info', args)
console.error = (...args: unknown[]) => emit('error', args)
console.warn = (...args: unknown[]) => emit('warn', args)
