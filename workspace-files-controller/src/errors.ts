/**
 * Standard wfc error envelope. All non-streaming responses follow:
 *   success:  { ok: true,  data: <payload> }
 *   failure:  { ok: false, error: { code, message } }
 *
 * Error `code` values are stable identifiers that clients can switch on; the
 * `message` is human-friendly and may change.
 */

export type ErrorCode =
  | 'path_invalid'
  | 'not_found'
  | 'already_exists'
  | 'not_a_directory'
  | 'is_a_directory'
  | 'not_empty'
  | 'payload_too_large'
  | 'forbidden'
  | 'unauthorized'
  | 'not_mounted'
  | 'internal'

export interface OkResponse<T> {
  ok: true
  data: T
}

export interface ErrResponse {
  ok: false
  error: { code: ErrorCode; message: string }
}

export type Envelope<T> = OkResponse<T> | ErrResponse

export class HttpError extends Error {
  readonly status: number
  readonly code: ErrorCode

  constructor(status: number, code: ErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const DEFAULT_STATUS_FOR_CODE: Record<ErrorCode, number> = {
  path_invalid: 400,
  not_found: 404,
  already_exists: 409,
  not_a_directory: 400,
  is_a_directory: 400,
  not_empty: 409,
  payload_too_large: 413,
  forbidden: 403,
  unauthorized: 401,
  not_mounted: 503,
  internal: 500,
}

/** Convenience constructor that picks the canonical HTTP status for a code. */
export function err(code: ErrorCode, message: string, status?: number): HttpError {
  return new HttpError(status ?? DEFAULT_STATUS_FOR_CODE[code], code, message)
}

export function ok<T>(data: T): OkResponse<T> {
  return { ok: true, data }
}

export function envelopeFromError(e: unknown): { status: number; body: ErrResponse } {
  if (e instanceof HttpError) {
    return { status: e.status, body: { ok: false, error: { code: e.code, message: e.message } } }
  }
  // Map Node fs error codes to canonical wfc codes.
  const fsErr = e as NodeJS.ErrnoException
  switch (fsErr?.code) {
    case 'ENOENT':
      return { status: 404, body: { ok: false, error: { code: 'not_found', message: 'no such file or directory' } } }
    case 'EEXIST':
      return { status: 409, body: { ok: false, error: { code: 'already_exists', message: 'file or directory already exists' } } }
    case 'ENOTDIR':
      return { status: 400, body: { ok: false, error: { code: 'not_a_directory', message: 'not a directory' } } }
    case 'EISDIR':
      return { status: 400, body: { ok: false, error: { code: 'is_a_directory', message: 'is a directory' } } }
    case 'ENOTEMPTY':
      return { status: 409, body: { ok: false, error: { code: 'not_empty', message: 'directory not empty' } } }
    case 'EROFS':
      return { status: 403, body: { ok: false, error: { code: 'forbidden', message: 'read-only filesystem' } } }
    default:
      return {
        status: 500,
        body: { ok: false, error: { code: 'internal', message: 'internal error' } },
      }
  }
}
