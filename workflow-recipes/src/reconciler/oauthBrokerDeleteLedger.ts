/**
 * In-process B3(a)(b) ledger for oauth-broker Secret / NetworkPolicy deletes.
 * Transition is (recipe, metadata.generation). The NetworkPolicy side adds a
 * 1h TTL so a later pass can reap a leftover without a watch. Indexing only
 * by recipe name is the E.6 vacuity mutation: a generation bump must miss.
 *
 * One entry per recipe, holding the highest generation recorded for the
 * recipe's current uid. A pass whose generation is at or below that value is
 * skipped: a queued pass still carrying an older object must not delete what
 * a newer generation provisioned. A different uid is a recipe recreated under
 * the same name, whose generations restart at 1, so it always deletes and
 * replaces the entry even when the recipe DELETE event was missed.
 *
 * `invalidateSecret` bumps a per-recipe epoch. A Secret delete is recorded
 * only when the epoch is unchanged since before the DELETE was sent, so an
 * ADDED handled while the DELETE is in flight is not overwritten by it.
 */

export const OAUTH_BROKER_NP_TTL_MS = 60 * 60 * 1000

/** The recipe identity the ledger keys on; a recipe's `metadata` satisfies it. */
export interface OAuthBrokerLedgerRecipe {
  name: string
  uid?: string
  generation?: number
}

interface SecretEntry {
  uid: string | undefined
  generation: number
}

interface PolicyEntry extends SecretEntry {
  expiresAt: number
}

function normalizeGeneration(generation: number | undefined): number {
  return generation ?? 0
}

function coversPass(entry: SecretEntry | undefined, recipe: OAuthBrokerLedgerRecipe): boolean {
  return (
    entry !== undefined &&
    entry.uid === recipe.uid &&
    normalizeGeneration(recipe.generation) <= entry.generation
  )
}

function nextEntry(entry: SecretEntry | undefined, recipe: OAuthBrokerLedgerRecipe): SecretEntry {
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
    return !coversPass(this.secrets.get(recipe.name), recipe)
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
    this.secrets.set(recipe.name, nextEntry(this.secrets.get(recipe.name), recipe))
    return true
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
   * A recreated token Secret re-arms only the Secret side. The NetworkPolicy
   * TTL is not tied to that Secret, and a watch reconnect replays ADDED for
   * every existing token, so clearing the policy side here would cost one
   * extra DELETE per recipe after each reconnect.
   */
  invalidateSecret(recipeName: string): void {
    this.secrets.delete(recipeName)
    this.epochClock += 1
    this.secretEpochs.set(recipeName, this.epochClock)
  }

  /**
   * Recipe deletion drops both sides. The epoch entry goes too; the clock is
   * global, so a DELETE in flight that read a non-zero epoch still mismatches.
   */
  invalidate(recipeName: string): void {
    this.secrets.delete(recipeName)
    this.policies.delete(recipeName)
    this.secretEpochs.delete(recipeName)
  }
}
