/** Pino `redact.paths` covering JWTs and token-bearing headers. */
export const TOKEN_LEAK_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  "req.headers['x-service-token']",
  "req.headers['x-user-session-token']",
  'headers.authorization',
  'headers.cookie',
  'token',
  'accessToken',
  'refreshToken',
  'chatgptAccountId',
  'accountId',
  'voucher',
  'password',
  'password_hash',
  'passwordHash',
  'claim_token',
  'claimToken',
  'client_secret',
  'clientSecret',
]

/** Asserted by unit tests so redactions can grow but never shrink. */
export const REQUIRED_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  "req.headers['x-service-token']",
  'headers.authorization',
  'accessToken',
  'refreshToken',
  'chatgptAccountId',
  'accountId',
  'claim_token',
  'claimToken',
  'client_secret',
  'clientSecret',
]
