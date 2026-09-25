/**
 * In-process B3(a)(b) ledger for oauth-broker Secret / NetworkPolicy deletes.
 * Transition is (recipe, metadata.generation). The NetworkPolicy side adds a
 * 1h TTL so a later pass can reap a leftover without a watch. Indexing only
 * by recipe name is the E.6 vacuity mutation: a generation bump must miss.
 */

export const OAUTH_BROKER_NP_TTL_MS = 60 * 60 * 1000

function ledgerKey(recipeName: string, generation: number | undefined): string {
  return `${recipeName}:${generation ?? 0}`
}

export class OAuthBrokerDeleteLedger {
  private readonly secrets = new Set<string>()
  private readonly policies = new Map<string, number>()

  shouldDeleteSecret(recipeName: string, generation: number | undefined): boolean {
    return !this.secrets.has(ledgerKey(recipeName, generation))
  }

  recordSecretDelete(recipeName: string, generation: number | undefined): void {
    this.secrets.add(ledgerKey(recipeName, generation))
  }

  shouldDeletePolicy(
    recipeName: string,
    generation: number | undefined,
    nowMs = Date.now()
  ): boolean {
    const expiresAt = this.policies.get(ledgerKey(recipeName, generation))
    return expiresAt === undefined || nowMs >= expiresAt
  }

  recordPolicyDelete(recipeName: string, generation: number | undefined, nowMs = Date.now()): void {
    this.policies.set(ledgerKey(recipeName, generation), nowMs + OAUTH_BROKER_NP_TTL_MS)
  }

  invalidate(recipeName: string): void {
    const prefix = `${recipeName}:`
    for (const key of [...this.secrets]) {
      if (key.startsWith(prefix)) this.secrets.delete(key)
    }
    for (const key of [...this.policies.keys()]) {
      if (key.startsWith(prefix)) this.policies.delete(key)
    }
  }
}
