import type { McpServerCondition } from '@lib/api'

/**
 * Which credential surface the connector screen should render.
 *
 * - set:          the envSecret Secret does not exist; it must be CREATED (POST).
 * - rotate:       the Secret exists; values are rotated through the merge-patch (PUT).
 * - recipe-owned: the Secret is missing on a WorkflowRecipe-owned connector.
 *                 Neither operation belongs on this screen.
 */
export type CredentialSurface = 'set' | 'rotate' | 'recipe-owned'

/**
 * A WorkflowRecipe-owned connector: `spec.managed === false`.
 *
 * This is an OWNERSHIP fact about the connector, and it is deliberately
 * independent of any observed status condition. The credential screen needs it
 * that way: a connector whose status has not been written yet (or is stale)
 * resolves to `rotate`, and only the PUT's own 404 later reveals the Secret is
 * absent. If ownership were re-derived from that observation, the late 404
 * would flip a recipe-owned connector into the create form and let the operator
 * POST an unlabeled Secret outside the recipe flow.
 *
 * Exported so the page and the resolver share one definition instead of two
 * copies of `managed === false` that can drift apart.
 */
export function isRecipeOwned(spec: { managed?: boolean } | undefined): boolean {
  return spec?.managed === false
}

/**
 * RFC3339 date-time, the format the Kubernetes API server stamps
 * `lastTransitionTime` with. Anchored on both ends: a trailing offset or `Z` is
 * mandatory, so a bare local date-time (which `Date.parse` would happily read
 * in the browser's timezone) is rejected.
 */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

/**
 * Parses `lastTransitionTime` STRICTLY, returning epoch milliseconds, or `null`
 * if the value is not a real instant (mini-spec C2).
 *
 * Two checks, and the second one is the load-bearing half:
 *
 *  1. syntax — the string must match RFC3339 exactly;
 *  2. calendar round-trip — the parsed instant must carry back the very
 *     components it was given.
 *
 * `new Date('2026-02-30T00:00:00.000Z')` does NOT throw and is NOT `Invalid
 * Date`: JavaScript silently normalizes February 30 into March 2. A syntax-only
 * check would therefore accept that value and rank it two days in the FUTURE of
 * the real February 28 — letting a malformed duplicate absence claim outrank a
 * valid resolution and force the operator back through the create path. The
 * round-trip is what rejects it: the normalized date reports day 2, not 30.
 *
 * Leap seconds (`:60`) are rejected by the same round-trip. RFC3339 permits
 * them, the Kubernetes API server never emits one, and ranking such a value
 * oldest is the safe reading anyway.
 */
function parseStrictRfc3339(value: string | undefined): number | null {
  if (typeof value !== 'string') return null
  const match = RFC3339.exec(value)
  if (!match) return null

  const [, year, month, day, hour, minute, second, fraction, offset] = match
  // Sub-millisecond precision is truncated, exactly as `Date.parse` truncates
  // it, so the round-trip below compares like with like.
  const ms = Number((fraction ?? '').padEnd(3, '0').slice(0, 3))

  // setUTCFullYear rather than Date.UTC: the latter maps years 0-99 onto
  // 1900-1999, which would fail the round-trip for a four-digit year like 0099.
  const candidate = new Date(0)
  candidate.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  candidate.setUTCHours(Number(hour), Number(minute), Number(second), ms)

  const roundTrips =
    candidate.getUTCFullYear() === Number(year) &&
    candidate.getUTCMonth() === Number(month) - 1 &&
    candidate.getUTCDate() === Number(day) &&
    candidate.getUTCHours() === Number(hour) &&
    candidate.getUTCMinutes() === Number(minute) &&
    candidate.getUTCSeconds() === Number(second) &&
    candidate.getUTCMilliseconds() === ms
  if (!roundTrips) return null

  if (offset === 'Z') return candidate.getTime()
  // `+HH:MM` means the named wall-clock is that far AHEAD of UTC, so the
  // instant is that much EARLIER than the same components read as UTC.
  const sign = offset.startsWith('-') ? -1 : 1
  const offsetHours = Number(offset.slice(1, 3))
  const offsetMinutes = Number(offset.slice(4, 6))
  if (offsetHours > 23 || offsetMinutes > 59) return null
  return candidate.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000
}

