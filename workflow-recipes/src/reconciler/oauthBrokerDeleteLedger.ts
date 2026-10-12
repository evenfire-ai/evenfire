/**
 * In-process B3(a)(b) ledger for oauth-broker Secret / NetworkPolicy deletes.
 * Transition is (recipe, metadata.generation). The NetworkPolicy side adds a
 * 1h TTL so a later pass can reap a leftover without a watch. Indexing only
 * by recipe name is the E.6 vacuity mutation: a generation bump must miss.
 *
 * One entry per recipe, holding the highest generation (the watermark) seen
 * for the recipe's current uid. A pass whose generation is below the
 * watermark is always skipped: a queued pass still carrying an older object
 * must not delete what a newer generation provisioned. A pass at the
 * watermark is skipped unless a token ADDED re-armed it. A different uid is a
 * recipe recreated under the same name, whose generations restart at 1, so it
 * always deletes and replaces the entry even when the recipe DELETE event was
 * missed.
 *
 * The Secret side deletes only after the Secret watch observed the recipe's
 * token (a non-zero epoch): a recipe that never had one gets no DELETE. The
 * epoch survives recipe deletion and returns to 0 only when the finalizer's
 * own token DELETE is observed 2xx/404 with no ADDED in between.
 *
 * The Secret watermark rises on a recorded delete and on
 * `noteSecretProvisioned`, which the backgroundAccess branch calls for the
 * generation that wants the token.
 *
 * `invalidateSecret` (a token ADDED) keeps the uid and the watermark and
 * re-arms the delete only for passes at or above the watermark. It also bumps
 * a per-recipe epoch: a Secret delete is recorded only when the epoch is
 * unchanged since before the DELETE was sent, so an ADDED handled while the
 * DELETE is in flight is not overwritten by it.
 */

export const OAUTH_BROKER_NP_TTL_MS = 60 * 60 * 1000

/** The recipe identity the ledger keys on; a recipe's `metadata` satisfies it. */
export interface OAuthBrokerLedgerRecipe {
  name: string
  uid?: string
  generation?: number
}

interface WatermarkEntry {
  uid: string | undefined
  generation: number
}

interface SecretEntry extends WatermarkEntry {
  /** A token ADDED landed after the watermark was set. */
  rearmed: boolean
}

interface PolicyEntry extends WatermarkEntry {
  expiresAt: number
}

function normalizeGeneration(generation: number | undefined): number {
  return generation ?? 0
}

function coversPass(entry: WatermarkEntry | undefined, recipe: OAuthBrokerLedgerRecipe): boolean {
  return (
    entry !== undefined &&
    entry.uid === recipe.uid &&
    normalizeGeneration(recipe.generation) <= entry.generation
  )
}

function nextEntry(
  entry: WatermarkEntry | undefined,
  recipe: OAuthBrokerLedgerRecipe
): WatermarkEntry {
  const generation = normalizeGeneration(recipe.generation)
  if (entry !== undefined && entry.uid === recipe.uid) {
    return { uid: recipe.uid, generation: Math.max(entry.generation, generation) }
  }
  return { uid: recipe.uid, generation }
}

export class OAuthBrokerDeleteLedger {
  private readonly secrets = new Map<string, SecretEntry>()
  private readonly policies = new Map<string, PolicyEntry>()
  private readonly secretEpochs = new Map<string, number>()
  private epochClock = 0

  shouldDeleteSecret(recipe: OAuthBrokerLedgerRecipe): boolean {
    // Epoch 0: no token ADDED since this process started, or the finalizer
    // observed the token gone (2xx/404) with no ADDED since. The Secret
    // watch's initial list replays ADDED for every token that exists, so
    // there is no token to reap and a DELETE would only 404.
    if (this.secretEpoch(recipe.name) === 0) return false
    const entry = this.secrets.get(recipe.name)
    if (entry === undefined || entry.uid !== recipe.uid) return true
    const generation = normalizeGeneration(recipe.generation)
    if (generation !== entry.generation) return generation > entry.generation
    return entry.rearmed
  }

  /** Read before sending the DELETE and hand back to `recordSecretDelete`. */
  secretEpoch(recipeName: string): number {
    return this.secretEpochs.get(recipeName) ?? 0
  }

  /**
   * Returns false, recording nothing, when an invalidation landed after
   * `epochBeforeDelete` was read.
   */
  recordSecretDelete(recipe: OAuthBrokerLedgerRecipe, epochBeforeDelete: number): boolean {
    if (this.secretEpoch(recipe.name) !== epochBeforeDelete) return false
    this.raiseSecretWatermark(recipe)
    return true
  }

  /**
   * The recipe's generation wants the token (backgroundAccess), so no pass at
   * or below it may delete the Secret, even after a later token ADDED.
   */
  noteSecretProvisioned(recipe: OAuthBrokerLedgerRecipe): void {
    this.raiseSecretWatermark(recipe)
  }

  private raiseSecretWatermark(recipe: OAuthBrokerLedgerRecipe): void {
    const entry = this.secrets.get(recipe.name)
    const generation = normalizeGeneration(recipe.generation)
    if (entry !== undefined && entry.uid === recipe.uid && generation < entry.generation) return
    this.secrets.set(recipe.name, { uid: recipe.uid, generation, rearmed: false })
  }

  shouldDeletePolicy(recipe: OAuthBrokerLedgerRecipe, nowMs = Date.now()): boolean {
    const entry = this.policies.get(recipe.name)
    if (entry === undefined || !coversPass(entry, recipe)) return true
    return nowMs >= entry.expiresAt
  }

  recordPolicyDelete(recipe: OAuthBrokerLedgerRecipe, nowMs = Date.now()): void {
    this.policies.set(recipe.name, {
      ...nextEntry(this.policies.get(recipe.name), recipe),
      expiresAt: nowMs + OAUTH_BROKER_NP_TTL_MS,
    })
  }

  /**
   * A recreated token Secret re-arms only the Secret side, and only for
   * passes at or above the watermark; the uid and watermark are kept. The
   * NetworkPolicy TTL is not tied to that Secret, and a watch reconnect
   * replays ADDED for every existing token, so clearing the policy side here
   * would cost one extra DELETE per recipe after each reconnect.
   */
  invalidateSecret(recipeName: string): void {
    const entry = this.secrets.get(recipeName)
    if (entry !== undefined) entry.rearmed = true
    this.epochClock += 1
    this.secretEpochs.set(recipeName, this.epochClock)
  }

  /**
   * Finalizer start: drops the Secret and NetworkPolicy entries and keeps the
   * epoch. Deleting a recipe does not delete its token; only the finalizer's
   * own DELETE, observed through `noteSecretGone`, may clear the epoch. A
   * DELETE that fails, is never sent, or races an ADDED leaves the token
   * seen, so a recipe recreated under the same name still reaps it.
   */
  forgetRecipe(recipeName: string): void {
    this.secrets.delete(recipeName)
    this.policies.delete(recipeName)
  }

  /**
   * The finalizer's token DELETE returned 2xx or 404. Clears the epoch only
   * when it is unchanged since `epochBeforeDelete` was read; returns false,
   * clearing nothing, when an ADDED landed while the DELETE was in flight.
   */
  noteSecretGone(recipeName: string, epochBeforeDelete: number): boolean {
    if (this.secretEpoch(recipeName) !== epochBeforeDelete) return false
    this.secretEpochs.delete(recipeName)
    return true
  }
}
