import pino from 'pino'
import { TOKEN_LEAK_REDACT_PATHS } from '../utils/log/redact.js'

/**
 * Root logger. Audit-only emission (4xx/5xx, denied attempts, approval
 * transitions, cron runs) — no per-request INFO.
 */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { svc: 'control-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [...TOKEN_LEAK_REDACT_PATHS],
    remove: true,
  },
})

export type Logger = typeof rootLogger
