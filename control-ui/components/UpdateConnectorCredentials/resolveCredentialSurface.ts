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
 * Returns the ONE authoritative `SecretResolved` condition.
 *
 * The McpServer CRD declares `status.conditions` as an ordinary array and does
 * NOT enforce uniqueness per `type`. HCC rewrites a type in place, but legacy
 * or hand-edited resources can carry two contradictory `SecretResolved`
 * entries. Asking `.some()` whether ANY of them proves absence lets an
 * arbitrarily stale entry win, which forces every key on the operator and
 * re-enables POST against a Secret that already exists.
 *
 * Ordering, from strongest to weakest key:
 *
 *  1. Newest parseable `lastTransitionTime` wins — recency is the only real
 *     evidence of which statement the controller made last.
 *  2. An absent, empty or unparseable timestamp ranks as the OLDEST possible.
 *     It carries no recency proof, so it must never outrank a well-stamped
 *     condition — in particular a malformed absence claim can never beat an
 *     observed resolution.
 *  3. On an exact tie, the condition that does NOT claim absence wins.
 *     Ambiguity must resolve away from "the Secret is missing": that verdict is
 *     the destructive one (it demands every key and re-opens the create path),
 *     while the rotate verdict is self-correcting — the PUT answers 404 if the
 *     Secret really is gone, and the screen recovers from there.
 *  4. Still tied — every remaining candidate claims absence and therefore
 *     agrees — so take the last array entry for determinism.
 */
function selectAuthoritativeSecretResolved(
  conditions: McpServerCondition[] | undefined
): McpServerCondition | undefined {
  let best: McpServerCondition | undefined
  let bestTime = Number.NEGATIVE_INFINITY

  for (const candidate of conditions ?? []) {
    if (candidate.type !== 'SecretResolved') continue
    const parsed = new Date(candidate.lastTransitionTime ?? '').getTime()
    const time = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed

    if (!best) {
      best = candidate
      bestTime = time
      continue
    }
    if (time > bestTime) {
      best = candidate
      bestTime = time
      continue
    }
    if (time < bestTime) continue
    // Exact tie (including two unparseable timestamps): rule 3, then rule 4.
    if (claimsAbsence(best) && !claimsAbsence(candidate)) {
      best = candidate
      bestTime = time
      continue
    }
    if (!claimsAbsence(best) && claimsAbsence(candidate)) continue
    best = candidate
    bestTime = time
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
