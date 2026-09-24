// G1-6 (#720): the delay a 429 advises, in milliseconds. Only delta-seconds
// from 1 to 3600 are accepted, the rule `gfsClient.ts` applies to gfsc's
// limiter; an HTTP-date, a fraction or anything out of range is treated as
// absent, never guessed.
const MAX_RETRY_AFTER_SECONDS = 3600

export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim()
  if (raw === undefined || !/^[1-9][0-9]{0,3}$/.test(raw)) return undefined
  const seconds = Number(raw)
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1000 : undefined
}
