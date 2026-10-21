import { ProfileApiError } from './api'

// A submit error that means the proof can never be used again. Retrying the
// same form only repeats the failure, so the screen must offer a way forward.
// The edge publishes these as stable machine codes; the human `error` sentence
// is display-only. `expired` is included because the dedicated reset route
// reports it as a code, not as the `/password` sentence.
export const TERMINAL_PASSWORD_ERROR_CODES: ReadonlySet<string> = new Set([
  'invitation_not_pending',
  'invalid_invitation',
  'not_found',
  'expired',
  'password_already_set',
])

export function isTerminalPasswordError(value: unknown): value is ProfileApiError {
  return (
    value instanceof ProfileApiError &&
    value.code !== null &&
    TERMINAL_PASSWORD_ERROR_CODES.has(value.code)
  )
}
