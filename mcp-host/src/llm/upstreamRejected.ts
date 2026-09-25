/**
 * The upstream status a proxy sends with `upstream_rejected` (review R1-H2,
 * #720), so a 402/403 entitlement refusal and a 404 missing route stay apart
 * downstream. Only an integer 4xx is accepted, and only on that code; any
 * other value is treated as absent, never guessed.
 */
export function upstreamRejectedStatus(code: string, value: unknown): number | undefined {
  return code === 'upstream_rejected' &&
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 400 &&
    value <= 499
    ? value
    : undefined
}
