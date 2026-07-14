import { emitLog } from './logger'

export const AUTH_RETRY_DELAY_MS = 5_000
export const AUTH_RETRY_MAX_ATTEMPTS = 13

type AuthRetryOptions = {
  maxAttempts?: number
  retryDelayMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function sendWithAuthRetryOn401(
  send: () => Promise<Response>,
  operation: string,
  options: AuthRetryOptions = {}
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? AUTH_RETRY_MAX_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? AUTH_RETRY_DELAY_MS
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('auth retry maxAttempts must be a positive safe integer')
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('auth retry retryDelayMs must be a non-negative safe integer')
  }

  for (let attempt = 1; ; attempt += 1) {
    const response = await send()
    if (response.status !== 401 || attempt >= maxAttempts) {
      return response
    }

    emitLog('warn', `Runtime auth rejected for ${operation}; retrying after token reread`, {
      operation,
      httpStatus: 401,
      attempt,
      maxAttempts,
      retryDelayMs,
    })
    if (retryDelayMs > 0) await sleep(retryDelayMs)
  }
}
