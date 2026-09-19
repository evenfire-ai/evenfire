import { ReporterTerminalError, type ReporterTerminalResult } from './boundedOffPathReporter'
import { hccLogger } from './logger'

const log = hccLogger.child({ module: 'reporter-http-failure' })

/**
 * control-api answers these (status, code) pairs deterministically: resending
 * the same event gets the same answer. `invalid_tracing_input` comes only from
 * request shape validation, so it is as final as `unsafe_tracing_input`. Every other failure (403 binding not yet
 * visible, 5xx, a 4xx without a code, a body that is not JSON) stays retryable.
 */
const TERMINAL_RESPONSES: ReadonlyArray<{
  status: number
  code: string
  result: ReporterTerminalResult
}> = [
  { status: 409, code: 'tracing_idempotency_conflict', result: 'conflict' },
  { status: 400, code: 'unsafe_tracing_input', result: 'rejected' },
  { status: 400, code: 'invalid_tracing_input', result: 'rejected' },
]

function unreadableBodyReason(error: unknown): 'not_json' | 'aborted' | 'read_failed' {
  if (error instanceof Error && error.name === 'SyntaxError') return 'not_json'
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return 'read_failed'
}

async function responseCode(response: Response, label: string): Promise<string | undefined> {
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    // No code can be read, so the caller treats the response as retryable.
    // Only the status and the failure kind are logged, never the body.
    log.warn('reporter could not read the response code', {
      label,
      status: response.status,
      reason: unreadableBodyReason(error),
    })
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const code = (body as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Throws for a non-2xx submit response. Only the `code` field of the body is
 * read; the body is never logged or attached to the error.
 */
export async function throwForFailedSubmit(response: Response, label: string): Promise<void> {
  if (response.ok) return
  const candidates = TERMINAL_RESPONSES.filter(entry => entry.status === response.status)
  if (candidates.length > 0) {
    const code = await responseCode(response, label)
    const terminal = candidates.find(entry => entry.code === code)
    if (terminal) {
      throw new ReporterTerminalError(
        terminal.result,
        `${label} submit rejected with ${response.status} ${terminal.code}`
      )
    }
  }
  throw new Error(`${label} submit failed with ${response.status}`)
}
