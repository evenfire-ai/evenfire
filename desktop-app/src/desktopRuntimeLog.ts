type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const priority: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function errorShape(value: unknown): Record<string, string | number> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const error = value as { name?: unknown; code?: unknown; status?: unknown }
  const result: Record<string, string | number> = {}
  if (typeof error.name === 'string' && /^(?:[A-Za-z]+)?Error$/.test(error.name)) {
    result.name = error.name
  }
  if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code)) {
    result.code = error.code
  }
  if (typeof error.status === 'number' && Number.isInteger(error.status)) {
    result.status = error.status
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** Main-process structured boundary: never serialize raw errors, stacks or request payloads. */
function log(level: LogLevel, message: string, error?: unknown): void {
  try {
    const configured = process.env.LOG_LEVEL as LogLevel | undefined
    const minimum =
      configured && Object.hasOwn(priority, configured) ? priority[configured] : priority.info
    if (priority[level] < minimum) return
    const record = JSON.stringify({
      level,
      service: 'desktop-app',
      message,
      err: errorShape(error),
    })
    // Direct console output is confined to this service adapter.
    console[level](record)
  } catch {
    // A logging sink must never change credential or lifecycle behavior.
  }
}

export const desktopRuntimeLog = {
  debug: (message: string, error?: unknown): void => log('debug', message, error),
  info: (message: string, error?: unknown): void => log('info', message, error),
  warn: (message: string, error?: unknown): void => log('warn', message, error),
  error: (message: string, error?: unknown): void => log('error', message, error),
}
