const LOG_LEVEL_WEIGHT: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 70,
}

export type TelegramRetryDisposition =
  | 'retry_buffer_full'
  | 'retry_buffer_unaccountable'
  | 'second_admission_429'
  | 'authorization_denied'
  | 'ambiguous_post'
  | 'shutdown'

/** Content-free structured telemetry for volatile Telegram admission retries. */
export function logTelegramRetryDisposition(
  disposition: TelegramRetryDisposition,
  pendingEvents: number,
  pendingBytes: number
): void {
  const configuredLevel = process.env.LOG_LEVEL?.trim().toLowerCase() || 'info'
  const minimumWeight = LOG_LEVEL_WEIGHT[configuredLevel] ?? LOG_LEVEL_WEIGHT.info
  if (minimumWeight > LOG_LEVEL_WEIGHT.warn) return

  // Intentionally allow-list all fields; event ids, targets, senders and message content never
  // cross this logging boundary.
  const record = {
    time: new Date().toISOString(),
    level: 'warn',
    service: 'channel-reader',
    event: 'telegram_admission_retry_disposition',
    disposition,
    pendingEvents,
    pendingBytes,
  }
  process.stdout.write(`${JSON.stringify(record)}\n`)
}
