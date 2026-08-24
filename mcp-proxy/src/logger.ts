type LogFields = Record<string, string | number | boolean | undefined>

function write(level: string, event: string, fields: LogFields = {}): void {
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