/**
 * The rank a condition competes on: its strictly-parsed instant, or
 * `-Infinity` when it has none (mini-spec C3).
 *
 * Missing, empty, non-RFC3339 and invalid-calendar timestamps deliberately
 * share ONE rank — the oldest possible. None of them carries recency evidence,
 * so none may outrank a well-stamped condition, and there is no meaningful
 * ordering among them to invent.
 */
function rankOf(condition: McpServerCondition): number {
  return parseStrictRfc3339(condition.lastTransitionTime) ?? Number.NEGATIVE_INFINITY
}

/**
 * Returns the ONE authoritative `SecretResolved` condition (mini-spec C1).
 *
 * The McpServer CRD declares `status.conditions` as an ordinary array and does
 * NOT enforce uniqueness per `type`. HCC rewrites a type in place, but legacy
 * or hand-edited resources can carry two contradictory `SecretResolved`
 * entries. Asking `.some()` whether ANY of them proves absence lets an
 * arbitrarily stale entry win, which forces every key on the operator and
 * re-enables POST against a Secret that already exists.
 *
 * Ordering:
 *
 *  1. Highest rank wins — the newest strictly-valid `lastTransitionTime`.
 *     Recency is the only real evidence of which statement the controller made
 *     last. A malformed timestamp ranks oldest (`rankOf`), so it can only win
 *     when nothing validly-stamped exists at all.
 *  2. Among equal ranks — including several sharing the oldest rank — the LAST
 *     entry in array order wins (mini-spec C4). Kubernetes appends new
 *     condition types at the end and rewrites in place, so later position is
 *     the only ordering signal left once the timestamps have said nothing.
 *
 * The tie-break is deliberately positional rather than semantic. An earlier
 * revision preferred "the candidate that does not claim absence", which reads
 * as the safer choice but makes the array-order rule unobservable: two
 * conditions of equal rank either agree on absence (same verdict) or are
 * separated by that preference, so nothing can ever detect the positional rule
 * being reversed. An untestable tie-break is not a contract — it is a comment.
 *
 * This function READS the array and never writes to it: no `sort`, no `splice`,
 * no `reverse` (mini-spec C5). Callers pass React state straight from the
 * fetched McpServer, and reordering it under them would mutate a rendered
 * resource behind React's back.
 */
function selectAuthoritativeSecretResolved(
  conditions: McpServerCondition[] | undefined
): McpServerCondition | undefined {
  let best: McpServerCondition | undefined
  let bestRank = Number.NEGATIVE_INFINITY

  for (const candidate of conditions ?? []) {
    if (candidate.type !== 'SecretResolved') continue
    const rank = rankOf(candidate)
    // `>=`, not `>`: equal ranks resolve to the LAST such entry (rule 2).
    if (best === undefined || rank >= bestRank) {
      best = candidate
      bestRank = rank
    }
  }

  return best
}

/**
 * Matching on `reason` is load-bearing. `SecretNotFound` means the Secret does
 * not exist and must be created. `SecretMissingKey` means it EXISTS but lacks a
 * declared key — the PUT merge-patch already adds it, so that case must stay on
 * `rotate`. Matching only type+status would send it to `set`, where POST hits
 * AlreadyExists and control-api answers a bare 500 (see spec Non-goals).
 */
function claimsAbsence(condition: McpServerCondition): boolean {
  return condition.status === 'False' && condition.reason === 'SecretNotFound'
}

/**
 * Which surface the connector credential screen should render, derived from the
 * authoritative `SecretResolved` condition (see above) and `spec.managed`.
 *
 * The `managed: false` check is applied ONLY when the Secret is missing. A
 * WRC-owned connector whose Secret resolves keeps today's rotate form; this
 * change fixes a dead end and does not restrict rotation that already works.
 *
 * NOTE: a `rotate` result here is NOT proof that the connector may create a
 * Secret. Absent or stale status yields `rotate` for recipe-owned connectors
 * too, so the create path must be gated on `isRecipeOwned(spec)` separately —
 * never on this value.
 */
export function resolveCredentialSurface(
  conditions: McpServerCondition[] | undefined,
  spec: { managed?: boolean } | undefined
): CredentialSurface {
  const authoritative = selectAuthoritativeSecretResolved(conditions)
  if (!authoritative || !claimsAbsence(authoritative)) return 'rotate'
  return isRecipeOwned(spec) ? 'recipe-owned' : 'set'
}
