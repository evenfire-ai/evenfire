import { describe, expect, it } from 'vitest'
import {
  OAUTH_BROKER_NP_TTL_MS,
  OAuthBrokerDeleteLedger,
  type OAuthBrokerLedgerRecipe,
} from './oauthBrokerDeleteLedger'

function ref(name: string, generation: number, uid = `uid-${name}`): OAuthBrokerLedgerRecipe {
  return { name, uid, generation }
}

function recordSecret(ledger: OAuthBrokerDeleteLedger, recipe: OAuthBrokerLedgerRecipe): void {
  expect(ledger.recordSecretDelete(recipe, ledger.secretEpoch(recipe.name))).toBe(true)
}

/**
 * The Secret watch observed the recipe's token (an ADDED, or the relist that
 * replays one). Every Secret-side case below starts here: without it the
 * ledger answers false for every pass, so a false would prove nothing.
 */
function tokenSeen(ledger: OAuthBrokerDeleteLedger, name: string): void {
  ledger.invalidateSecret(name)
}

describe('OAuthBrokerDeleteLedger', () => {
  it('never deletes a Secret it never saw a token for', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    for (const generation of [0, 1, 4]) {
      expect(ledger.shouldDeleteSecret(ref('r', generation))).toBe(false)
    }
    // A recipe recreated under the same name does not bypass it either.
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-recreated'))).toBe(false)

    // Liveness witness: the token ADDED arms the delete, for that recipe only.
    tokenSeen(ledger, 'r')
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(true)
    expect(ledger.shouldDeleteSecret(ref('r2', 4))).toBe(false)
  })

  it('remembers a Secret delete for the recorded generation only', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(true)
    recordSecret(ledger, ref('r', 4))
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(false)
    expect(ledger.shouldDeleteSecret(ref('r', 5))).toBe(true)
  })

  it('keeps the highest generation per recipe: an older generation arriving late is skipped', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    recordSecret(ledger, ref('r', 4))
    recordSecret(ledger, ref('r', 5))
    expect(ledger.shouldDeleteSecret(ref('r', 5))).toBe(false)
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(false)
    expect(ledger.shouldDeleteSecret(ref('r', 6))).toBe(true)

    ledger.recordPolicyDelete(ref('r', 4), 0)
    ledger.recordPolicyDelete(ref('r', 5), 0)
    expect(ledger.shouldDeletePolicy(ref('r', 5), 1)).toBe(false)
    expect(ledger.shouldDeletePolicy(ref('r', 4), 1)).toBe(false)
    expect(ledger.shouldDeletePolicy(ref('r', 6), 1)).toBe(true)
  })

  it('an older generation recorded late does not lower the recorded generation', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    recordSecret(ledger, ref('r', 5))
    recordSecret(ledger, ref('r', 3))
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(false)
    // Liveness witness: the watermark is 5, not unset.
    expect(ledger.shouldDeleteSecret(ref('r', 6))).toBe(true)

    ledger.recordPolicyDelete(ref('r', 5), 0)
    ledger.recordPolicyDelete(ref('r', 3), 0)
    expect(ledger.shouldDeletePolicy(ref('r', 4), 1)).toBe(false)
  })

  it('a recipe recreated under the same name (new uid) deletes again at any generation', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    recordSecret(ledger, ref('r', 5, 'uid-old'))
    ledger.recordPolicyDelete(ref('r', 5, 'uid-old'), 0)
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-old'))).toBe(false)
    expect(ledger.shouldDeletePolicy(ref('r', 1, 'uid-old'), 1)).toBe(false)

    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-new'))).toBe(true)
    expect(ledger.shouldDeletePolicy(ref('r', 1, 'uid-new'), 1)).toBe(true)

    // Recording the recreated recipe replaces the old uid's higher generation.
    recordSecret(ledger, ref('r', 1, 'uid-new'))
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-new'))).toBe(false)
    expect(ledger.shouldDeleteSecret(ref('r', 2, 'uid-new'))).toBe(true)
  })

  it('does not let one recipe suppress another', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'a')
    tokenSeen(ledger, 'a-b')
    tokenSeen(ledger, 'b')
    recordSecret(ledger, ref('a', 1))
    expect(ledger.shouldDeleteSecret(ref('a', 1))).toBe(false)
    expect(ledger.shouldDeleteSecret(ref('a-b', 1))).toBe(true)
    expect(ledger.shouldDeleteSecret(ref('b', 1))).toBe(true)
  })

  it('expires the NetworkPolicy entry after the TTL', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    ledger.recordPolicyDelete(ref('r', 4), 1_000)
    expect(ledger.shouldDeletePolicy(ref('r', 4), 1_000 + OAUTH_BROKER_NP_TTL_MS - 1)).toBe(false)
    expect(ledger.shouldDeletePolicy(ref('r', 4), 1_000 + OAUTH_BROKER_NP_TTL_MS)).toBe(true)
  })

  it('never saw a token: the NetworkPolicy side still deletes, it is not tied to the Secret', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(false)
    expect(ledger.shouldDeletePolicy(ref('r', 4), 1)).toBe(true)
  })

  it('invalidateSecret re-arms only the Secret side; the NetworkPolicy TTL survives', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    recordSecret(ledger, ref('r', 4))
    ledger.recordPolicyDelete(ref('r', 4), 0)
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(false)
    expect(ledger.shouldDeletePolicy(ref('r', 4), 1)).toBe(false)

    ledger.invalidateSecret('r')
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(true)
    expect(ledger.shouldDeletePolicy(ref('r', 4), 1)).toBe(false)
  })

  it('R2-L1: an ADDED after a newer generation provisioned the token does not re-arm an older pass', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    // gen4 has no backgroundAccess: the Secret is reaped and recorded.
    recordSecret(ledger, ref('r', 4))
    // gen5 turns backgroundAccess on and the token is issued.
    ledger.noteSecretProvisioned(ref('r', 5))
    // The token's watch ADDED.
    ledger.invalidateSecret('r')

    // A queued pass still carrying the gen4 object must not delete the live token.
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(false)
    // Liveness witness: a newer generation that drops backgroundAccess reaps it.
    expect(ledger.shouldDeleteSecret(ref('r', 6))).toBe(true)
  })

  it('R2-L1: invalidateSecret keeps the watermark: below it stays skipped, at it re-arms', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    recordSecret(ledger, ref('r', 5))
    ledger.invalidateSecret('r')
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(false)
    expect(ledger.shouldDeleteSecret(ref('r', 5))).toBe(true)

    // Recording the re-armed delete disarms it again.
    recordSecret(ledger, ref('r', 5))
    expect(ledger.shouldDeleteSecret(ref('r', 5))).toBe(false)
  })

  it('does not record a Secret delete when an invalidation landed after the epoch was read', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    const epochBeforeDelete = ledger.secretEpoch('r')
    ledger.invalidateSecret('r')
    expect(ledger.recordSecretDelete(ref('r', 4), epochBeforeDelete)).toBe(false)
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(true)

    // Liveness witness: with a fresh epoch the same record is accepted.
    expect(ledger.recordSecretDelete(ref('r', 4), ledger.secretEpoch('r'))).toBe(true)
    expect(ledger.shouldDeleteSecret(ref('r', 4))).toBe(false)
  })

  it('an invalidation for one recipe does not reject another recipe record', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r2')
    const epochBeforeDelete = ledger.secretEpoch('r2')
    ledger.invalidateSecret('r')
    expect(ledger.recordSecretDelete(ref('r2', 4), epochBeforeDelete)).toBe(true)
    expect(ledger.shouldDeleteSecret(ref('r2', 4))).toBe(false)
  })

  it('forgetRecipe drops both entries for the named recipe and no other, and keeps the token seen', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    tokenSeen(ledger, 'r2')
    recordSecret(ledger, ref('r', 4))
    ledger.recordPolicyDelete(ref('r', 4), 0)
    recordSecret(ledger, ref('r2', 4))
    ledger.recordPolicyDelete(ref('r2', 4), 0)

    ledger.forgetRecipe('r')
    // Deleting the recipe does not delete its token: the watermark went, the
    // epoch stayed, so a generation below the old watermark deletes.
    expect(ledger.shouldDeleteSecret(ref('r', 3))).toBe(true)
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-recreated'))).toBe(true)
    expect(ledger.shouldDeletePolicy(ref('r', 4), 1)).toBe(true)
    // The other recipe keeps both entries.
    expect(ledger.shouldDeleteSecret(ref('r2', 4))).toBe(false)
    expect(ledger.shouldDeletePolicy(ref('r2', 4), 1)).toBe(false)
  })

  it('Table B: noteSecretGone with the epoch unchanged clears the token-seen bit until the next ADDED', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    tokenSeen(ledger, 'r2')
    ledger.forgetRecipe('r')
    const epochBeforeDelete = ledger.secretEpoch('r')
    expect(epochBeforeDelete).toBeGreaterThan(0)
    expect(ledger.noteSecretGone('r', epochBeforeDelete)).toBe(true)

    expect(ledger.secretEpoch('r')).toBe(0)
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-recreated'))).toBe(false)
    // Liveness witness: another recipe is untouched, and the next ADDED re-arms.
    expect(ledger.shouldDeleteSecret(ref('r2', 1))).toBe(true)
    tokenSeen(ledger, 'r')
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-recreated'))).toBe(true)
  })

  it('Table B: noteSecretGone after an ADDED raced the finalizer DELETE clears nothing', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    ledger.forgetRecipe('r')
    const epochBeforeDelete = ledger.secretEpoch('r')
    // The recreated recipe's token ADDED lands while the DELETE is in flight.
    ledger.invalidateSecret('r')
    expect(ledger.noteSecretGone('r', epochBeforeDelete)).toBe(false)
    expect(ledger.secretEpoch('r')).toBeGreaterThan(epochBeforeDelete)
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-recreated'))).toBe(true)
  })

  it('Table B: a finalizer DELETE that failed or was never sent keeps the token seen', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    tokenSeen(ledger, 'r')
    recordSecret(ledger, ref('r', 4, 'uid-old'))
    const epochBeforeForget = ledger.secretEpoch('r')
    // Finalizer start; the DELETE then fails (or is never sent), so
    // noteSecretGone is not called.
    ledger.forgetRecipe('r')
    expect(ledger.secretEpoch('r')).toBe(epochBeforeForget)
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-recreated'))).toBe(true)
  })

  it('a DELETE in flight across a finalizer start that followed an ADDED is recorded against the old uid only', () => {
    const ledger = new OAuthBrokerDeleteLedger()
    ledger.invalidateSecret('r')
    const epochBeforeDelete = ledger.secretEpoch('r')
    ledger.forgetRecipe('r')
    // The epoch did not move, so the in-flight DELETE of the old recipe is
    // recorded for its own uid.
    expect(ledger.recordSecretDelete(ref('r', 4, 'uid-old'), epochBeforeDelete)).toBe(true)
    expect(ledger.shouldDeleteSecret(ref('r', 4, 'uid-old'))).toBe(false)

    // A recipe recreated under the same name (new uid) still deletes.
    expect(ledger.shouldDeleteSecret(ref('r', 1, 'uid-new'))).toBe(true)
  })
})
