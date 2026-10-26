// desktop-app/test/e2e-playwright/gfsTransportRetry.ts
//
// Bounded retry for the cluster calls the GFS journeys make.
//
// The shared fixture harness reaches the cluster through one `kubectl exec` per
// call, and that stream can end early ("error: EOF"). That is transport
// noise, not a verdict: without a retry a hiccup during the SETUP leaves
// seeded rows on the shared drive, and a hiccup during the CLEANUP aborts it
// before it writes the tombstone — the drive is left dirty either way.
//
// The discrimination is deliberately narrow: only a dropped stream is retried.
// A real failure (a rejected mutation, a missing row, an assertion) propagates
// on the first attempt, so a retry can never turn a failed journey green.

/**
 * True when the failure is a dropped transport stream.
 *
 * The shared harness reports a failed cleanup as an AggregateError whose own
 * message does NOT carry the cause, so the nested errors are inspected too —
 * otherwise the retry would never fire for exactly the case it exists for.
 */
export function isTransportNoise(caught: unknown): boolean {
  const parts: string[] = []
  const collect = (value: unknown): void => {
    if (value instanceof Error) {
      parts.push(value.message)
      const nested = (value as AggregateError).errors
      if (Array.isArray(nested)) nested.forEach(collect)
    } else {
      parts.push(String(value))
    }
  }
  collect(caught)
  return /\bEOF\b|socket hang up|connection reset|stream closed/i.test(parts.join(' | '))
}

/** Run `action`, retrying once when the failure is a dropped transport stream. */
export async function withTransportRetry<T>(
  what: string,
  action: () => T,
  delayMs = 1_500
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action()
    } catch (caught) {
      if (attempt >= 2 || !isTransportNoise(caught)) {
        throw new Error(`[gfs-dnd] ${what} failed: ${describe(caught)}`, { cause: caught })
      }
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}
