type LogFields = Record<string, string | number | boolean | undefined>

const LEVEL_WEIGHT: Record<string, number> = {
  silent: Number.POSITIVE_INFINITY,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}

function configuredWeight(): number {
  const configured = process.env.LOG_LEVEL?.trim().toLowerCase() || 'info'
  return LEVEL_WEIGHT[configured] ?? LEVEL_WEIGHT.info
}

function write(level: string, event: string, fields: LogFields = {}): void {
  if ((LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info) > configuredWeight()) return
  process.stdout.write(
    JSON.stringify({
      level,
      service: 'mcp-proxy',
      event,
      ...fields,
    }) + '\n'
  )
}

export const proxyLogger = {
  info(event: string, fields?: LogFields): void {
    write('info', event, fields)
  },
  warn(event: string, fields?: LogFields): void {
    write('warn', event, fields)
  },
  error(event: string, fields?: LogFields): void {
    write('error', event, fields)
  },
}
