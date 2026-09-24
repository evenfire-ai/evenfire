/** The part of a server response the heartbeat touches. */
export type HeartbeatSink = {
  write(chunk: string): boolean
  readonly writableEnded: boolean
  readonly destroyed: boolean
}

const KEEPALIVE = ': keepalive\n\n'

/**
 * Well under the Host's 300 s undici headers/body timeouts, so a silent
 * upstream never reaches them: the admission clock (60 s) + redeem (15 s) +
 * one interval stays below 300 s.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Largest interval config accepts. Every wait a request performs before the
 * redeem (body budget, stream gate) is bounded by one admission clock of
 * `maxQueueWaitMs` (60 s) from arrival (#739 D1), so the queue time counts
 * once: 60 s + the 15 s redeem + one 60 s interval = 135 s, which ends before
 * the Host's 300 s headers timeout, and one interval stays below its body
 * timeout.
 */
export const MAX_HEARTBEAT_INTERVAL_MS = 60_000

/**
 * Writes an SSE comment every `intervalMs` so the Host's HTTP client, whose
 * headers and body timeouts are 300 s, keeps the attempt open while the
 * upstream is silent (reasoning, or tool calls that the proxy buffers until
 * the stream completes). SSE readers ignore comment lines.
 *
 * The first comment goes out at +intervalMs. A tick never waits on `drain`
 * and never adds a listener: a comment is 13 bytes, and a slow client is
 * already bounded by the frame writer's backpressure. The caller must call
 * the returned stop function before ending the response.
 */
export function startSseHeartbeat(
  res: HeartbeatSink,
  signal: AbortSignal,
  intervalMs: number,
  onBeat: () => void
): () => void {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('heartbeat interval must be a positive integer')
  }
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed || signal.aborted) return
    res.write(KEEPALIVE)
    onBeat()
  }, intervalMs)
  return () => clearInterval(timer)
}
