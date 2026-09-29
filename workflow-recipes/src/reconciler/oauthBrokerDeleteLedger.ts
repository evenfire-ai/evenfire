/**
 * In-process B3(a)(b) ledger for oauth-broker Secret / NetworkPolicy deletes.
 * Transition is (recipe, metadata.generation). The NetworkPolicy side adds a
 * 1h TTL so a later pass can reap a leftover without a watch. Indexing only
 * by recipe name is the E.6 vacuity mutation: a generation bump must miss.
 *
 * One entry per recipe (the last generation wins): generations only increase,
 * so older entries can never match again and keeping them would grow the
 * ledger by one key per spec edit for the life of the process.
 */

export const OAUTH_BROKER_NP_TTL_MS = 60 * 60 * 1000

interface PolicyEntry {
  generation: number
  expiresAt: number
}

function normalizeGeneration(generation: number | undefined): number {
  return generation ?? 0
}

export class OAuthBrokerDeleteLedger {
  private readonly secrets = new Map<string, number>()
  private readonly policies = new Map<string, PolicyEntry>()

  shouldDeleteSecret(recipeName: string, generation: number | undefined): boolean {
    return this.secrets.get(recipeName) !== normalizeGeneration(generation)
  }

  recordSecretDelete(recipeName: string, generation: number | undefined): void {
    this.secrets.set(recipeName, normalizeGeneration(generation))
  }

  shouldDeletePolicy(
    recipeName: string,
    generation: number | undefined,
    nowMs = Date.now()
  ): boolean {
    const entry = this.policies.get(recipeName)
    return (
      entry === undefined ||
      entry.generation !== normalizeGeneration(generation) ||
      nowMs >= entry.expiresAt
    )
  }

  recordPolicyDelete(recipeName: string, generation: number | undefined, nowMs = Date.now()): void {
    this.policies.set(recipeName, {
      generation: normalizeGeneration(generation),
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
  }

  /** Recipe deletion drops both sides. */
  invalidate(recipeName: string): void {
    this.secrets.delete(recipeName)
    this.policies.delete(recipeName)
  }
}
