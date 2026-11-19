/**
 * The V2 host wake route's answers after the authority check passed, pinned
 * against the real route in test/actionAuthorityHostWake.test.ts and read by
 * rpc-proxy's V2 wake client tests. On the same HTTP status the route can also
 * answer an authority refusal (`{ version: 2, status, code }`); the body tells
 * the two apart.
 */
export const hostWakeV2Answers = {
  unknown: { status: 404, body: { status: 'unknown' } },
  notStateless: { status: 409, body: { status: 'not-stateless' } },
} as const
