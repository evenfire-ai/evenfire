/**
 * A failure while reading an upstream response body AFTER its headers arrived.
 * The upstream has already received the request (and for a mutating call may
 * have applied it), so this is never a down-host signal: the wake-and-hold
 * classifier excludes it by name and a mutating POST is not re-issued. The
 * original failure is kept as `cause` (a timeout there still maps to 504).
 */
export class UpstreamBodyReadError extends Error {
  constructor(cause: unknown) {
    super(
      `Upstream response body read failed after headers: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    )
    this.name = 'UpstreamBodyReadError'
  }
}

/**
 * Reads the body of a mutating upstream call (approve, deny, set-model,
 * cancel). Only an error raised before `fetch()` resolved may trigger a wake
 * and a re-issued POST; a socket that dies mid-body surfaces as
 * {@link UpstreamBodyReadError} instead.
 */
export async function readMutatingResponseBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    throw new UpstreamBodyReadError(error)
  }
}
