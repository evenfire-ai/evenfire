import { ReporterTerminalError, type ReporterTerminalResult } from './boundedOffPathReporter'

/**
 * control-api answers these (status, code) pairs deterministically: resending
 * the same event gets the same answer. Every other failure (403 binding not yet
 * visible, 5xx, a 4xx without a code, a body that is not JSON) stays retryable.
 */
const TERMINAL_RESPONSES: ReadonlyArray<{
  status: number
  code: string
  result: ReporterTerminalResult
}> = [
  { status: 409, code: 'tracing_idempotency_conflict', result: 'conflict' },
  { status: 400, code: 'unsafe_tracing_input', result: 'rejected' },
]

async function responseCode(response: Response): Promise<string | undefined> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A body that is not JSON carries no code; the caller treats it as retryable.
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
    const code = await responseCode(response)
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
