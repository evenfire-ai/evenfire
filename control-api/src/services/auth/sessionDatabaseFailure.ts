import { DatabaseError } from 'pg'

const BACKEND_UNAVAILABLE_SQLSTATE_CLASSES = new Set(['08', '53', '57', '58'])
const SYSTEM_ERROR_CODE = /^E[A-Z]+$/
const SQLSTATE_CODE = /^[0-9A-Z]{5}$/

/** Trusted provenance that a real external-session database operation failed. */
export class ExternalSessionBackendUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('External session database is unavailable', { cause })
    this.name = 'ExternalSessionBackendUnavailableError'
  }
}

/**
 * Classifies only failures passed from an actual external-session DB I/O
 * boundary. Callers must not apply this to an authentication/business operation.
 */
export function externalSessionDatabaseFailure(error: unknown): unknown {
  if (error instanceof ExternalSessionBackendUnavailableError) return error
  if (error instanceof DatabaseError) {
    return BACKEND_UNAVAILABLE_SQLSTATE_CLASSES.has(String(error.code).slice(0, 2))
      ? new ExternalSessionBackendUnavailableError(error)
      : error
  }
  if (!(error instanceof Error)) return error

  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') {
    if (SYSTEM_ERROR_CODE.test(code)) return new ExternalSessionBackendUnavailableError(error)
    // Do not mistake SQL/application codes or Node's ERR_* codes for a pool
    // transport failure merely because the driver surfaced a base Error.
    if (SQLSTATE_CODE.test(code) || code.startsWith('ERR_')) return error
  }
  return error.constructor === Error ? new ExternalSessionBackendUnavailableError(error) : error
}

export async function runExternalSessionDatabaseOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw externalSessionDatabaseFailure(error)
  }
}

export function isExternalSessionBackendUnavailableError(
  error: unknown
): error is ExternalSessionBackendUnavailableError {
  return error instanceof ExternalSessionBackendUnavailableError
}
