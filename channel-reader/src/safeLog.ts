const SECRET_TEXT = /authorization:\s*bearer\s+\S+|xox[baprs]-[A-Za-z0-9-]+/gi

export interface CaughtErrorSummary {
  name: string
  code: string
  message: string
}

export function caughtErrorSummary(err: unknown): CaughtErrorSummary {
  const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : null
  const data =
    record && record.data && typeof record.data === 'object'
      ? (record.data as { error?: unknown })
      : null
  const slackCode = typeof data?.error === 'string' ? data.error : ''
  const code = typeof record?.code === 'string' ? record.code : ''
  const name = err instanceof Error ? err.name : 'Error'
  const rawMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown'
  return {
    name,
    code: slackCode || code || name,
    message: rawMessage.replace(SECRET_TEXT, '[redacted]').slice(0, 300),
  }
}

export function logCaughtError(
  level: 'error' | 'warn',
  msg: string,
  err: unknown,
  fields?: Record<string, string | number | boolean | null>
): void {
  const line = JSON.stringify({
    level,
    msg,
    ...fields,
    ...caughtErrorSummary(err),
  })
  if (level === 'warn') console.warn(line)
  else console.error(line)
}
