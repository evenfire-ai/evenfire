import pino from 'pino'

const REDACT_PATHS = [
  'accessToken',
  'refreshToken',
  'executionTicket',
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'attemptReceipt',
]

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { svc: 'codex-llm-proxy' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, remove: true },
})
