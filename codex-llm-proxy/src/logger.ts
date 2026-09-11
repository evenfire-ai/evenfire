import pino, { type DestinationStream } from 'pino'

export const REDACT_PATHS = [
  'accessToken',
  'refreshToken',
  'chatgptAccountId',
  'accountId',
  'executionTicket',
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'attemptReceipt',
  'id_token',
  'idToken',
  'pkceVerifier',
  'refresh_token',
]

export function createProxyLogger(destination?: DestinationStream) {
  return pino(
    {
      level: destination
        ? 'info'
        : (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info')),
      base: { svc: 'codex-llm-proxy' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, remove: true },
    },
    destination
  )
}

export const logger = createProxyLogger()
