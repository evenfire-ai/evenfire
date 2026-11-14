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

/**
 * Text for an `upstream_rejected` whose upstream status is 400 (#1433). A 400
 * has many causes (request shape, parameters, malformed text), so the message
 * states only what every 400 proves. Other upstream 4xx keep the generic text:
 * a 402/403 entitlement refusal is not covered by it.
 */
export const UPSTREAM_REQUEST_REJECTED_MESSAGE =
  'The provider rejected this request (HTTP 400). This is not a connection problem, and retrying the same request will not help.'

/** The fixed text for an upstream 400, or `undefined` for any other refusal. */
export function upstreamRequestRejectedMessage(
  code: string,
  upstreamStatus: number | undefined
): string | undefined {
  return code === 'upstream_rejected' && upstreamStatus === 400
    ? UPSTREAM_REQUEST_REJECTED_MESSAGE
    : undefined
}
