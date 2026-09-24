// G1-6 (#720): the delay a 429 advises, in milliseconds. Only delta-seconds
// from 1 to 3600 are accepted, the rule `gfsClient.ts` applies to gfsc's
// limiter; an HTTP-date, a fraction or anything out of range is treated as
// absent, never guessed. The proxies parse the upstream header with the same
// rule in their own copies (`retryAfterSeconds` in `codexTransport.ts` and
// `grokTransport.ts`, #799); a change here goes there too.
const MAX_RETRY_AFTER_SECONDS = 3600

// The shape of a code in a JSON `error`: what control-api, the proxies and
// their gateways answer. A reason phrase is not one.
const MACHINE_CODE = /^[a-z][a-z0-9_]*$/

/**
 * The code of a 429 (G1-11, #720): the machine code its JSON `error` carries
 * (`rate_limited`, `budget_denied`, …), else `rate_limited`. control-api's own
 * limiters answer `{ "error": "Too Many Requests" }`, a reason phrase, and a
 * gateway limiter answers no JSON at all; both are a rate limit.
 */
export function rateLimitedCode(error: unknown): string {
  return typeof error === 'string' && MACHINE_CODE.test(error) ? error : 'rate_limited'
}

export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim()
  if (raw === undefined || !/^[1-9][0-9]{0,3}$/.test(raw)) return undefined
  const seconds = Number(raw)
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1000 : undefined
}
