import pino, { type DestinationStream } from 'pino'

export const REDACT_PATHS = [
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'deviceCode',
  'device_code',
  'userCode',
  'user_code',
  'accountSubject',
  'account_subject',
  'accountId',
  'executionTicket',
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  "req.headers['x-service-token']",
  'attemptReceipt',
  'id_token',
  'idToken',
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
]

export function createProxyLogger(destination?: DestinationStream) {
  return pino(
    {
      level: destination
        ? 'info'
        : (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info')),
      base: { svc: 'grok-llm-proxy' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, remove: true },
    },
    destination
  )
}

export const logger = createProxyLogger()
